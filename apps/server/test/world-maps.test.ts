import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { registerWorldCoreRoutes } from "../src/routes/worlds/core.js";
import { registerWorldMapRoutes } from "../src/routes/worlds/maps.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * World maps + markers (migration 0359). Pins the resolveWorld +
 * canEditWorld composition on every route, the caps, world-scoped slug
 * uniqueness, the https-only image validator, fraction clamping, the
 * entry-link/kind validation, and — most important — the server-side
 * secret-marker scrub (non-editors must never RECEIVE secret rows, not
 * merely not render them).
 */

const ADULT_DOB = "1990-01-01";
const MINOR_DOB = "2012-06-01";

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
  await registerWorldMapRoutes(app, db, mockIo, mkdtempSync(join(tmpdir(), "spire-maps-")));
  await app.ready();
  return app;
}

async function insertWorld(
  db: Db,
  opts: { ownerUserId: string; visibility?: "private" | "public" | "open"; isNsfw?: boolean; name?: string },
): Promise<string> {
  const id = nanoid();
  await db.insert(schema.worlds).values({
    id,
    ownerUserId: opts.ownerUserId,
    slug: `w-${id.slice(0, 8).toLowerCase()}`,
    name: opts.name ?? "Map World",
    visibility: opts.visibility ?? "public",
    ...(opts.isNsfw !== undefined ? { isNsfw: opts.isNsfw } : {}),
  });
  return id;
}

describe("world maps + markers", () => {
  let db: Db;
  let app: FastifyInstance;
  let ownerId: string;
  let collabId: string;
  let ownerToken: string;
  let collabToken: string;
  let adminToken: string;
  let strangerToken: string;
  let minorToken: string;

  before(async () => {
    ({ db } = makeTestDb());
    app = await buildApp(db);
    const owner = await createUser(db, { birthdate: ADULT_DOB });
    const collab = await createUser(db, { birthdate: ADULT_DOB });
    const admin = await createUser(db, { role: "admin", birthdate: ADULT_DOB });
    const stranger = await createUser(db, { birthdate: ADULT_DOB });
    const minor = await createUser(db, { birthdate: MINOR_DOB });
    ownerId = owner.id;
    collabId = collab.id;
    ownerToken = await tokenFor(db, owner.id);
    collabToken = await tokenFor(db, collab.id);
    adminToken = await tokenFor(db, admin.id);
    strangerToken = await tokenFor(db, stranger.id);
    minorToken = await tokenFor(db, minor.id);
  });

  async function addCollab(worldId: string) {
    await db.insert(schema.worldCollaborators).values({ worldId, userId: collabId });
  }

  async function createMap(worldId: string, token: string, body?: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/worlds/${worldId}/maps`,
      headers: auth(token),
      payload: { name: "Realm", imageUrl: "https://img.example/map.png", ...(body ?? {}) },
    });
  }

  test("map create gates: owner, collaborator, and edit_others_world admin pass; member/stranger 403; anon 401", async () => {
    const worldId = await insertWorld(db, { ownerUserId: ownerId });
    await addCollab(worldId);

    const asOwner = await createMap(worldId, ownerToken, { name: "Owner map" });
    assert.equal(asOwner.statusCode, 200);
    const asCollab = await createMap(worldId, collabToken, { name: "Collab map" });
    assert.equal(asCollab.statusCode, 200);
    const asAdmin = await createMap(worldId, adminToken, { name: "Admin map" });
    assert.equal(asAdmin.statusCode, 200);

    const asStranger = await createMap(worldId, strangerToken, { name: "Nope" });
    assert.equal(asStranger.statusCode, 403);

    const anon = await app.inject({
      method: "POST",
      url: `/worlds/${worldId}/maps`,
      payload: { name: "Anon", imageUrl: "https://img.example/x.png" },
    });
    assert.equal(anon.statusCode, 401);
  });

  test("image URL validator rejects javascript:, data:, and plain-http downgrades", async () => {
    const worldId = await insertWorld(db, { ownerUserId: ownerId });
    for (const bad of [
      "javascript:alert(1)",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "http://img.example/map.png",
      "file:///etc/passwd",
      "not a url",
    ]) {
      const r = await createMap(worldId, ownerToken, { imageUrl: bad });
      assert.equal(r.statusCode, 400, `expected 400 for ${bad}`);
    }
    const good = await createMap(worldId, ownerToken, { imageUrl: "https://img.example/fine.webp" });
    assert.equal(good.statusCode, 200);
    assert.equal((good.json() as { map: { imageKind: string } }).map.imageKind, "external");
  });

  test("map slugs are unique per world (case-insensitive) but free across worlds; cap is 12", async () => {
    const worldId = await insertWorld(db, { ownerUserId: ownerId });
    const otherWorldId = await insertWorld(db, { ownerUserId: ownerId });

    const first = await createMap(worldId, ownerToken, { name: "Overworld", slug: "overworld" });
    assert.equal(first.statusCode, 200);
    const dup = await createMap(worldId, ownerToken, { name: "Overworld 2", slug: "OVERWORLD" });
    assert.equal(dup.statusCode, 409);
    const elsewhere = await createMap(otherWorldId, ownerToken, { name: "Overworld", slug: "overworld" });
    assert.equal(elsewhere.statusCode, 200);

    // 11 more on top of the first = 12 total, the 13th must 409.
    for (let i = 0; i < 11; i++) {
      const r = await createMap(worldId, ownerToken, { name: `Map ${i}`, slug: `map-${i}` });
      assert.equal(r.statusCode, 200);
    }
    const overCap = await createMap(worldId, ownerToken, { name: "One too many", slug: "map-extra" });
    assert.equal(overCap.statusCode, 409);
  });

  test("WorldDetail rides light map rows only; map-less worlds get an empty list", async () => {
    const worldId = await insertWorld(db, { ownerUserId: ownerId });
    const bare = await app.inject({ method: "GET", url: `/worlds/${worldId}`, headers: auth(strangerToken) });
    assert.equal(bare.statusCode, 200);
    assert.deepEqual((bare.json() as { maps: unknown[] }).maps, []);

    const created = await createMap(worldId, ownerToken, { name: "Atlas", slug: "atlas" });
    assert.equal(created.statusCode, 200);
    const detail = await app.inject({ method: "GET", url: `/worlds/${worldId}`, headers: auth(strangerToken) });
    const maps = (detail.json() as { maps: Array<Record<string, unknown>> }).maps;
    assert.equal(maps.length, 1);
    assert.equal(maps[0].slug, "atlas");
    assert.equal(maps[0].name, "Atlas");
    // Light rows stay light: no image URL / marker payload on the detail.
    assert.equal("imageUrl" in maps[0], false);
    assert.equal("markers" in maps[0], false);
  });

  test("map GET composes resolveWorld: NSFW worlds hide from anon + minors, private worlds from strangers", async () => {
    const nsfwWorldId = await insertWorld(db, { ownerUserId: ownerId, visibility: "public", isNsfw: true });
    const made = await createMap(nsfwWorldId, ownerToken, { name: "Adult map", slug: "adult" });
    assert.equal(made.statusCode, 200);

    const anon = await app.inject({ method: "GET", url: `/worlds/${nsfwWorldId}/maps/adult` });
    assert.equal(anon.statusCode, 404);
    const minor = await app.inject({ method: "GET", url: `/worlds/${nsfwWorldId}/maps/adult`, headers: auth(minorToken) });
    assert.equal(minor.statusCode, 404);
    const adult = await app.inject({ method: "GET", url: `/worlds/${nsfwWorldId}/maps/adult`, headers: auth(strangerToken) });
    assert.equal(adult.statusCode, 200);

    const privateWorldId = await insertWorld(db, { ownerUserId: ownerId, visibility: "private" });
    const priv = await createMap(privateWorldId, ownerToken, { name: "Hidden", slug: "hidden" });
    assert.equal(priv.statusCode, 200);
    const strangerPriv = await app.inject({ method: "GET", url: `/worlds/${privateWorldId}/maps/hidden`, headers: auth(strangerToken) });
    assert.equal(strangerPriv.statusCode, 404);
    const ownerPriv = await app.inject({ method: "GET", url: `/worlds/${privateWorldId}/maps/hidden`, headers: auth(ownerToken) });
    assert.equal(ownerPriv.statusCode, 200);
  });

  test("markers: fraction clamping, kind + entry-link validation, and CRUD gates", async () => {
    const worldId = await insertWorld(db, { ownerUserId: ownerId });
    const map = (await createMap(worldId, ownerToken, { name: "Marks", slug: "marks" })).json() as { map: { id: string } };
    const mapId = map.map.id;
    const markersUrl = `/worlds/${worldId}/maps/${mapId}/markers`;

    // Out-of-range fractions clamp to the edge with full precision kept in range.
    const clamped = await app.inject({
      method: "POST", url: markersUrl, headers: auth(ownerToken),
      payload: { kind: "poi", label: "Edge", x: 1.5, y: -0.25 },
    });
    assert.equal(clamped.statusCode, 200);
    const cm = (clamped.json() as { marker: { x: number; y: number; id: string } }).marker;
    assert.equal(cm.x, 1);
    assert.equal(cm.y, 0);

    const precise = await app.inject({
      method: "POST", url: markersUrl, headers: auth(ownerToken),
      payload: { kind: "town", label: "Precise", x: 0.123456789, y: 0.987654321 },
    });
    assert.equal(precise.statusCode, 200);
    assert.equal((precise.json() as { marker: { x: number } }).marker.x, 0.123456789);

    // Kind must be a builtin marker kind, a builtin entity kind, lore,
    // or a registered custom kind.
    const unknownKind = await app.inject({
      method: "POST", url: markersUrl, headers: auth(ownerToken),
      payload: { kind: "dragon", label: "Nope", x: 0.5, y: 0.5 },
    });
    assert.equal(unknownKind.statusCode, 400);
    const entityKind = await app.inject({
      method: "POST", url: markersUrl, headers: auth(ownerToken),
      payload: { kind: "npc", label: "Somebody", x: 0.5, y: 0.5 },
    });
    assert.equal(entityKind.statusCode, 200);
    await db.insert(schema.worldEntityKinds).values({ worldId, key: "deity", label: "Deities" });
    const customKind = await app.inject({
      method: "POST", url: markersUrl, headers: auth(ownerToken),
      payload: { kind: "deity", label: "Nox", x: 0.5, y: 0.5 },
    });
    assert.equal(customKind.statusCode, 200);

    // Entry link: both halves or neither; kind validated against the
    // world's ENTITY kinds (the map-only kinds event/label aren't
    // linkable targets — poi/town became real entity kinds in A6).
    const halfLink = await app.inject({
      method: "POST", url: markersUrl, headers: auth(ownerToken),
      payload: { kind: "poi", label: "Half", x: 0.5, y: 0.5, entryKind: "npc" },
    });
    assert.equal(halfLink.statusCode, 400);
    const badLinkKind = await app.inject({
      method: "POST", url: markersUrl, headers: auth(ownerToken),
      payload: { kind: "poi", label: "Bad", x: 0.5, y: 0.5, entryKind: "label", entrySlug: "somewhere" },
    });
    assert.equal(badLinkKind.statusCode, 400);
    const goodLink = await app.inject({
      method: "POST", url: markersUrl, headers: auth(ownerToken),
      payload: { kind: "poi", label: "Linked", x: 0.5, y: 0.5, entryKind: "npc", entrySlug: "captain-vane" },
    });
    assert.equal(goodLink.statusCode, 200);
    const linked = (goodLink.json() as { marker: { id: string; entryKind: string; entrySlug: string } }).marker;
    assert.equal(linked.entryKind, "npc");
    assert.equal(linked.entrySlug, "captain-vane");

    // Write gates: strangers can't create, move, or delete; anon 401.
    const strangerCreate = await app.inject({
      method: "POST", url: markersUrl, headers: auth(strangerToken),
      payload: { kind: "poi", label: "Nope", x: 0.5, y: 0.5 },
    });
    assert.equal(strangerCreate.statusCode, 403);
    const strangerMove = await app.inject({
      method: "PATCH", url: `${markersUrl}/${cm.id}`, headers: auth(strangerToken),
      payload: { x: 0.9 },
    });
    assert.equal(strangerMove.statusCode, 403);
    const strangerDelete = await app.inject({
      method: "DELETE", url: `${markersUrl}/${cm.id}`, headers: auth(strangerToken),
    });
    assert.equal(strangerDelete.statusCode, 403);
    const anonCreate = await app.inject({
      method: "POST", url: markersUrl,
      payload: { kind: "poi", label: "Anon", x: 0.5, y: 0.5 },
    });
    assert.equal(anonCreate.statusCode, 401);

    // PATCH move clamps like create, and collaborators can move too.
    await addCollab(worldId);
    const move = await app.inject({
      method: "PATCH", url: `${markersUrl}/${cm.id}`, headers: auth(collabToken),
      payload: { x: 2, y: 0.25 },
    });
    assert.equal(move.statusCode, 200);
    const moved = (move.json() as { marker: { x: number; y: number } }).marker;
    assert.equal(moved.x, 1);
    assert.equal(moved.y, 0.25);

    // Owner delete works and the row is gone.
    const del = await app.inject({ method: "DELETE", url: `${markersUrl}/${cm.id}`, headers: auth(ownerToken) });
    assert.equal(del.statusCode, 200);
    const after = await app.inject({ method: "GET", url: `/worlds/${worldId}/maps/${mapId}`, headers: auth(ownerToken) });
    const ids = (after.json() as { markers: Array<{ id: string }> }).markers.map((m) => m.id);
    assert.ok(!ids.includes(cm.id));
  });

  test("marker color and icon validation: 32-char color cap, slug-or-glyph icon, lowercase kind storage", async () => {
    const worldId = await insertWorld(db, { ownerUserId: ownerId });
    const map = (await createMap(worldId, ownerToken, { name: "Styled", slug: "styled" })).json() as { map: { id: string } };
    const markersUrl = `/worlds/${worldId}/maps/${map.map.id}/markers`;

    const longColor = await app.inject({
      method: "POST", url: markersUrl, headers: auth(ownerToken),
      payload: { kind: "poi", label: "Too colorful", x: 0.5, y: 0.5, color: "x".repeat(33) },
    });
    assert.equal(longColor.statusCode, 400);

    // Icon must be slug-shaped or a short glyph; a long non-slug fails.
    const badIcon = await app.inject({
      method: "POST", url: markersUrl, headers: auth(ownerToken),
      payload: { kind: "poi", label: "Bad icon", x: 0.5, y: 0.5, icon: "NotASlugTooLong" },
    });
    assert.equal(badIcon.statusCode, 400);

    const slugIcon = await app.inject({
      method: "POST", url: markersUrl, headers: auth(ownerToken),
      payload: { kind: "poi", label: "Sworded", x: 0.5, y: 0.5, color: "#e05c5c", icon: "sword" },
    });
    assert.equal(slugIcon.statusCode, 200);
    const sm = (slugIcon.json() as { marker: { color: string; icon: string } }).marker;
    assert.equal(sm.color, "#e05c5c");
    assert.equal(sm.icon, "sword");

    const glyphIcon = await app.inject({
      method: "POST", url: markersUrl, headers: auth(ownerToken),
      payload: { kind: "poi", label: "Castle", x: 0.5, y: 0.5, icon: "🏰" },
    });
    assert.equal(glyphIcon.statusCode, 200);
    assert.equal((glyphIcon.json() as { marker: { icon: string } }).marker.icon, "🏰");

    // Custom kinds match case-insensitively but store lowercase, so
    // client kind lookups and layer grouping never split on case.
    await db.insert(schema.worldEntityKinds).values({ worldId, key: "deity", label: "Deities" });
    const upperKind = await app.inject({
      method: "POST", url: markersUrl, headers: auth(ownerToken),
      payload: { kind: "DEITY", label: "Nox", x: 0.5, y: 0.5 },
    });
    assert.equal(upperKind.statusCode, 200);
    assert.equal((upperKind.json() as { marker: { kind: string } }).marker.kind, "deity");
  });

  test("secret markers are stripped server-side for non-editors (byte-level)", async () => {
    const worldId = await insertWorld(db, { ownerUserId: ownerId });
    const map = (await createMap(worldId, ownerToken, { name: "Secrets", slug: "secrets" })).json() as { map: { id: string } };
    const mapId = map.map.id;
    const secretLabel = `dm-secret-${nanoid(8)}`;
    const secret = await app.inject({
      method: "POST", url: `/worlds/${worldId}/maps/${mapId}/markers`, headers: auth(ownerToken),
      payload: { kind: "poi", label: secretLabel, x: 0.4, y: 0.4, isSecret: true, body: "<p>hidden lair</p>" },
    });
    assert.equal(secret.statusCode, 200);
    const secretId = (secret.json() as { marker: { id: string } }).marker.id;
    const open = await app.inject({
      method: "POST", url: `/worlds/${worldId}/maps/${mapId}/markers`, headers: auth(ownerToken),
      payload: { kind: "poi", label: "public-pin", x: 0.6, y: 0.6 },
    });
    assert.equal(open.statusCode, 200);

    // Editors receive the secret row (flagged so the client can dim it).
    const asOwner = await app.inject({ method: "GET", url: `/worlds/${worldId}/maps/${mapId}`, headers: auth(ownerToken) });
    assert.ok(asOwner.body.includes(secretLabel));
    assert.ok(asOwner.body.includes(secretId));

    // Members/strangers and anonymous visitors never RECEIVE it: the
    // whole payload string must be free of the label, the id, and the
    // secret body.
    for (const headers of [auth(strangerToken), undefined]) {
      const r = await app.inject({
        method: "GET",
        url: `/worlds/${worldId}/maps/${mapId}`,
        ...(headers ? { headers } : {}),
      });
      assert.equal(r.statusCode, 200);
      assert.ok(!r.body.includes(secretLabel), "secret label must not reach non-editors");
      assert.ok(!r.body.includes(secretId), "secret id must not reach non-editors");
      assert.ok(!r.body.includes("hidden lair"), "secret body must not reach non-editors");
      assert.ok(r.body.includes("public-pin"), "public markers still arrive");
    }
  });

  test("marker cap: the 301st marker on a map 409s", async () => {
    const worldId = await insertWorld(db, { ownerUserId: ownerId });
    const map = (await createMap(worldId, ownerToken, { name: "Dense", slug: "dense" })).json() as { map: { id: string } };
    const now = new Date();
    await db.insert(schema.worldMapMarkers).values(
      Array.from({ length: 300 }, (_, i) => ({
        id: nanoid(), mapId: map.map.id, kind: "poi", label: `m${i}`,
        x: 0.5, y: 0.5, sortOrder: i, createdAt: now, updatedAt: now,
      })),
    );
    const overCap = await app.inject({
      method: "POST", url: `/worlds/${worldId}/maps/${map.map.id}/markers`, headers: auth(ownerToken),
      payload: { kind: "poi", label: "301st", x: 0.5, y: 0.5 },
    });
    assert.equal(overCap.statusCode, 409);
  });

  test("map PATCH/DELETE gates + dimension hints; deleting a map cascades its markers", async () => {
    const worldId = await insertWorld(db, { ownerUserId: ownerId });
    const map = (await createMap(worldId, ownerToken, { name: "Doomed", slug: "doomed" })).json() as { map: { id: string } };
    const mapId = map.map.id;

    const strangerPatch = await app.inject({
      method: "PATCH", url: `/worlds/${worldId}/maps/${mapId}`, headers: auth(strangerToken),
      payload: { name: "Hijacked" },
    });
    assert.equal(strangerPatch.statusCode, 403);
    const strangerDelete = await app.inject({
      method: "DELETE", url: `/worlds/${worldId}/maps/${mapId}`, headers: auth(strangerToken),
    });
    assert.equal(strangerDelete.statusCode, 403);

    const dims = await app.inject({
      method: "PATCH", url: `/worlds/${worldId}/maps/${mapId}`, headers: auth(ownerToken),
      payload: { width: 4096, height: 2048 },
    });
    assert.equal(dims.statusCode, 200);
    const dimsMap = (dims.json() as { map: { width: number; height: number } }).map;
    assert.equal(dimsMap.width, 4096);
    assert.equal(dimsMap.height, 2048);

    // Swapping the image invalidates stale hints.
    const swapped = await app.inject({
      method: "PATCH", url: `/worlds/${worldId}/maps/${mapId}`, headers: auth(ownerToken),
      payload: { imageUrl: "https://img.example/other.png" },
    });
    assert.equal(swapped.statusCode, 200);
    assert.equal((swapped.json() as { map: { width: number | null } }).map.width, null);

    const marker = await app.inject({
      method: "POST", url: `/worlds/${worldId}/maps/${mapId}/markers`, headers: auth(ownerToken),
      payload: { kind: "poi", label: "Goes down with the ship", x: 0.5, y: 0.5 },
    });
    assert.equal(marker.statusCode, 200);
    const markerId = (marker.json() as { marker: { id: string } }).marker.id;

    const del = await app.inject({ method: "DELETE", url: `/worlds/${worldId}/maps/${mapId}`, headers: auth(ownerToken) });
    assert.equal(del.statusCode, 200);
    const orphan = (await db.select().from(schema.worldMapMarkers).where(eq(schema.worldMapMarkers.id, markerId)))[0];
    assert.equal(orphan, undefined);
    const gone = await app.inject({ method: "GET", url: `/worlds/${worldId}/maps/${mapId}`, headers: auth(ownerToken) });
    assert.equal(gone.statusCode, 404);
  });
});
