import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import type { Role } from "@thekeep/shared";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { SessionUser } from "../src/commands/types.js";
import { dispatchChatInput } from "../src/realtime/dispatch.js";
import { CommandRegistry } from "../src/commands/registry.js";
import { registerBuiltins } from "../src/commands/builtins/index.js";
import { registerRoomsRoutes } from "../src/routes/rooms.js";
import { registerEmoticonRoutes } from "../src/routes/emoticons.js";
import { enableAdultChannel } from "../src/lib/adultChannel.js";
import { canPostInStaffRoom, isPostLockedFor } from "../src/lib/postMode.js";
import { roomVisibilityWhere } from "../src/realtime/targetedMessages.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Info rooms (post_mode = 'staff', migration 0345): the dispatch gate
 * (members refused BEFORE the rate limit; room owner / room mod / server
 * staff / site staff pass; whispers + non-posting commands unaffected),
 * reactions staying open for everyone, the 18+ channel of an info room
 * inheriting nothing, the per-viewer postLocked flag on GET /rooms, and
 * the minor pair scrub staying byte-identical with post modes in play.
 */

const ADULT_DOB = "1990-01-01";
const MINOR_DOB = "2012-01-01";

/* ── Fake socket.io: enough surface for dispatch + addMessage fan-out. ── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeIo(): any {
  return {
    async fetchSockets() { return []; },
    in() {
      return {
        async fetchSockets() { return []; },
        emit() { /* no live sockets in these tests */ },
      };
    },
    to() { return { emit() { /* no-op */ } }; },
    emit() { /* no-op */ },
  };
}

interface Notice { code: string; message: string }

/** A dispatch-shaped socket: joined to the room, collecting error notices. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeSocket(roomId: string): { socket: any; notices: Notice[] } {
  const notices: Notice[] = [];
  const socket = {
    rooms: new Set([`room:${roomId}`]),
    data: {},
    emit(event: string, payload: unknown) {
      if (event === "error:notice") notices.push(payload as Notice);
    },
  };
  return { socket, notices };
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

let db: Db;
let app: FastifyInstance;
let registry: CommandRegistry;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let io: any;
let owner: { id: string; username: string; role: Role };
let member: { id: string; username: string; role: Role };
let roomMod: { id: string; username: string; role: Role };
let serverStaff: { id: string; username: string; role: Role };
let siteMod: { id: string; username: string; role: Role };
let minor: { id: string; username: string };
let memberToken: string;
let minorToken: string;
let serverId: string;
let infoRoomId: string;
let openRoomId: string;

async function insertRoom(opts: {
  name: string; ownerId?: string | null; serverId?: string | null;
  postMode?: "everyone" | "staff"; isNsfw?: boolean; linkedRoomId?: string | null;
  replyMode?: "flat" | "nested";
}): Promise<string> {
  const id = nanoid();
  await db.insert(schema.rooms).values({
    id,
    name: opts.name,
    slug: opts.name.toLowerCase().replace(/_/g, "-"),
    type: "public",
    ownerId: opts.ownerId ?? null,
    isNsfw: opts.isNsfw ?? false,
    postMode: opts.postMode ?? "everyone",
    replyMode: opts.replyMode ?? "flat",
    ...(opts.serverId !== undefined ? { serverId: opts.serverId } : {}),
    ...(opts.linkedRoomId !== undefined ? { linkedRoomId: opts.linkedRoomId } : {}),
  });
  return id;
}

async function dispatch(user: { id: string; username: string; role: Role }, roomId: string, text: string): Promise<Notice[]> {
  const { socket, notices } = makeFakeSocket(roomId);
  await dispatchChatInput({
    io, socket, db, registry,
    user: sessionUser(user),
    roomId, text,
  });
  return notices;
}

async function messageCount(roomId: string): Promise<number> {
  return (await db.select({ id: schema.messages.id }).from(schema.messages)
    .where(eq(schema.messages.roomId, roomId))).length;
}

before(async () => {
  db = makeTestDb().db;
  io = makeFakeIo();
  registry = new CommandRegistry();
  registerBuiltins(registry);
  app = Fastify();
  await registerRoomsRoutes(app, db, io);
  await registerEmoticonRoutes(app, db, io, mkdtempSync(join(tmpdir(), "postmode-uploads-")));
  await app.ready();

  owner = { ...(await createUser(db, { birthdate: ADULT_DOB })), role: "user" };
  member = { ...(await createUser(db, { birthdate: ADULT_DOB })), role: "user" };
  roomMod = { ...(await createUser(db, { birthdate: ADULT_DOB })), role: "user" };
  serverStaff = { ...(await createUser(db, { birthdate: ADULT_DOB })), role: "user" };
  siteMod = { ...(await createUser(db, { role: "mod", birthdate: ADULT_DOB })), role: "mod" };
  minor = await createUser(db, { birthdate: MINOR_DOB });
  memberToken = await tokenFor(db, member.id);
  minorToken = await tokenFor(db, minor.id);

  serverId = nanoid();
  await db.insert(schema.servers).values({
    id: serverId, slug: `srv-${serverId.slice(0, 6)}`, name: "Info Server", ownerUserId: owner.id,
  });
  await db.insert(schema.serverMembers).values([
    { serverId, userId: serverStaff.id, role: "mod" },
    { serverId, userId: member.id, role: "member" },
  ]);

  infoRoomId = await insertRoom({ name: "Info_Hall", ownerId: owner.id, serverId, postMode: "staff" });
  openRoomId = await insertRoom({ name: "Open_Hall", ownerId: owner.id, serverId });
  await db.insert(schema.roomMembers).values([
    { roomId: infoRoomId, userId: roomMod.id, role: "mod" },
    { roomId: infoRoomId, userId: member.id, role: "member" },
  ]);
});

describe("dispatch gate (post_mode = 'staff')", () => {
  test("plain member is refused with ROOM_READ_ONLY and nothing persists", async () => {
    const notices = await dispatch(member, infoRoomId, "hello there");
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.code, "ROOM_READ_ONLY");
    assert.equal(await messageCount(infoRoomId), 0);
  });

  test("speech commands (/me, /reply) are refused the same as plain says", async () => {
    for (const text of ["/me waves", "/reply someid hi"]) {
      const notices = await dispatch(member, infoRoomId, text);
      assert.equal(notices[0]?.code, "ROOM_READ_ONLY", text);
    }
    assert.equal(await messageCount(infoRoomId), 0);
  });

  test("the gate runs BEFORE the rate limit: a refusal burst never escalates", async () => {
    // 15 attempts would blow the 12-per-10s budget if they were counted;
    // every one must come back as the read-only notice instead.
    for (let i = 0; i < 15; i++) {
      const notices = await dispatch(member, infoRoomId, `spam ${i}`);
      assert.equal(notices[0]?.code, "ROOM_READ_ONLY");
    }
  });

  test("room owner, room mod, server staff, and site staff all post", async () => {
    for (const staff of [owner, roomMod, serverStaff, siteMod]) {
      const beforeCount = await messageCount(infoRoomId);
      const notices = await dispatch(staff, infoRoomId, `announcement from ${staff.username}`);
      assert.deepEqual(notices.map((n) => n.code), [], staff.username);
      assert.equal(await messageCount(infoRoomId), beforeCount + 1, staff.username);
    }
  });

  test("whispers and non-posting commands are unaffected", async () => {
    // Whisper: private one-to-one, never a room post. It may surface its
    // own notices (delivery, offline target) but never the read-only one.
    const whisper = await dispatch(member, infoRoomId, `/whisper @id:${owner.id} psst`);
    assert.equal(whisper.some((n) => n.code === "ROOM_READ_ONLY"), false);
    // A non-speech command (/postmode readout) is not a room post either.
    const readout = await dispatch(member, infoRoomId, "/postmode");
    assert.equal(readout.some((n) => n.code === "ROOM_READ_ONLY"), false);
    assert.equal(readout[0]?.code, "POSTMODE");
  });

  test("post_mode = 'everyone' rooms are untouched", async () => {
    const notices = await dispatch(member, openRoomId, "hello open room");
    assert.deepEqual(notices.map((n) => n.code), []);
    assert.equal(await messageCount(openRoomId), 1);
  });
});

describe("room-posting commands outside the speech list are gated too", () => {
  test("/poll, /storydice, /check and friends are refused for a plain member", async () => {
    const beforeCount = await messageCount(infoRoomId);
    for (const text of [
      "/poll Is this locked? | yes | no",
      "/storydice",
      "/check",
      "/trivia What color? | blue",
      "/scramble",
      `/duel @id:${owner.id}`,
    ]) {
      const notices = await dispatch(member, infoRoomId, text);
      assert.equal(notices[0]?.code, "ROOM_READ_ONLY", text);
    }
    assert.equal(await messageCount(infoRoomId), beforeCount, "nothing persisted");
  });

  test("staff still run room-posting commands (/poll passes the gate)", async () => {
    const beforeCount = await messageCount(infoRoomId);
    const notices = await dispatch(owner, infoRoomId, "/poll Next event? | raid | market");
    assert.equal(notices.some((n) => n.code === "ROOM_READ_ONLY"), false);
    assert.equal(await messageCount(infoRoomId), beforeCount + 1);
  });

  test("custom commands always post to the room, so they are refused as well", async () => {
    await db.insert(schema.customCommands).values({
      id: nanoid(),
      name: "hugtest",
      template: "{sender} hugs {args}",
      createdById: owner.id,
    });
    await registry.reloadCustom(db);
    const beforeCount = await messageCount(infoRoomId);
    const denied = await dispatch(member, infoRoomId, "/hugtest arbitrary text");
    assert.equal(denied[0]?.code, "ROOM_READ_ONLY");
    assert.equal(await messageCount(infoRoomId), beforeCount);
    // Staff pass the same gate.
    const allowed = await dispatch(owner, infoRoomId, "/hugtest the room");
    assert.equal(allowed.some((n) => n.code === "ROOM_READ_ONLY"), false);
    assert.equal(await messageCount(infoRoomId), beforeCount + 1);
  });
});

describe("reactions stay open for everyone", () => {
  test("a locked member can still react to a staff post", async () => {
    const staffMsg = (await db.select({ id: schema.messages.id }).from(schema.messages)
      .where(and(eq(schema.messages.roomId, infoRoomId), eq(schema.messages.kind, "say"))).limit(1))[0];
    assert.ok(staffMsg, "a staff post exists to react to");
    const res = await app.inject({
      method: "POST", url: "/reactions/toggle", headers: auth(memberToken),
      payload: { targetKind: "chat_message", targetId: staffMsg!.id, unicodeChar: "👍" },
    });
    assert.equal(res.statusCode, 200);
    const j = res.json() as { op?: string; summary?: { entries: unknown[] } };
    assert.equal(j.op, "add");
    assert.equal(j.summary?.entries.length, 1);
  });
});

describe("/postmode command", () => {
  test("owner flips the mode; plain members may not", async () => {
    const roomId = await insertRoom({ name: "Flip_Room", ownerId: owner.id, serverId });
    const denied = await dispatch(member, roomId, "/postmode staff");
    assert.equal(denied[0]?.code, "PERM");
    const flipped = await dispatch(owner, roomId, "/postmode staff");
    assert.equal(flipped.some((n) => n.code === "PERM"), false);
    const row = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, roomId)))[0]!;
    assert.equal(row.postMode, "staff");
    // And back.
    await dispatch(owner, roomId, "/postmode everyone");
    const back = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, roomId)))[0]!;
    assert.equal(back.postMode, "everyone");
  });
});

describe("18+ channel of an info room inherits nothing", () => {
  test("the annex is created post_mode 'everyone' and members post there", async () => {
    const baseRow = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, infoRoomId)))[0]!;
    const ch = await enableAdultChannel(db, baseRow);
    assert.equal(ch.ok, true);
    const annexId = (ch as { channelRoomId?: string }).channelRoomId!;
    const annex = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, annexId)))[0]!;
    assert.equal(annex.postMode, "everyone", "post_mode is per-room, never inherited by the channel");
    const notices = await dispatch(member, annexId, "hello annex");
    assert.deepEqual(notices.map((n) => n.code), []);
    assert.equal(await messageCount(annexId), 1);
  });
});

describe("per-viewer postLocked on GET /rooms", () => {
  interface RoomRow {
    name: string; postMode?: string; postLocked?: boolean;
    linkedNsfwRoomId?: string | null; categoryId?: string | null;
  }
  const fetchRooms = async (token?: string): Promise<RoomRow[]> => {
    const res = await app.inject({ method: "GET", url: "/rooms", ...(token ? { headers: auth(token) } : {}) });
    assert.equal(res.statusCode, 200);
    return (res.json() as { rooms: RoomRow[] }).rooms;
  };

  test("locked for plain members and anonymous viewers; absent for posters", async () => {
    const asMember = await fetchRooms(memberToken);
    const infoForMember = asMember.find((r) => r.name === "Info_Hall")!;
    assert.equal(infoForMember.postMode, "staff");
    assert.equal(infoForMember.postLocked, true);
    assert.equal(asMember.find((r) => r.name === "Open_Hall")!.postLocked, undefined);

    const anon = await fetchRooms();
    assert.equal(anon.find((r) => r.name === "Info_Hall")!.postLocked, true);

    for (const poster of [owner, roomMod, serverStaff, siteMod]) {
      const rows = await fetchRooms(await tokenFor(db, poster.id));
      assert.equal(rows.find((r) => r.name === "Info_Hall")!.postLocked, undefined, poster.username);
    }
  });

  test("minor + pair scrub interplay unchanged (annex hidden, pointer scrubbed, lock intact)", async () => {
    // Info_Hall now carries an 18+ channel (created above). A minor must
    // still receive ONLY the SFW base with the annex pointer scrubbed —
    // and the read-only flag rides the surviving row untouched.
    const rows = await fetchRooms(minorToken);
    const infoRows = rows.filter((r) => r.name.startsWith("Info_Hall"));
    assert.equal(infoRows.length, 1, "minor receives only the SFW base");
    assert.equal(infoRows[0]!.linkedNsfwRoomId, null, "annex pointer scrubbed");
    assert.equal(infoRows[0]!.postLocked, true, "minor is not staff, so the lock rides along");
  });
});

describe("@cid:/@id: identity-token mentions resolve in a plain say", () => {
  async function latestFrom(roomId: string, userId: string) {
    return (await db.select().from(schema.messages)
      .where(and(eq(schema.messages.roomId, roomId), eq(schema.messages.userId, userId)))
      .orderBy(desc(schema.messages.createdAt)).limit(1))[0]!;
  }
  test("@cid: rewrites the plain-body token to the character name", async () => {
    const charId = nanoid();
    await db.insert(schema.characters).values({ id: charId, userId: member.id, name: "Sigrid" });
    await dispatch(owner, openRoomId, `hey @cid:${charId} welcome`);
    const row = await latestFrom(openRoomId, owner.id);
    assert.ok(!row.body.includes("@cid:"), `token should be rewritten, got: ${row.body}`);
    assert.ok(row.body.includes("Sigrid"), `resolved name should be in the body, got: ${row.body}`);
  });
  test("@id: rewrites the plain-body token to the master username", async () => {
    await dispatch(owner, openRoomId, `ping @id:${member.id} please`);
    const row = await latestFrom(openRoomId, owner.id);
    assert.ok(!row.body.includes("@id:"), `token should be rewritten, got: ${row.body}`);
  });
});

describe("info-room backlog shows only posted content", () => {
  // The read-side guard (roomVisibilityWhere infoRoom mode) is what keeps
  // whispers, system lines, targeted notifications, and removed-message
  // tombstones out of an info channel — including rows that were written
  // BEFORE the room became one, which the write-side guards can't touch.
  test("filter excludes whispers, system, targeted, and deleted rows", async () => {
    const rid = await insertRoom({ name: "Info_Backlog", ownerId: owner.id, serverId, postMode: "staff" });
    const base = { roomId: rid, characterId: null, displayName: "x", body: "b" };
    await db.insert(schema.messages).values([
      { id: nanoid(), ...base, userId: owner.id, kind: "say", body: "the announcement" },       // content → shows
      { id: nanoid(), ...base, userId: member.id, toUserId: owner.id, kind: "whisper", body: "psst" }, // whisper → hidden
      { id: nanoid(), ...base, userId: owner.id, kind: "system", body: "someone joined" },        // system → hidden
      { id: nanoid(), ...base, userId: owner.id, kind: "system", targetUserId: member.id, body: "[Description]: hi" }, // targeted → hidden
      { id: nanoid(), ...base, userId: owner.id, kind: "say", body: "gone", deletedAt: new Date() }, // tombstone → hidden
    ]);

    const infoRows = await db.select().from(schema.messages)
      .where(roomVisibilityWhere(rid, member.id, serverId, true, true));
    assert.deepEqual(infoRows.map((r) => r.body), ["the announcement"]);

    // Control: as a NON-info room the same viewer would also see the system
    // line, their own whisper, their targeted line, and the tombstone.
    const normalRows = await db.select().from(schema.messages)
      .where(roomVisibilityWhere(rid, member.id, serverId, true, false));
    assert.ok(normalRows.length >= 4, `non-info shows the rest (${normalRows.length})`);
  });
});

describe("qualification helper", () => {
  test("boards are never post-locked (their own permission system governs)", async () => {
    const board = {
      id: "board1", ownerId: null, serverId, postMode: "staff" as const, forumId: "forum1",
    };
    assert.equal(await isPostLockedFor(db, { id: member.id, role: "user" }, board), false);
  });

  test("canPostInStaffRoom matches the four staff lanes", async () => {
    const room = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, infoRoomId)))[0]!;
    assert.equal(await canPostInStaffRoom(db, { id: member.id, role: "user" }, room), false);
    assert.equal(await canPostInStaffRoom(db, { id: owner.id, role: "user" }, room), true);
    assert.equal(await canPostInStaffRoom(db, { id: roomMod.id, role: "user" }, room), true);
    assert.equal(await canPostInStaffRoom(db, { id: serverStaff.id, role: "user" }, room), true);
    assert.equal(await canPostInStaffRoom(db, { id: siteMod.id, role: "mod" }, room), true);
  });
});
