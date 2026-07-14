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
import { ensureSiteSettings, updateSettings } from "../src/settings.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Event-linked map markers (Feature A phase A5). Pins:
 *   - the linked-event picker source: only communities whose servers.world_id
 *     points at THIS world, and only ones the EDITOR can participate in;
 *   - marker eventId write validation (featuring-community events only);
 *   - the per-viewer event resolution on the map GET: participants receive
 *     title/next-occurrence/going-count, non-members and anonymous visitors
 *     never receive event details (byte-level), cancelled events surface
 *     their state, and a deleted event SET-NULLs the marker link.
 */

const ADULT_DOB = "1990-01-01";
const DAY_MS = 86_400_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockIo: any = { fetchSockets: async () => [] };

describe("world map event links", () => {
  let db: Db;
  let app: FastifyInstance;
  let worldOwnerId: string;
  let worldOwnerToken: string;
  let serverOwnerId: string;
  let memberId: string;
  let memberToken: string;
  let strangerToken: string;

  before(async () => {
    ({ db } = makeTestDb());
    const fastify = Fastify();
    fastify.setErrorHandler((err, _req, reply) => {
      if (err instanceof ZodError) {
        reply.code(400);
        return reply.send({ error: "validation" });
      }
      throw err;
    });
    await registerWorldCoreRoutes(fastify, db, mockIo);
    await registerWorldMapRoutes(fastify, db, mockIo, mkdtempSync(join(tmpdir(), "spire-map-events-")));
    await fastify.ready();
    app = fastify;
    await ensureSiteSettings(db);
    const worldOwner = await createUser(db, { birthdate: ADULT_DOB });
    const serverOwner = await createUser(db, { birthdate: ADULT_DOB });
    const member = await createUser(db, { birthdate: ADULT_DOB });
    const stranger = await createUser(db, { birthdate: ADULT_DOB });
    worldOwnerId = worldOwner.id;
    serverOwnerId = serverOwner.id;
    memberId = member.id;
    worldOwnerToken = await tokenFor(db, worldOwner.id);
    memberToken = await tokenFor(db, member.id);
    strangerToken = await tokenFor(db, stranger.id);
    await updateSettings(db, { serversEnabled: true }, worldOwner.id);
  });

  async function insertWorld(): Promise<string> {
    const id = nanoid();
    await db.insert(schema.worlds).values({
      id,
      ownerUserId: worldOwnerId,
      slug: `w-${id.slice(0, 8).toLowerCase()}`,
      name: "Event World",
      visibility: "public",
    });
    return id;
  }

  async function insertServer(opts: { worldId?: string | null; joinMode?: "open" | "application" }): Promise<string> {
    const id = nanoid();
    await db.insert(schema.servers).values({
      id,
      slug: `s-${id.slice(0, 8).toLowerCase()}`,
      name: `Community ${id.slice(0, 6)}`,
      ownerUserId: serverOwnerId,
      worldId: opts.worldId ?? null,
      joinMode: opts.joinMode ?? "open",
    });
    return id;
  }

  async function insertEvent(serverId: string, opts: {
    title: string;
    startsAt: number;
    endsAt?: number | null;
    status?: "scheduled" | "live" | "ended" | "cancelled";
    recurrenceJson?: string | null;
  }): Promise<string> {
    const id = nanoid();
    await db.insert(schema.serverEvents).values({
      id,
      serverId,
      title: opts.title,
      startsAt: opts.startsAt,
      endsAt: opts.endsAt ?? null,
      status: opts.status ?? "scheduled",
      recurrenceJson: opts.recurrenceJson ?? null,
    });
    return id;
  }

  async function createMap(worldId: string): Promise<string> {
    const r = await app.inject({
      method: "POST",
      url: `/worlds/${worldId}/maps`,
      headers: auth(worldOwnerToken),
      payload: { name: `Map ${nanoid(6)}`, imageUrl: "https://img.example/map.png" },
    });
    assert.equal(r.statusCode, 200);
    return (r.json() as { map: { id: string } }).map.id;
  }

  async function createMarker(worldId: string, mapId: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/worlds/${worldId}/maps/${mapId}/markers`,
      headers: auth(worldOwnerToken),
      payload: { kind: "event", label: "Festival grounds", x: 0.5, y: 0.5, ...body },
    });
  }

  test("picker lists upcoming events of communities featuring the world the editor can enter", async () => {
    const worldId = await insertWorld();
    const now = Date.now();
    const featuring = await insertServer({ worldId, joinMode: "open" });
    const upcomingId = await insertEvent(featuring, { title: "Grand Melee", startsAt: now + 2 * DAY_MS });
    const cancelledId = await insertEvent(featuring, { title: "Called Off", startsAt: now + 3 * DAY_MS, status: "cancelled" });
    const endedId = await insertEvent(featuring, { title: "Long Done", startsAt: now - 5 * DAY_MS, status: "ended" });
    // Weekly series anchored in the past: still pickable at its NEXT occurrence.
    const recurringId = await insertEvent(featuring, {
      title: "Weekly Tavern Night",
      startsAt: now - 30 * DAY_MS,
      endsAt: now - 30 * DAY_MS + 2 * 60 * 60_000,
      recurrenceJson: JSON.stringify({ freq: "weekly" }),
    });
    const unrelated = await insertServer({ worldId: null, joinMode: "open" });
    const unrelatedEventId = await insertEvent(unrelated, { title: "Elsewhere", startsAt: now + DAY_MS });
    // Application-mode community the editor is NOT a member of: its events
    // must never surface in the picker (membership composes with editorship).
    const closed = await insertServer({ worldId, joinMode: "application" });
    const closedEventId = await insertEvent(closed, { title: "Sealed Gathering", startsAt: now + DAY_MS });

    const r = await app.inject({ method: "GET", url: `/worlds/${worldId}/map-events`, headers: auth(worldOwnerToken) });
    assert.equal(r.statusCode, 200);
    const events = (r.json() as { events: Array<{ id: string; serverId: string; startsAt: number; recurring: boolean }> }).events;
    const ids = events.map((e) => e.id);
    assert.ok(ids.includes(upcomingId), "upcoming event listed");
    assert.ok(ids.includes(recurringId), "recurring series listed at its next occurrence");
    assert.ok(!ids.includes(cancelledId), "cancelled events are not pickable");
    assert.ok(!ids.includes(endedId), "ended events are not pickable");
    assert.ok(!ids.includes(unrelatedEventId), "events of non-featuring communities never appear");
    assert.ok(!ids.includes(closedEventId), "events of communities the editor can't enter never appear");
    const recurring = events.find((e) => e.id === recurringId)!;
    assert.ok(recurring.recurring);
    assert.ok(recurring.startsAt > now - 60 * 60_000, "next occurrence is current, not the stale anchor");

    // Only world editors may enumerate linkable events.
    const asStranger = await app.inject({ method: "GET", url: `/worlds/${worldId}/map-events`, headers: auth(strangerToken) });
    assert.equal(asStranger.statusCode, 403);
    const anon = await app.inject({ method: "GET", url: `/worlds/${worldId}/map-events` });
    assert.equal(anon.statusCode, 401);
  });

  test("marker eventId is validated against communities featuring THIS world", async () => {
    const worldId = await insertWorld();
    const mapId = await createMap(worldId);
    const now = Date.now();
    const featuring = await insertServer({ worldId, joinMode: "open" });
    const goodEventId = await insertEvent(featuring, { title: "Linkable", startsAt: now + DAY_MS });
    const elsewhere = await insertServer({ worldId: null, joinMode: "open" });
    const foreignEventId = await insertEvent(elsewhere, { title: "Not Linkable", startsAt: now + DAY_MS });

    const bad = await createMarker(worldId, mapId, { eventId: foreignEventId });
    assert.equal(bad.statusCode, 400);
    const ghost = await createMarker(worldId, mapId, { eventId: "no-such-event" });
    assert.equal(ghost.statusCode, 400);

    const good = await createMarker(worldId, mapId, { eventId: goodEventId });
    assert.equal(good.statusCode, 200);
    const marker = (good.json() as { marker: { id: string; eventId: string } }).marker;
    assert.equal(marker.eventId, goodEventId);

    // PATCH can swap or clear the link (null detaches; bad ids still 400).
    const swapBad = await app.inject({
      method: "PATCH",
      url: `/worlds/${worldId}/maps/${mapId}/markers/${marker.id}`,
      headers: auth(worldOwnerToken),
      payload: { eventId: foreignEventId },
    });
    assert.equal(swapBad.statusCode, 400);
    const cleared = await app.inject({
      method: "PATCH",
      url: `/worlds/${worldId}/maps/${mapId}/markers/${marker.id}`,
      headers: auth(worldOwnerToken),
      payload: { eventId: null },
    });
    assert.equal(cleared.statusCode, 200);
    assert.equal((cleared.json() as { marker: { eventId: string | null } }).marker.eventId, null);
  });

  test("write gate composes membership; an unchanged link survives unfeaturing", async () => {
    const worldId = await insertWorld();
    const mapId = await createMap(worldId);
    const now = Date.now();
    // Application-mode featuring community the editor is NOT a member of:
    // the picker never lists its events, and a replayed id must not link
    // either — the write gate mirrors the read gate.
    const closed = await insertServer({ worldId, joinMode: "application" });
    const closedEventId = await insertEvent(closed, { title: "Sealed", startsAt: now + DAY_MS });
    const denied = await createMarker(worldId, mapId, { eventId: closedEventId });
    assert.equal(denied.statusCode, 400);

    const open = await insertServer({ worldId, joinMode: "open" });
    const eventId = await insertEvent(open, { title: "Fair", startsAt: now + DAY_MS });
    const made = await createMarker(worldId, mapId, { eventId });
    assert.equal(made.statusCode, 200);
    const markerId = (made.json() as { marker: { id: string } }).marker.id;

    // The community stops featuring the world: edits that echo the stored
    // eventId back must keep saving (only a CHANGED link re-validates), so
    // the stale link degrades instead of bricking unrelated edits.
    await db.update(schema.servers).set({ worldId: null }).where(eq(schema.servers.id, open));
    const relabel = await app.inject({
      method: "PATCH",
      url: `/worlds/${worldId}/maps/${mapId}/markers/${markerId}`,
      headers: auth(worldOwnerToken),
      payload: { label: "Old fairgrounds", eventId },
    });
    assert.equal(relabel.statusCode, 200);
    assert.equal((relabel.json() as { marker: { eventId: string | null } }).marker.eventId, eventId);
  });

  test("map GET resolves event details per viewer: members get them, non-members and anon never do (byte-level)", async () => {
    const worldId = await insertWorld();
    const mapId = await createMap(worldId);
    const now = Date.now();
    // Application-mode community: only explicit members participate. The
    // world owner joins too — the marker write gate requires the EDITOR to
    // be able to participate in the event's community.
    const communityId = await insertServer({ worldId, joinMode: "application" });
    await db.insert(schema.serverMembers).values({ serverId: communityId, userId: memberId, role: "member" });
    await db.insert(schema.serverMembers).values({ serverId: communityId, userId: worldOwnerId, role: "member" });
    const secretTitle = `festival-of-${nanoid(8)}`;
    const eventId = await insertEvent(communityId, { title: secretTitle, startsAt: now + 2 * DAY_MS });
    for (const uid of [memberId, serverOwnerId]) {
      await db.insert(schema.serverEventRsvps).values({ id: nanoid(), eventId, userId: uid, status: "going" });
    }
    const made = await createMarker(worldId, mapId, { eventId });
    assert.equal(made.statusCode, 200);

    const url = `/worlds/${worldId}/maps/${mapId}`;

    // Member of the owning community: full popover data.
    const asMember = await app.inject({ method: "GET", url, headers: auth(memberToken) });
    assert.equal(asMember.statusCode, 200);
    const memberJson = asMember.json() as {
      markers: Array<{ eventId: string | null }>;
      events?: Array<{ id: string; title: string; status: string; goingCount: number; startsAt: number }>;
    };
    assert.equal(memberJson.markers[0]?.eventId, eventId);
    assert.equal(memberJson.events?.length, 1);
    assert.equal(memberJson.events?.[0]?.title, secretTitle);
    assert.equal(memberJson.events?.[0]?.goingCount, 2);
    assert.equal(memberJson.events?.[0]?.status, "scheduled");

    // Authed non-member + anonymous visitor: the marker arrives with its
    // eventId, but the payload bytes never contain the event's details.
    for (const headers of [auth(strangerToken), undefined]) {
      const r = await app.inject({ method: "GET", url, ...(headers ? { headers } : {}) });
      assert.equal(r.statusCode, 200);
      assert.ok(!r.body.includes(secretTitle), "event title must not reach non-participants");
      assert.ok(!r.body.includes('"events"'), "no events block for non-participants");
      const j = r.json() as { markers: Array<{ eventId: string | null }> };
      assert.equal(j.markers[0]?.eventId, eventId, "the bare link id itself still rides the marker");
    }

    // Cancelled: members see the state (the client renders it, no button).
    await db.update(schema.serverEvents).set({ status: "cancelled" }).where(eq(schema.serverEvents.id, eventId));
    const cancelled = await app.inject({ method: "GET", url, headers: auth(memberToken) });
    assert.equal((cancelled.json() as { events?: Array<{ status: string }> }).events?.[0]?.status, "cancelled");

    // Servers feature dark: event details vanish for everyone.
    await updateSettings(db, { serversEnabled: false }, worldOwnerId);
    const dark = await app.inject({ method: "GET", url, headers: auth(memberToken) });
    assert.equal(dark.statusCode, 200);
    assert.ok(!dark.body.includes(secretTitle));
    await updateSettings(db, { serversEnabled: true }, worldOwnerId);

    // Deleting the event SET-NULLs the marker link (migration 0359 FK).
    await db.delete(schema.serverEvents).where(eq(schema.serverEvents.id, eventId));
    const after = await app.inject({ method: "GET", url, headers: auth(memberToken) });
    const afterJson = after.json() as { markers: Array<{ eventId: string | null }>; events?: unknown[] };
    assert.equal(afterJson.markers[0]?.eventId, null);
    assert.equal(afterJson.events, undefined);
  });
});
