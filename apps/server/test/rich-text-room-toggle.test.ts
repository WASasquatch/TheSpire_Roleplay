import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import type { Role } from "@thekeep/shared";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { SessionUser } from "../src/commands/types.js";
import { sanitizeRichMessageHtml } from "../src/lib/richHtml.js";
import { dispatchChatInput } from "../src/realtime/dispatch.js";
import { CommandRegistry } from "../src/commands/registry.js";
import { registerBuiltins } from "../src/commands/builtins/index.js";
import { registerMessageRoutes } from "../src/routes/messages.js";
import { registerRoomsRoutes } from "../src/routes/rooms.js";
import { registerServerConsoleRoutes } from "../src/routes/serversConsole.js";
import { serverAuthority, serverCan } from "../src/servers/authority.js";
import { getSessionUser } from "../src/routes/auth.js";
import type { ServerRoutesCtx } from "../src/routes/serversShared.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Per-room rich-text toggle (rooms.rich_text_disabled, migration 0354):
 * the dispatch ingest degradation matrix (headings unwrap to paragraphs,
 * alignment strips, inline marks survive, md untouched), the edit-route
 * enforcement, default-off byte-identity for untouched rooms, the console
 * create/PATCH gate + audit, historical rich messages rendering as sent
 * (the wire is format-driven, never room-driven), and the RoomSummary
 * field on GET /rooms.
 */

const ADULT_DOB = "1990-01-01";

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

/** Mirror of the ctx routes/servers.ts builds (same as retention-exempt.test). */
function buildConsoleCtx(app: FastifyInstance, db: Db, io: unknown): ServerRoutesCtx {
  const requireServerPermission: ServerRoutesCtx["requireServerPermission"] = async (req, serverId, key) => {
    const me = await getSessionUser(req, db);
    if (!me) return { fail: { code: 401, error: "auth" } };
    const a = await serverAuthority(db, me, serverId);
    if (!a.server) return { fail: { code: 404, error: "no server" } };
    if (!serverCan(a, key)) return { fail: { code: 403, error: "you don't have that server permission" } };
    return { me, server: a.server, authority: a };
  };
  return {
    app,
    db,
    io: io as ServerRoutesCtx["io"],
    serversLive: async () => true,
    requireServerOwner: async (req, serverId) => {
      const me = await getSessionUser(req, db);
      if (!me) return { fail: { code: 401, error: "auth" } };
      const a = await serverAuthority(db, me, serverId);
      if (!a.server) return { fail: { code: 404, error: "no server" } };
      if (!a.isOwner) return { fail: { code: 403, error: "server owner only" } };
      return { me, server: a.server, authority: a };
    },
    requireServerPermission,
    resolveServerTarget: async () => ({ ok: false, error: "unused in these tests" }),
    writeServerImage: async () => ({ error: "unused in these tests", status: 400 }),
    unlinkServerImage: () => {},
  };
}

let db: Db;
let app: FastifyInstance;
let registry: CommandRegistry;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let io: any;
let owner: { id: string; username: string; role: Role };
let member: { id: string; username: string; role: Role };
let ownerToken: string;
let memberToken: string;
let serverId: string;
let simpleRoomId: string;
let fullRoomId: string;

async function insertRoom(opts: { name: string; richTextDisabled?: boolean }): Promise<string> {
  const id = nanoid();
  await db.insert(schema.rooms).values({
    id,
    name: opts.name,
    slug: opts.name.toLowerCase().replace(/_/g, "-"),
    type: "public",
    ownerId: owner.id,
    serverId,
    ...(opts.richTextDisabled !== undefined ? { richTextDisabled: opts.richTextDisabled } : {}),
  });
  return id;
}

async function dispatch(
  user: { id: string; username: string; role: Role },
  roomId: string,
  text: string,
  opts?: { format?: "html" },
): Promise<Notice[]> {
  const { socket, notices } = makeFakeSocket(roomId);
  await dispatchChatInput({
    io, socket, db, registry,
    user: sessionUser(user),
    roomId, text,
    ...(opts?.format ? { format: opts.format } : {}),
  });
  return notices;
}

async function lastMessage(roomId: string): Promise<typeof schema.messages.$inferSelect | undefined> {
  return (
    await db.select().from(schema.messages)
      .where(eq(schema.messages.roomId, roomId))
      .orderBy(desc(sql`rowid`))
      .limit(1)
  )[0];
}

before(async () => {
  db = makeTestDb().db;
  io = makeFakeIo();
  registry = new CommandRegistry();
  registerBuiltins(registry);
  app = Fastify();
  await registerMessageRoutes(app, db, io);
  await registerRoomsRoutes(app, db, io);
  registerServerConsoleRoutes(buildConsoleCtx(app, db, io));
  await app.ready();

  owner = { ...(await createUser(db, { birthdate: ADULT_DOB })), role: "user" };
  member = { ...(await createUser(db, { birthdate: ADULT_DOB })), role: "user" };
  ownerToken = await tokenFor(db, owner.id);
  memberToken = await tokenFor(db, member.id);

  serverId = nanoid();
  await db.insert(schema.servers).values({
    id: serverId, slug: `srv-${serverId.slice(0, 6)}`, name: "Simple Server", ownerUserId: owner.id,
  });
  await db.insert(schema.serverMembers).values({ serverId, userId: member.id, role: "member" });

  simpleRoomId = await insertRoom({ name: "Simple_Hall", richTextDisabled: true });
  fullRoomId = await insertRoom({ name: "Full_Hall" });
});

/* ── reduced sanitizer profile (unit) ── */

describe("sanitizeRichMessageHtml blocksDisabled profile", () => {
  test("headings unwrap to paragraphs; alignment strips; both at once", () => {
    const cases: Array<[string, string]> = [
      ["<h1>Big</h1><p>tail</p>", "<p>Big</p><p>tail</p>"],
      ["<h2>Two</h2><h3>Three</h3>", "<p>Two</p><p>Three</p>"],
      ['<p style="text-align:center">mid</p>', "<p>mid</p>"],
      ['<h1 style="text-align:right">both</h1>', "<p>both</p>"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(sanitizeRichMessageHtml(input, { blocksDisabled: true }), expected, input);
    }
  });

  test("inline whitelist is untouched: marks, color, size, spoiler, links, lists, quotes", () => {
    const body =
      '<p><strong>b</strong><em>i</em><u>u</u><s>s</s><code>c</code>' +
      '<span class="spoiler">sp</span><span style="color:#ff0000;font-size:1.35em">loud</span>' +
      '<a href="https://e.com/x" rel="noopener noreferrer ugc" target="_blank">l</a></p>' +
      "<blockquote><p>q</p></blockquote><ul><li>one</li></ul><pre>code</pre>";
    assert.equal(sanitizeRichMessageHtml(body, { blocksDisabled: true }), body);
  });

  test("the default profile is byte-identical to before (no opts = full whitelist)", () => {
    const body = '<h1 style="text-align:center">Big</h1><p style="text-align:right">tail</p>';
    assert.equal(sanitizeRichMessageHtml(body), body);
  });

  test("hostile markup still dies under the reduced profile", () => {
    assert.equal(
      sanitizeRichMessageHtml('<h1 onclick="alert(1)">x<script>alert(1)</script></h1>', { blocksDisabled: true }),
      "<p>x</p>",
    );
  });
});

/* ── dispatch ingest degradation matrix ── */

describe("ingest into a rich-disabled room degrades, never rejects", () => {
  test("html with a heading persists without the heading (unwrapped to a paragraph)", async () => {
    const notices = await dispatch(owner, simpleRoomId, '<h1 style="text-align:center">Big</h1><p>tail</p>', { format: "html" });
    assert.deepEqual(notices.map((n) => n.code), [], "degrade, never reject");
    const row = (await lastMessage(simpleRoomId))!;
    assert.equal(row.kind, "say");
    assert.equal(row.format, "html");
    assert.equal(row.body, "<p>Big</p><p>tail</p>");
    assert.equal(row.bodyText, "Big\ntail");
  });

  test("html with alignment persists with the align style stripped", async () => {
    await dispatch(member, simpleRoomId, '<p style="text-align:right">right lane</p>', { format: "html" });
    const row = (await lastMessage(simpleRoomId))!;
    assert.equal(row.format, "html");
    assert.equal(row.body, "<p>right lane</p>");
    assert.ok(!row.body.includes("text-align"), row.body);
  });

  test("plain inline-marks html persists as reduced html, marks intact", async () => {
    const body = '<p><strong>b</strong> and <span class="spoiler">sp</span></p><ul><li>one</li></ul>';
    await dispatch(owner, simpleRoomId, body, { format: "html" });
    const row = (await lastMessage(simpleRoomId))!;
    assert.equal(row.format, "html");
    assert.equal(row.body, body, "inline constructs ride through byte-identical");
  });

  test("md sends into the disabled room are untouched", async () => {
    await dispatch(member, simpleRoomId, "**bold** stays md");
    const row = (await lastMessage(simpleRoomId))!;
    assert.equal(row.format, "md");
    assert.equal(row.body, "**bold** stays md");
    assert.equal(row.bodyText, null);
  });

  test("default-off byte-identity: a room that never touched the toggle keeps headings", async () => {
    const body = '<h1 style="text-align:center">Big</h1><p>tail</p>';
    await dispatch(owner, fullRoomId, body, { format: "html" });
    const row = (await lastMessage(fullRoomId))!;
    assert.equal(row.format, "html");
    assert.equal(row.body, body, "untouched rooms behave exactly as before");
  });
});

/* ── edit-route enforcement ── */

describe("PATCH /messages/:id enforces the room's toggle", () => {
  test("an edit into a rich-disabled room loses headings and alignment", async () => {
    const id = nanoid();
    await db.insert(schema.messages).values({
      id, roomId: simpleRoomId, userId: owner.id, characterId: null,
      displayName: owner.username, kind: "say",
      body: "<p>original</p>", format: "html", bodyText: "original",
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/messages/${id}`,
      headers: auth(ownerToken),
      payload: { body: '<h2 style="text-align:right">edited</h2><p>tail</p>' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const row = (await db.select().from(schema.messages).where(eq(schema.messages.id, id)).limit(1))[0]!;
    assert.equal(row.format, "html");
    assert.equal(row.body, "<p>edited</p><p>tail</p>");
    assert.equal(row.bodyText, "edited\ntail");
  });

  test("edits in a full-rich room keep headings (control)", async () => {
    const id = nanoid();
    await db.insert(schema.messages).values({
      id, roomId: fullRoomId, userId: owner.id, characterId: null,
      displayName: owner.username, kind: "say",
      body: "<p>original</p>", format: "html", bodyText: "original",
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/messages/${id}`,
      headers: auth(ownerToken),
      payload: { body: "<h2>edited</h2>" },
    });
    assert.equal(res.statusCode, 200, res.body);
    const row = (await db.select().from(schema.messages).where(eq(schema.messages.id, id)).limit(1))[0]!;
    assert.equal(row.body, "<h2>edited</h2>");
  });
});

/* ── console create / PATCH (manage_rooms gate + audit) ── */

describe("console Text formatting control", () => {
  test("PATCH: 401 anonymous, 403 plain member, 200 owner; audit names the field", async () => {
    const roomId = await insertRoom({ name: "Console_RT_Room" });
    const patch = (token: string | undefined, payload: unknown) => app.inject({
      method: "PATCH", url: `/servers/${serverId}/rooms/${roomId}`,
      ...(token ? { headers: auth(token) } : {}), payload,
    });
    assert.equal((await patch(undefined, { richTextDisabled: true })).statusCode, 401);
    assert.equal((await patch(memberToken, { richTextDisabled: true })).statusCode, 403);
    const ok = await patch(ownerToken, { richTextDisabled: true });
    assert.equal(ok.statusCode, 200, ok.body);
    const row = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, roomId)))[0]!;
    assert.equal(row.richTextDisabled, true);

    const audit = (await db.select().from(schema.auditLog)
      .where(eq(schema.auditLog.targetRoomId, roomId))
      .orderBy(desc(sql`rowid`)).limit(1))[0]!;
    assert.equal(audit.action, "server_room_update");
    assert.equal(audit.serverId, serverId);
    assert.ok(String(audit.metadataJson).includes("richTextDisabled"), String(audit.metadataJson));

    // And back off again through the same gate.
    assert.equal((await patch(ownerToken, { richTextDisabled: false })).statusCode, 200);
    const back = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, roomId)))[0]!;
    assert.equal(back.richTextDisabled, false);
  });

  test("create: the field lands on the fresh room; omitted = full rich text", async () => {
    const mk = (payload: Record<string, unknown>) => app.inject({
      method: "POST", url: `/servers/${serverId}/rooms`,
      headers: auth(ownerToken), payload,
    });
    const simple = await mk({ name: "Created_Simple", richTextDisabled: true });
    assert.equal(simple.statusCode, 200, simple.body);
    const simpleId = (simple.json() as { id: string }).id;
    const simpleRow = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, simpleId)))[0]!;
    assert.equal(simpleRow.richTextDisabled, true);

    const plain = await mk({ name: "Created_Plain" });
    assert.equal(plain.statusCode, 200, plain.body);
    const plainId = (plain.json() as { id: string }).id;
    const plainRow = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, plainId)))[0]!;
    assert.equal(plainRow.richTextDisabled, false);
  });
});

/* ── historical messages + RoomSummary ── */

describe("history and summaries", () => {
  test("flipping a room to Simple leaves stored rich messages exactly as sent", async () => {
    const flipRoomId = await insertRoom({ name: "Flip_History" });
    const body = '<h1 style="text-align:center">Old heading</h1><p>old tail</p>';
    await dispatch(owner, flipRoomId, body, { format: "html" });

    const flip = await app.inject({
      method: "PATCH", url: `/servers/${serverId}/rooms/${flipRoomId}`,
      headers: auth(ownerToken), payload: { richTextDisabled: true },
    });
    assert.equal(flip.statusCode, 200, flip.body);

    // The persisted row is untouched...
    const row = (await lastMessage(flipRoomId))!;
    assert.equal(row.body, body);
    // ...and the backlog wire still ships format 'html' + the original
    // markup: rendering is format-driven, never room-driven.
    const res = await app.inject({
      method: "GET",
      url: `/rooms/${flipRoomId}/messages?before=${Date.now() + 60_000}`,
      headers: auth(ownerToken),
    });
    assert.equal(res.statusCode, 200, res.body);
    const wire = (res.json() as { messages: Array<{ body: string; format?: string }> }).messages;
    const line = wire.find((m) => m.body === body);
    assert.ok(line, JSON.stringify(wire));
    assert.equal(line!.format, "html");
  });

  test("GET /rooms rows carry richTextDisabled for the composer", async () => {
    const res = await app.inject({ method: "GET", url: "/rooms", headers: auth(memberToken) });
    assert.equal(res.statusCode, 200);
    const rows = (res.json() as { rooms: Array<{ name: string; richTextDisabled?: boolean }> }).rooms;
    assert.equal(rows.find((r) => r.name === "Simple_Hall")!.richTextDisabled, true);
    assert.equal(rows.find((r) => r.name === "Full_Hall")!.richTextDisabled, false);
  });
});
