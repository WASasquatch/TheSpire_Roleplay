/**
 * Route-test harness: a hermetic in-memory DB with every migration applied,
 * a minimal Fastify app with the real route handlers mounted, and factories
 * for users + bearer sessions.
 *
 * Auth model (see routes/auth.ts `getSessionUser`): a request is
 * authenticated by an `Authorization: Bearer <sessionId>` header that resolves
 * a row in the `sessions` table. Tests mint sessions directly rather than
 * going through `/auth/login`, so they don't depend on password hashing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { Role } from "@thekeep/shared";
import * as schema from "../../src/db/schema.js";
import type { Db } from "../../src/db/index.js";
import { registerUsersRoutes } from "../../src/routes/users.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = resolve(HERE, "../../drizzle");

/**
 * Fresh in-memory DB with the full migration set applied, replicating
 * `scripts/apply-migrations.mjs`: read every `.sql` in `drizzle/` in name
 * order and exec each statement (split on the `--> statement-breakpoint`
 * marker). FK enforcement is enabled AFTER the migrations run, matching the
 * applier (which runs with SQLite's default FK-off) so cross-table seed
 * ordering inside a migration can't trip the suite.
 */
export function makeTestDb(): { db: Db; raw: Database.Database } {
  const raw = new Database(":memory:");
  const files = readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = readFileSync(resolve(DRIZZLE_DIR, file), "utf8");
    const stmts = sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    for (const stmt of stmts) raw.exec(stmt);
  }
  raw.pragma("foreign_keys = ON");
  const db = drizzle(raw, { schema }) as unknown as Db;
  return { db, raw };
}

/** Minimal socket.io stand-in: the only method the routes under test reach
 *  (via forceLogoutUser) is `fetchSockets`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockIo: any = { fetchSockets: async () => [] };

/** Build a Fastify app with the real users routes mounted against `db`.
 *  Replicates the production app's global ZodError→400 handler (index.ts),
 *  which the route handlers rely on, their `schema.parse(req.body)` calls
 *  throw a ZodError on bad input and depend on this mapping to return 400
 *  instead of bubbling up as a 500. */
export async function buildUsersApp(db: Db): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      reply.code(400);
      return reply.send({
        error: "validation",
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    throw err;
  });
  await registerUsersRoutes(app, db, mockIo);
  await app.ready();
  return app;
}

/** Insert a user. Provides the NOT-NULL-without-default columns
 *  (id/email/username/passwordHash); everything else takes its schema default. */
export async function createUser(
  db: Db,
  opts: { role?: Role; username?: string; disabledAt?: Date | null } = {},
): Promise<{ id: string; username: string; role: Role }> {
  const id = nanoid();
  const username = opts.username ?? `u_${id.slice(0, 8)}`;
  const role: Role = opts.role ?? "user";
  await db.insert(schema.users).values({
    id,
    username,
    email: `${username}@test.local`,
    passwordHash: "x",
    role,
    ...(opts.disabledAt !== undefined ? { disabledAt: opts.disabledAt } : {}),
  });
  return { id, username, role };
}

/** Mint a session row and return its id (the bearer token). */
export async function tokenFor(db: Db, userId: string): Promise<string> {
  const sid = nanoid();
  await db.insert(schema.sessions).values({
    id: sid,
    userId,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return sid;
}

/** Authorization header for a bearer token. */
export function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}
