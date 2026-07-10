import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { registerWorldCoreRoutes } from "../src/routes/worlds/core.js";
import { registerWorldMembershipRoutes } from "../src/routes/worlds/membership.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Phase 4 world gates (age-restriction plan, plan_ext §B5 + §F):
 * `worlds.is_nsfw` HARD-blocks minors + anonymous at the resolveWorld
 * chokepoint (detail payload, the /w/:slug page's data fetch, and every
 * pages/membership/application route behind it), SOFT-hides 18+ worlds
 * from browse listings for anyone with canSeeNsfw=false, and is
 * adult-owner-set only. Flag flips keep membership rows (keep-but-hide).
 */

const MINOR_DOB = "2012-01-01";
const ADULT_DOB = "1990-01-01";

// Membership join fires a presence rebroadcast; with no live sockets it
// no-ops, which is all these HTTP-level tests need.
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
  await registerWorldMembershipRoutes(app, db, mockIo);
  await app.ready();
  return app;
}

async function insertWorld(
  db: Db,
  opts: { ownerUserId: string; isNsfw?: boolean; visibility?: string; slug?: string; name?: string },
): Promise<string> {
  const id = nanoid();
  await db.insert(schema.worlds).values({
    id,
    ownerUserId: opts.ownerUserId,
    slug: opts.slug ?? `w-${id.slice(0, 8).toLowerCase()}`,
    name: opts.name ?? "Test World",
    visibility: (opts.visibility ?? "open") as "private" | "public" | "open",
    isNsfw: opts.isNsfw ?? false,
  });
  return id;
}

describe("18+ worlds (plan §B5)", () => {
  let db: Db;
  let app: FastifyInstance;
  let adultOwnerId: string;
  let adultOwnerToken: string;
  let minorToken: string;
  let minorId: string;
  let minorOwnerToken: string;
  let minorOwnerId: string;
  let hidePrefToken: string;
  let sfwWorldId: string;
  let nsfwWorldId: string;
  let nsfwWorldSlug: string;

  before(async () => {
    ({ db } = makeTestDb());
    app = await buildWorldsApp(db);
    const adultOwner = await createUser(db, { birthdate: ADULT_DOB });
    const minor = await createUser(db, { birthdate: MINOR_DOB });
    const minorOwner = await createUser(db, { birthdate: MINOR_DOB });
    const hidePref = await createUser(db, { birthdate: ADULT_DOB, hideNsfw: true });
    adultOwnerId = adultOwner.id;
    minorId = minor.id;
    minorOwnerId = minorOwner.id;
    adultOwnerToken = await tokenFor(db, adultOwner.id);
    minorToken = await tokenFor(db, minor.id);
    minorOwnerToken = await tokenFor(db, minorOwner.id);
    hidePrefToken = await tokenFor(db, hidePref.id);

    sfwWorldId = await insertWorld(db, { ownerUserId: adultOwner.id, name: "All ages" });
    nsfwWorldId = await insertWorld(db, { ownerUserId: adultOwner.id, isNsfw: true, name: "Adults" });
    nsfwWorldSlug = (await db
      .select({ slug: schema.worlds.slug })
      .from(schema.worlds)
      .where(eq(schema.worlds.id, nsfwWorldId)))[0]!.slug;
  });

  /* ── Browse listings (SOFT: canSeeNsfw) ────────────────────────── */

  test("catalog hides 18+ worlds from anon / minor / hide-pref adult; adult sees the flag", async () => {
    for (const headers of [undefined, auth(minorToken), auth(hidePrefToken)]) {
      const r = await app.inject({ method: "GET", url: "/worlds/catalog", ...(headers ? { headers } : {}) });
      assert.equal(r.statusCode, 200);
      const ids = (r.json() as { entries: Array<{ id: string }> }).entries.map((e) => e.id);
      assert.ok(ids.includes(sfwWorldId));
      assert.ok(!ids.includes(nsfwWorldId), "18+ world must not list");
    }
    const adult = await app.inject({ method: "GET", url: "/worlds/catalog", headers: auth(adultOwnerToken) });
    const entries = (adult.json() as { entries: Array<{ id: string; isNsfw?: boolean }> }).entries;
    const nsfwEntry = entries.find((e) => e.id === nsfwWorldId);
    assert.ok(nsfwEntry, "adult should see the 18+ world listed");
    assert.equal(nsfwEntry.isNsfw, true, "card carries the 18+ flag for the chip");
  });

  test("featured strip applies the same exclusion", async () => {
    const asMinor = await app.inject({ method: "GET", url: "/worlds/featured", headers: auth(minorToken) });
    const minorIds = (asMinor.json() as { entries: Array<{ id: string }> }).entries.map((e) => e.id);
    assert.ok(!minorIds.includes(nsfwWorldId));
    const asAdult = await app.inject({ method: "GET", url: "/worlds/featured", headers: auth(adultOwnerToken) });
    const adultIds = (asAdult.json() as { entries: Array<{ id: string }> }).entries.map((e) => e.id);
    assert.ok(adultIds.includes(nsfwWorldId));
  });

  /* ── Viewer / deep-link payload (HARD: isAdult) ────────────────── */

  test("world detail 404s for minors and anonymous, opens for adults incl. hide-pref", async () => {
    const asMinor = await app.inject({ method: "GET", url: `/worlds/${nsfwWorldId}`, headers: auth(minorToken) });
    assert.equal(asMinor.statusCode, 404);
    const asAnon = await app.inject({ method: "GET", url: `/worlds/${nsfwWorldSlug}` });
    assert.equal(asAnon.statusCode, 404);
    const asAdult = await app.inject({ method: "GET", url: `/worlds/${nsfwWorldId}`, headers: auth(adultOwnerToken) });
    assert.equal(asAdult.statusCode, 200);
    assert.equal((asAdult.json() as { world: { isNsfw?: boolean } }).world.isNsfw, true);
    const asHidePref = await app.inject({ method: "GET", url: `/worlds/${nsfwWorldId}`, headers: auth(hidePrefToken) });
    assert.equal(asHidePref.statusCode, 200, "hide preference is SOFT only; direct open stays adult-allowed");
  });

  test("anonymous private-world stub never leaks an 18+ world's name", async () => {
    const nsfwPrivateId = await insertWorld(db, { ownerUserId: adultOwnerId, isNsfw: true, visibility: "private" });
    const sfwPrivateId = await insertWorld(db, { ownerUserId: adultOwnerId, visibility: "private" });
    const nsfw = await app.inject({ method: "GET", url: `/worlds/${nsfwPrivateId}` });
    assert.equal(nsfw.statusCode, 404, "18+ private world must be a plain 404 for anonymous");
    const sfw = await app.inject({ method: "GET", url: `/worlds/${sfwPrivateId}` });
    assert.equal(sfw.statusCode, 200, "SFW private stub behavior unchanged");
    assert.equal((sfw.json() as { private?: true }).private, true);
  });

  /* ── Flag writes (adult owners only) ───────────────────────────── */

  test("minor owner cannot set the 18+ flag on their own world", async () => {
    const mineId = await insertWorld(db, { ownerUserId: minorOwnerId });
    const r = await app.inject({
      method: "PATCH",
      url: `/worlds/${mineId}`,
      headers: auth(minorOwnerToken),
      payload: { isNsfw: true },
    });
    assert.equal(r.statusCode, 400);
    assert.match((r.json() as { error: string }).error, /adults/);
  });

  test("minor cannot create a world born 18+", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/worlds",
      headers: auth(minorOwnerToken),
      payload: { name: "Nope", isNsfw: true },
    });
    assert.equal(r.statusCode, 400);
    assert.match((r.json() as { error: string }).error, /adults/);
  });

  test("adult owner can create and toggle 18+ worlds; collaborators cannot re-rate", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/worlds",
      headers: auth(adultOwnerToken),
      payload: { name: "Born adult", isNsfw: true, visibility: "open" },
    });
    assert.equal(created.statusCode, 201);
    assert.equal((created.json() as { isNsfw?: boolean }).isNsfw, true);

    // An adult COLLABORATOR passes canEditWorld for pages/metadata but
    // may not flip the world's rating (owner or edit_others_world only).
    const collaborator = await createUser(db, { birthdate: ADULT_DOB });
    const collabToken = await tokenFor(db, collaborator.id);
    await db.insert(schema.worldCollaborators).values({
      worldId: sfwWorldId,
      userId: collaborator.id,
      addedByUserId: adultOwnerId,
    });
    const denied = await app.inject({
      method: "PATCH",
      url: `/worlds/${sfwWorldId}`,
      headers: auth(collabToken),
      payload: { isNsfw: true },
    });
    assert.equal(denied.statusCode, 403);
    assert.match((denied.json() as { error: string }).error, /owner/);
  });

  /* ── Keep-but-hide membership on flips ─────────────────────────── */

  test("flipping a world 18+ keeps the minor's membership row but hides everything", async () => {
    const flipId = await insertWorld(db, { ownerUserId: adultOwnerId, name: "Flips later" });
    // Minor joins while the world is all-ages (real route, per-identity row).
    const join = await app.inject({
      method: "POST",
      url: `/worlds/${flipId}/members`,
      headers: auth(minorToken),
    });
    assert.equal(join.statusCode, 200);

    // Owner flips it 18+.
    const flip = await app.inject({
      method: "PATCH",
      url: `/worlds/${flipId}`,
      headers: auth(adultOwnerToken),
      payload: { isNsfw: true },
    });
    assert.equal(flip.statusCode, 200);

    // Membership row survives (keep-but-hide)...
    const row = (await db
      .select()
      .from(schema.worldMembers)
      .where(and(eq(schema.worldMembers.worldId, flipId), eq(schema.worldMembers.userId, minorId))))[0];
    assert.ok(row, "membership row must be kept");

    // ...but the minor can no longer resolve the world or see it in
    // their joined list.
    const detail = await app.inject({ method: "GET", url: `/worlds/${flipId}`, headers: auth(minorToken) });
    assert.equal(detail.statusCode, 404);
    const memberships = await app.inject({ method: "GET", url: "/me/worlds/memberships", headers: auth(minorToken) });
    const listed = (memberships.json() as { memberships: Array<{ worldId: string }> }).memberships;
    assert.ok(!listed.some((m) => m.worldId === flipId), "18+ world must drop off the minor's joined list");

    // Flip back: everything returns without any re-join.
    const unflip = await app.inject({
      method: "PATCH",
      url: `/worlds/${flipId}`,
      headers: auth(adultOwnerToken),
      payload: { isNsfw: false },
    });
    assert.equal(unflip.statusCode, 200);
    const detailBack = await app.inject({ method: "GET", url: `/worlds/${flipId}`, headers: auth(minorToken) });
    assert.equal(detailBack.statusCode, 200);
    const membershipsBack = await app.inject({ method: "GET", url: "/me/worlds/memberships", headers: auth(minorToken) });
    const listedBack = (membershipsBack.json() as { memberships: Array<{ worldId: string }> }).memberships;
    assert.ok(listedBack.some((m) => m.worldId === flipId));
  });

  test("a minor's own /me/worlds hides an 18+ world flagged over their head", async () => {
    // Simulate an adult staffer flagging a minor-owned world (direct
    // write; the route itself refuses minors, which is the point).
    const staffFlaggedId = await insertWorld(db, { ownerUserId: minorOwnerId, isNsfw: true });
    const r = await app.inject({ method: "GET", url: "/me/worlds", headers: auth(minorOwnerToken) });
    assert.equal(r.statusCode, 200);
    const ids = (r.json() as { worlds: Array<{ id: string }> }).worlds.map((w) => w.id);
    assert.ok(!ids.includes(staffFlaggedId), "no dead card for the minor owner");
    // The row itself is untouched (keep-but-hide).
    const still = (await db.select().from(schema.worlds).where(eq(schema.worlds.id, staffFlaggedId)))[0];
    assert.ok(still);
  });

  test("member profile world listings hide 18+ worlds from viewers who can't see NSFW", async () => {
    // The adult owner joins their own 18+ world so the profile listing
    // has a row to (not) show.
    const join = await app.inject({
      method: "POST",
      url: `/worlds/${nsfwWorldId}/members`,
      headers: auth(adultOwnerToken),
    });
    assert.equal(join.statusCode, 200);
    const asMinor = await app.inject({
      method: "GET",
      url: `/users/${adultOwnerId}/world-memberships`,
      headers: auth(minorToken),
    });
    const minorSees = (asMinor.json() as { memberships: Array<{ worldId: string }> }).memberships;
    assert.ok(!minorSees.some((m) => m.worldId === nsfwWorldId));
    const asAdult = await app.inject({
      method: "GET",
      url: `/users/${adultOwnerId}/world-memberships`,
      headers: auth(adultOwnerToken),
    });
    const adultSees = (asAdult.json() as { memberships: Array<{ worldId: string }> }).memberships;
    assert.ok(adultSees.some((m) => m.worldId === nsfwWorldId));
  });
});
