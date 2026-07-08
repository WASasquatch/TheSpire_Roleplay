/**
 * Google sign-in (OAuth) HTTP routes — /auth/google/* + /me/oauth/*.
 *
 * The whole surface is env-gated: when `googleConfigured` is false (no
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) every route 404s, so an
 * unconfigured deploy behaves as if the feature doesn't exist. The consent-URL
 * builder + token/userinfo exchange + state signing live in
 * ../auth/googleOauth.ts (the shared, Foundation-owned module); this file wires
 * them into the request lifecycle and reuses the local-auth primitives from
 * ./auth.ts (issueSession + the login/register return bundle shape).
 *
 * SECURITY posture:
 *   - A session bearer token is NEVER placed in a URL. The callback stashes the
 *     freshly-issued token in a short-lived in-memory HANDOFF map keyed by a
 *     random single-use code and redirects to a client route carrying only that
 *     code; the client POSTs the code to /auth/google/exchange to receive the
 *     token in the response body. New-user flows redirect with a PENDING code
 *     instead (holds the Google identity, no token yet) and the client collects
 *     a username via POST /auth/google/finish.
 *   - The OAuth `state` param is HMAC-signed (signState/verifyState) for CSRF +
 *     tamper protection and expires in ~10 min.
 *   - Scopes are fixed at openid/email/profile in buildConsentUrl.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { type Role } from "@thekeep/shared";
import { oauthAccounts, serverMembers, users } from "../db/schema.js";
import { hashPassword } from "../auth/passwords.js";
import { permissionsFor } from "../auth/permissions.js";
import { getSettings } from "../settings.js";
import { createEmailToken } from "../email/tokens.js";
import { sendVerificationEmail } from "../email/templates.js";
import {
  buildConsentUrl,
  exchangeCodeForIdentity,
  googleConfigured,
  googleRedirectUri,
  signState,
  verifyState,
} from "../auth/googleOauth.js";
import type { Db } from "../db/index.js";
import {
  getSessionUser,
  issueSession,
  MASTER_USERNAME_RULE_MESSAGE,
  MASTER_USERNAME_RX,
  normalizeMasterUsername,
} from "./auth.js";

/** Email-verification link validity — mirrors routes/auth.ts (24h). */
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Provider key. Kept as a const so every oauth_accounts read/write agrees and
 * a future second provider is a one-line addition rather than scattered string
 * literals.
 */
const PROVIDER = "google";

/** Cookie holding the OAuth `state` nonce so the callback can confirm the flow
 *  was started by THIS browser (CSRF / login-session-fixation guard). HttpOnly +
 *  SameSite=Lax (rides the top-level GET redirect back from Google), scoped to
 *  /auth/google, ~10 min. */
const OAUTH_CSRF_COOKIE = "tk_goauth";

/** Constant-time string compare for the nonce check. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Where the callback bounces the browser after it has stashed a code. These are
 * client SPA routes (not API routes); the SPA reads the `code` query param and
 * calls the matching POST. Kept relative so they work on any host.
 */
const DONE_PATH = "/auth/google/done"; // existing user → exchange for a token
const FINISH_PATH = "/auth/google/finish"; // new user → collect a username
const LINKED_PATH = "/?googleLinked=1"; // link mode → back to the app

/**
 * Short-lived, single-use handoff store. Two entry kinds:
 *   - "session": an already-issued session token for a returning user. Redeemed
 *     by POST /auth/google/exchange, which returns the full login bundle.
 *   - "pending": the Google identity for a brand-new user (no local account
 *     yet). Redeemed by POST /auth/google/finish once the user picks a username.
 *
 * In-memory on purpose (same rationale as the captcha store in routes/auth.ts):
 * the codes are throwaway, single-use, and expire in 5 minutes, so a process
 * restart just forces the user to re-run consent — nothing worth persisting.
 * Bounded growth: every issue opportunistically sweeps expired entries, and
 * redemption deletes on read, so the map can't accumulate.
 */
const HANDOFF_TTL_MS = 5 * 60 * 1000;

interface SessionHandoff {
  kind: "session";
  userId: string;
  sessionToken: string;
  expiresAt: number;
}
interface PendingHandoff {
  kind: "pending";
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  expiresAt: number;
}
type Handoff = SessionHandoff | PendingHandoff;

const handoffs = new Map<string, Handoff>();

function sweepHandoffs(now: number): void {
  for (const [k, v] of handoffs) {
    if (v.expiresAt < now) handoffs.delete(k);
  }
}

/** Mint a random single-use code and store its payload. */
function putHandoff(payload: Omit<SessionHandoff, "expiresAt"> | Omit<PendingHandoff, "expiresAt">): string {
  const now = Date.now();
  sweepHandoffs(now);
  const code = randomBytes(24).toString("base64url");
  handoffs.set(code, { ...payload, expiresAt: now + HANDOFF_TTL_MS } as Handoff);
  return code;
}

/** Redeem (and delete) a handoff code. Returns null when unknown/expired. */
function takeHandoff(code: string): Handoff | null {
  const entry = handoffs.get(code);
  if (!entry) return null;
  handoffs.delete(code); // single-use: always drop on read
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

/** 302 helper that stays independent of Fastify's version-specific
 *  reply.redirect() argument order (index.ts uses this same low-level form). */
function redirect(reply: FastifyReply, location: string): FastifyReply {
  return reply.code(302).header("location", location).send();
}

/** Look up an existing local account for a Google subject id. */
async function findLinkByProviderUid(db: Db, sub: string) {
  return (await db
    .select()
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.provider, PROVIDER), eq(oauthAccounts.providerUserId, sub)))
    .limit(1))[0];
}

/**
 * Look up existing local accounts whose email matches (case-insensitively). Used
 * to reconcile a returning PASSWORD user who clicks "Continue with Google" with
 * the same address they registered under but has no oauth link yet. Returns up
 * to two rows so the caller can distinguish "exactly one" (safe to auto-link)
 * from "more than one" (ambiguous — refuse). users.email is not unique at the DB
 * layer, so a match count > 1 is possible. The disabled/banned gate is applied
 * later in signInExistingUser, so only the id is needed here.
 */
async function findUsersByEmail(db: Db, email: string) {
  return db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .limit(2);
}

/**
 * Upsert the (user, google) link. The UNIQUE(userId, provider) index means a
 * user has at most one Google link; onConflictDoUpdate refreshes the mapped
 * subject id + email if they re-link. The UNIQUE(provider, providerUserId)
 * index still guards against attaching one Google account to two locals — that
 * collision surfaces as a thrown constraint error the caller maps to a 409.
 */
async function upsertLink(
  db: Db,
  userId: string,
  sub: string,
  email: string | null,
): Promise<void> {
  await db
    .insert(oauthAccounts)
    .values({
      id: nanoid(),
      userId,
      provider: PROVIDER,
      providerUserId: sub,
      providerEmail: email,
      linkedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: [oauthAccounts.userId, oauthAccounts.provider],
      set: { providerUserId: sub, providerEmail: email, linkedAt: Date.now() },
    });
}

/**
 * Sign a KNOWN-existing user in and redirect into the token-exchange handoff —
 * the shared tail of both login-branch paths (matched by Google subject id, or
 * reconciled by verified email). Honors the same disabled/banned gate the socket
 * handshake and /auth/me apply — never mints a session for a disabled account.
 * Returns the redirect reply; the caller returns it directly.
 */
async function signInExistingUser(
  db: Db,
  reply: FastifyReply,
  req: FastifyRequest,
  userId: string,
): Promise<FastifyReply> {
  const u = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!u || u.disabledAt) {
    return redirect(reply, "/?googleError=disabled");
  }
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, u.id));
  const sessionToken = await issueSession(db, u.id, req);
  const code = putHandoff({ kind: "session", userId: u.id, sessionToken });
  return redirect(reply, `${DONE_PATH}?code=${encodeURIComponent(code)}`);
}

/** Username validator identical to /auth/register (NFC-normalize + the ASCII
 *  allow-list regex). */
const usernameSchema = z
  .string()
  .min(2)
  .max(40)
  .transform((s) => normalizeMasterUsername(s))
  .refine((s) => MASTER_USERNAME_RX.test(s), { message: MASTER_USERNAME_RULE_MESSAGE });

const finishBody = z.object({
  code: z.string().min(1).max(256),
  username: usernameSchema,
  // Same defense-in-depth as /auth/register: prove the disclaimer + age/mature
  // acknowledgments server-side (literal true rejects coerced truthy values), so
  // the Google-signup path can't skip the gate a direct POST would otherwise
  // bypass.
  acceptDisclaimer: z.literal(true, {
    errorMap: () => ({ message: "you must accept the disclaimer to register" }),
  }),
  acceptAgeMature: z.literal(true, {
    errorMap: () => ({ message: "you must confirm you are 18+ and understand this site may contain mature content" }),
  }),
});

export async function registerGoogleAuthRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // Feature fully dark when unconfigured: register NOTHING so every path 404s
  // exactly like a route that doesn't exist. (Registering handlers that 404
  // internally would still advertise the surface; a hard skip is cleaner.)
  if (!googleConfigured) return;

  // Tight per-IP throttles — these endpoints hit Google + the DB and mint
  // sessions, so treat them like the credential routes in routes/auth.ts.
  const startLimit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } } as const;
  const exchangeLimit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } } as const;
  const finishLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } } as const;

  /**
   * Kick off the OAuth dance. `mode=login` (default) is for signing in /
   * registering; `mode=link` attaches Google to the CURRENTLY signed-in account
   * and therefore requires a valid session (whose id we bind into the signed
   * state so the callback links the right account). Redirects to Google's
   * consent screen with an HMAC-signed state.
   */
  app.get("/auth/google/start", startLimit, async (req, reply) => {
    const mode = (req.query as { mode?: string } | undefined)?.mode === "link" ? "link" : "login";
    let uid: string | undefined;
    if (mode === "link") {
      const me = await getSessionUser(req, db);
      if (!me) {
        reply.code(401);
        return { error: "sign in first to link Google" };
      }
      uid = me.id;
    }
    const { state, nonce } = signState({ mode, ...(uid ? { uid } : {}) });
    // Bind this flow to the initiating browser: the nonce is also set as an
    // HttpOnly SameSite=Lax cookie the callback must echo back. Without it the
    // signed state alone doesn't stop OAuth login-CSRF — an attacker could
    // capture a valid state + their own consent code and replay it in a victim's
    // browser to silently sign the victim into the attacker's account.
    reply.setCookie(OAUTH_CSRF_COOKIE, nonce, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/auth/google",
      maxAge: 600,
    });
    return redirect(reply, buildConsentUrl(state, googleRedirectUri(req)));
  });

  /**
   * Google redirects the browser back here with `?code&state`. We verify the
   * state (CSRF + tamper + freshness), swap the code for the Google identity,
   * then branch on mode:
   *   - link  → upsert the (uid, google) link, bounce back to the app.
   *   - login → find an existing local by the Google subject id:
   *       found         → issue a session, stash it under a single-use handoff
   *                       code, redirect to DONE_PATH?code=… (token via /exchange).
   *       no link, but a local account already uses this (Google-VERIFIED) email:
   *         exactly one → auto-link Google to that account and sign in as a
   *                       returning user (so a password user who "Continue with
   *                       Google"s under their existing email isn't dead-ended at
   *                       the per-email cap). Requires emailVerified.
   *         >1 / unverified → ambiguous or unproven: redirect with
   *                       ?googleError=email_exists (client tells them to log in
   *                       with their password, then link Google from the profile).
   *       otherwise     → stash the Google identity under a single-use PENDING
   *                       code, redirect to FINISH_PATH?code=… (username via
   *                       POST /finish).
   * Any failure (bad state, exchange failure, link collision) redirects to a
   * client route with an `?googleError=…` marker rather than dumping a raw JSON
   * error into a top-level navigation.
   */
  app.get("/auth/google/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string } | undefined;
    const code = typeof q?.code === "string" ? q.code : "";
    const stateStr = typeof q?.state === "string" ? q.state : "";
    const state = verifyState(stateStr);
    // CSRF binding: the browser that began the flow holds a cookie equal to the
    // signed state's nonce. Read + clear it (single-use) before anything else.
    const csrfCookie = (req.cookies as Record<string, string | undefined> | undefined)?.[OAUTH_CSRF_COOKIE];
    reply.clearCookie(OAUTH_CSRF_COOKIE, { path: "/auth/google" });
    if (!code || !state) {
      return redirect(reply, "/?googleError=state");
    }
    if (!csrfCookie || !state.nonce || !safeEqual(csrfCookie, state.nonce)) {
      // No matching browser cookie → this callback wasn't initiated by this
      // browser (OAuth login-CSRF / session-fixation attempt). Reject.
      return redirect(reply, "/?googleError=state");
    }

    const identity = await exchangeCodeForIdentity(code, googleRedirectUri(req));
    if (!identity) {
      return redirect(reply, "/?googleError=exchange");
    }

    if (state.mode === "link") {
      // Link mode must have a bound uid from a session-backed /start.
      if (!state.uid) return redirect(reply, "/?googleError=state");
      try {
        await upsertLink(db, state.uid, identity.sub, identity.email);
      } catch (err) {
        // UNIQUE(provider, providerUserId): this Google account is already
        // linked to a DIFFERENT local account. Surface a distinct marker.
        const msg = err instanceof Error ? err.message : "";
        if (/UNIQUE|oauth_accounts_provider_uid_uq/i.test(msg)) {
          return redirect(reply, "/?googleError=already_linked");
        }
        throw err;
      }
      return redirect(reply, LINKED_PATH);
    }

    // login/register mode.
    const existing = await findLinkByProviderUid(db, identity.sub);
    if (existing) {
      // Returning user matched by Google subject id → straight to session handoff.
      return signInExistingUser(db, reply, req, existing.userId);
    }

    // No oauth link yet, but an EXISTING local account may already own this
    // email (the classic "I registered with a password, now I'm clicking
    // Continue with Google" case). Reconcile it here instead of routing to the
    // new-user finish flow, which would dead-end at the per-email account cap
    // with a 409 and no way out.
    //
    // Only auto-link when Google actually VERIFIED the address AND it's
    // unambiguous (exactly one local account uses it) — that pairing proves the
    // person controls both the Google account and the email the local account
    // was registered under, which is the same assurance a password login gives.
    // If the email is unverified, or more than one account shares it, we won't
    // silently attach Google to someone's account; we bounce with a marker the
    // client turns into "an account with this email already exists — log in with
    // your password, then link Google from your profile."
    if (identity.email) {
      const sameEmail = await findUsersByEmail(db, identity.email);
      if (sameEmail.length > 0) {
        if (identity.emailVerified && sameEmail.length === 1) {
          await upsertLink(db, sameEmail[0]!.id, identity.sub, identity.email);
          return signInExistingUser(db, reply, req, sameEmail[0]!.id);
        }
        return redirect(reply, "/?googleError=email_exists");
      }
    }

    // New user: hold the verified identity under a pending code; the client
    // collects a username + disclaimers and calls POST /auth/google/finish.
    const code3 = putHandoff({
      kind: "pending",
      sub: identity.sub,
      email: identity.email,
      emailVerified: identity.emailVerified,
      name: identity.name,
    });
    return redirect(reply, `${FINISH_PATH}?code=${encodeURIComponent(code3)}`);
  });

  /**
   * Redeem a "session" handoff code for a returning Google user. Returns the
   * SAME bundle POST /auth/login returns so the client's existing post-login
   * wiring works unchanged. Single-use: the code is deleted on read.
   */
  app.post<{ Body: unknown }>("/auth/google/exchange", exchangeLimit, async (req, reply) => {
    const body = z.object({ code: z.string().min(1).max(256) }).parse(req.body);
    const entry = takeHandoff(body.code);
    if (!entry || entry.kind !== "session") {
      reply.code(400);
      return { error: "This sign-in link is invalid or has expired. Please try again." };
    }
    const u = (await db.select().from(users).where(eq(users.id, entry.userId)).limit(1))[0];
    if (!u || u.disabledAt) {
      reply.code(400);
      return { error: "This sign-in link is invalid or has expired. Please try again." };
    }
    const permissions = await permissionsFor({ id: u.id, role: u.role }, db);
    const settings = await getSettings(db);
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      permissions,
      incognitoMode: u.incognitoMode,
      incognitoAlias: u.incognitoAlias,
      incognitoCharacterId: u.incognitoCharacterId,
      emailVerifiedAt: u.emailVerifiedAt ? +u.emailVerifiedAt : null,
      emailVerificationEnabled: settings.emailVerificationEnabled,
      emailVerificationMode: settings.emailVerificationMode,
      // Session already issued in the callback; hand the stored token back here
      // (in the body, never a URL).
      sessionToken: entry.sessionToken,
    };
  });

  /**
   * Redeem a "pending" handoff code + finish provisioning a brand-new account
   * for a first-time Google user. Validates the username (same rules as
   * /auth/register) + required disclaimers, creates the user with an UNUSABLE
   * local password (has_password=false), links the Google identity, enrolls the
   * default server, issues a session, and returns the login bundle.
   */
  app.post<{ Body: unknown }>("/auth/google/finish", finishLimit, async (req, reply) => {
    const settings = await getSettings(db);
    if (!settings.registrationOpen) {
      reply.code(503);
      return { error: "registration is closed" };
    }
    const body = finishBody.parse(req.body);

    const entry = takeHandoff(body.code);
    if (!entry || entry.kind !== "pending") {
      reply.code(400);
      return { error: "This sign-up link is invalid or has expired. Please try again." };
    }

    // Guard against a race where this Google account got linked (via another
    // tab / a concurrent finish) between the callback and now.
    const already = await findLinkByProviderUid(db, entry.sub);
    if (already) {
      reply.code(409);
      return { error: "This Google account is already connected to an account. Try signing in instead." };
    }

    // Username uniqueness — same generic 409 wording as /auth/register so an
    // attacker can't probe which handles exist.
    const usernameTaken = (await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.username}) = ${body.username.toLowerCase()}`)
      .limit(1))[0];
    if (usernameTaken) {
      reply.code(409);
      return { error: "registration conflict - try a different username" };
    }

    // Same per-email account cap /auth/register enforces (users.email is not
    // unique at the DB layer, so this is the only gate) — Google signup must not
    // be a bypass.
    const emailCountRow = (await db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(sql`lower(${users.email}) = ${entry.email.toLowerCase()}`))[0];
    if ((emailCountRow?.n ?? 0) >= settings.maxAccountsPerEmail) {
      reply.code(409);
      return { error: "registration conflict - try a different email or username" };
    }

    // Provision the account. The password hash is over 32 random bytes and is
    // never revealed to anyone, so it can never be used to log in; has_password
    // stays false so the client offers "set a password" (via reset) instead of
    // "change password", and the unlink guard below refuses to strip the only
    // way in. Email verification honors the site policy exactly like
    // /auth/register: when verification is ON we mark unverified + send the
    // link even though Google vouched for the address, because the operator
    // asked to "still require email auth if enabled".
    const unusablePassword = await hashPassword(randomBytes(32).toString("base64url"));
    const verifyOn = settings.emailVerificationEnabled;
    const id = nanoid();
    const role: Role = "user";
    await db.insert(users).values({
      id,
      email: entry.email,
      username: body.username,
      passwordHash: unusablePassword,
      hasPassword: false,
      role,
      emailVerifiedAt: verifyOn ? null : new Date(),
      lastLoginAt: new Date(),
    });

    // Default-server enrollment — same additive, flag-off-safe, never-fatal
    // insert as /auth/register.
    try {
      await db.insert(serverMembers).values({
        serverId: "server_spire_system",
        userId: id,
        role: "member",
        permissionsJson: "[]",
        joinedAt: new Date(),
      }).onConflictDoNothing();
    } catch (err) {
      req.log.error({ err }, "default-server auto-join failed (non-fatal)");
    }

    // Link the Google identity to the fresh account.
    await upsertLink(db, id, entry.sub, entry.email);

    // Fire-and-forget verification mail when the policy requires it (a mail
    // hiccup must never fail signup — the user can re-request from the banner).
    if (verifyOn) {
      try {
        const token = await createEmailToken(db, id, "email_verify", VERIFY_TTL_MS);
        void sendVerificationEmail(db, entry.email, body.username, token);
      } catch (err) {
        req.log.error({ err }, "verification email send failed");
      }
    }

    const sessionToken = await issueSession(db, id, req);
    const permissions = await permissionsFor({ id, role }, db);
    return {
      id,
      username: body.username,
      role,
      permissions,
      incognitoMode: false,
      incognitoAlias: null,
      incognitoCharacterId: null,
      emailVerifiedAt: verifyOn ? null : Date.now(),
      emailVerificationEnabled: settings.emailVerificationEnabled,
      emailVerificationMode: settings.emailVerificationMode,
      sessionToken,
    };
  });

  /**
   * List the caller's linked providers (for the profile "connected accounts"
   * UI). providerEmail is informational — the account's own email stays
   * authoritative.
   */
  app.get("/me/oauth", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) {
      reply.code(401);
      return { error: "not authenticated" };
    }
    const rows = await db
      .select({
        provider: oauthAccounts.provider,
        providerEmail: oauthAccounts.providerEmail,
        linkedAt: oauthAccounts.linkedAt,
      })
      .from(oauthAccounts)
      .where(eq(oauthAccounts.userId, me.id));
    return {
      providers: rows.map((r) => ({
        provider: r.provider,
        providerEmail: r.providerEmail,
        linkedAt: typeof r.linkedAt === "number" ? r.linkedAt : +new Date(r.linkedAt as unknown as string),
      })),
    };
  });

  /**
   * Unlink Google from the caller's account.
   *
   * LOCKOUT GUARD: if the account has no usable local password
   * (has_password=false) AND Google is its only remaining provider link,
   * removing it would strip every way to sign in. Refuse with 409 and tell the
   * user to set a password first (in-app, Privacy → Password) before unlinking.
   */
  app.post("/me/oauth/google/unlink", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) {
      reply.code(401);
      return { error: "not authenticated" };
    }
    const u = (await db
      .select({ hasPassword: users.hasPassword })
      .from(users)
      .where(eq(users.id, me.id))
      .limit(1))[0];
    if (!u) {
      reply.code(404);
      return { error: "no user" };
    }
    // Count the caller's other (non-google) provider links so we don't lock
    // them out by removing their last credential.
    const otherRow = (await db
      .select({ n: sql<number>`count(*)` })
      .from(oauthAccounts)
      .where(and(eq(oauthAccounts.userId, me.id), sql`${oauthAccounts.provider} != ${PROVIDER}`)))[0];
    const otherProviders = otherRow?.n ?? 0;
    if (!u.hasPassword && otherProviders === 0) {
      reply.code(409);
      return {
        error: "Set a password first (in your profile under Privacy → Password) before unlinking Google, or you'll be locked out.",
      };
    }
    await db
      .delete(oauthAccounts)
      .where(and(eq(oauthAccounts.userId, me.id), eq(oauthAccounts.provider, PROVIDER)));
    return { ok: true };
  });
}
