import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, ne, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { type Role, VERSION } from "@thekeep/shared";
import { serverMembers, sessions, users } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import { permissionsFor } from "../auth/permissions.js";
import { getSettings } from "../settings.js";
import { createEmailToken, consumeEmailToken } from "../email/tokens.js";
import { sendPasswordResetEmail, sendVerificationEmail } from "../email/templates.js";
import type { Db } from "../db/index.js";

/** Password-reset link validity. Short by design — these are sensitive. */
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
/** Email-verification link validity. Longer; less sensitive than reset. */
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Sessions are now bearer-token based, no cookie. The client stores
 * the token returned by /auth/login or /auth/register in sessionStorage
 * (per-tab, not per-browser) and sends it on every request as
 * `Authorization: Bearer <sid>`. The session row in SQLite is
 * unchanged; only the transport switched. This makes each tab an
 * independent login: two tabs can sign in as different accounts (or
 * the same account with different active characters) without
 * stomping each other.
 */

/**
 * Master usernames are login identifiers - they need to be unambiguous when
 * referenced in chat ("ban @admin") or moderation logs. We deliberately keep
 * them ASCII-only AFTER applying NFKC normalization so that:
 *   - full-width / half-width variants collapse ("ＡＤＭＩＮ" → "ADMIN")
 *   - full-Unicode-letter homograph attacks stay blocked (Cyrillic 'а'
 *     impersonating Latin 'a' to register `аdmin` is rejected)
 *
 * The allow-list itself is intentionally generous within ASCII: letters,
 * digits, a handful of common punctuation marks, and one specific
 * "invisible" character, U+00A0 (NBSP), the Alt+0160 keyboard trick.
 *
 * The punctuation is what people coming from phpMyChat / older chat
 * systems expect to be able to use in handles (backticks for leet-style
 * names, periods for "first.last", apostrophes for "O'Reilly").
 *
 * NBSP is the classic phpMyChat trick for "I want my name to read as
 * 'Two Words' but with no real space." Visually it looks like a space;
 * mechanically it's a non-breaking character that survives @mention
 * tokenization, URL routing, and JSON serialization without any of the
 * problems a real space would cause. Users on Windows type Alt+0160
 * (numpad) to enter it.
 *
 * Regular spaces are NOT allowed, they break @mention tokenization
 * (`@John Smith` would resolve only `@John`) and require URL encoding
 * (`/p/John%20Smith`) in every shareable link. NBSP gives the visual
 * illusion of a space without any of that breakage.
 *
 * Character names are NOT subject to this regex - they're display-only and
 * RP needs `Æthelred` / `Saorla` / `孫悟空` to be valid. Master usernames
 * stay trustworthy as identifiers; character names stay expressive.
 */
/* eslint-disable no-irregular-whitespace -- NBSP (U+00A0) is deliberately in the allow-list */
export const MASTER_USERNAME_RX = /^[a-zA-Z0-9_\-'.` ]{2,40}$/;
/* eslint-enable no-irregular-whitespace */
export const MASTER_USERNAME_RULE_MESSAGE =
  "username must be 2-40 chars: ASCII letters/numbers and _ - ' . ` plus NBSP (Alt+0160); regular spaces and Unicode confusables blocked";
export function normalizeMasterUsername(input: string): string {
  // NFC, not NFKC. NFKC's compatibility decomposition collapses NBSP
  // (U+00A0) into a regular space (U+0020), which then fails the regex
  // that only allows NBSP. NFC preserves NBSP while still composing
  // canonical sequences (e.g. `e` + combining-acute → `é` as a single
  // codepoint). The Unicode-confusables defense lives in the regex's
  // `[a-zA-Z0-9_\-'.` ]` allow-list, Cyrillic 'а' isn't in
  // [a-zA-Z], so NFKC's compatibility passes never gated that anyway.
  return input.normalize("NFC");
}

/**
 * Convert a username-shaped URL slug back to its canonical DB form.
 *
 * Master usernames allow NBSP (U+00A0) as an invisible "fake space"
 * separator. We deliberately present those as regular spaces (U+0020)
 * in shareable URLs so the address bar reads `/p/The Watcher` instead
 * of `/p/The%C2%A0Watcher`. Any handler that takes a name out of a URL
 * (or any HTTP param meant to identify a master account) runs the
 * incoming string through this helper before the DB lookup so the
 * round-trip works regardless of which form the caller used.
 *
 * Regular spaces are NOT a legal username character (see
 * MASTER_USERNAME_RX above), so the substitution is unambiguous,
 * there's no DB row that contains a literal U+0020.
 */
export function slugToUsername(slug: string): string {
  // Map regular space (U+0020) -> NBSP (U+00A0). Regular space is not a
  // legal username character, so the substitution is unambiguous and the
  // round-trip with the client-side `usernameToSlug` is exact.
  return slug.replace(/ /g, String.fromCharCode(0xA0));
}

const masterUsernameSchema = z
  .string()
  .min(2)
  .max(40)
  .transform((s) => normalizeMasterUsername(s))
  .refine((s) => MASTER_USERNAME_RX.test(s), {
    message: MASTER_USERNAME_RULE_MESSAGE,
  });

const credentialsSchema = z.object({
  email: z.string().email().max(200),
  username: masterUsernameSchema,
  password: z.string().min(8).max(200),
  /**
   * Defense-in-depth: the client only submits when the user ticks the
   * disclaimer checkbox, but a direct POST could bypass that. Require the
   * field server-side so any registration path proves acceptance. The
   * literal `true` rejects coerced/truthy values.
   */
  acceptDisclaimer: z.literal(true, {
    errorMap: () => ({ message: "you must accept the disclaimer to register" }),
  }),
  /**
   * Age + mature content acknowledgment. Combined into one field because the
   * UI presents them as a single statement: "I am 18 or older and understand
   * this site may contain mature content." Same literal-true posture as the
   * disclaimer above so a coerced truthy value can't slip through.
   */
  acceptAgeMature: z.literal(true, {
    errorMap: () => ({ message: "you must confirm you are 18+ and understand this site may contain mature content" }),
  }),
  /**
   * Captcha token issued by GET /auth/captcha. Single-use; the server
   * deletes the entry on validation, so a leaked token can't be replayed.
   */
  captchaId: z.string().min(1).max(64),
  captchaAnswer: z.string().min(1).max(16),
  /**
   * Honeypot. Real users never see this field (display:none in the form).
   * Bots that fill in every input post a value; we silently 400 them.
   */
  hp: z.string().max(200).optional(),
});

/**
 * In-memory captcha store. Single-use math challenges with a 5-minute TTL.
 *
 * We keep this in-memory deliberately - there's no value in persisting:
 *   - tokens are throwaway (one registration each), so durability is moot;
 *   - the 5-min window is short enough that a process restart just makes
 *     the user fetch a fresh challenge, which costs nothing;
 *   - persisting to SQLite would write/delete on every register attempt
 *     and add a janitor sweep for nothing.
 *
 * Bounded growth: each entry holds a tiny payload and self-expires; we also
 * sweep expired entries on every issue so the map can't bloat indefinitely
 * even under attack (the rate limiter caps the issue rate).
 */
const CAPTCHA_TTL_MS = 5 * 60 * 1000;
interface CaptchaEntry { answer: string; expiresAt: number }
const captchas = new Map<string, CaptchaEntry>();

function makeCaptcha(): { id: string; question: string } {
  // Single-digit addition - low friction for humans, just structured enough
  // to defeat naive form-fillers that don't run JS or read the question.
  const a = Math.floor(Math.random() * 9) + 1;
  const b = Math.floor(Math.random() * 9) + 1;
  const id = nanoid();
  // Opportunistic GC: drop expired entries when issuing new ones. Cheap
  // (the map is small) and avoids needing a separate sweep timer.
  const now = Date.now();
  for (const [k, v] of captchas) {
    if (v.expiresAt < now) captchas.delete(k);
  }
  captchas.set(id, { answer: String(a + b), expiresAt: now + CAPTCHA_TTL_MS });
  return { id, question: `What is ${a} + ${b}?` };
}

function consumeCaptcha(id: string, rawAnswer: string): boolean {
  const entry = captchas.get(id);
  if (!entry) return false;
  // Single-use: always delete, even on a wrong answer. Forces a fresh
  // fetch per attempt, which combines with the rate limiter to make
  // brute-forcing the answer space impractical.
  captchas.delete(id);
  if (entry.expiresAt < Date.now()) return false;
  return entry.answer === rawAnswer.trim();
}

export async function registerAuthRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // Tight per-IP throttles on the credential endpoints. /auth/register caps
  // at 5/minute (sustained signup attack mitigation); /auth/login caps at
  // 10/minute and bumps an extra 30s ban after 3 failures within the window
  // - handled implicitly by the plugin's bans option.
  const registerLimit = {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
  } as const;
  const loginLimit = {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  } as const;

  /**
   * Captcha issue endpoint. Public + cheap; rate-limited via the same
   * registerLimit bucket below would be too tight (a single mistyped
   * answer needs a fresh challenge), so we use a more lenient cap here.
   */
  app.get("/auth/captcha", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async () => {
    return makeCaptcha();
  });

  app.post<{ Body: unknown }>("/auth/register", registerLimit, async (req, reply) => {
    const settings = await getSettings(db);
    if (!settings.registrationOpen) {
      reply.code(503);
      return { error: "registration is closed" };
    }
    const body = credentialsSchema.parse(req.body);

    // Honeypot: real users never see the `hp` field (display:none on the
    // form). Bots that fill in every input get silently rejected with a
    // generic 400 so they can't tell they tripped the trap.
    if (body.hp && body.hp.trim().length > 0) {
      reply.code(400);
      return { error: "registration failed" };
    }

    // IP block: a banned user can't just register a burner account from the
    // same network to keep harassing. Checked early (before captcha + the DB
    // lookups). Honest-but-not-naming message so a shared-network bystander can
    // seek help without it confirming who was banned.
    {
      const { isIpBanned } = await import("../auth/ipBan.js");
      if (await isIpBanned(db, req.ip)) {
        reply.code(403);
        return { error: "Registration isn't available from your network right now." };
      }
    }

    // Captcha. Validated before the more expensive DB queries so a bad
    // answer doesn't cost us a username/email lookup.
    if (!consumeCaptcha(body.captchaId, body.captchaAnswer)) {
      reply.code(400);
      return { error: "captcha was wrong or expired - please try again" };
    }

    // Username + email cap checks. Both errors collapse to the same generic
    // message so an attacker can't probe whether a particular email is
    // registered (or how many accounts share it). The user has to retry with
    // a different combination if either side trips. Username + email are
    // checked together so the error wording stays consistent.
    const usernameTaken = (await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.username}) = ${body.username.toLowerCase()}`)
      .limit(1))[0];
    const emailCountRow = (await db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(sql`lower(${users.email}) = ${body.email.toLowerCase()}`))[0];
    const emailCount = emailCountRow?.n ?? 0;
    if (usernameTaken || emailCount >= settings.maxAccountsPerEmail) {
      reply.code(409);
      return { error: "registration conflict - try a different email or username" };
    }

    // Bootstrap: if there are no human accounts yet (only the `system`
    // sentinel exists), the first registrant becomes the keymaster admin.
    // This removes the manual SQL step that was previously needed to
    // unlock /admin and the moderation tools.
    const humanCountRow = (await db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(sql`${users.username} != 'system'`))[0];
    const isFirstUser = (humanCountRow?.n ?? 0) === 0;

    const id = nanoid();
    try {
      await db.insert(users).values({
        id,
        email: body.email,
        username: body.username,
        passwordHash: await hashPassword(body.password),
        // The bootstrap user gets `masteradmin` so they hold every
        // lever needed to configure a fresh install (branding,
        // settings, rules, role escalation). Subsequent users default
        // to plain `user` and are promoted by hand.
        role: isFirstUser ? "masteradmin" : "user",
        // Verified-on-create unless verification is enabled for a normal
        // signup. This way, flipping verification ON later only affects
        // accounts made AFTER the flip — nobody who registered while it was
        // off gets retroactively nagged, and the bootstrap admin is never
        // gated out of a fresh install.
        emailVerifiedAt: (settings.emailVerificationEnabled && !isFirstUser) ? null : new Date(),
        // Treat registration itself as the first login so the admin
        // panel's recent-registrations widget doesn't tag a user who
        // signed up + immediately started chatting (via the
        // post-register session token) as "never logged in", they
        // never hit POST /auth/login because they were already
        // authenticated by the issueSession call below, so without
        // this seed the column stayed null forever.
        lastLoginAt: new Date(),
      });
    } catch (err) {
      // Race: two simultaneous registrations for the same username slip past
      // the pre-check above. The unique index on lower(username) catches it
      // here. better-sqlite3 surfaces this as a SQLITE_CONSTRAINT_UNIQUE
      // error; we map it to the same friendly 409 the pre-check uses so
      // the user sees a consistent message regardless of which path tripped.
      const msg = err instanceof Error ? err.message : "";
      if (/UNIQUE|users_username_uq/i.test(msg)) {
        reply.code(409);
        return { error: "registration conflict - try a different email or username" };
      }
      throw err;
    }

    // Enroll every new account as an explicit member of the default server
    // (`server_spire_system`) so it owns an enumerable roster row. This is
    // PURELY additive and safe even with the servers feature OFF: access to the
    // default server already flows from serverAuthority's is_system implicit-
    // membership rule (a signed-in user is a member with NO row), so this writes
    // a management-enumeration convenience, never the access source of truth —
    // nothing reads it on the flag-off path. INSERT OR IGNORE keeps it
    // idempotent (re-runs / races are no-ops). The try/catch guards a fresh
    // install where ensureSystemServer hasn't run yet: a missing default server
    // (FK miss) must NEVER fail registration, so we swallow + log only.
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

    const sessionToken = await issueSession(db, id, req);
    const role: Role = isFirstUser ? "masteradmin" : "user";
    const permissions = await permissionsFor({ id, role }, db);
    // Email verification (admin-toggled). New accounts start unverified
    // (email_verified_at null). When enabled, send a confirmation link.
    // Fire-and-forget: a mail hiccup must never fail the signup — the
    // user can re-request from the verify banner. The bootstrap admin is
    // exempt (they can't lock themselves out of a fresh install).
    if (settings.emailVerificationEnabled && !isFirstUser) {
      try {
        const token = await createEmailToken(db, id, "email_verify", VERIFY_TTL_MS);
        void sendVerificationEmail(db, body.email, body.username, token);
      } catch (err) { req.log.error({ err }, "verification email send failed"); }
    }
    // Wire shape: `role` and `permissions` now always ride on the
    // register response (previously `role` was spread only on the
    // bootstrap path). The change is backwards compatible, older
    // clients that did `j.role ?? "user"` still work, but new
    // clients can rely on both fields being present so they don't
    // have to defensively re-derive permissions from the role tier.
    return {
      id,
      username: body.username,
      role,
      permissions,
      // Fresh signups always start non-incognito; mirror the same
      // wire shape /auth/me uses so the client can set me.incognitoMode
      // off the register response without a second probe.
      incognitoMode: false,
      incognitoAlias: null,
      incognitoCharacterId: null,
      // Unverified only when verification is on for a normal signup
      // (mirrors the insert above). Lets the client raise the verify
      // banner/gate straight off the register response.
      emailVerifiedAt: (settings.emailVerificationEnabled && !isFirstUser) ? null : Date.now(),
      // Carry the policy too so the gate shows immediately after sign-up.
      emailVerificationEnabled: settings.emailVerificationEnabled,
      emailVerificationMode: settings.emailVerificationMode,
      sessionToken,
      ...(isFirstUser ? { bootstrap: true } : {}),
    };
  });

  app.post<{ Body: unknown }>("/auth/login", loginLimit, async (req, reply) => {
    const body = z.object({
      identifier: z.string().min(1),
      password: z.string().min(1),
    }).parse(req.body);

    // IP block (global ban → IP block). A banned person can't sign into ANY
    // account (including alts) from a blocked network. Timed bans expire on
    // their own; an admin unban clears it. Distinguishable from a wrong-password
    // 401 so a shared-network bystander knows to seek help, not retype.
    {
      const { isIpBanned } = await import("../auth/ipBan.js");
      if (await isIpBanned(db, req.ip)) {
        reply.code(403);
        return { error: "Access from your network is currently restricted." };
      }
    }

    // NFKC-normalize the identifier so a user who types in a different Unicode
    // form (e.g. their phone autocompleted full-width letters) still finds
    // their stored ASCII username. Email side passes through unchanged.
    const lookupKey = normalizeMasterUsername(body.identifier).toLowerCase();
    const u = (await db
      .select()
      .from(users)
      .where(
        sql`lower(${users.email}) = ${lookupKey} OR lower(${users.username}) = ${lookupKey}`,
      )
      .limit(1))[0];

    if (!u) {
      reply.code(401);
      return { error: "invalid credentials" };
    }
    if (u.disabledAt) {
      // Lazily lift a TIMED ban that has lapsed so the user can sign back
      // in the instant it expires, without waiting for the periodic sweep.
      // A permanent ban (bannedUntil null) and a plain admin disable
      // (bannedAt null) both fall through to the rejection below.
      const banExpired = u.bannedAt != null && u.bannedUntil != null && +u.bannedUntil <= Date.now();
      if (banExpired) {
        await db
          .update(users)
          .set({ bannedAt: null, bannedUntil: null, banReason: null, bannedById: null, disabledAt: null })
          .where(eq(users.id, u.id));
      } else {
        reply.code(401);
        return { error: "invalid credentials" };
      }
    }
    const ok = await verifyPassword(u.passwordHash, body.password);
    if (!ok) {
      reply.code(401);
      return { error: "invalid credentials" };
    }
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, u.id));
    const sessionToken = await issueSession(db, u.id, req);
    const permissions = await permissionsFor({ id: u.id, role: u.role }, db);
    const settings = await getSettings(db);
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      permissions,
      // Incognito state survives logout, so a moderator who toggled
      // /incognito before signing out reappears as hidden on the
      // next login without having to re-toggle.
      incognitoMode: u.incognitoMode,
      incognitoAlias: u.incognitoAlias,
      incognitoCharacterId: u.incognitoCharacterId,
      emailVerifiedAt: u.emailVerifiedAt ? +u.emailVerifiedAt : null,
      // Mirror the verify policy on the login response so the nudge banner /
      // block gate can show the INSTANT the user signs in, instead of only
      // after the first /auth/me poll lands (which left them wandering /
      // trying to chat with no idea they needed to verify).
      emailVerificationEnabled: settings.emailVerificationEnabled,
      emailVerificationMode: settings.emailVerificationMode,
      sessionToken,
    };
  });

  app.post("/auth/logout", async (req) => {
    // Token is read off the Authorization header. We delete the row so
    // any other place this token might be cached (e.g. an inadvertently
    // shared sessionStorage via target=_blank link inheritance) stops
    // working immediately.
    const sid = readBearerToken(req);
    if (sid) await db.delete(sessions).where(eq(sessions.id, sid));
    return { ok: true };
  });

  // /auth/me is the silent-poll endpoint: 60s/tab and one initial probe on
  // page load. Per-IP cap of 60/min comfortably covers 5+ tabs while blocking
  // an attacker spamming it as a cheap DB-load amplifier.
  const meLimit = {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  } as const;
  app.get("/auth/me", meLimit, async (req, reply) => {
    const user = await getSessionUser(req, db);
    if (!user) {
      reply.code(401);
      return { error: "not authenticated" };
    }
    // Treat the silent-poll endpoint as a "last active" stamp so an
    // ongoing session keeps the `lastLoginAt` column fresh, without
    // this, a user who registered + chatted continuously via the
    // post-register session token would show as "never logged in"
    // forever because they never POST /auth/login. Gated to once per
    // 15 minutes so the 60s polling cadence (one per tab) doesn't
    // hammer the DB. Best-effort, failure is ignored, the next poll
    // tries again.
    try {
      const row = (await db
        .select({ lastLoginAt: users.lastLoginAt })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1))[0];
      const last = row?.lastLoginAt ? +row.lastLoginAt : 0;
      if (Date.now() - last > 15 * 60 * 1000) {
        await db
          .update(users)
          .set({ lastLoginAt: new Date() })
          .where(eq(users.id, user.id));
      }
    } catch { /* non-fatal, auth/me still succeeds */ }
    // `version` rides on every /auth/me poll so the client can detect a
    // post-deploy version drift. The web bundle stamps the build's
    // VERSION at compile time; after a deploy the running server reports
    // the new version while the user's still-loaded tab reports the old
    // one. The 60s poll cadence is fast enough that a fresh deploy
    // surfaces a "please refresh" hint within a minute.
    //
    // `updateMessage` is the short release note `remote-deploy.sh
    // --update-msg "..."` stages as the fly secret `UPDATE_MESSAGE`
    // each deploy. Surfaced on the same stale-version banner so users
    // see what changed before they hit Refresh. Empty/unset reads as
    // null on the wire and the banner renders the version lines alone.
    // Read on every request (not cached at boot) so a `flyctl secrets
    // set UPDATE_MESSAGE=...` outside a deploy script propagates on
    // the next poll without needing a restart.
    const rawUpdateMsg = process.env.UPDATE_MESSAGE ?? "";
    const updateMessage = rawUpdateMsg.trim().length > 0 ? rawUpdateMsg : null;
    // `permissions` is the resolved set the granular system answers
    // for this user, every key for masteradmin, role-grant ∪
    // user-override otherwise. Client mirrors gate UI on
    // `me.permissions.includes(...)` instead of `isAdminRole(me.role)`.
    // Refreshes on the same 60s poll, so a matrix edit lands on the
    // affected user's tab within a minute.
    const permissions = await permissionsFor({ id: user.id, role: user.role }, db);
    // Incognito mode + alias mirrored to the client so the chat
    // banner can show "You're incognito as <alias>" and the
    // ToolPanel button can flip between "Go Incognito" / "Leave
    // Incognito" without an extra round-trip.
    const incognitoRow = (await db
      .select({
        incognitoMode: users.incognitoMode,
        incognitoAlias: users.incognitoAlias,
        incognitoCharacterId: users.incognitoCharacterId,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1))[0];
    // Verification status + the site policy, mirrored so the client can
    // decide whether to show the verify banner (nudge) or gate chat
    // (block) without a second request. `emailVerified` is the resolved
    // boolean the UI keys on; the mode/enabled drive WHICH treatment.
    const settings = await getSettings(db);
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      permissions,
      incognitoMode: incognitoRow?.incognitoMode ?? false,
      incognitoAlias: incognitoRow?.incognitoAlias ?? null,
      incognitoCharacterId: incognitoRow?.incognitoCharacterId ?? null,
      emailVerifiedAt: incognitoRow?.emailVerifiedAt ? +incognitoRow.emailVerifiedAt : null,
      emailVerificationEnabled: settings.emailVerificationEnabled,
      emailVerificationMode: settings.emailVerificationMode,
      version: VERSION,
      updateMessage,
    };
  });

  // ---- Password reset ----------------------------------------------------
  // Request a reset link. ALWAYS returns a generic 200 so an attacker can't
  // probe which emails are registered. An email may back multiple accounts
  // (maxAccountsPerEmail); each gets its own link naming its username.
  const forgotLimit = { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } } as const;
  app.post<{ Body: unknown }>("/auth/forgot-password", forgotLimit, async (req) => {
    const body = z.object({ email: z.string().email().max(200) }).parse(req.body);
    const rows = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${body.email.toLowerCase()}`);
    for (const u of rows) {
      if (u.disabledAt) continue; // never mail a banned/disabled account
      try {
        const token = await createEmailToken(db, u.id, "password_reset", RESET_TTL_MS);
        void sendPasswordResetEmail(db, u.email, u.username, token);
      } catch (err) { req.log.error({ err }, "password reset email send failed"); }
    }
    return { ok: true };
  });

  // Redeem a reset link + set a new password. On success every existing
  // session for the account is revoked (force re-login everywhere).
  const resetLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } } as const;
  app.post<{ Body: unknown }>("/auth/reset-password", resetLimit, async (req, reply) => {
    const body = z.object({
      token: z.string().min(1),
      password: z.string().min(8).max(200),
    }).parse(req.body);
    const userId = await consumeEmailToken(db, body.token, "password_reset");
    if (!userId) {
      reply.code(400);
      return { error: "This reset link is invalid or has expired. Request a new one." };
    }
    await db.update(users).set({ passwordHash: await hashPassword(body.password), hasPassword: true }).where(eq(users.id, userId));
    await db.delete(sessions).where(eq(sessions.userId, userId));
    return { ok: true };
  });

  // In-app password management for the signed-in account. Two modes, decided by
  // whether the account already has a usable password:
  //   - has a password → CHANGE it; the current password must be re-entered and
  //     verified (so a walked-away session can't silently reset it).
  //   - OAuth-only (has_password=0) → SET a first password with no current one
  //     to prove (there is none). This closes the "lose your Google login and
  //     you're locked out of the account" gap.
  // On success every OTHER session is revoked (a leaked session shouldn't
  // outlive a password change) while the caller's own session is kept so they
  // stay signed in on this device.
  const passwordLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } } as const;
  app.post<{ Body: unknown }>("/me/password", passwordLimit, async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "not authenticated" }; }
    const body = z.object({
      currentPassword: z.string().max(200).optional(),
      newPassword: z.string().min(8).max(200),
    }).parse(req.body);
    const u = (await db
      .select({ passwordHash: users.passwordHash, hasPassword: users.hasPassword })
      .from(users)
      .where(eq(users.id, me.id))
      .limit(1))[0];
    if (!u) { reply.code(404); return { error: "no user" }; }
    if (u.hasPassword) {
      if (!body.currentPassword) {
        reply.code(400);
        return { error: "Enter your current password." };
      }
      if (!(await verifyPassword(u.passwordHash, body.currentPassword))) {
        reply.code(400);
        return { error: "Your current password is incorrect." };
      }
    }
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(body.newPassword), hasPassword: true })
      .where(eq(users.id, me.id));
    // Keep this session, drop the rest.
    const currentSid = readBearerToken(req);
    if (currentSid) {
      await db.delete(sessions).where(and(eq(sessions.userId, me.id), ne(sessions.id, currentSid)));
    } else {
      await db.delete(sessions).where(eq(sessions.userId, me.id));
    }
    return { ok: true };
  });

  // Does the signed-in account have a usable local password? Drives the profile
  // Security section (Change vs Set a password). Deliberately NOT gated on
  // Google being enabled, so a password user can always reach Change Password.
  app.get("/me/password-status", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "not authenticated" }; }
    const u = (await db
      .select({ hasPassword: users.hasPassword })
      .from(users)
      .where(eq(users.id, me.id))
      .limit(1))[0];
    if (!u) { reply.code(404); return { error: "no user" }; }
    return { hasPassword: !!u.hasPassword };
  });

  // ---- Email verification ------------------------------------------------
  // Confirm an email via the link token. Idempotent-ish: a used/expired
  // token reads as invalid, but an already-verified account simply re-marks.
  app.post<{ Body: unknown }>("/auth/verify-email", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = z.object({ token: z.string().min(1) }).parse(req.body);
    const userId = await consumeEmailToken(db, body.token, "email_verify");
    if (!userId) {
      reply.code(400);
      return { error: "This confirmation link is invalid or has expired." };
    }
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId));
    return { ok: true };
  });

  // Re-send the verification email to the signed-in user (from the nudge
  // banner / block gate). Tight rate limit to prevent mail abuse.
  app.post("/auth/resend-verification", { config: { rateLimit: { max: 3, timeWindow: "5 minutes" } } }, async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "not authenticated" }; }
    const settings = await getSettings(db);
    if (!settings.emailVerificationEnabled) { reply.code(400); return { error: "verification is not enabled" }; }
    const row = (await db.select().from(users).where(eq(users.id, me.id)).limit(1))[0];
    if (!row) { reply.code(404); return { error: "no user" }; }
    if (row.emailVerifiedAt) return { ok: true, alreadyVerified: true };
    try {
      const token = await createEmailToken(db, row.id, "email_verify", VERIFY_TTL_MS);
      void sendVerificationEmail(db, row.email, row.username, token);
    } catch (err) { req.log.error({ err }, "resend verification email failed"); }
    return { ok: true };
  });
}

export async function issueSession(
  db: Db,
  userId: string,
  req: FastifyRequest,
): Promise<string> {
  const id = nanoid(40);
  // Read TTL from admin-managed site settings. The value is now interpreted
  // as the *idle* window - sliding-extended on every authenticated socket
  // event in `extendSession` - but the initial expiresAt is still seeded
  // here so a brand-new session has a valid horizon.
  const { sessionTtlMs } = await getSettings(db);
  const expiresAt = new Date(Date.now() + sessionTtlMs);
  await db.insert(sessions).values({
    id,
    userId,
    expiresAt,
    userAgent: req.headers["user-agent"] ?? null,
    ip: req.ip,
  });
  return id;
}

/**
 * Pull the session id out of an `Authorization: Bearer <sid>` header.
 * Case-insensitive on the scheme so a sloppy client still works; the
 * token itself is opaque (the `sessions.id` nanoid) and case-sensitive.
 * Returns null when the header is missing or malformed, never throws,
 * so callers can use it inline.
 */
export function readBearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const tok = m[1]!.trim();
  return tok.length > 0 ? tok : null;
}

export async function getSessionUser(
  req: FastifyRequest,
  db: Db,
): Promise<{ id: string; username: string; role: Role; activeCharacterId: string | null } | null> {
  const sid = readBearerToken(req);
  if (!sid) return null;
  const row = (await db.select().from(sessions).where(eq(sessions.id, sid)).limit(1))[0];
  if (!row || +row.expiresAt < Date.now()) {
    if (row) await db.delete(sessions).where(eq(sessions.id, sid));
    return null;
  }
  const u = (await db.select().from(users).where(eq(users.id, row.userId)).limit(1))[0];
  if (!u || u.disabledAt) return null;
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    // Surfacing the currently-voiced character so HTTP routes that
    // act per-identity (world join/apply, etc.) can branch without
    // a second DB hit. Per-tab socket overrides keep this DB column
    // synced on identity switches; HTTP requests reflect whatever
    // the last socket sync wrote.
    activeCharacterId: u.activeCharacterId,
  };
}

/** Look up the userId for a session id (used by the websocket auth handshake). */
export async function userIdFromSessionId(db: Db, sid: string): Promise<string | null> {
  const row = (await db.select().from(sessions).where(eq(sessions.id, sid)).limit(1))[0];
  if (!row || +row.expiresAt < Date.now()) return null;
  return row.userId;
}

