import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import {
  registerServerEventRoutes,
  sweepEventRemindersOnce,
  sweepEventStatusTransitionsOnce,
} from "../src/servers/events.js";
import { ensureSiteSettings, updateSettings } from "../src/settings.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Event upgrades (migration 0358): the one-primary-link write matrix
 * (room / chat message / forum / external URL), message-link canonicalization,
 * recurrence rule validation + windowed occurrence expansion on GET,
 * per-occurrence reminder single-fire (clock-injected sweeps), the
 * scheduled→live→ended auto-transitions (recurring series cycling back to
 * scheduled; cancelled untouched), and the anon-safe forum upcoming-events
 * strip with its NSFW-teaser and flag-off postures.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;
// Fixed far-future anchor so real wall-clock never crosses the fixtures.
const T0 = Date.UTC(2031, 5, 2, 18, 0, 0);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeIo: any = {
  async fetchSockets() { return []; },
  to() { return { emit() { /* no-op */ } }; },
  emit() { /* no-op */ },
};

let db: Db;
let app: FastifyInstance;
let owner: { id: string };
let member: { id: string };
let ownerToken: string;
let memberToken: string;
let srv: string;
let srvB: string;
let roomA: string;
let forumA: string;      // slug forum_a, affiliated to srv
let forumNsfw: string;   // slug forum_x, 18+, affiliated to srv

function api(method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT", url: string, token?: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    ...(token ? { headers: auth(token) } : {}),
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function createEvent(body: Record<string, unknown>, token = ownerToken) {
  return api("POST", `/servers/${srv}/events`, token, {
    title: "Session",
    startsAt: T0,
    ...body,
  });
}

async function eventRow(id: string) {
  return (await db.select().from(schema.serverEvents).where(eq(schema.serverEvents.id, id)).limit(1))[0]!;
}

async function notifCountFor(userId: string): Promise<number> {
  return (await db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId))).length;
}

before(async () => {
  db = makeTestDb().db;
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) { reply.code(400); return reply.send({ error: "validation" }); }
    throw err;
  });
  await registerServerEventRoutes(app, db, fakeIo);
  await app.ready();

  await ensureSiteSettings(db);
  owner = await createUser(db);
  member = await createUser(db);
  ownerToken = await tokenFor(db, owner.id);
  memberToken = await tokenFor(db, member.id);
  await updateSettings(db, { serversEnabled: true }, owner.id);

  srv = nanoid();
  srvB = nanoid();
  await db.insert(schema.servers).values([
    { id: srv, slug: "srv-events", name: "Events Server", ownerUserId: owner.id, joinMode: "open" },
    { id: srvB, slug: "srv-other", name: "Other Server", ownerUserId: owner.id, joinMode: "open" },
  ]);
  roomA = nanoid();
  await db.insert(schema.rooms).values([
    { id: roomA, name: "tavern", serverId: srv },
    { id: nanoid(), name: "elsewhere", serverId: srvB },
  ]);
  forumA = nanoid();
  forumNsfw = nanoid();
  await db.insert(schema.forums).values([
    { id: forumA, slug: "forum_a", name: "Forum A", ownerUserId: owner.id, serverId: srv },
    { id: forumNsfw, slug: "forum_x", name: "Forum X", ownerUserId: owner.id, serverId: srv, isNsfw: true },
  ]);
});

describe("one-primary-link rule", () => {
  test("create with two destinations is rejected", async () => {
    for (const links of [
      { linkedRoomId: roomA, linkedForumId: forumA },
      { linkedRoomId: roomA, externalUrl: "https://example.test/x" },
      { linkedMessageId: `${nanoid()}:${nanoid()}`, externalUrl: "https://example.test/x" },
      { linkedForumId: forumA, linkedMessageId: `${nanoid()}:${nanoid()}` },
    ]) {
      const res = await createEvent(links);
      assert.equal(res.statusCode, 400, JSON.stringify(links));
      assert.match((res.json() as { error: string }).error, /one place/);
    }
  });

  test("each single destination is accepted; message links store the canonical token", async () => {
    const roomRes = await createEvent({ linkedRoomId: roomA });
    assert.equal(roomRes.statusCode, 200, roomRes.body);

    const forumRes = await createEvent({ linkedForumId: forumA });
    assert.equal(forumRes.statusCode, 200, forumRes.body);

    const extRes = await createEvent({ externalUrl: "https://example.test/party" });
    assert.equal(extRes.statusCode, 200, extRes.body);

    // A full copied URL canonicalizes down to the bare token.
    const rid = nanoid();
    const mid = nanoid();
    const msgRes = await createEvent({ linkedMessageId: `https://spire.test/?m=${rid}:${mid}` });
    assert.equal(msgRes.statusCode, 200, msgRes.body);
    const wire = (msgRes.json() as { event: { linkedMessageId: string } }).event;
    assert.equal(wire.linkedMessageId, `${rid}:${mid}`);
  });

  test("malformed message links and non-https URLs are rejected", async () => {
    const badMsg = await createEvent({ linkedMessageId: "not a link" });
    assert.equal(badMsg.statusCode, 400);
    assert.match((badMsg.json() as { error: string }).error, /message link/);

    for (const url of ["javascript:alert(1)", "ftp://example.test/x", "http://example.test/x", `https://example.test/${"a".repeat(500)}`]) {
      const res = await createEvent({ externalUrl: url });
      assert.equal(res.statusCode, 400, url);
    }
  });

  test("a partial PATCH cannot sneak a second destination beside an existing one", async () => {
    const created = (await createEvent({ linkedRoomId: roomA })).json() as { id: string };
    const add = await api("PATCH", `/servers/${srv}/events/${created.id}`, ownerToken, {
      externalUrl: "https://example.test/x",
    });
    assert.equal(add.statusCode, 400);
    assert.match((add.json() as { error: string }).error, /one place/);

    // Swapping in the same PATCH (old one cleared) is fine.
    const swap = await api("PATCH", `/servers/${srv}/events/${created.id}`, ownerToken, {
      linkedRoomId: null,
      externalUrl: "https://example.test/x",
    });
    assert.equal(swap.statusCode, 200, swap.body);
    const row = await eventRow(created.id);
    assert.equal(row.linkedRoomId, null);
    assert.equal(row.externalUrl, "https://example.test/x");
  });
});

describe("recurrence validation + windowed expansion", () => {
  test("out-of-preset rules are rejected at write", async () => {
    for (const recurrence of [
      { freq: "daily", until: T0 + DAY, count: 3 }, // mutually exclusive
      { freq: "daily", byWeekday: [1] },            // weekly-only
      { freq: "weekly", count: 53 },                // over the cap
      { freq: "yearly" },                            // unknown preset
    ]) {
      const res = await createEvent({ recurrence });
      assert.equal(res.statusCode, 400, JSON.stringify(recurrence));
    }
  });

  test("a repeat-until before the start (zero occurrences) is rejected on create and PATCH", async () => {
    const create = await createEvent({ recurrence: { freq: "daily", until: T0 - DAY } });
    assert.equal(create.statusCode, 400);
    assert.match((create.json() as { error: string }).error, /repeat end/i);

    // Moving the start past the stored until is caught with the EFFECTIVE rule.
    const created = (await createEvent({
      title: "Until-bound",
      recurrence: { freq: "daily", until: T0 + 2 * DAY },
    })).json() as { id: string };
    const move = await api("PATCH", `/servers/${srv}/events/${created.id}`, ownerToken, {
      startsAt: T0 + 5 * DAY,
    });
    assert.equal(move.statusCode, 400);
    assert.match((move.json() as { error: string }).error, /repeat end/i);
  });

  test("windowed GET expands a weekly series into occurrences; unwindowed GET lists the series once", async () => {
    const start = T0 + 30 * DAY;
    const created = (await createEvent({
      title: "Weekly session",
      startsAt: start,
      endsAt: start + HOUR,
      recurrence: { freq: "weekly", count: 4 },
    })).json() as { id: string };

    const windowed = await api(
      "GET",
      `/servers/${srv}/events?from=${start - HOUR}&to=${start + 40 * DAY}`,
      memberToken,
    );
    assert.equal(windowed.statusCode, 200, windowed.body);
    const items = (windowed.json() as {
      events: { event: { id: string }; occurrenceStartsAt: number; occurrenceEndsAt: number | null }[];
    }).events.filter((e) => e.event.id === created.id);
    assert.equal(items.length, 4);
    for (let i = 0; i < items.length; i++) {
      assert.equal(items[i]!.occurrenceStartsAt, start + i * 7 * DAY);
      assert.equal(items[i]!.occurrenceEndsAt, start + i * 7 * DAY + HOUR);
    }

    const flat = await api("GET", `/servers/${srv}/events`, memberToken);
    const flatItems = (flat.json() as { events: { event: { id: string } }[] }).events
      .filter((e) => e.event.id === created.id);
    assert.equal(flatItems.length, 1, "console (unwindowed) list keeps one row per series");
  });

  test("a one-off event's occurrence mirrors its own times exactly", async () => {
    const start = T0 + 60 * DAY;
    const created = (await createEvent({ title: "One-off", startsAt: start, endsAt: start + HOUR })).json() as { id: string };
    const res = await api("GET", `/servers/${srv}/events?from=${start - HOUR}&to=${start + HOUR}`, memberToken);
    const item = (res.json() as {
      events: { event: { id: string; startsAt: number }; occurrenceStartsAt: number; occurrenceEndsAt: number | null }[];
    }).events.find((e) => e.event.id === created.id);
    assert.ok(item);
    assert.equal(item!.occurrenceStartsAt, item!.event.startsAt);
    assert.equal(item!.occurrenceEndsAt, start + HOUR);
  });

  test("a recurring series anchored before the window still surfaces its in-window occurrences", async () => {
    const start = T0 + 90 * DAY;
    const created = (await createEvent({
      title: "Old anchor",
      startsAt: start,
      recurrence: { freq: "daily", count: 20 },
    })).json() as { id: string };
    // Window opens 10 days into the series: the anchor start is outside, the
    // 10 remaining occurrences are not.
    const res = await api(
      "GET",
      `/servers/${srv}/events?from=${start + 10 * DAY}&to=${start + 40 * DAY}`,
      memberToken,
    );
    const items = (res.json() as { events: { event: { id: string }; occurrenceStartsAt: number }[] }).events
      .filter((e) => e.event.id === created.id);
    assert.equal(items.length, 10);
    assert.equal(items[0]!.occurrenceStartsAt, start + 10 * DAY);
  });
});

describe("reminder sweep — per-occurrence single-fire", () => {
  test("a recurring event reminds once per occurrence, never twice", async () => {
    const start = T0 + 120 * DAY;
    const created = (await createEvent({
      title: "Reminded weekly",
      startsAt: start,
      endsAt: start + HOUR,
      recurrence: { freq: "weekly", count: 3 },
      reminderLeadMs: 30 * MIN,
    })).json() as { id: string };
    await db.insert(schema.serverEventRsvps).values({
      id: nanoid(), eventId: created.id, userId: member.id, characterId: null, status: "going",
    });

    const base = await notifCountFor(member.id);

    // Before the window: nothing.
    await sweepEventRemindersOnce(db, fakeIo, start - HOUR);
    assert.equal(await notifCountFor(member.id), base);

    // Inside occurrence 1's window: exactly one fire, stamped per-occurrence.
    await sweepEventRemindersOnce(db, fakeIo, start - 20 * MIN);
    assert.equal(await notifCountFor(member.id), base + 1);
    assert.equal(+(await eventRow(created.id)).reminderFiredFor!, start);

    // Re-sweep in the same window: the conditional claim refuses a second fire.
    await sweepEventRemindersOnce(db, fakeIo, start - 10 * MIN);
    assert.equal(await notifCountFor(member.id), base + 1);

    // Occurrence 2's window a week later: fires once more, once only.
    const start2 = start + 7 * DAY;
    await sweepEventRemindersOnce(db, fakeIo, start2 - 20 * MIN);
    assert.equal(await notifCountFor(member.id), base + 2);
    assert.equal(+(await eventRow(created.id)).reminderFiredFor!, start2);
    await sweepEventRemindersOnce(db, fakeIo, start2 - 5 * MIN);
    assert.equal(await notifCountFor(member.id), base + 2);

    // The deep-link target is unchanged: kind event + owning server.
    const rows = await db.select().from(schema.notifications)
      .where(and(eq(schema.notifications.userId, member.id), eq(schema.notifications.targetId, created.id)));
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.targetKind, "event");
      assert.equal(r.serverId, srv);
    }
  });

  test("one-off events keep the original once-only semantics", async () => {
    const start = T0 + 150 * DAY;
    const created = (await createEvent({
      title: "Reminded once",
      startsAt: start,
      reminderLeadMs: 30 * MIN,
    })).json() as { id: string };
    await db.insert(schema.serverEventRsvps).values({
      id: nanoid(), eventId: created.id, userId: member.id, characterId: null, status: "maybe",
    });
    const base = await notifCountFor(member.id);
    await sweepEventRemindersOnce(db, fakeIo, start - 10 * MIN);
    assert.equal(await notifCountFor(member.id), base + 1);
    assert.ok((await eventRow(created.id)).reminderFiredAt != null);
    await sweepEventRemindersOnce(db, fakeIo, start - 5 * MIN);
    assert.equal(await notifCountFor(member.id), base + 1);
  });
});

describe("status auto-transitions", () => {
  test("one-off: scheduled → live at start, live → ended at end, idempotently", async () => {
    const start = T0 + 200 * DAY;
    const created = (await createEvent({ title: "Timed", startsAt: start, endsAt: start + 2 * HOUR })).json() as { id: string };

    await sweepEventStatusTransitionsOnce(db, start - HOUR);
    assert.equal((await eventRow(created.id)).status, "scheduled");

    await sweepEventStatusTransitionsOnce(db, start + MIN);
    assert.equal((await eventRow(created.id)).status, "live");
    await sweepEventStatusTransitionsOnce(db, start + 2 * MIN);
    assert.equal((await eventRow(created.id)).status, "live", "second pass is a no-op");

    await sweepEventStatusTransitionsOnce(db, start + 2 * HOUR + MIN);
    assert.equal((await eventRow(created.id)).status, "ended");
    await sweepEventStatusTransitionsOnce(db, start + 3 * HOUR);
    assert.equal((await eventRow(created.id)).status, "ended", "ended is terminal for the sweep");

    // Ended events refuse RSVPs (the transition closes the door).
    const rsvp = await api("PUT", `/servers/${srv}/events/${created.id}/rsvp`, memberToken, { status: "going" });
    assert.equal(rsvp.statusCode, 409);
  });

  test("open-ended one-off: flips live at start and never auto-ends", async () => {
    const start = T0 + 210 * DAY;
    const created = (await createEvent({ title: "Open-ended", startsAt: start })).json() as { id: string };
    await sweepEventStatusTransitionsOnce(db, start + 10 * DAY);
    assert.equal((await eventRow(created.id)).status, "live");
  });

  test("recurring: live during an occurrence, back to scheduled between, ended after the last", async () => {
    const start = T0 + 220 * DAY;
    const created = (await createEvent({
      title: "Weekly timed",
      startsAt: start,
      endsAt: start + HOUR,
      recurrence: { freq: "weekly", count: 2 },
    })).json() as { id: string };

    await sweepEventStatusTransitionsOnce(db, start + 10 * MIN);
    assert.equal((await eventRow(created.id)).status, "live");

    // Between occurrence 1 and 2: another occurrence remains → scheduled again,
    // so the series RSVP stays open.
    await sweepEventStatusTransitionsOnce(db, start + HOUR + 10 * MIN);
    assert.equal((await eventRow(created.id)).status, "scheduled");
    const rsvp = await api("PUT", `/servers/${srv}/events/${created.id}/rsvp`, memberToken, { status: "going" });
    assert.equal(rsvp.statusCode, 200, rsvp.body);

    // Occurrence 2 runs...
    const start2 = start + 7 * DAY;
    await sweepEventStatusTransitionsOnce(db, start2 + 10 * MIN);
    assert.equal((await eventRow(created.id)).status, "live");
    // ...and once it's over the series is exhausted.
    await sweepEventStatusTransitionsOnce(db, start2 + HOUR + 10 * MIN);
    assert.equal((await eventRow(created.id)).status, "ended");
    await sweepEventStatusTransitionsOnce(db, start2 + 2 * HOUR);
    assert.equal((await eventRow(created.id)).status, "ended", "idempotent");
  });

  test("rescheduling an auto-ended event re-opens it", async () => {
    const start = T0 + 240 * DAY;
    const created = (await createEvent({ title: "Comeback", startsAt: start, endsAt: start + HOUR })).json() as { id: string };
    await sweepEventStatusTransitionsOnce(db, start + 2 * HOUR);
    assert.equal((await eventRow(created.id)).status, "ended");

    // Moving the schedule clears the 'ended' dead end (the sweep never scans
    // ended rows), so RSVPs open again.
    const move = await api("PATCH", `/servers/${srv}/events/${created.id}`, ownerToken, {
      startsAt: start + 7 * DAY,
      endsAt: start + 7 * DAY + HOUR,
    });
    assert.equal(move.statusCode, 200, move.body);
    assert.equal((await eventRow(created.id)).status, "scheduled");
    const rsvp = await api("PUT", `/servers/${srv}/events/${created.id}/rsvp`, memberToken, { status: "going" });
    assert.equal(rsvp.statusCode, 200, rsvp.body);

    // An explicit status in the same PATCH still wins over the auto re-open.
    const explicit = await api("PATCH", `/servers/${srv}/events/${created.id}`, ownerToken, {
      startsAt: start + 14 * DAY,
      endsAt: start + 14 * DAY + HOUR,
      status: "cancelled",
    });
    assert.equal(explicit.statusCode, 200, explicit.body);
    assert.equal((await eventRow(created.id)).status, "cancelled");
  });

  test("cancelled stays manual — the sweep never touches it", async () => {
    const start = T0 + 230 * DAY;
    const created = (await createEvent({ title: "Called off", startsAt: start, endsAt: start + HOUR })).json() as { id: string };
    const cancel = await api("PATCH", `/servers/${srv}/events/${created.id}`, ownerToken, { status: "cancelled" });
    assert.equal(cancel.statusCode, 200, cancel.body);
    await sweepEventStatusTransitionsOnce(db, start + 10 * MIN);
    assert.equal((await eventRow(created.id)).status, "cancelled");
  });
});

describe("forum upcoming-events strip (anon-safe)", () => {
  // The strip windows on the REAL clock (now-1h .. now+90d), so its fixtures
  // anchor to Date.now() rather than the far-future T0 the injected-clock
  // sweeps use.
  test("anonymous visitors see the forum's upcoming events, without descriptions", async () => {
    const start = Date.now() + 7 * DAY;
    const created = (await createEvent({
      title: "Forum fest",
      startsAt: start,
      descriptionHtml: "<p>secret details</p>",
      linkedForumId: forumA,
      recurrence: { freq: "weekly", count: 2 },
    })).json() as { id: string };

    const res = await api("GET", "/forums/forum_a/events");
    assert.equal(res.statusCode, 200, res.body);
    const events = (res.json() as {
      events: { event: Record<string, unknown>; occurrenceStartsAt: number; counts: { going: number } }[];
    }).events;
    const mine = events.filter((e) => e.event.id === created.id);
    assert.ok(mine.length >= 1, "the linked event is on the strip");
    assert.equal(mine[0]!.event.title, "Forum fest");
    assert.equal(mine[0]!.event.descriptionHtml, undefined, "description never ships on the public strip");
    assert.equal(mine[0]!.counts.going, 0);
    // Case-insensitive slug + id both resolve.
    assert.equal((await api("GET", `/forums/${forumA}/events`)).statusCode, 200);
  });

  test("one-off events outside the strip's window never reach it", async () => {
    // Beyond the 90-day horizon, and started well before the 1h grace.
    const far = (await createEvent({
      title: "Far future", startsAt: Date.now() + 200 * DAY, linkedForumId: forumA,
    })).json() as { id: string };
    const past = (await createEvent({
      title: "Long started", startsAt: Date.now() - 2 * DAY, linkedForumId: forumA,
    })).json() as { id: string };
    const events = (await api("GET", "/forums/forum_a/events")).json() as { events: { event: { id: string } }[] };
    assert.ok(!events.events.some((e) => e.event.id === far.id), "beyond the horizon");
    assert.ok(!events.events.some((e) => e.event.id === past.id), "before the just-started grace");
  });

  test("cancelled events never reach the strip", async () => {
    const start = Date.now() + 10 * DAY;
    const created = (await createEvent({ title: "Scrapped", startsAt: start, linkedForumId: forumA })).json() as { id: string };
    await api("PATCH", `/servers/${srv}/events/${created.id}`, ownerToken, { status: "cancelled" });
    const events = (await api("GET", "/forums/forum_a/events")).json() as { events: { event: { id: string } }[] };
    assert.ok(!events.events.some((e) => e.event.id === created.id));
  });

  test("an 18+ forum's strip is empty for anonymous viewers and full for adults", async () => {
    const start = Date.now() + 12 * DAY;
    const created = (await createEvent({ title: "Adults only", startsAt: start, linkedForumId: forumNsfw })).json() as { id: string };

    const anon = (await api("GET", "/forums/forum_x/events")).json() as { events: unknown[] };
    assert.equal(anon.events.length, 0, "NSFW teaser: anon gets nothing");

    const adult = (await api("GET", "/forums/forum_x/events", ownerToken)).json() as { events: { event: { id: string } }[] };
    assert.ok(adult.events.some((e) => e.event.id === created.id), "adults get the strip");
  });

  test("unknown forum 404s; servers-off returns an empty strip", async () => {
    assert.equal((await api("GET", "/forums/nope_nope/events")).statusCode, 404);
    await updateSettings(db, { serversEnabled: false }, owner.id);
    try {
      const res = await api("GET", "/forums/forum_a/events");
      assert.equal(res.statusCode, 200);
      assert.deepEqual((res.json() as { events: unknown[] }).events, []);
    } finally {
      await updateSettings(db, { serversEnabled: true }, owner.id);
    }
  });
});

describe("permission edges unchanged", () => {
  test("members cannot create; cross-server events stay invisible", async () => {
    const res = await createEvent({ title: "Nope" }, memberToken);
    assert.equal(res.statusCode, 403);

    const created = (await createEvent({ title: "Mine" })).json() as { id: string };
    const cross = await api("PATCH", `/servers/${srvB}/events/${created.id}`, ownerToken, { title: "Stolen" });
    assert.equal(cross.statusCode, 404, "cross-server ids are invisible");
  });
});
