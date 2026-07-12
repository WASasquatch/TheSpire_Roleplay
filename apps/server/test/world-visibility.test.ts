import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { registerWorldCoreRoutes } from "../src/routes/worlds/core.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * World visibility tiers vs the catalog. The enum stays
 * private/public/open on the wire; only `open` is catalog-listed
 * (displayed as "Public"), `public` is link-only (displayed as
 * "Unlisted"), `private` is owner-only. These tests pin the PATCH
 * persistence of every tier transition and the exact catalog
 * membership rule so a rename of the display labels can never drift
 * the semantics.
 */

const ADULT_DOB = "1990-01-01";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockIo: any = { fetchSockets: async () => [] };

async function buildWorldsApp(db: Db): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      reply.code(400);
      return reply.send({ error: "validation" });
    }
    throw err;
  });
  await registerWorldCoreRoutes(app, db, mockIo);
  await app.ready();
  return app;
}

async function insertWorld(
  db: Db,
  opts: { ownerUserId: string; visibility?: "private" | "public" | "open"; status?: "active" | "featured" | "archived"; name?: string },
): Promise<string> {
  const id = nanoid();
  await db.insert(schema.worlds).values({
    id,
    ownerUserId: opts.ownerUserId,
    slug: `w-${id.slice(0, 8).toLowerCase()}`,
    name: opts.name ?? "Visibility World",
    visibility: opts.visibility ?? "private",
    ...(opts.status ? { status: opts.status } : {}),
  });
  return id;
}

async function visibilityOf(db: Db, worldId: string): Promise<string> {
  const row = (await db
    .select({ visibility: schema.worlds.visibility })
    .from(schema.worlds)
    .where(eq(schema.worlds.id, worldId)))[0];
  assert.ok(row, "world row must exist");
  return row.visibility;
}

async function catalogIds(app: FastifyInstance, token?: string): Promise<string[]> {
  const r = await app.inject({
    method: "GET",
    url: "/worlds/catalog",
    ...(token ? { headers: auth(token) } : {}),
  });
  assert.equal(r.statusCode, 200);
  return (r.json() as { entries: Array<{ id: string }> }).entries.map((e) => e.id);
}

describe("world visibility tiers vs the catalog", () => {
  let db: Db;
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;
  let viewerToken: string;

  before(async () => {
    ({ db } = makeTestDb());
    app = await buildWorldsApp(db);
    const owner = await createUser(db, { birthdate: ADULT_DOB });
    const viewer = await createUser(db, { birthdate: ADULT_DOB });
    ownerId = owner.id;
    ownerToken = await tokenFor(db, owner.id);
    viewerToken = await tokenFor(db, viewer.id);
  });

  test("PATCH persists every visibility transition", async () => {
    // private → public (unlisted) → open (catalog-listed), plus the
    // direct private → open jump on a second world.
    const steppedId = await insertWorld(db, { ownerUserId: ownerId });
    for (const next of ["public", "open"] as const) {
      const r = await app.inject({
        method: "PATCH",
        url: `/worlds/${steppedId}`,
        headers: auth(ownerToken),
        payload: { visibility: next },
      });
      assert.equal(r.statusCode, 200);
      assert.equal(await visibilityOf(db, steppedId), next);
    }

    // ...and back down: open → public (unlisted) → private must
    // persist the same way, so downgrades can never silently no-op.
    for (const next of ["public", "private"] as const) {
      const r = await app.inject({
        method: "PATCH",
        url: `/worlds/${steppedId}`,
        headers: auth(ownerToken),
        payload: { visibility: next },
      });
      assert.equal(r.statusCode, 200);
      assert.equal(await visibilityOf(db, steppedId), next);
    }

    const jumpId = await insertWorld(db, { ownerUserId: ownerId });
    const jump = await app.inject({
      method: "PATCH",
      url: `/worlds/${jumpId}`,
      headers: auth(ownerToken),
      payload: { visibility: "open" },
    });
    assert.equal(jump.statusCode, 200);
    assert.equal(await visibilityOf(db, jumpId), "open");
  });

  test("catalog lists a world only at open visibility, for owner and stranger alike", async () => {
    const worldId = await insertWorld(db, { ownerUserId: ownerId, name: "Flips to open" });

    // Private: nobody sees it in the catalog.
    assert.ok(!(await catalogIds(app, ownerToken)).includes(worldId));
    assert.ok(!(await catalogIds(app, viewerToken)).includes(worldId));

    // public (unlisted): still absent from the catalog for everyone —
    // the middle tier is link-only by design, flipping to it must NOT
    // start listing the world.
    const toPublic = await app.inject({
      method: "PATCH",
      url: `/worlds/${worldId}`,
      headers: auth(ownerToken),
      payload: { visibility: "public" },
    });
    assert.equal(toPublic.statusCode, 200);
    assert.ok(!(await catalogIds(app, ownerToken)).includes(worldId), "unlisted world must not list for the owner");
    assert.ok(!(await catalogIds(app, viewerToken)).includes(worldId), "unlisted world must not list for other users");
    assert.ok(!(await catalogIds(app)).includes(worldId), "unlisted world must not list anonymously");

    // ...but it stays reachable by direct link for a stranger.
    const direct = await app.inject({
      method: "GET",
      url: `/worlds/${worldId}`,
      headers: auth(viewerToken),
    });
    assert.equal(direct.statusCode, 200);
    assert.equal((direct.json() as { world: { visibility: string } }).world.visibility, "public");

    // open: NOW it lists, for the owner AND an unrelated viewer.
    const toOpen = await app.inject({
      method: "PATCH",
      url: `/worlds/${worldId}`,
      headers: auth(ownerToken),
      payload: { visibility: "open" },
    });
    assert.equal(toOpen.statusCode, 200);
    assert.ok((await catalogIds(app, ownerToken)).includes(worldId), "open world must list for the owner");
    assert.ok((await catalogIds(app, viewerToken)).includes(worldId), "open world must list for other users");

    // Downgrade open → public (unlisted): the catalog entry must
    // vanish again for everyone, not linger from the open stint.
    const backToPublic = await app.inject({
      method: "PATCH",
      url: `/worlds/${worldId}`,
      headers: auth(ownerToken),
      payload: { visibility: "public" },
    });
    assert.equal(backToPublic.statusCode, 200);
    assert.equal(await visibilityOf(db, worldId), "public");
    assert.ok(!(await catalogIds(app, ownerToken)).includes(worldId), "downgraded world must de-list for the owner");
    assert.ok(!(await catalogIds(app, viewerToken)).includes(worldId), "downgraded world must de-list for other users");
    assert.ok(!(await catalogIds(app)).includes(worldId), "downgraded world must de-list anonymously");

    // ...and the final public → private step also stays de-listed.
    const backToPrivate = await app.inject({
      method: "PATCH",
      url: `/worlds/${worldId}`,
      headers: auth(ownerToken),
      payload: { visibility: "private" },
    });
    assert.equal(backToPrivate.statusCode, 200);
    assert.equal(await visibilityOf(db, worldId), "private");
    assert.ok(!(await catalogIds(app, ownerToken)).includes(worldId));
    assert.ok(!(await catalogIds(app, viewerToken)).includes(worldId));
  });

  test("archived worlds stay out of the catalog even at open visibility", async () => {
    const archivedId = await insertWorld(db, {
      ownerUserId: ownerId,
      visibility: "open",
      status: "archived",
    });
    assert.ok(!(await catalogIds(app, ownerToken)).includes(archivedId));
    assert.ok(!(await catalogIds(app, viewerToken)).includes(archivedId));
    // Direct link still resolves (archived hides from browse only).
    const direct = await app.inject({
      method: "GET",
      url: `/worlds/${archivedId}`,
      headers: auth(viewerToken),
    });
    assert.equal(direct.statusCode, 200);
  });
});
