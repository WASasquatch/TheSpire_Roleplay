import "./helpers/env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { expireIfEmpty, findServerLanding } from "../src/realtime/broadcast/presence.js";
import { createUser, makeTestDb } from "./helpers/harness.js";

/**
 * Server FRONT DOOR lifecycle (the "Enter boots me back to the Spire"
 * report): a community's default room must never auto-park, and the
 * landing resolver must never hand out a dead room id — a parked landing
 * 404'd every visitor's join, global staff included.
 */

/** io stand-in for expireIfEmpty: no sockets anywhere, swallow emits. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const io: any = {
  in() { return { async fetchSockets() { return []; } }; },
  to() { return { emit() {} }; },
  async fetchSockets() { return []; },
  emit() {},
};

async function mkServer(db: Db, ownerId: string): Promise<string> {
  const id = nanoid();
  await db.insert(schema.servers).values({
    id, slug: `srv-${id.slice(0, 6)}`.toLowerCase(), name: "Test Server",
    ownerUserId: ownerId, isSystem: false, isDefault: false,
    status: "active", visibility: "public", joinMode: "open",
  });
  return id;
}

async function mkRoom(db: Db, ownerId: string, serverId: string, opts: {
  name: string; isDefault?: boolean; isSystem?: boolean; archivedAt?: Date;
}): Promise<string> {
  const id = nanoid();
  await db.insert(schema.rooms).values({
    id, name: opts.name, slug: opts.name.toLowerCase(), type: "public",
    ownerId, serverId,
    ...(opts.isDefault ? { isDefault: true } : {}),
    ...(opts.isSystem ? { isSystem: true } : {}),
    ...(opts.archivedAt ? { archivedAt: opts.archivedAt } : {}),
  });
  return id;
}

describe("server front door", () => {
  test("a server's default room never auto-parks on emptiness", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const serverId = await mkServer(db, owner.id);
    const landing = await mkRoom(db, owner.id, serverId, { name: "welcome", isDefault: true });
    assert.equal(await expireIfEmpty(io, db, landing), false, "default rooms are server structure");
    const row = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, landing)).limit(1))[0]!;
    assert.equal(row.archivedAt, null);
  });

  test("findServerLanding: archived default still resolves (for the visit heal); fallbacks must be live", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const serverId = await mkServer(db, owner.id);
    // Pre-fix data shape: the only default room got auto-parked.
    const parkedDefault = await mkRoom(db, owner.id, serverId, {
      name: "welcome2", isDefault: true, archivedAt: new Date(),
    });
    const landing = await findServerLanding(db, serverId);
    assert.equal(landing?.id, parkedDefault, "archived DEFAULT is returned so /visit can heal it");

    // Without a default: an archived system room must be skipped in favor
    // of any LIVE public room.
    const serverB = await mkServer(db, owner.id);
    await mkRoom(db, owner.id, serverB, { name: "sys-parked", isSystem: true, archivedAt: new Date() });
    const liveRoom = await mkRoom(db, owner.id, serverB, { name: "alive" });
    const landingB = await findServerLanding(db, serverB);
    assert.equal(landingB?.id, liveRoom, "dead fallbacks are never handed out");
  });
});
