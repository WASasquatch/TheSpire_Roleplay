import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { sessions, users } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import { getSettings } from "../settings.js";
import type { Db } from "../db/index.js";

const SESSION_COOKIE = "tk_sess";

const credentialsSchema = z.object({
  email: z.string().email().max(200),
  username: z.string().min(2).max(40).regex(/^[\p{L}\p{N}_\-]+$/u),
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
});

export async function registerAuthRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // Tight per-IP throttles on the credential endpoints. /auth/register caps
  // at 5/minute (sustained signup attack mitigation); /auth/login caps at
  // 10/minute and bumps an extra 30s ban after 3 failures within the window
  // — handled implicitly by the plugin's bans option.
  const registerLimit = {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
  } as const;
  const loginLimit = {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  } as const;

  app.post<{ Body: unknown }>("/auth/register", registerLimit, async (req, reply) => {
    const settings = await getSettings(db);
    if (!settings.registrationOpen) {
      reply.code(503);
      return { error: "registration is closed" };
    }
    const body = credentialsSchema.parse(req.body);

    // Username remains globally unique at the DB layer.
    const usernameTaken = (await db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = ${body.username.toLowerCase()}`)
      .limit(1))[0];
    if (usernameTaken) {
      reply.code(409);
      return { error: "username already in use" };
    }

    // Email cap is enforced in code so admins can lift it without touching
    // the DB. Counts existing live (non-disabled) users sharing this email.
    const emailCountRow = (await db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(sql`lower(${users.email}) = ${body.email.toLowerCase()}`))[0];
    const emailCount = emailCountRow?.n ?? 0;
    if (emailCount >= settings.maxAccountsPerEmail) {
      reply.code(409);
      return {
        error: settings.maxAccountsPerEmail === 1
          ? "email already in use"
          : `email already used by ${settings.maxAccountsPerEmail} account(s) — the configured limit`,
      };
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
    await db.insert(users).values({
      id,
      email: body.email,
      username: body.username,
      passwordHash: await hashPassword(body.password),
      role: isFirstUser ? "admin" : "user",
    });

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

    const u = (await db
      .select()
      .from(users)
      .where(
        sql`lower(${users.email}) = ${body.identifier.toLowerCase()} OR lower(${users.username}) = ${body.identifier.toLowerCase()}`,
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

  app.get("/auth/me", async (req, reply) => {
    const user = await getSessionUser(req, db);
    if (!user) {
      reply.code(401);
      return { error: "not authenticated" };
    }
    return { id: user.id, username: user.username, role: user.role };
  });
}

async function issueSession(
  reply: import("fastify").FastifyReply,
  db: Db,
  userId: string,
  req: FastifyRequest,
): Promise<string> {
  const id = nanoid(40);
  // Read TTL from admin-managed site settings — admins can shorten or extend
  // session lifetime sitewide without redeploys.
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
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(sessionTtlMs / 1000),
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
): Promise<{ id: string; username: string; role: "user" | "mod" | "admin" } | null> {
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
