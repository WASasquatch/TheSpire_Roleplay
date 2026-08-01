import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import type { WorldExportDossier } from "@thekeep/shared";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { registerWorldExportRoutes } from "../src/routes/worlds/exportDossier.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * The world export dossier (GET /worlds/:idOrSlug/export), which feeds the
 * "print this world as a magazine" PDF.
 *
 * The point of these tests is that the dossier can never be a WIDER view of a
 * world than the wiki is. It ships bodies, markers and the Overlook scene in
 * one payload, so every visibility rule the lazy per-entry routes apply has to
 * be reproduced here. A leak would land in a file the reader keeps.
 */

const ADULT_DOB = "1990-01-01";
const MINOR_DOB = "2012-06-01";

async function buildApp(db: Db): Promise<FastifyInstance> {
  const app = Fastify();
  await registerWorldExportRoutes(app, db);
  await app.ready();
  return app;
}

async function insertWorld(
  db: Db,
  opts: { ownerUserId: string; visibility?: "private" | "public" | "open"; isNsfw?: boolean; overlookEnabled?: boolean },
): Promise<string> {
  const id = nanoid();
  await db.insert(schema.worlds).values({
    id,
    ownerUserId: opts.ownerUserId,
    slug: `w-${id.slice(0, 8).toLowerCase()}`,
    name: "Halcyon",
    visibility: opts.visibility ?? "public",
    ...(opts.isNsfw !== undefined ? { isNsfw: opts.isNsfw } : {}),
    ...(opts.overlookEnabled !== undefined ? { overlookEnabled: opts.overlookEnabled } : {}),
  });
  return id;
}

describe("world export dossier", () => {
  let db: Db;
  let app: FastifyInstance;
  let ownerId: string;
  let collabId: string;
  let ownerToken: string;
  let collabToken: string;
  let strangerToken: string;
  let minorToken: string;

  before(async () => {
    ({ db } = makeTestDb());
    app = await buildApp(db);
    const owner = await createUser(db, { birthdate: ADULT_DOB });
    const collab = await createUser(db, { birthdate: ADULT_DOB });
    const stranger = await createUser(db, { birthdate: ADULT_DOB });
    const minor = await createUser(db, { birthdate: MINOR_DOB });
    ownerId = owner.id;
    collabId = collab.id;
    ownerToken = await tokenFor(db, owner.id);
    collabToken = await tokenFor(db, collab.id);
    strangerToken = await tokenFor(db, stranger.id);
    minorToken = await tokenFor(db, minor.id);
  });

  async function get(worldId: string, token?: string) {
    return app.inject({
      method: "GET",
      url: `/worlds/${worldId}/export`,
      ...(token ? { headers: auth(token) } : {}),
    });
  }

  /** A world with one public and one private entry, plus a mapped secret. */
  async function seedWorld(worldId: string) {
    await db.insert(schema.worldPages).values({
      id: nanoid(), worldId, slug: "cosmology", title: "Cosmology", bodyHtml: "<p>Stars</p>",
    });
    await db.insert(schema.worldEntities).values([
      { id: nanoid(), worldId, kind: "npc", slug: "vane", name: "Captain Vane", bodyHtml: "<p>Public</p>", isPublic: 1 },
      { id: nanoid(), worldId, kind: "npc", slug: "mole", name: "The Mole", bodyHtml: "<p>Secret</p>", isPublic: 0 },
    ]);
    await db.insert(schema.worldSessions).values({
      id: nanoid(), worldId, slug: "s1", title: "First night", bodyHtml: "<p>Log</p>",
    });
    const mapId = nanoid();
    await db.insert(schema.worldMaps).values({
      id: mapId, worldId, slug: "realm", name: "Realm", imageUrl: "https://img.example/m.png",
    });
    await db.insert(schema.worldMapMarkers).values([
      { id: nanoid(), mapId, kind: "poi", label: "Harbour", x: 0.2, y: 0.3, isSecret: false },
      { id: nanoid(), mapId, kind: "poi", label: "Smuggler cove", x: 0.6, y: 0.7, isSecret: true },
    ]);
  }

  test("editors receive private entries and secret markers; readers receive neither", async () => {
    const worldId = await insertWorld(db, { ownerUserId: ownerId });
    await seedWorld(worldId);

    const asOwner = await get(worldId, ownerToken);
    assert.equal(asOwner.statusCode, 200);
    const owned = asOwner.json() as WorldExportDossier;
    assert.equal(owned.viewerCanEdit, true);
    assert.deepEqual(owned.entities.map((e) => e.slug).sort(), ["mole", "vane"]);
    assert.equal(owned.maps[0]?.markers.length, 2);
    // Bodies are the whole reason this endpoint exists.
    assert.equal(owned.entities.find((e) => e.slug === "vane")?.bodyHtml, "<p>Public</p>");
    assert.equal(owned.sessions[0]?.bodyHtml, "<p>Log</p>");
    assert.equal(owned.pages[0]?.bodyHtml, "<p>Stars</p>");

    const asStranger = await get(worldId, strangerToken);
    assert.equal(asStranger.statusCode, 200);
    const read = asStranger.json() as WorldExportDossier;
    assert.equal(read.viewerCanEdit, false);
    assert.deepEqual(read.entities.map((e) => e.slug), ["vane"]);
    assert.deepEqual(read.maps[0]?.markers.map((m) => m.label), ["Harbour"]);
  });

  test("collaborators are editors here too", async () => {
    const worldId = await insertWorld(db, { ownerUserId: ownerId });
    await seedWorld(worldId);
    await db.insert(schema.worldCollaborators).values({ worldId, userId: collabId });

    const res = await get(worldId, collabToken);
    assert.equal(res.statusCode, 200);
    const dossier = res.json() as WorldExportDossier;
    assert.equal(dossier.viewerCanEdit, true);
    assert.equal(dossier.entities.length, 2);
  });

  test("private worlds 404 for everyone but their editors", async () => {
    const worldId = await insertWorld(db, { ownerUserId: ownerId, visibility: "private" });
    assert.equal((await get(worldId, ownerToken)).statusCode, 200);
    assert.equal((await get(worldId, strangerToken)).statusCode, 404);
    assert.equal((await get(worldId)).statusCode, 404);
  });

  test("18+ worlds 404 for minors and anonymous callers, with no owner bypass", async () => {
    const worldId = await insertWorld(db, { ownerUserId: ownerId, isNsfw: true });
    assert.equal((await get(worldId, ownerToken)).statusCode, 200);
    assert.equal((await get(worldId, minorToken)).statusCode, 404);
    assert.equal((await get(worldId)).statusCode, 404);
  });

  test("the Overlook scene rides along only when the world opted in", async () => {
    const off = await insertWorld(db, { ownerUserId: ownerId, overlookEnabled: false });
    await db.insert(schema.overlooks).values({
      id: nanoid(), worldId: off, sceneJson: '{"elements":[{"id":"a"}]}', elementCount: 1,
    });
    assert.equal((await get(off, ownerToken)).json().overlookSceneJson, null);

    const on = await insertWorld(db, { ownerUserId: ownerId, overlookEnabled: true });
    await db.insert(schema.overlooks).values({
      id: nanoid(), worldId: on, sceneJson: '{"elements":[{"id":"a"}]}', elementCount: 1,
    });
    assert.equal(
      (await get(on, ownerToken)).json().overlookSceneJson,
      '{"elements":[{"id":"a"}]}',
    );

    // Switched on but never drawn on: nothing to print, so nothing is sent.
    const blank = await insertWorld(db, { ownerUserId: ownerId, overlookEnabled: true });
    await db.insert(schema.overlooks).values({
      id: nanoid(), worldId: blank, sceneJson: '{"elements":[]}', elementCount: 0,
    });
    assert.equal((await get(blank, ownerToken)).json().overlookSceneJson, null);
  });

  test("sessions read forward, unlike the viewer's newest-first list", async () => {
    const worldId = await insertWorld(db, { ownerUserId: ownerId });
    await db.insert(schema.worldSessions).values([
      { id: nanoid(), worldId, slug: "late", title: "Late", sessionDate: new Date(2_000_000) },
      { id: nanoid(), worldId, slug: "early", title: "Early", sessionDate: new Date(1_000_000) },
    ]);
    const dossier = (await get(worldId, ownerToken)).json() as WorldExportDossier;
    assert.deepEqual(dossier.sessions.map((s) => s.slug), ["early", "late"]);
  });
});
