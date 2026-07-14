import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { registerWorldCoreRoutes } from "../src/routes/worlds/core.js";
import { registerWorldMapRoutes } from "../src/routes/worlds/maps.js";
import { ensureSiteSettings, updateSettings } from "../src/settings.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * World map uploads (migration 0360, admin-gated, default OFF). Pins the
 * server-side boundary: the route — not the hidden client affordance — must
 * reject data-URL bodies while the switch is off; when on, the existing
 * data-URL pipeline applies (magic-byte sniff with SVG excluded forever,
 * the 6MB cap as 413, a per-world stored-image quota, content-hashed
 * filenames under /uploads/worldmaps/<worldId>/, and orphaned files
 * unlinked on delete/replace).
 */

const ADULT_DOB = "1990-01-01";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockIo: any = { fetchSockets: async () => [] };

/** Bytes with a valid PNG signature (the sniff only reads the magic). */
function pngBytes(seed: string, padTo = 0): Buffer {
  const body = Buffer.from(`png-body-${seed}`);
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const base = Buffer.concat([magic, body]);
  if (padTo <= base.length) return base;
  return Buffer.concat([base, Buffer.alloc(padTo - base.length)]);
}

function asDataUrl(bytes: Buffer, mime = "image/png"): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

describe("world map uploads (admin-gated)", () => {
  let db: Db;
  let app: FastifyInstance;
  let uploadsRoot: string;
  let ownerId: string;
  let ownerToken: string;

  before(async () => {
    ({ db } = makeTestDb());
    uploadsRoot = mkdtempSync(join(tmpdir(), "spire-map-uploads-"));
    const fastify = Fastify();
    fastify.setErrorHandler((err, _req, reply) => {
      if (err instanceof ZodError) {
        reply.code(400);
        return reply.send({ error: "validation" });
      }
      throw err;
    });
    await registerWorldCoreRoutes(fastify, db, mockIo);
    await registerWorldMapRoutes(fastify, db, mockIo, uploadsRoot);
    await fastify.ready();
    app = fastify;
    await ensureSiteSettings(db);
    const owner = await createUser(db, { birthdate: ADULT_DOB });
    ownerId = owner.id;
    ownerToken = await tokenFor(db, owner.id);
  });

  async function insertWorld(): Promise<string> {
    const id = nanoid();
    await db.insert(schema.worlds).values({
      id,
      ownerUserId: ownerId,
      slug: `w-${id.slice(0, 8).toLowerCase()}`,
      name: "Upload World",
      visibility: "public",
    });
    return id;
  }

  async function createMap(worldId: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/worlds/${worldId}/maps`,
      headers: auth(ownerToken),
      payload: { name: `Map ${nanoid(6)}`, ...body },
    });
  }

  /** Filesystem path a stored /uploads/worldmaps/... URL resolves to. */
  function diskPath(url: string): string {
    const segments = url.split("/").filter(Boolean); // uploads, worldmaps, <wid>, <file>
    return join(uploadsRoot, ...segments.slice(1));
  }

  test("default OFF: a data-URL body is rejected 403 and nothing is written", async () => {
    const worldId = await insertWorld();
    const r = await createMap(worldId, { imageDataUrl: asDataUrl(pngBytes("off")) });
    assert.equal(r.statusCode, 403);
    assert.ok((r.json() as { error: string }).error.length > 0);
    assert.equal(existsSync(join(uploadsRoot, "worldmaps", worldId)), false);

    // External https URLs keep working while uploads are off.
    const external = await createMap(worldId, { imageUrl: "https://img.example/atlas.png" });
    assert.equal(external.statusCode, 200);
    assert.equal((external.json() as { map: { imageKind: string } }).map.imageKind, "external");
  });

  test("ON: a sniffed PNG lands content-hashed under /uploads/worldmaps/<worldId>/ with imageKind 'upload'", async () => {
    await updateSettings(db, { worldMapUploadsEnabled: true }, ownerId);
    const worldId = await insertWorld();
    const r = await createMap(worldId, { imageDataUrl: asDataUrl(pngBytes("on")) });
    assert.equal(r.statusCode, 200);
    const map = (r.json() as { map: { imageKind: string; imageUrl: string } }).map;
    assert.equal(map.imageKind, "upload");
    assert.match(map.imageUrl, new RegExp(`^/uploads/worldmaps/${worldId}/[a-f0-9]{16}\\.png$`));
    assert.equal(existsSync(diskPath(map.imageUrl)), true);

    // GIF magic is on the allowlist too.
    const gif = Buffer.concat([Buffer.from([0x47, 0x49, 0x46, 0x38]), Buffer.from("gif-body")]);
    const g = await createMap(worldId, { imageDataUrl: asDataUrl(gif, "image/gif") });
    assert.equal(g.statusCode, 200);
    assert.match((g.json() as { map: { imageUrl: string } }).map.imageUrl, /\.gif$/);

    // WEBP needs BOTH the RIFF container header and the "WEBP" fourcc.
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([8, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.from("webp-body")]);
    const wr = await createMap(worldId, { imageDataUrl: asDataUrl(webp, "image/webp") });
    assert.equal(wr.statusCode, 200);
    assert.match((wr.json() as { map: { imageUrl: string } }).map.imageUrl, /\.webp$/);
  });

  test("sniff rejections: SVG bytes and mislabeled non-images 415, malformed data URLs 400", async () => {
    const worldId = await insertWorld();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    // Even an honest SVG mime is refused — SVG is never uploadable.
    const asSvg = await createMap(worldId, { imageDataUrl: asDataUrl(svg, "image/svg+xml") });
    assert.equal(asSvg.statusCode, 415);
    // SVG bytes smuggled under a PNG mime fail the magic sniff the same way.
    const smuggled = await createMap(worldId, { imageDataUrl: asDataUrl(svg, "image/png") });
    assert.equal(smuggled.statusCode, 415);
    const text = await createMap(worldId, { imageDataUrl: asDataUrl(Buffer.from("plain text"), "image/png") });
    assert.equal(text.statusCode, 415);
    // A RIFF file that is not WEBP (e.g. WAV) fails the fourcc check.
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.from([8, 0, 0, 0]), Buffer.from("WAVEfmt "), Buffer.from("wav-body")]);
    const asWebp = await createMap(worldId, { imageDataUrl: asDataUrl(wav, "image/webp") });
    assert.equal(asWebp.statusCode, 415);

    const notADataUrl = await createMap(worldId, { imageDataUrl: `x`.repeat(64) });
    assert.equal(notADataUrl.statusCode, 400);
    assert.equal(existsSync(join(uploadsRoot, "worldmaps", worldId)), false);
  });

  test("6MB cap: an oversized image is 413", async () => {
    const worldId = await insertWorld();
    const big = pngBytes("big", 6 * 1024 * 1024 + 1);
    const r = await createMap(worldId, { imageDataUrl: asDataUrl(big) });
    assert.equal(r.statusCode, 413);
  });

  test("per-world quota: the 11th stored image is 409; external links stay available", async () => {
    const worldId = await insertWorld();
    for (let i = 0; i < 10; i++) {
      const r = await createMap(worldId, { imageDataUrl: asDataUrl(pngBytes(`quota-${i}`)) });
      assert.equal(r.statusCode, 200, `upload ${i} should pass`);
    }
    const overQuota = await createMap(worldId, { imageDataUrl: asDataUrl(pngBytes("quota-extra")) });
    assert.equal(overQuota.statusCode, 409);
    const external = await createMap(worldId, { imageUrl: "https://img.example/spillover.png" });
    assert.equal(external.statusCode, 200);
  });

  test("replacement + delete unlink orphans; a hash-shared file survives its twin", async () => {
    const worldId = await insertWorld();
    const first = (await createMap(worldId, { imageDataUrl: asDataUrl(pngBytes("gen1")) })).json() as {
      map: { id: string; imageUrl: string };
    };
    const firstPath = diskPath(first.map.imageUrl);
    assert.equal(existsSync(firstPath), true);

    // Uploading a new image over the old one sweeps the replaced file.
    const patched = await app.inject({
      method: "PATCH",
      url: `/worlds/${worldId}/maps/${first.map.id}`,
      headers: auth(ownerToken),
      payload: { imageDataUrl: asDataUrl(pngBytes("gen2")) },
    });
    assert.equal(patched.statusCode, 200);
    const patchedMap = (patched.json() as { map: { imageUrl: string; imageKind: string } }).map;
    assert.equal(patchedMap.imageKind, "upload");
    assert.notEqual(patchedMap.imageUrl, first.map.imageUrl);
    assert.equal(existsSync(firstPath), false, "replaced upload must be unlinked");
    const secondPath = diskPath(patchedMap.imageUrl);
    assert.equal(existsSync(secondPath), true);

    // Switching back to an external URL orphans (and sweeps) the stored file.
    const toExternal = await app.inject({
      method: "PATCH",
      url: `/worlds/${worldId}/maps/${first.map.id}`,
      headers: auth(ownerToken),
      payload: { imageUrl: "https://img.example/back-external.png" },
    });
    assert.equal(toExternal.statusCode, 200);
    assert.equal((toExternal.json() as { map: { imageKind: string } }).map.imageKind, "external");
    assert.equal(existsSync(secondPath), false, "abandoned upload must be unlinked");

    // Two maps sharing identical bytes share one content-hashed file; the
    // file only goes once BOTH referencing maps are gone.
    const twinA = (await createMap(worldId, { imageDataUrl: asDataUrl(pngBytes("twin")) })).json() as { map: { id: string; imageUrl: string } };
    const twinB = (await createMap(worldId, { imageDataUrl: asDataUrl(pngBytes("twin")) })).json() as { map: { id: string; imageUrl: string } };
    assert.equal(twinA.map.imageUrl, twinB.map.imageUrl);
    const twinPath = diskPath(twinA.map.imageUrl);
    const delA = await app.inject({ method: "DELETE", url: `/worlds/${worldId}/maps/${twinA.map.id}`, headers: auth(ownerToken) });
    assert.equal(delA.statusCode, 200);
    assert.equal(existsSync(twinPath), true, "file still referenced by the twin map");
    const delB = await app.inject({ method: "DELETE", url: `/worlds/${worldId}/maps/${twinB.map.id}`, headers: auth(ownerToken) });
    assert.equal(delB.statusCode, 200);
    assert.equal(existsSync(twinPath), false, "orphaned file swept with the last map");
  });

  test("toggling back OFF re-arms the 403 for PATCH too", async () => {
    const worldId = await insertWorld();
    const map = (await createMap(worldId, { imageDataUrl: asDataUrl(pngBytes("rearm")) })).json() as { map: { id: string } };
    await updateSettings(db, { worldMapUploadsEnabled: false }, ownerId);
    const r = await app.inject({
      method: "PATCH",
      url: `/worlds/${worldId}/maps/${map.map.id}`,
      headers: auth(ownerToken),
      payload: { imageDataUrl: asDataUrl(pngBytes("rearm-2")) },
    });
    assert.equal(r.statusCode, 403);
    await updateSettings(db, { worldMapUploadsEnabled: true }, ownerId);
  });
});
