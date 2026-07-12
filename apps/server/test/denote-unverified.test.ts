import "./helpers/env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { lookupProfile } from "../src/commands/builtins/profile.js";
import { currentOccupants } from "../src/realtime/broadcast.js";
import { ensureSiteSettings, updateSettings } from "../src/settings.js";
import { createUser, makeTestDb } from "./helpers/harness.js";

/**
 * Denote-unverified-users (migration 0353): the admin toggle that puts a
 * subtle "Unverified" marker on accounts with no email_verified_at. Pinned
 * here: the flag rides the occupant/profile wire ONLY while the setting is
 * on (no wire noise when off), and verified/backfilled accounts never carry
 * it (migration 0257 backfilled email_verified_at = created_at for every
 * pre-existing account).
 */

type RoomRow = typeof schema.rooms.$inferSelect;

async function mkRoom(db: Db, ownerId: string): Promise<RoomRow> {
  const id = nanoid();
  await db.insert(schema.rooms).values({ id, name: `denote-room-${id.slice(0, 6)}`, type: "public", ownerId });
  return (await db.select().from(schema.rooms).where(eq(schema.rooms.id, id)).limit(1))[0]!;
}

/** io stub: the named room band holds one fake socket per occupant userId. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ioWithOccupants(roomId: string, userIds: string[]): any {
  return {
    async fetchSockets() { return []; },
    in(band: string) {
      const socks = band === `room:${roomId}`
        ? userIds.map((userId) => ({ data: { userId }, emit() {} }))
        : [];
      return { async fetchSockets() { return socks; }, emit() {} };
    },
    to() { return { emit() {} }; },
    emit() {},
  };
}

describe("denote unverified users", () => {
  test("profile payload: flag present ONLY when the setting is on AND the account is unverified", async () => {
    const { db } = makeTestDb();
    await ensureSiteSettings(db);
    const admin = await createUser(db, { role: "masteradmin" });
    const ghost = await createUser(db); // emailVerifiedAt NULL (unverified)
    const legacy = await createUser(db);
    // The migration-0257 backfill shape: legacy accounts read verified.
    await db.update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, legacy.id));

    // Setting OFF (default): no wire noise for anyone.
    let view = await lookupProfile(db, ghost.username);
    assert.ok(view && view.kind === "master");
    assert.equal((view.profile as { unverified?: boolean }).unverified, undefined, "flag absent while the toggle is off");

    // Setting ON: unverified accounts carry the flag...
    await updateSettings(db, { denoteUnverifiedUsers: true }, admin.id);
    view = await lookupProfile(db, ghost.username);
    assert.ok(view && view.kind === "master");
    assert.equal((view.profile as { unverified?: boolean }).unverified, true);

    // ...but verified / backfilled accounts never do.
    const legacyView = await lookupProfile(db, legacy.username);
    assert.ok(legacyView && legacyView.kind === "master");
    assert.equal((legacyView.profile as { unverified?: boolean }).unverified, undefined);

    // Character profiles inherit the OWNING account's marker.
    const charId = nanoid();
    await db.insert(schema.characters).values({ id: charId, userId: ghost.id, name: `Shade_${charId.slice(0, 6)}` });
    const charView = await lookupProfile(db, `Shade_${charId.slice(0, 6)}`);
    assert.ok(charView && charView.kind === "character");
    assert.equal((charView.profile as { unverified?: boolean }).unverified, true);

    // Flip back off: wire returns to byte-identical quiet.
    await updateSettings(db, { denoteUnverifiedUsers: false }, admin.id);
    view = await lookupProfile(db, ghost.username);
    assert.ok(view && view.kind === "master");
    assert.equal((view.profile as { unverified?: boolean }).unverified, undefined);
  });

  test("occupant payload: same on-only contract in the userlist wire", async () => {
    const { db } = makeTestDb();
    await ensureSiteSettings(db);
    const admin = await createUser(db, { role: "masteradmin" });
    const ghost = await createUser(db);
    const legacy = await createUser(db);
    await db.update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, legacy.id));
    const room = await mkRoom(db, admin.id);
    const io = ioWithOccupants(room.id, [ghost.id, legacy.id]);

    // OFF: nobody carries the field at all.
    let occ = await currentOccupants(io, db, room.id);
    assert.equal(occ.length, 2);
    for (const o of occ) assert.equal(o.unverified, undefined, "no wire noise while the toggle is off");

    // ON: only the unverified account is flagged.
    await updateSettings(db, { denoteUnverifiedUsers: true }, admin.id);
    occ = await currentOccupants(io, db, room.id);
    const ghostRow = occ.find((o) => o.userId === ghost.id)!;
    const legacyRow = occ.find((o) => o.userId === legacy.id)!;
    assert.equal(ghostRow.unverified, true);
    assert.equal(legacyRow.unverified, undefined, "backfilled/verified accounts are never tagged");
  });
});
