import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { registerMessageRoutes } from "../src/routes/messages.js";
import { enableAdultChannel } from "../src/lib/adultChannel.js";
import { createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Regression: editing a chat message in a room WITH an 18+ channel must
 * complete (the "save button becomes three dots forever" report). The
 * staff-pair mirror runs inside emitMessageUpdate; if it hangs or throws,
 * the PATCH never answers and every edit in a paired room wedges.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeIo(): any {
  return {
    async fetchSockets() { return []; },
    in() { return { async fetchSockets() { return []; }, emit() {} }; },
    to() { return { emit() {} }; },
    emit() {},
  };
}

let db: Db;
let app: FastifyInstance;
let author: { id: string };
let token: string;
let msgId: string;

before(async () => {
  db = makeTestDb().db;
  app = Fastify();
  await registerMessageRoutes(app, db, makeFakeIo());
  await app.ready();
  author = await createUser(db);
  token = await tokenFor(db, author.id);
  const roomId = nanoid();
  await db.insert(schema.rooms).values({
    id: roomId, name: "paired-room", slug: "paired-room", type: "public", ownerId: author.id,
  });
  const base = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, roomId)).limit(1))[0]!;
  const on = await enableAdultChannel(db, base);
  assert.ok(on.ok && on.channelRoomId, "pair exists");
  msgId = nanoid();
  await db.insert(schema.messages).values({
    id: msgId, roomId, userId: author.id, characterId: null,
    displayName: "author", kind: "say", body: "original",
  });
});

describe("PATCH /messages/:id in a paired room", () => {
  test("resolves promptly and persists the edit", async () => {
    const res = await Promise.race([
      app.inject({
        method: "PATCH",
        url: `/messages/${msgId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { body: "edited body" },
      }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("PATCH hung — pair mirror never settled")), 5000)),
    ]);
    assert.equal(res.statusCode, 200, res.body);
    const row = (await db.select().from(schema.messages).where(eq(schema.messages.id, msgId)).limit(1))[0]!;
    assert.equal(row.body, "edited body");
  });
});
