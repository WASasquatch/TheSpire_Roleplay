import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Role } from "@thekeep/shared";
import { sessions, users } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import { getSettings } from "../settings.js";
import type { Db } from "../db/index.js";

const SESSION_COOKIE = "tk_sess";

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
 * "invisible" character — U+00A0 (NBSP), the Alt+0160 keyboard trick.
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
 * Regular spaces are NOT allowed — they break @mention tokenization
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
  return input.normalize("NFKC");
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
        role: isFirstUser ? "admin" : "user",
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

    await issueSession(reply, db, id, req);
    return {
      id,
      username: body.username,
      ...(isFirstUser ? { role: "admin", bootstrap: true } : {}),
    };
  });

  app.post<{ Body: unknown }>("/auth/login", loginLimit, async (req, reply) => {
    const body = z.object({
      identifier: z.string().min(1),
      password: z.string().min(1),
    }).parse(req.body);

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

    if (!u || u.disabledAt) {
      reply.code(401);
      return { error: "invalid credentials" };
    }
    const ok = await verifyPassword(u.passwordHash, body.password);
    if (!ok) {
      reply.code(401);
      return { error: "invalid credentials" };
    }
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, u.id));
    await issueSession(reply, db, u.id, req);
    return { id: u.id, username: u.username, role: u.role };
  });

  app.post("/auth/logout", async (req, reply) => {
    const sid = readSessionCookie(req);
    if (sid) await db.delete(sessions).where(eq(sessions.id, sid));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
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
    return { id: user.id, username: user.username, role: user.role };
  });
}

/**
 * Hard upper bound on the cookie's lifetime in the browser. Decoupled from
 * the admin-configured idle timeout: the cookie just stores a session id, so
 * if the underlying row has been swept the cookie is already worthless even
 * if the browser still has it. A long cookie life means an admin shortening
 * the idle timeout doesn't drop active users mid-session due to the browser
 * discarding the cookie before the server-side row would have expired.
 */
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

async function issueSession(
  reply: import("fastify").FastifyReply,
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
  reply.setCookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    // Default: secure only in production (where same-origin = HTTPS by
    // construction). Override with FORCE_SECURE_COOKIES=true when proxying
    // dev through ngrok / Cloudflare Tunnel / any HTTPS frontend - without
    // this, the session cookie travels in plaintext over HTTP between the
    // tunnel terminator and Fastify on localhost.
    secure: process.env.FORCE_SECURE_COOKIES === "true" || process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  return id;
}

function readSessionCookie(req: FastifyRequest): string | null {
  const raw = req.cookies?.[SESSION_COOKIE];
  return raw ?? null;
}

export async function getSessionUser(
  req: FastifyRequest,
  db: Db,
): Promise<{ id: string; username: string; role: Role } | null> {
  const sid = readSessionCookie(req);
  if (!sid) return null;
  const row = (await db.select().from(sessions).where(eq(sessions.id, sid)).limit(1))[0];
  if (!row || +row.expiresAt < Date.now()) {
    if (row) await db.delete(sessions).where(eq(sessions.id, sid));
    return null;
  }
  const u = (await db.select().from(users).where(eq(users.id, row.userId)).limit(1))[0];
  if (!u || u.disabledAt) return null;
  return { id: u.id, username: u.username, role: u.role };
}

/** Look up the userId for a session id (used by the websocket auth handshake). */
export async function userIdFromSessionId(db: Db, sid: string): Promise<string | null> {
  const row = (await db.select().from(sessions).where(eq(sessions.id, sid)).limit(1))[0];
  if (!row || +row.expiresAt < Date.now()) return null;
  return row.userId;
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
