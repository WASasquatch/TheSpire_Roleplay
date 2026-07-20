import "./helpers/env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { maybeSendServerJoinWelcome, renderWelcomeTemplate } from "../src/realtime/serverWelcome.js";
import { invalidateServerSettings } from "../src/settings.js";
import { makeTestDb } from "./helpers/harness.js";

/**
 * First-join welcome (migration 0366): the in-chat replacement for the old
 * first-words notification. Verifies the once-ever-per-(user, server) claim,
 * the per-server off switch (which must NOT consume the claim), and custom
 * template rendering. Posting is asserted against the persisted `messages`
 * rows, so the io mock only needs the `to().emit()` addSystemMessage reaches.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const io: any = { to: () => ({ emit() { /* no-op */ } }), async fetchSockets() { return []; }, emit() { /* no-op */ } };

async function seed(db: Db) {
  const sysId = nanoid();
  await db.insert(schema.users).values({ id: sysId, username: "system", email: "system@test.local", passwordHash: "x", role: "user" });
  const uid = nanoid();
  await db.insert(schema.users).values({ id: uid, username: "erin", email: "erin@test.local", passwordHash: "x", role: "user" });
  const serverId = nanoid();
  await db.insert(schema.servers).values({
    id: serverId, slug: `srv-${serverId.slice(0, 8)}`.toLowerCase(), name: "The Spire",
    ownerUserId: sysId, isSystem: false, isDefault: false, status: "active", visibility: "public", joinMode: "open",
  });
  const roomId = nanoid();
  await db.insert(schema.rooms).values({ id: roomId, name: "General", slug: `general-${roomId.slice(0, 6)}`, type: "public", serverId });
  invalidateServerSettings();
  return { sysId, uid, serverId, roomId };
}

async function sysMessages(db: Db, roomId: string) {
  return db.select().from(schema.messages)
    .where(and(eq(schema.messages.roomId, roomId), eq(schema.messages.kind, "system")));
}

describe("renderWelcomeTemplate", () => {
  test("substitutes {user} and {server}, case-insensitive and repeatable", () => {
    assert.equal(
      renderWelcomeTemplate("Welcome {user} to {server}! {USER} joined {Server}.", { user: "Erin", server: "The Spire" }),
      "Welcome Erin to The Spire! Erin joined The Spire.",
    );
  });
});

describe("maybeSendServerJoinWelcome", () => {
  test("posts once ever per (user, server); a second call is silent", async () => {
    const { db } = makeTestDb();
    const { uid, serverId, roomId } = await seed(db);
    await maybeSendServerJoinWelcome(io, db, { userId: uid, serverId, roomId, displayName: "Erin" });
    let msgs = await sysMessages(db, roomId);
    assert.equal(msgs.length, 1, "first appearance posts a welcome");
    assert.match(msgs[0]!.body, /Welcome Erin to The Spire!/);
    await maybeSendServerJoinWelcome(io, db, { userId: uid, serverId, roomId, displayName: "Erin" });
    msgs = await sysMessages(db, roomId);
    assert.equal(msgs.length, 1, "an already-welcomed member is never greeted again");
  });

  test("the per-server off switch suppresses it WITHOUT consuming the claim", async () => {
    const { db } = makeTestDb();
    const { uid, serverId, roomId } = await seed(db);
    await db.insert(schema.serverSettings).values({ serverId, joinWelcomeEnabled: false });
    invalidateServerSettings();
    await maybeSendServerJoinWelcome(io, db, { userId: uid, serverId, roomId, displayName: "Erin" });
    assert.equal((await sysMessages(db, roomId)).length, 0, "disabled server posts nothing");
    const claims = await db.select().from(schema.serverWelcomes).where(eq(schema.serverWelcomes.serverId, serverId));
    assert.equal(claims.length, 0, "off switch leaves the once-ever claim unspent so a later enable still greets");
  });

  test("a custom template with placeholders is used verbatim", async () => {
    const { db } = makeTestDb();
    const { uid, serverId, roomId } = await seed(db);
    await db.insert(schema.serverSettings).values({ serverId, joinWelcomeTemplate: "{server} says hi to {user}!" });
    invalidateServerSettings();
    await maybeSendServerJoinWelcome(io, db, { userId: uid, serverId, roomId, displayName: "Erin" });
    const msgs = await sysMessages(db, roomId);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]!.body, "The Spire says hi to Erin!");
  });
});
