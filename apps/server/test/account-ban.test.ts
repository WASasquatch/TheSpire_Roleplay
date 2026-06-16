import "./helpers/env.js"; // MUST be first - sets SQLITE_PATH before the db singleton loads
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { auth, buildUsersApp, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Account-ban lifecycle + permission gates over the real `routes/users.ts`
 * handlers. This is the seed suite for the route harness; the invariants here
 * (who may ban, that a ban blocks auth, that unban + expiry restore access,
 * and that the review endpoint reports correctly) are exactly the kind that
 * TypeScript can't catch and that a grant-migration refactor could silently
 * break.
 */
describe("account ban", () => {
  let db: Db;
  let raw: ReturnType<typeof makeTestDb>["raw"];
  let app: FastifyInstance;

  before(async () => {
    ({ db, raw } = makeTestDb());
    app = await buildUsersApp(db);
  });
  after(async () => {
    await app.close();
    raw.close();
  });

  // Fresh users per test so ids/usernames never collide. (The DB persists
  // across tests in this file; we just create new principals each time.)
  beforeEach(() => { /* no-op: factories generate unique ids */ });

  async function ban(token: string, targetId: string, body: unknown) {
    return app.inject({
      method: "POST",
      url: `/users/${targetId}/ban`,
      headers: { ...auth(token), "content-type": "application/json" },
      payload: body as object,
    });
  }
  async function unban(token: string, targetId: string) {
    return app.inject({
      method: "POST",
      url: `/users/${targetId}/unban`,
      headers: { ...auth(token), "content-type": "application/json" },
      payload: {},
    });
  }
  async function moderation(token: string, targetId: string) {
    return app.inject({ method: "GET", url: `/users/${targetId}/moderation`, headers: auth(token) });
  }

  test("a mod can ban a regular user; it sets ban + disable columns", async () => {
    const mod = await createUser(db, { role: "mod" });
    const target = await createUser(db, { role: "user" });
    const modTok = await tokenFor(db, mod.id);

    const res = await ban(modTok, target.id, { durationMs: 24 * 60 * 60 * 1000, reason: "ad spam" });
    assert.equal(res.statusCode, 200);

    const row = (await db.select().from(users).where(eq(users.id, target.id)).limit(1))[0]!;
    assert.ok(row.bannedAt, "bannedAt set");
    assert.ok(row.bannedUntil, "bannedUntil set (timed ban)");
    assert.equal(row.banReason, "ad spam");
    assert.equal(row.bannedById, mod.id);
    assert.ok(row.disabledAt, "disabledAt set so existing login/chat gates block");
  });

  test("a banned account fails authentication (disabled gate)", async () => {
    const mod = await createUser(db, { role: "mod" });
    const target = await createUser(db, { role: "user" });
    const modTok = await tokenFor(db, mod.id);

    await ban(modTok, target.id, { durationMs: 1000, reason: "x" });

    // Even a freshly-minted session for the now-disabled account is rejected
    // by getSessionUser (401), proving the ban actually blocks access.
    const targetTok = await tokenFor(db, target.id);
    const res = await moderation(targetTok, target.id);
    assert.equal(res.statusCode, 401);
  });

  test("a regular user cannot ban anyone (missing permission)", async () => {
    const actor = await createUser(db, { role: "user" });
    const target = await createUser(db, { role: "user" });
    const actorTok = await tokenFor(db, actor.id);

    const res = await ban(actorTok, target.id, { durationMs: 1000, reason: "nope" });
    assert.equal(res.statusCode, 403);
  });

  test("a mod cannot ban a peer or someone who outranks them", async () => {
    const mod = await createUser(db, { role: "mod" });
    const peer = await createUser(db, { role: "mod" });
    const admin = await createUser(db, { role: "admin" });
    const modTok = await tokenFor(db, mod.id);

    const peerRes = await ban(modTok, peer.id, { durationMs: 1000, reason: "peer" });
    assert.equal(peerRes.statusCode, 403, "cannot ban a peer mod");
    const adminRes = await ban(modTok, admin.id, { durationMs: 1000, reason: "up" });
    assert.equal(adminRes.statusCode, 403, "cannot ban someone who outranks you");
  });

  test("reason is required and bounded", async () => {
    const mod = await createUser(db, { role: "mod" });
    const target = await createUser(db, { role: "user" });
    const modTok = await tokenFor(db, mod.id);

    const empty = await ban(modTok, target.id, { durationMs: 1000, reason: "   " });
    assert.equal(empty.statusCode, 400, "blank reason rejected");
    const missing = await ban(modTok, target.id, { durationMs: 1000 });
    assert.equal(missing.statusCode, 400, "missing reason rejected");
  });

  test("a permanent ban stores no expiry", async () => {
    const admin = await createUser(db, { role: "admin" });
    const target = await createUser(db, { role: "user" });
    const adminTok = await tokenFor(db, admin.id);

    const res = await ban(adminTok, target.id, { durationMs: null, reason: "permanent" });
    assert.equal(res.statusCode, 200);
    const row = (await db.select().from(users).where(eq(users.id, target.id)).limit(1))[0]!;
    assert.ok(row.bannedAt, "bannedAt set");
    assert.equal(row.bannedUntil, null, "permanent ban has no until");
  });

  test("unban clears the ban + disable columns", async () => {
    const mod = await createUser(db, { role: "mod" });
    const target = await createUser(db, { role: "user" });
    const modTok = await tokenFor(db, mod.id);

    await ban(modTok, target.id, { durationMs: 1000, reason: "temp" });
    const res = await unban(modTok, target.id);
    assert.equal(res.statusCode, 200);

    const row = (await db.select().from(users).where(eq(users.id, target.id)).limit(1))[0]!;
    assert.equal(row.bannedAt, null);
    assert.equal(row.bannedUntil, null);
    assert.equal(row.banReason, null);
    assert.equal(row.disabledAt, null, "disable cleared so the account works again");

    // A fresh session for the unbanned user now authenticates: the moderation
    // route returns 403 (auth OK, lacks ban_account) rather than 401 (disabled).
    const targetTok = await tokenFor(db, target.id);
    const after = await moderation(targetTok, target.id);
    assert.equal(after.statusCode, 403);
  });

  test("the moderation endpoint reports current ban + history to mods", async () => {
    const mod = await createUser(db, { role: "mod" });
    const target = await createUser(db, { role: "user" });
    const modTok = await tokenFor(db, mod.id);

    await ban(modTok, target.id, { durationMs: 24 * 60 * 60 * 1000, reason: "harassment" });
    const res = await moderation(modTok, target.id);
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      ban: { reason: string | null; by: string | null } | null;
      history: Array<{ action: string; reason: string | null }>;
    };
    assert.ok(body.ban, "active ban reported");
    assert.equal(body.ban!.reason, "harassment");
    assert.equal(body.ban!.by, mod.username);
    assert.ok(body.history.length >= 1, "history has the ban entry");
    assert.equal(body.history[0]!.action, "account_ban");
  });

  test("an expired timed ban reads as inactive (auto-lift semantics)", async () => {
    const mod = await createUser(db, { role: "mod" });
    const target = await createUser(db, { role: "user" });
    const modTok = await tokenFor(db, mod.id);

    await ban(modTok, target.id, { durationMs: 60_000, reason: "short" });
    // Fast-forward the expiry into the past (the sweep / login lazy-lift do
    // this for real; here we assert the review endpoint's active computation).
    await db.update(users).set({ bannedUntil: new Date(Date.now() - 1000) }).where(eq(users.id, target.id));

    const res = await moderation(modTok, target.id);
    assert.equal(res.statusCode, 200);
    const body = res.json() as { ban: unknown | null };
    assert.equal(body.ban, null, "expired ban is not reported as active");
  });

  test("a non-mod cannot read the moderation endpoint", async () => {
    const actor = await createUser(db, { role: "user" });
    const target = await createUser(db, { role: "user" });
    const actorTok = await tokenFor(db, actor.id);

    const res = await moderation(actorTok, target.id);
    assert.equal(res.statusCode, 403);
  });
});
