import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { CommandContext, SessionUser } from "../src/commands/types.js";
import { serverAuthority } from "../src/servers/authority.js";
import { evictMinorsFromServer } from "../src/lib/nsfwRooms.js";
import { addMessage, pushTriggers } from "../src/realtime/broadcast.js";
import { invalidatePermissionsCache } from "../src/auth/permissions.js";
import { createUser, makeTestDb } from "./helpers/harness.js";

/**
 * Phase 2 server-level 18+ gates (age-restriction plan): the canParticipate
 * age fold every chokepoint inherits, the effective-rating message stamp
 * (`server.is_nsfw OR room.is_nsfw`), the server-flip eviction that keeps
 * `server_members` rows, and the minor mention-notification skip.
 */

const MINOR_DOB = "2012-01-01";
const ADULT_DOB = "1990-01-01";

class FakeSocket {
  id = nanoid();
  rooms = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any = {};
  emitted: Array<{ event: string; payload: unknown }> = [];
  emit(event: string, payload?: unknown): boolean {
    this.emitted.push({ event, payload });
    return true;
  }
  join(band: string): void { this.rooms.add(band); }
  leave(band: string): void { this.rooms.delete(band); }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeIo(sockets: FakeSocket[] = []): any {
  return {
    async fetchSockets() { return sockets; },
    in(band: string) {
      return {
        async fetchSockets() { return sockets.filter((s) => s.rooms.has(band)); },
        emit(event: string, payload?: unknown) {
          for (const s of sockets) if (s.rooms.has(band)) s.emit(event, payload);
        },
      };
    },
    to(band: string) {
      return {
        emit(event: string, payload?: unknown) {
          for (const s of sockets) if (s.rooms.has(band)) s.emit(event, payload);
        },
      };
    },
    // Global pulse (rooms:tree-changed) lands here; nothing to observe.
    emit() {},
  };
}

function sessionUserFor(
  u: { id: string; username: string },
  opts: { birthdate: string | null },
): SessionUser {
  return {
    id: u.id,
    username: u.username,
    role: "user",
    activeCharacterId: null,
    birthdate: opts.birthdate,
    isAdult: opts.birthdate === null || opts.birthdate <= "2007-12-31",
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
let owner: { id: string; username: string };
let adult: { id: string; username: string };
let minor: { id: string; username: string };
let nsfwServerId: string;
let sfwServerId: string;

before(async () => {
  invalidatePermissionsCache();
  db = makeTestDb().db;
  owner = await createUser(db, { birthdate: ADULT_DOB });
  adult = await createUser(db, { birthdate: ADULT_DOB });
  minor = await createUser(db, { birthdate: MINOR_DOB });

  nsfwServerId = nanoid();
  await db.insert(schema.servers).values({
    id: nsfwServerId, slug: "adults-only", name: "Adults Only", ownerUserId: owner.id, isNsfw: true, joinMode: "open",
  });
  sfwServerId = nanoid();
  await db.insert(schema.servers).values({
    id: sfwServerId, slug: "all-ages", name: "All Ages", ownerUserId: owner.id, joinMode: "open",
  });
});

describe("serverAuthority age fold (canParticipate chokepoint)", () => {
  test("minor cannot participate in an 18+ server; adult can", async () => {
    const minorA = await serverAuthority(db, { id: minor.id, role: "user", isAdult: false }, nsfwServerId);
    assert.equal(minorA.canParticipate, false);
    const adultA = await serverAuthority(db, { id: adult.id, role: "user", isAdult: true }, nsfwServerId);
    assert.equal(adultA.canParticipate, true);
  });

  test("anonymous can never participate (unchanged), and the fold leaves SFW servers alone", async () => {
    const anon = await serverAuthority(db, null, nsfwServerId);
    assert.equal(anon.canParticipate, false);
    const minorSfw = await serverAuthority(db, { id: minor.id, role: "user", isAdult: false }, sfwServerId);
    assert.equal(minorSfw.canParticipate, true);
  });

  test("a caller without in-hand age context is resolved from the DB (fail closed)", async () => {
    // Bare { id, role } — the fold reads users.birthdate itself.
    const minorA = await serverAuthority(db, { id: minor.id, role: "user" }, nsfwServerId);
    assert.equal(minorA.canParticipate, false);
    const adultA = await serverAuthority(db, { id: adult.id, role: "user" }, nsfwServerId);
    assert.equal(adultA.canParticipate, true);
  });

  test("no escape for a minor OWNER: authority stays, participation does not", async () => {
    const minorOwner = await createUser(db, { birthdate: MINOR_DOB });
    const sid = nanoid();
    await db.insert(schema.servers).values({
      id: sid, slug: "minor-owned", name: "Minor Owned", ownerUserId: minorOwner.id, isNsfw: true,
    });
    const a = await serverAuthority(db, { id: minorOwner.id, role: "user", isAdult: false }, sid);
    assert.equal(a.isOwner, true, "authority over the rows is kept");
    assert.equal(a.canParticipate, false, "participation is age-gated regardless");
  });

  test("an adult with the hide preference still passes (HARD tier)", async () => {
    const hidePref = await createUser(db, { birthdate: ADULT_DOB, hideNsfw: true });
    const a = await serverAuthority(db, { id: hidePref.id, role: "user", isAdult: true }, nsfwServerId);
    assert.equal(a.canParticipate, true);
  });
});

describe("addMessage stamping (effective rating at write time)", () => {
  async function stampFor(roomOpts: { isNsfw: boolean; serverId: string | null }): Promise<boolean> {
    const roomId = nanoid();
    await db.insert(schema.rooms).values({
      id: roomId,
      name: `room_${roomId.slice(0, 6)}`,
      slug: `room-${roomId.slice(0, 6)}`,
      type: "public",
      isNsfw: roomOpts.isNsfw,
      ...(roomOpts.serverId ? { serverId: roomOpts.serverId } : {}),
    });
    const socket = new FakeSocket();
    const user = sessionUserFor(adult, { birthdate: ADULT_DOB });
    socket.data.userId = adult.id;
    socket.data.user = user;
    const ctx = {
      db,
      io: makeFakeIo([socket]),
      socket: socket as never,
      user,
      roomId,
      argsText: "",
      args: [],
      invokedAs: "say",
      registry: {} as never, // body has no "!", the inline expander never touches it
    } as unknown as CommandContext;
    const id = await addMessage(ctx, { kind: "say", body: "hello there" });
    assert.ok(id, "message persisted");
    const row = (await db.select().from(schema.messages).where(eq(schema.messages.id, id!)).limit(1))[0]!;
    return row.isNsfw;
  }

  test("SFW room in no server stamps 0", async () => {
    assert.equal(await stampFor({ isNsfw: false, serverId: null }), false);
  });
  test("18+ room stamps 1", async () => {
    assert.equal(await stampFor({ isNsfw: true, serverId: null }), true);
  });
  test("SFW room inside an 18+ server stamps 1 (server OR room)", async () => {
    assert.equal(await stampFor({ isNsfw: false, serverId: nsfwServerId }), true);
  });
  test("SFW room inside an all-ages server stamps 0", async () => {
    assert.equal(await stampFor({ isNsfw: false, serverId: sfwServerId }), false);
  });
});

describe("server flip eviction", () => {
  test("evictMinorsFromServer boots minors to the canonical landing and KEEPS server_members rows", async () => {
    // Landing outside the flipped server (the canonical, SFW by invariant).
    const landingId = nanoid();
    await db.insert(schema.rooms).values({
      id: landingId, name: "The_Spire", slug: "the-spire", type: "public", isDefault: true, isSystem: true,
    });
    const roomId = nanoid();
    await db.insert(schema.rooms).values({
      id: roomId, name: "InsideNsfw", slug: "inside-nsfw", type: "public", serverId: nsfwServerId,
    });
    await db.insert(schema.serverMembers).values([
      { serverId: nsfwServerId, userId: minor.id, role: "member" },
      { serverId: nsfwServerId, userId: adult.id, role: "member" },
    ]);

    const minorSock = new FakeSocket();
    minorSock.data.userId = minor.id;
    minorSock.data.user = sessionUserFor(minor, { birthdate: MINOR_DOB });
    minorSock.data.roomId = roomId;
    minorSock.data.serverId = nsfwServerId;
    minorSock.rooms.add(`room:${roomId}`);
    const adultSock = new FakeSocket();
    adultSock.data.userId = adult.id;
    adultSock.data.user = sessionUserFor(adult, { birthdate: ADULT_DOB });
    adultSock.data.roomId = roomId;
    adultSock.data.serverId = nsfwServerId;
    adultSock.rooms.add(`room:${roomId}`);

    const io = makeFakeIo([minorSock, adultSock]);
    const booted = await evictMinorsFromServer(io, db, nsfwServerId, "This community is now for adults only.");
    assert.equal(booted, 1);
    assert.equal(minorSock.rooms.has(`room:${roomId}`), false);
    assert.equal(minorSock.rooms.has(`room:${landingId}`), true);
    assert.equal(adultSock.rooms.has(`room:${roomId}`), true);

    // Keep-but-hide: the minor's membership row survives.
    const rows = await db.select().from(schema.serverMembers)
      .where(and(eq(schema.serverMembers.serverId, nsfwServerId), eq(schema.serverMembers.userId, minor.id)));
    assert.equal(rows.length, 1);
  });
});

describe("mention notifications in 18+ rooms", () => {
  test("minor recipients get no inbox row; adult recipients do", async () => {
    const roomId = nanoid();
    await db.insert(schema.rooms).values({
      id: roomId, name: "MentionRoom", slug: "mention-room", type: "public", isNsfw: true,
    });
    const sender = sessionUserFor(owner, { birthdate: ADULT_DOB });
    const msg = {
      id: nanoid(),
      roomId,
      userId: owner.id,
      characterId: null,
      displayName: owner.username,
      kind: "say" as const,
      body: `@${minor.username} and @${adult.username} look here`,
      color: null,
      createdAt: Date.now(),
    };
    await pushTriggers(makeFakeIo(), db, msg, sender, "say", true);

    const minorRows = await db.select().from(schema.notifications)
      .where(eq(schema.notifications.userId, minor.id));
    assert.equal(minorRows.length, 0, "minor mention skipped in an 18+ room");
    const adultRows = await db.select().from(schema.notifications)
      .where(eq(schema.notifications.userId, adult.id));
    assert.equal(adultRows.length, 1, "adult mention still lands");
  });

  test("in an all-ages room the minor mention lands normally", async () => {
    const roomId = nanoid();
    await db.insert(schema.rooms).values({
      id: roomId, name: "SafeMention", slug: "safe-mention", type: "public",
    });
    const sender = sessionUserFor(owner, { birthdate: ADULT_DOB });
    const msg = {
      id: nanoid(),
      roomId,
      userId: owner.id,
      characterId: null,
      displayName: owner.username,
      kind: "say" as const,
      body: `@${minor.username} hello`,
      color: null,
      createdAt: Date.now(),
    };
    await pushTriggers(makeFakeIo(), db, msg, sender, "say", false);
    const minorRows = await db.select().from(schema.notifications)
      .where(eq(schema.notifications.userId, minor.id));
    assert.equal(minorRows.length, 1);
  });
});
