import "./helpers/env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import type { Role, RoomOccupant, RoomSummary } from "@thekeep/shared";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { SessionUser } from "../src/commands/types.js";
import {
  currentOccupants,
  findCanonicalLanding,
  findLiveliestLanding,
  findServerLanding,
  joinRoom,
} from "../src/realtime/broadcast.js";
import { restampPostLockedForRoom } from "../src/lib/postMode.js";
import { registerRoomsRoutes } from "../src/routes/rooms.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Phantom presence for info rooms (post_mode = 'staff'): the info room
 * reports ZERO occupants on every surface, readers display in their
 * anchor room (last normal room, else the landing) marked `reading`,
 * every per-viewer scrub (blocks / isolation) applies to the attributed
 * row, join/leave system lines stay silent around info rooms, and the
 * landing pickers never place anyone INTO one.
 */

// The join-announce paths are suppressed wholesale during the 30s server
// BOOT grace (presence.ts isInBootGrace) — which this fresh test process
// would always be inside, making every "line was suppressed" assertion
// vacuous and the "line still fires" sanity checks impossible. Shift
// Date.now past the window; `new Date()` reads the real clock, so stored
// rows are unaffected.
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + 60_000;

const ADULT_DOB = "1990-01-01";
const MINOR_DOB = "2012-01-01";

/* ── Fake socket.io: real socket lists so presence attribution can walk. ── */

interface FakeSocket {
  id: string;
  rooms: Set<string>;
  data: Record<string, unknown>;
  emitted: Array<{ ev: string; payload: unknown }>;
  emit(ev: string, payload?: unknown): void;
  join(band: string): void;
  leave(band: string): void;
}

function makeSocket(
  userId: string | null,
  opts: { roomId?: string; data?: Record<string, unknown> } = {},
): FakeSocket {
  const emitted: Array<{ ev: string; payload: unknown }> = [];
  return {
    id: nanoid(),
    rooms: new Set(opts.roomId ? [`room:${opts.roomId}`] : []),
    data: {
      ...(userId ? { userId } : {}),
      ...(opts.roomId ? { roomId: opts.roomId } : {}),
      ...(opts.data ?? {}),
    },
    emitted,
    emit(ev, payload) {
      emitted.push({ ev, payload });
    },
    join(band) {
      this.rooms.add(band);
    },
    leave(band) {
      this.rooms.delete(band);
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeIo(sockets: FakeSocket[]): any {
  return {
    async fetchSockets() {
      return sockets;
    },
    in(band: string) {
      return {
        async fetchSockets() {
          return sockets.filter((s) => s.rooms.has(band));
        },
        emit() {
          /* room-band broadcast — not asserted here */
        },
      };
    },
    to() {
      return { emit() { /* no-op */ } };
    },
    emit() {
      /* no-op */
    },
  };
}

/** Full SessionUser shape from a harness user row. */
function sessionUser(u: { id: string; username: string; role: Role }): SessionUser {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    activeCharacterId: null,
    birthdate: ADULT_DOB,
    isAdult: true,
    hideNsfw: false,
    isolateFromAdults: false,
    locale: null,
    displayName: u.username,
    chatColor: null,
    awayMessage: null,
    currentMood: null,
    incognitoMode: false,
    incognitoAlias: null,
    incognitoCharacterId: null,
    incognitoExitMessage: null,
    incognitoReturnMessage: null,
  };
}

async function insertRoom(
  db: Db,
  opts: {
    name: string;
    ownerId?: string | null;
    serverId?: string | null;
    postMode?: "everyone" | "staff" | "roles";
    isDefault?: boolean;
    isSystem?: boolean;
    persistent?: boolean;
    type?: "public" | "private";
    archivedAt?: Date | null;
  },
): Promise<string> {
  const id = nanoid();
  await db.insert(schema.rooms).values({
    id,
    name: opts.name,
    slug: opts.name.toLowerCase().replace(/_/g, "-"),
    type: opts.type ?? "public",
    ownerId: opts.ownerId ?? null,
    ...(opts.serverId !== undefined ? { serverId: opts.serverId } : {}),
    ...(opts.postMode ? { postMode: opts.postMode } : {}),
    ...(opts.isDefault ? { isDefault: true } : {}),
    ...(opts.isSystem ? { isSystem: true } : {}),
    ...(opts.persistent ? { persistent: true } : {}),
    ...(opts.archivedAt ? { archivedAt: opts.archivedAt } : {}),
  });
  return id;
}

/** All message bodies persisted in a room, oldest first. */
async function roomBodies(db: Db, roomId: string): Promise<string[]> {
  const rows = await db
    .select({ body: schema.messages.body })
    .from(schema.messages)
    .where(eq(schema.messages.roomId, roomId));
  return rows.map((r) => r.body);
}

/** A reading socket parked in an info room with the given anchor stamp. */
function readingSocket(userId: string, infoRoomId: string, anchorRoomId: string | null): FakeSocket {
  return makeSocket(userId, {
    roomId: infoRoomId,
    data: {
      tabCharId: null,
      presenceInfoRoomId: infoRoomId,
      presenceAnchorRoomId: anchorRoomId,
    },
  });
}

describe("info-room presence attribution (currentOccupants)", () => {
  test("info room reports zero occupants; reader displays in the anchor room as reading+idle", async () => {
    const { db } = makeTestDb();
    const alice = await createUser(db);
    const bob = await createUser(db);
    const hall = await insertRoom(db, { name: "hall", persistent: true });
    const annc = await insertRoom(db, { name: "annc", postMode: "staff", persistent: true });
    const reader = readingSocket(alice.id, annc, hall);
    const liveBob = makeSocket(bob.id, { roomId: hall });
    const io = makeIo([reader, liveBob]);

    assert.deepEqual(await currentOccupants(io, db, annc), [], "info room displays nobody");

    const hallOcc = await currentOccupants(io, db, hall);
    assert.equal(hallOcc.length, 2, "live occupant + attributed reader");
    const aliceRow = hallOcc.find((o) => o.userId === alice.id);
    const bobRow = hallOcc.find((o) => o.userId === bob.id);
    assert.ok(aliceRow, "reader is attributed to the anchor room");
    assert.equal(aliceRow?.reading, true);
    assert.equal(aliceRow?.idle, true, "reading rows degrade to idle for old bundles");
    assert.equal(aliceRow?.away, false, "the user's real away state is untouched");
    assert.equal(bobRow?.reading, undefined, "physically-present rows carry no reading flag");
    assert.equal(bobRow?.idle, false);
  });

  test("a live tab in the anchor room wins the identity dedup over the reading tab", async () => {
    const { db } = makeTestDb();
    const alice = await createUser(db);
    const hall = await insertRoom(db, { name: "hall", persistent: true });
    const annc = await insertRoom(db, { name: "annc", postMode: "staff", persistent: true });
    const io = makeIo([
      makeSocket(alice.id, { roomId: hall, data: { tabCharId: null } }),
      readingSocket(alice.id, annc, hall),
    ]);
    const occ = await currentOccupants(io, db, hall);
    assert.equal(occ.length, 1, "same identity renders once");
    assert.equal(occ[0]!.reading, undefined, "the live presence wins");
    assert.equal(occ[0]!.idle, false);
  });

  test("archived anchor falls back to the landing room; no usable prior does too", async () => {
    const { db } = makeTestDb();
    const alice = await createUser(db);
    const carol = await createUser(db);
    const landing = await insertRoom(db, { name: "The_Spire", isDefault: true, isSystem: true });
    const hall = await insertRoom(db, { name: "hall", archivedAt: new Date() });
    const annc = await insertRoom(db, { name: "annc", postMode: "staff", persistent: true });
    const io = makeIo([
      readingSocket(alice.id, annc, hall), // dead anchor
      readingSocket(carol.id, annc, null), // never had one
    ]);
    assert.deepEqual(await currentOccupants(io, db, annc), []);
    assert.deepEqual(await currentOccupants(io, db, hall), [], "nobody displays in the archived anchor");
    const landingOcc = await currentOccupants(io, db, landing);
    assert.deepEqual(
      landingOcc.map((o) => [o.userId, o.reading] as const).sort(),
      [[alice.id, true], [carol.id, true]].sort(),
      "both readers fall back to the landing room",
    );
  });

  test("a private anchor the reader has no membership of falls back to the landing", async () => {
    const { db } = makeTestDb();
    const alice = await createUser(db);
    const owner = await createUser(db);
    const landing = await insertRoom(db, { name: "The_Spire", isDefault: true, isSystem: true });
    const lair = await insertRoom(db, { name: "lair", type: "private", ownerId: owner.id });
    const annc = await insertRoom(db, { name: "annc", postMode: "staff", persistent: true });
    const io = makeIo([readingSocket(alice.id, annc, lair)]);
    assert.deepEqual(await currentOccupants(io, db, lair), [], "no membership → not displayed there");
    assert.equal((await currentOccupants(io, db, landing))[0]?.userId, alice.id);

    // With a membership row the private anchor displays the reader again.
    await db.insert(schema.roomMembers).values({ roomId: lair, userId: alice.id, role: "member" });
    const lairOcc = await currentOccupants(io, db, lair);
    assert.equal(lairOcc[0]?.userId, alice.id);
    assert.equal(lairOcc[0]?.reading, true);
  });

  test("a stale reading stamp never attributes: socket must still hold the info room's band", async () => {
    const { db } = makeTestDb();
    const alice = await createUser(db);
    const hall = await insertRoom(db, { name: "hall", persistent: true });
    const annc = await insertRoom(db, { name: "annc", postMode: "staff", persistent: true });
    // Kick/boot relocate shape: bands moved to the landing, stamps untouched.
    const relocated = readingSocket(alice.id, annc, hall);
    relocated.rooms = new Set([`room:${hall}`]);
    (relocated.data as { roomId?: string }).roomId = hall;
    const io = makeIo([relocated]);
    const occ = await currentOccupants(io, db, hall);
    assert.equal(occ.length, 1, "counted once, via its real (live) presence");
    assert.equal(occ[0]!.reading, undefined);
  });

  test("a live mode flip back to 'everyone' restores normal presence (no double display)", async () => {
    const { db } = makeTestDb();
    const alice = await createUser(db);
    const hall = await insertRoom(db, { name: "hall", persistent: true });
    const annc = await insertRoom(db, { name: "annc", postMode: "staff", persistent: true });
    const reader = readingSocket(alice.id, annc, hall);
    (reader.data as { user?: SessionUser }).user = sessionUser(alice);
    const io = makeIo([reader]);

    // Flip to 'everyone': occupants render normally in the (ex-info) room.
    await db.update(schema.rooms).set({ postMode: "everyone" }).where(eq(schema.rooms.id, annc));
    const flipped = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, annc)).limit(1))[0]!;
    await restampPostLockedForRoom(io, db, flipped);
    assert.equal((reader.data as { presenceInfoRoomId?: string | null }).presenceInfoRoomId, null);
    assert.equal((await currentOccupants(io, db, annc)).length, 1, "reader is a normal occupant again");
    assert.deepEqual(await currentOccupants(io, db, hall), [], "no lingering attributed row");

    // Flip back to 'staff': occupants caught inside become readers again.
    await db.update(schema.rooms).set({ postMode: "staff" }).where(eq(schema.rooms.id, annc));
    const reflipped = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, annc)).limit(1))[0]!;
    await restampPostLockedForRoom(io, db, reflipped);
    assert.equal((reader.data as { presenceInfoRoomId?: string | null }).presenceInfoRoomId, annc);
    assert.deepEqual(await currentOccupants(io, db, annc), [], "info room displays nobody again");
  });
});

describe("info-room presence on GET /rooms", () => {
  test("info room ships occupants: []; the anchor room carries the attributed reader", async () => {
    const { db } = makeTestDb();
    const alice = await createUser(db);
    const viewer = await createUser(db, { birthdate: ADULT_DOB });
    const hall = await insertRoom(db, { name: "hall", persistent: true });
    const annc = await insertRoom(db, { name: "annc", postMode: "staff", persistent: true });
    const io = makeIo([readingSocket(alice.id, annc, hall)]);
    const app = Fastify();
    await registerRoomsRoutes(app, db, io);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/rooms", headers: auth(await tokenFor(db, viewer.id)) });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { rooms: Array<RoomSummary & { occupants: RoomOccupant[] }> };
    const anncRow = body.rooms.find((r) => r.id === annc);
    const hallRow = body.rooms.find((r) => r.id === hall);
    assert.deepEqual(anncRow?.occupants, [], "rail payload for the info room lists nobody");
    assert.equal(hallRow?.occupants.length, 1);
    assert.equal(hallRow?.occupants[0]?.userId, alice.id);
    assert.equal(hallRow?.occupants[0]?.reading, true);
    await app.close();
  });

  test("blocked and isolation scrubs apply to the attributed row exactly as if the reader stood there", async () => {
    const { db } = makeTestDb();
    const alice = await createUser(db, { birthdate: ADULT_DOB });
    const blocker = await createUser(db, { birthdate: ADULT_DOB });
    const isolatedMinor = await createUser(db, { birthdate: MINOR_DOB, isolateFromAdults: true });
    const neutral = await createUser(db, { birthdate: ADULT_DOB });
    await db.insert(schema.blocks).values({ blockerUserId: blocker.id, blockedUserId: alice.id });
    const hall = await insertRoom(db, { name: "hall", persistent: true });
    const annc = await insertRoom(db, { name: "annc", postMode: "staff", persistent: true });
    const io = makeIo([readingSocket(alice.id, annc, hall)]);
    const app = Fastify();
    await registerRoomsRoutes(app, db, io);
    await app.ready();

    const occupantsFor = async (userId: string): Promise<RoomOccupant[]> => {
      const res = await app.inject({ method: "GET", url: "/rooms", headers: auth(await tokenFor(db, userId)) });
      const body = res.json() as { rooms: Array<RoomSummary & { occupants: RoomOccupant[] }> };
      return body.rooms.find((r) => r.id === hall)?.occupants ?? [];
    };
    assert.equal((await occupantsFor(neutral.id)).length, 1, "visible to a neutral viewer");
    assert.deepEqual(await occupantsFor(blocker.id), [], "blocked viewer never sees the attributed row");
    assert.deepEqual(await occupantsFor(isolatedMinor.id), [], "isolated minor never sees the attributed adult");
    await app.close();
  });
});

describe("info-room system-line silence (joinRoom)", () => {
  test("no join/leave/connected lines around info rooms; normal switches still announce", async () => {
    const { db } = makeTestDb();
    // addSystemMessage attributes lines to the boot-seeded "system" user and
    // silently no-ops without it — seed one so announces actually persist
    // (the positive sanity checks below depend on it).
    await createUser(db, { username: "system" });
    const alice = await createUser(db);
    const bob = await createUser(db);
    await insertRoom(db, { name: "The_Spire", isDefault: true, isSystem: true });
    const hall = await insertRoom(db, { name: "hall", persistent: true });
    const den = await insertRoom(db, { name: "den", persistent: true });
    const annc = await insertRoom(db, { name: "annc", postMode: "staff", persistent: true });
    const bobSock = makeSocket(bob.id, { roomId: hall });
    const aliceSock = makeSocket(alice.id);
    const io = makeIo([bobSock, aliceSock]);
    const aliceUser = sessionUser(alice);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await joinRoom(io, db, aliceSock as any, aliceUser, hall);

    // hall → info room: the reader keeps their displayed presence in hall,
    // so no departure line there; the info room itself persists nothing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await joinRoom(io, db, aliceSock as any, aliceUser, annc);
    assert.ok(
      !(await roomBodies(db, hall)).some((b) => b.includes("has left the room")),
      "no departure line in the anchor room",
    );
    assert.deepEqual(await roomBodies(db, annc), [], "no arrival line in the info room");
    const sd = aliceSock.data as { presenceInfoRoomId?: string | null; presenceAnchorRoomId?: string | null };
    assert.equal(sd.presenceInfoRoomId, annc);
    assert.equal(sd.presenceAnchorRoomId, hall);
    const hallOcc = await currentOccupants(io, db, hall);
    assert.equal(hallOcc.find((o) => o.userId === alice.id)?.reading, true);

    // info room → back to the anchor: everyone there watched the idle row
    // the whole time, so re-entry stays silent too.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await joinRoom(io, db, aliceSock as any, aliceUser, hall);
    assert.ok(
      !(await roomBodies(db, hall)).some((b) => b.includes("has entered the room")),
      "returning to the anchor room is silent",
    );
    assert.equal(sd.presenceInfoRoomId, null, "normal room clears the reading state");
    assert.equal(sd.presenceAnchorRoomId, null);

    // Sanity: an ordinary room switch still announces on both sides.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await joinRoom(io, db, aliceSock as any, aliceUser, den);
    assert.ok(
      (await roomBodies(db, den)).some((b) => b.includes("has entered the room")),
      "normal arrivals still announce",
    );
    assert.ok(
      (await roomBodies(db, hall)).some((b) => b.includes("has left the room")),
      "normal departures still announce",
    );
  });

  test("a session that CONNECTS into an info room stays silent and displays at the landing", async () => {
    const { db } = makeTestDb();
    await createUser(db, { username: "system" });
    const carol = await createUser(db);
    const landing = await insertRoom(db, { name: "The_Spire", isDefault: true, isSystem: true });
    const annc = await insertRoom(db, { name: "annc", postMode: "staff", persistent: true });
    const carolSock = makeSocket(carol.id, { data: { loginIntent: true } });
    const io = makeIo([carolSock]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await joinRoom(io, db, carolSock as any, sessionUser(carol), annc);
    assert.deepEqual(await roomBodies(db, annc), [], "no 'has connected' line in the info room");
    const landingOcc = await currentOccupants(io, db, landing);
    assert.equal(landingOcc[0]?.userId, carol.id, "no usable prior room → attributed to the landing");
    assert.equal(landingOcc[0]?.reading, true);
  });
});

describe("landing pickers never place anyone into an info room", () => {
  test("findCanonicalLanding skips an info default room", async () => {
    const { db } = makeTestDb();
    await insertRoom(db, { name: "annc-default", postMode: "staff", isDefault: true, isSystem: true });
    const system = await insertRoom(db, { name: "alpha", isSystem: true });
    assert.equal((await findCanonicalLanding(db))?.id, system);
  });

  test("findServerLanding skips info rooms at every tier", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const serverId = nanoid();
    await db.insert(schema.servers).values({
      id: serverId, slug: `srv-${serverId.slice(0, 6)}`.toLowerCase(), name: "Test Server",
      ownerUserId: owner.id, isSystem: false, isDefault: false,
      status: "active", visibility: "public", joinMode: "open",
    });
    await insertRoom(db, { name: "annc", postMode: "staff", isDefault: true, serverId });
    await insertRoom(db, { name: "annc-sys", postMode: "staff", isSystem: true, serverId });
    const live = await insertRoom(db, { name: "welcome", serverId });
    assert.equal((await findServerLanding(db, serverId))?.id, live);
  });

  test("findLiveliestLanding ignores recent chat inside info rooms", async () => {
    const { db } = makeTestDb();
    const staff = await createUser(db, { role: "admin" });
    const annc = await insertRoom(db, { name: "annc", postMode: "staff" });
    await db.insert(schema.messages).values({
      id: nanoid(),
      roomId: annc,
      userId: staff.id,
      characterId: null,
      displayName: staff.username,
      kind: "say",
      body: "announcement chatter",
    });
    assert.equal(await findLiveliestLanding(db), null, "an info room never wins the liveliest pick");
  });
});
