import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { registerWorldCoreRoutes } from "../src/routes/worlds/core.js";
import { registerWorldKnowledgeBaseRoutes } from "../src/routes/worlds/knowledgeBase.js";
import { registerWorldMapRoutes } from "../src/routes/worlds/maps.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * A6 follow-up surface (migration 0361): marker label display modes, the
 * https-only entity image validator, the entry→marker reverse lookup
 * (entity-map-refs) with its secret-marker scrub, and poi/town as builtin
 * WIKI entity kinds (kind parity with the map-marker kinds).
 */

const ADULT_DOB = "1990-01-01";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockIo: any = { fetchSockets: async () => [] };

async function buildApp(db: Db): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      reply.code(400);
      return reply.send({ error: "validation" });
    }
    throw err;
  });
  await registerWorldCoreRoutes(app, db, mockIo);
  await registerWorldKnowledgeBaseRoutes(app, db, mockIo);
  await registerWorldMapRoutes(app, db, mockIo, mkdtempSync(join(tmpdir(), "spire-maps-")));
  await app.ready();
  return app;
}

async function insertWorld(
  db: Db,
  opts: { ownerUserId: string; visibility?: "private" | "public" | "open" },
): Promise<string> {
  const id = nanoid();
  await db.insert(schema.worlds).values({
    id,
    ownerUserId: opts.ownerUserId,
    slug: `w-${id.slice(0, 8).toLowerCase()}`,
    name: "Label World",
    visibility: opts.visibility ?? "public",
  });
  return id;
}

describe("world map label modes + entry images + kind parity", () => {
  let db: Db;
  let app: FastifyInstance;
  let ownerId: string;
  let ownerToken: string;
  let strangerToken: string;

  before(async () => {
    ({ db } = makeTestDb());
    app = await buildApp(db);
    const owner = await createUser(db, { birthdate: ADULT_DOB });
    const stranger = await createUser(db, { birthdate: ADULT_DOB });
    ownerId = owner.id;
    ownerToken = await tokenFor(db, owner.id);
    strangerToken = await tokenFor(db, stranger.id);
  });

  async function createMap(worldId: string, body?: Record<string, unknown>) {
    const r = await app.inject({
      method: "POST",
      url: `/worlds/${worldId}/maps`,
      headers: auth(ownerToken),
      payload: { name: "Realm", imageUrl: "https://img.example/map.png", ...(body ?? {}) },
    });
    assert.equal(r.statusCode, 200);
    return (r.json() as { map: { id: string } }).map.id;
  }

  test("labelMode: defaults to icon, round-trips text/both, rejects unknown values", async () => {
    const worldId = await insertWorld(db, { ownerUserId: ownerId });
    const mapId = await createMap(worldId);
    const markersUrl = `/worlds/${worldId}/maps/${mapId}/markers`;

    // Omitted → the icon default (the pre-A6 behavior).
    const plain = await app.inject({
      method: "POST", url: markersUrl, headers: auth(ownerToken),
      payload: { kind: "poi", label: "Plain", x: 0.5, y: 0.5 },
    });
    assert.equal(plain.statusCode, 200);
    const pm = (plain.json() as { marker: { id: string; labelMode: string } }).marker;
    assert.equal(pm.labelMode, "icon");

    // Explicit create + PATCH round-trips.
    const texty = await app.inject({
      method: "POST", url: markersUrl, headers: auth(ownerToken),
      payload: { kind: "town", label: "Texty", x: 0.4, y: 0.4, labelMode: "text" },
    });
    assert.equal(texty.statusCode, 200);
    assert.equal((texty.json() as { marker: { labelMode: string } }).marker.labelMode, "text");

    const toBoth = await app.inject({
      method: "PATCH", url: `${markersUrl}/${pm.id}`, headers: auth(ownerToken),
      payload: { labelMode: "both" },
    });
    assert.equal(toBoth.statusCode, 200);
    assert.equal((toBoth.json() as { marker: { labelMode: string } }).marker.labelMode, "both");

    // Enum is closed: anything else is a 400.
    for (const bad of ["banner", "ICON", "", 3, null]) {
      const r = await app.inject({
        method: "POST", url: markersUrl, headers: auth(ownerToken),
        payload: { kind: "poi", label: "Bad", x: 0.5, y: 0.5, labelMode: bad },
      });
      assert.equal(r.statusCode, 400, `expected 400 for labelMode ${JSON.stringify(bad)}`);
    }
    const badPatch = await app.inject({
      method: "PATCH", url: `${markersUrl}/${pm.id}`, headers: auth(ownerToken),
      payload: { labelMode: "banner" },
    });
    assert.equal(badPatch.statusCode, 400);
  });

  test("pre-0361 marker rows read back with labelMode 'icon' and are otherwise unchanged", async () => {
    const worldId = await insertWorld(db, { ownerUserId: ownerId });
    const mapId = await createMap(worldId, { slug: "legacy" });
    // Raw insert that omits label_mode entirely — exactly what every row
    // written before the migration looks like (the column default fills).
    const legacyId = nanoid();
    await db.run(sql`
      INSERT INTO world_map_markers (id, map_id, kind, label, x, y, sort_order)
      VALUES (${legacyId}, ${mapId}, 'poi', 'Old pin', 0.25, 0.75, 0)
    `);
    const r = await app.inject({ method: "GET", url: `/worlds/${worldId}/maps/${mapId}`, headers: auth(ownerToken) });
    assert.equal(r.statusCode, 200);
    const marker = (r.json() as { markers: Array<Record<string, unknown>> }).markers.find((m) => m.id === legacyId);
    assert.ok(marker, "legacy row still arrives");
    assert.equal(marker.labelMode, "icon");
    assert.equal(marker.label, "Old pin");
    assert.equal(marker.x, 0.25);
    assert.equal(marker.y, 0.75);
  });

  test("entity imageUrl is https-only: javascript:/data:/http reject, https round-trips onto the wire", async () => {
    const worldId = await insertWorld(db, { ownerUserId: ownerId });
    let picN = 0;
    for (const bad of [
      "javascript:alert(1)",
      "data:image/png;base64,iVBORw0KGgo=",
      "http://img.example/npc.png",
      "not a url",
    ]) {
      const r = await app.inject({
        method: "POST", url: `/worlds/${worldId}/entities`, headers: auth(ownerToken),
        payload: { kind: "npc", name: "Pic test", slug: `pic-${picN++}`, imageUrl: bad },
      });
      assert.equal(r.statusCode, 400, `expected 400 for imageUrl ${bad}`);
    }
    const good = await app.inject({
      method: "POST", url: `/worlds/${worldId}/entities`, headers: auth(ownerToken),
      payload: { kind: "npc", name: "Captain Vane", slug: "captain-vane", imageUrl: "https://img.example/vane.png", isPublic: true },
    });
    assert.equal(good.statusCode, 200);
    const entity = (good.json() as { entity: { id: string; imageUrl: string } }).entity;
    assert.equal(entity.imageUrl, "https://img.example/vane.png");

    // PATCH validates the same way; the light rows on WorldDetail carry
    // the image so cards/popovers/panel thumbnails can render it.
    const badPatch = await app.inject({
      method: "PATCH", url: `/worlds/${worldId}/entities/${entity.id}`, headers: auth(ownerToken),
      payload: { imageUrl: "http://img.example/downgrade.png" },
    });
    assert.equal(badPatch.statusCode, 400);
    const detail = await app.inject({ method: "GET", url: `/worlds/${worldId}`, headers: auth(strangerToken) });
    assert.equal(detail.statusCode, 200);
    const light = (detail.json() as { entities: Array<{ slug: string; imageUrl: string | null }> })
      .entities.find((e) => e.slug === "captain-vane");
    assert.equal(light?.imageUrl, "https://img.example/vane.png");
  });

  test("entity-map-refs: non-secret refs for everyone the world resolves for; secret refs only for editors (byte-level)", async () => {
    const worldId = await insertWorld(db, { ownerUserId: ownerId });
    const mapId = await createMap(worldId, { slug: "atlas" });
    const markersUrl = `/worlds/${worldId}/maps/${mapId}/markers`;

    const open = await app.inject({
      method: "POST", url: markersUrl, headers: auth(ownerToken),
      payload: { kind: "town", label: "Port Vael", x: 0.2, y: 0.2, entryKind: "town", entrySlug: "port-vael" },
    });
    assert.equal(open.statusCode, 200);
    const openMarkerId = (open.json() as { marker: { id: string } }).marker.id;

    // Distinctive + SLUG_RX-safe (nanoid can emit "_", which a slug can't).
    const secretSlug = `hidden-lair-${Math.random().toString(36).slice(2, 8) || "x1"}`;
    const secret = await app.inject({
      method: "POST", url: markersUrl, headers: auth(ownerToken),
      payload: { kind: "location", label: "Hidden lair", x: 0.8, y: 0.8, entryKind: "location", entrySlug: secretSlug, isSecret: true },
    });
    assert.equal(secret.statusCode, 200);
    const secretMarkerId = (secret.json() as { marker: { id: string } }).marker.id;

    // A marker without an entry link contributes no ref at all.
    const unlinked = await app.inject({
      method: "POST", url: markersUrl, headers: auth(ownerToken),
      payload: { kind: "label", label: "Just text", x: 0.5, y: 0.5 },
    });
    assert.equal(unlinked.statusCode, 200);
    const unlinkedId = (unlinked.json() as { marker: { id: string } }).marker.id;

    // Editors get both refs.
    const asOwner = await app.inject({ method: "GET", url: `/worlds/${worldId}/entity-map-refs`, headers: auth(ownerToken) });
    assert.equal(asOwner.statusCode, 200);
    const ownerRefs = (asOwner.json() as { refs: Array<{ markerId: string; entrySlug: string; mapId: string; mapSlug: string }> }).refs;
    assert.equal(ownerRefs.length, 2);
    assert.ok(ownerRefs.some((r) => r.markerId === openMarkerId && r.entrySlug === "port-vael" && r.mapSlug === "atlas"));
    assert.ok(ownerRefs.some((r) => r.markerId === secretMarkerId && r.entrySlug === secretSlug));
    assert.ok(!ownerRefs.some((r) => r.markerId === unlinkedId));

    // Strangers and anonymous visitors never RECEIVE the secret ref: the
    // whole payload string is free of the marker id and the entry slug.
    for (const headers of [auth(strangerToken), undefined]) {
      const r = await app.inject({
        method: "GET",
        url: `/worlds/${worldId}/entity-map-refs`,
        ...(headers ? { headers } : {}),
      });
      assert.equal(r.statusCode, 200);
      assert.ok(!r.body.includes(secretMarkerId), "secret marker id must not reach non-editors");
      assert.ok(!r.body.includes(secretSlug), "secret entry slug must not reach non-editors");
      assert.ok(r.body.includes(openMarkerId), "public refs still arrive");
      assert.equal((r.json() as { refs: unknown[] }).refs.length, 1);
    }

    // resolveWorld composes: a private world's refs are 404 for strangers.
    const privateWorldId = await insertWorld(db, { ownerUserId: ownerId, visibility: "private" });
    const privAsStranger = await app.inject({
      method: "GET", url: `/worlds/${privateWorldId}/entity-map-refs`, headers: auth(strangerToken),
    });
    assert.equal(privAsStranger.statusCode, 404);
    const privAsOwner = await app.inject({
      method: "GET", url: `/worlds/${privateWorldId}/entity-map-refs`, headers: auth(ownerToken),
    });
    assert.equal(privAsOwner.statusCode, 200);
    assert.deepEqual((privAsOwner.json() as { refs: unknown[] }).refs, []);
  });

  test("kind parity: poi/town are builtin wiki kinds — CRUD round-trip, markers may link them, keys are reserved", async () => {
    const worldId = await insertWorld(db, { ownerUserId: ownerId });

    for (const kind of ["poi", "town"] as const) {
      const created = await app.inject({
        method: "POST", url: `/worlds/${worldId}/entities`, headers: auth(ownerToken),
        payload: { kind, name: `Some ${kind}`, slug: `some-${kind}`, summary: "A place", isPublic: true },
      });
      assert.equal(created.statusCode, 200, `create ${kind} entity`);
      const entity = (created.json() as { entity: { id: string; kind: string; slug: string } }).entity;
      assert.equal(entity.kind, kind);

      const fetched = await app.inject({
        method: "GET", url: `/worlds/${worldId}/entities/${entity.id}`, headers: auth(strangerToken),
      });
      assert.equal(fetched.statusCode, 200);

      const patched = await app.inject({
        method: "PATCH", url: `/worlds/${worldId}/entities/${entity.id}`, headers: auth(ownerToken),
        payload: { summary: "An updated place" },
      });
      assert.equal(patched.statusCode, 200);

      // The builtin keys are reserved — no custom kind can shadow them.
      const shadow = await app.inject({
        method: "POST", url: `/worlds/${worldId}/entity-kinds`, headers: auth(ownerToken),
        payload: { key: kind, label: "Shadow" },
      });
      assert.equal(shadow.statusCode, 409);
    }

    // A marker can now link a poi entry (entry kinds = entity kinds ∪ lore).
    const mapId = await createMap(worldId, { slug: "parity" });
    const linked = await app.inject({
      method: "POST", url: `/worlds/${worldId}/maps/${mapId}/markers`, headers: auth(ownerToken),
      payload: { kind: "poi", label: "Linked poi", x: 0.5, y: 0.5, entryKind: "poi", entrySlug: "some-poi" },
    });
    assert.equal(linked.statusCode, 200);
    const marker = (linked.json() as { marker: { entryKind: string; entrySlug: string } }).marker;
    assert.equal(marker.entryKind, "poi");
    assert.equal(marker.entrySlug, "some-poi");

    // event/label stay map-only annotations with no wiki twin.
    for (const kind of ["event", "label"]) {
      const r = await app.inject({
        method: "POST", url: `/worlds/${worldId}/entities`, headers: auth(ownerToken),
        payload: { kind, name: "Nope", slug: "nope" },
      });
      assert.equal(r.statusCode, 400, `entity kind ${kind} must stay invalid`);
    }
  });
});
