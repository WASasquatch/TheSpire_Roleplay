import "./helpers/env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { startOfUtcDayMs } from "@thekeep/shared";
import { nanoid } from "nanoid";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { rollupYesterday } from "../src/analytics/rollup.js";
import {
  ensureEngagementBackfill,
  featureBucketForReason,
  rollupEngagementYesterday,
} from "../src/analytics/engagement.js";
import { registerAnalyticsAdminRoutes } from "../src/analytics/admin.js";
import { invalidatePermissionsCache } from "../src/auth/permissions.js";
import { makeTestDb, createUser, tokenFor, auth } from "./helpers/harness.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Stable string key for an analytics_daily row (id excluded). */
function rowKey(r: {
  day: string;
  metric: string;
  dim1: string | null;
  dim2: string | null;
  count: number;
}): string {
  return `${r.day}|${r.metric}|${r.dim1 ?? ""}|${r.dim2 ?? ""}|${r.count}`;
}

async function allDailyRows(db: Db) {
  const rows = await db
    .select({
      day: schema.analyticsDaily.day,
      metric: schema.analyticsDaily.metric,
      dim1: schema.analyticsDaily.dim1,
      dim2: schema.analyticsDaily.dim2,
      count: schema.analyticsDaily.count,
    })
    .from(schema.analyticsDaily);
  return rows.map(rowKey).sort();
}

async function findDaily(db: Db, day: string, metric: string, dim1: string | null, dim2: string | null) {
  const rows = await db
    .select()
    .from(schema.analyticsDaily)
    .where(eq(schema.analyticsDaily.metric, metric));
  return rows.find((r) => r.day === day && (r.dim1 ?? null) === dim1 && (r.dim2 ?? null) === dim2) ?? null;
}

async function insertLedger(
  db: Db,
  row: {
    scope: "user" | "character";
    ownerId: string;
    reason: string;
    createdAt: number;
    serverId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(schema.earningLedger).values({
    id: nanoid(),
    serverId: row.serverId ?? "server_spire_system",
    scope: row.scope,
    ownerId: row.ownerId,
    xpDelta: 1,
    currencyDelta: 0,
    reason: row.reason,
    metadataJson: row.metadata ? JSON.stringify(row.metadata) : null,
    createdAt: new Date(row.createdAt),
  });
}

async function insertCharacter(db: Db, userId: string): Promise<string> {
  const id = nanoid();
  await db.insert(schema.characters).values({ id, userId, name: `c_${id.slice(0, 6)}` });
  return id;
}

async function insertIpLog(
  db: Db,
  row: { userId: string; ip: string; firstSeenAt: number; lastSeenAt: number },
): Promise<void> {
  await db.insert(schema.userIpLog).values({
    id: nanoid(),
    userId: row.userId,
    ip: row.ip,
    firstSeenAt: new Date(row.firstSeenAt),
    lastSeenAt: new Date(row.lastSeenAt),
  });
}

/** Bare Fastify with the real analytics admin routes + the prod-shaped
 *  preHandler that resolves a bearer session into req.sessionUser. */
async function buildAnalyticsApp(db: Db): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return;
    const sid = header.slice("Bearer ".length);
    const [sess] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sid));
    if (!sess) return;
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, sess.userId));
    if (!u) return;
    (req as FastifyRequest & { sessionUser?: { id: string; role: string } }).sessionUser = {
      id: u.id,
      role: u.role,
    };
  });
  await registerAnalyticsAdminRoutes(app, db);
  await app.ready();
  return app;
}

/* =============================================================
 * Rollup extension correctness (new families + priors unchanged)
 * ============================================================= */

test("rollupYesterday emits engagement families and leaves prior families byte-identical", async () => {
  const { db } = makeTestDb();
  const now = Date.now();
  const yStart = startOfUtcDayMs(now) - DAY_MS; // yesterday 00:00 UTC
  const yDay = dayKey(yStart);
  const h = (hours: number) => yStart + hours * 60 * 60 * 1000;

  // --- registrations: two accounts created yesterday, one older ---
  const u1 = await createUser(db);
  const u2 = await createUser(db);
  const u3 = await createUser(db);
  await db.update(schema.users).set({ createdAt: new Date(h(10)) }).where(eq(schema.users.id, u1.id));
  await db.update(schema.users).set({ createdAt: new Date(h(11)) }).where(eq(schema.users.id, u2.id));
  await db
    .update(schema.users)
    .set({ createdAt: new Date(yStart - 8 * DAY_MS) })
    .where(eq(schema.users.id, u3.id));

  // --- activity sources ---
  // u3 only shows up via the ip log.
  await insertIpLog(db, { userId: u3.id, ip: "10.0.0.3", firstSeenAt: yStart - 8 * DAY_MS, lastSeenAt: h(12) });
  // u1 chats IC while voicing two characters: the fan-out writes TWO ledger
  // rows for ONE message — the message metric must dedupe on messageId.
  // Reasons are the award engine's real vocabulary (message_<source kind>);
  // IC vs OOC comes from the routing scope, not the reason.
  const c1a = await insertCharacter(db, u1.id);
  const c1b = await insertCharacter(db, u1.id);
  await insertLedger(db, { scope: "character", ownerId: c1a, reason: "message_say", createdAt: h(13), metadata: { messageId: "m1" } });
  await insertLedger(db, { scope: "character", ownerId: c1b, reason: "message_say", createdAt: h(13), metadata: { messageId: "m1" } });
  // u2: one OOC message (master-pool scope) on another server + a forum
  // topic + a purchase.
  await insertLedger(db, { scope: "user", ownerId: u2.id, reason: "message_say", createdAt: h(14), serverId: "srvA", metadata: { messageId: "m2" } });
  await insertLedger(db, { scope: "user", ownerId: u2.id, reason: "forum_topic", createdAt: h(15) });
  await insertLedger(db, { scope: "user", ownerId: u2.id, reason: "purchase_fancy_hat", createdAt: h(16) });
  // presence sweep + arcade + an admin grant (which must be EXCLUDED).
  await insertLedger(db, { scope: "character", ownerId: c1a, reason: "presence_ic", createdAt: h(17) });
  await insertLedger(db, { scope: "user", ownerId: u3.id, reason: "urugal_floor", createdAt: h(18), serverId: "srvA" });
  await insertLedger(db, { scope: "user", ownerId: u2.id, reason: "admin_grant", createdAt: h(19) });

  // --- prior families' raw rows (pageviews + events) for yesterday ---
  await db.insert(schema.analyticsPageView).values([
    { id: nanoid(), createdAt: new Date(h(9)), path: "/", visitorHash: "v1", isBot: false },
    { id: nanoid(), createdAt: new Date(h(9)), path: "/", visitorHash: "v2", isBot: false },
    { id: nanoid(), createdAt: new Date(h(9)), path: "/", visitorHash: "vb", isBot: true },
  ]);
  await db.insert(schema.analyticsEvent).values([
    { id: nanoid(), createdAt: new Date(h(9)), kind: "modal", key: "helpOpen", isBot: false },
  ]);

  await rollupYesterday(db, now);

  // --- new engagement families ---
  assert.equal((await findDaily(db, yDay, "registration", "", ""))?.count, 2);
  assert.equal((await findDaily(db, yDay, "activeUser", "", ""))?.count, 3, "u1+u2+u3 active");
  assert.equal((await findDaily(db, yDay, "message", "ic", "server_spire_system"))?.count, 1, "fan-out deduped");
  assert.equal((await findDaily(db, yDay, "message", "ooc", "srvA"))?.count, 1);
  assert.equal((await findDaily(db, yDay, "forumPost", "topic", "server_spire_system"))?.count, 1);
  assert.equal((await findDaily(db, yDay, "feature", "purchases", "server_spire_system"))?.count, 1);
  assert.equal((await findDaily(db, yDay, "feature", "presence", "server_spire_system"))?.count, 1);
  assert.equal((await findDaily(db, yDay, "feature", "games", "srvA"))?.count, 1);
  // admin_grant is bookkeeping, never a feature bucket.
  const featureRows = (await db.select().from(schema.analyticsDaily)).filter(
    (r) => r.metric === "feature" && r.day === yDay,
  );
  assert.equal(featureRows.length, 3);

  // --- prior families byte-identical to the pre-extension rollup ---
  assert.equal((await findDaily(db, yDay, "pageview", "/", null))?.count, 2);
  assert.equal((await findDaily(db, yDay, "pageview:bot", "/", null))?.count, 1);
  assert.equal((await findDaily(db, yDay, "visitor", null, null))?.count, 2);
  assert.equal((await findDaily(db, yDay, "visitor:bot", null, null))?.count, 1);
  assert.equal((await findDaily(db, yDay, "referrer", "direct", null))?.count, 2);
  assert.equal((await findDaily(db, yDay, "referrer:bot", "direct", null))?.count, 1);
  assert.equal((await findDaily(db, yDay, "event", "modal", "helpOpen"))?.count, 1);
});

test("featureBucketForReason taxonomy", () => {
  assert.equal(featureBucketForReason("presence_ic"), "presence");
  assert.equal(featureBucketForReason("message_say"), null);
  assert.equal(featureBucketForReason("message_whisper"), null);
  assert.equal(featureBucketForReason("forum_reply"), null);
  assert.equal(featureBucketForReason("scriptorium_royalty"), "scriptorium");
  assert.equal(featureBucketForReason("purchase_raffle_2026"), "games");
  assert.equal(featureBucketForReason("purchase_neon_style"), "purchases");
  assert.equal(featureBucketForReason("border_purchase_gold"), "purchases");
  // Real shop/item vocabulary (item_purchase_<key>, item_use_<key>,
  // command_<kind>) — the dominant prod reasons for the shop.
  assert.equal(featureBucketForReason("item_purchase_apple"), "purchases");
  assert.equal(featureBucketForReason("item_use_scroll"), "items");
  assert.equal(featureBucketForReason("command_give"), "items");
  // A purchase key ending in _win must NOT fall into the games heuristic.
  assert.equal(featureBucketForReason("purchase_big_win"), "purchases");
  assert.equal(featureBucketForReason("urugal_boss"), "games");
  assert.equal(featureBucketForReason("grimhold_runner"), "games");
  assert.equal(featureBucketForReason("rps_win"), "games");
  assert.equal(featureBucketForReason("currency_send_in"), "transfers");
  assert.equal(featureBucketForReason("admin_grant"), null);
  assert.equal(featureBucketForReason("backfill_message_xp"), null);
  assert.equal(featureBucketForReason("character_deleted_currency_rollover"), null);
  assert.equal(featureBucketForReason("emoticon_submission_accepted"), "other");
  assert.equal(featureBucketForReason("mystery_reason"), "other");
});

/* =============================================================
 * Retention cohort math
 * ============================================================= */

test("retention cohorts: exact D1/D7 counts from a known fixture", async () => {
  const { db } = makeTestDb();
  const now = Date.now();
  const cStart = startOfUtcDayMs(now) - 10 * DAY_MS; // cohort day, fully closed
  const cDay = dayKey(cStart);
  const at = (dayOffset: number, hour: number) => cStart + dayOffset * DAY_MS + hour * 60 * 60 * 1000;

  const mk = async (hour: number) => {
    const u = await createUser(db);
    await db.update(schema.users).set({ createdAt: new Date(at(0, hour)) }).where(eq(schema.users.id, u.id));
    return u;
  };
  const r1 = await mk(9); // back on day+1 (ledger) → D1 and D7
  const r2 = await mk(10); // back on day+5 (ip log) → D7 only
  await mk(11); // never back → neither
  const r4 = await mk(12); // active only on registration day → neither

  await insertLedger(db, { scope: "user", ownerId: r1.id, reason: "presence_ooc", createdAt: at(1, 10) });
  await insertIpLog(db, { userId: r2.id, ip: "10.1.0.2", firstSeenAt: at(0, 10), lastSeenAt: at(5, 12) });
  await insertIpLog(db, { userId: r4.id, ip: "10.1.0.4", firstSeenAt: at(0, 13), lastSeenAt: at(0, 13) });

  await ensureEngagementBackfill(db, now);

  assert.equal((await findDaily(db, cDay, "registration", "", ""))?.count, 4);
  assert.equal((await findDaily(db, cDay, "retention", "d1", ""))?.count, 1, "only r1 back on D+1");
  assert.equal((await findDaily(db, cDay, "retention", "d7", ""))?.count, 2, "r1 + r2 back within a week");

  // Exact percentages through the endpoint payload (client math): 25% / 50%.
  invalidatePermissionsCache();
  const admin = await createUser(db, { role: "masteradmin" });
  const app = await buildAnalyticsApp(db);
  const res = await app.inject({
    method: "GET",
    url: "/admin/analytics/engagement?range=30",
    headers: auth(await tokenFor(db, admin.id)),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    retention: Array<{ day: string; registrations: number; d1: number | null; d7: number | null }>;
  };
  const cohort = body.retention.find((r) => r.day === cDay);
  assert.ok(cohort, "cohort day present in the 30d window");
  // The admin account created "now" lands in today's cohort, not this one.
  assert.equal(cohort!.registrations, 4);
  assert.equal((100 * cohort!.d1!) / cohort!.registrations, 25);
  assert.equal((100 * cohort!.d7!) / cohort!.registrations, 50);
  // A cohort whose window hasn't closed reports null, never 0.
  const today = body.retention[body.retention.length - 1]!;
  assert.equal(today.d1, null);
  assert.equal(today.d7, null);
  await app.close();
});

/* =============================================================
 * Backfill: guarded + idempotent
 * ============================================================= */

test("backfill is guarded by the marker and idempotent on re-run", async () => {
  const { db } = makeTestDb();
  const now = Date.now();
  const dStart = startOfUtcDayMs(now) - 5 * DAY_MS;

  const u = await createUser(db);
  await db.update(schema.users).set({ createdAt: new Date(dStart + 3600_000) }).where(eq(schema.users.id, u.id));
  await insertLedger(db, { scope: "user", ownerId: u.id, reason: "message_say", createdAt: dStart + 7200_000, metadata: { messageId: "mX" } });

  const first = await ensureEngagementBackfill(db, now);
  assert.equal(first, true, "first call performs the backfill");
  const afterFirst = await allDailyRows(db);
  assert.ok(afterFirst.length > 0);

  const second = await ensureEngagementBackfill(db, now);
  assert.equal(second, false, "marker short-circuits the second call");
  assert.deepEqual(await allDailyRows(db), afterFirst, "no row changed on re-run");

  // Even with the marker removed, a forced re-run upserts identical rows.
  await db.delete(schema.analyticsDaily).where(eq(schema.analyticsDaily.metric, "engagement:backfill:v2"));
  const third = await ensureEngagementBackfill(db, now);
  assert.equal(third, true);
  assert.deepEqual(await allDailyRows(db), afterFirst, "recompute replaces, never doubles");

  // The daily pass is safe to run repeatedly too.
  await rollupEngagementYesterday(db, now);
  await rollupEngagementYesterday(db, now);
  const afterDaily = await allDailyRows(db);
  assert.deepEqual(afterDaily, afterFirst, "daily re-runs stay idempotent");
});

/* =============================================================
 * Endpoint: gate, shape, range clamp
 * ============================================================= */

test("engagement endpoint: permission gate, shape and range clamping", async () => {
  const { db } = makeTestDb();
  invalidatePermissionsCache();
  const app = await buildAnalyticsApp(db);

  // Unauthenticated and un-permissioned callers are both 403.
  const anon = await app.inject({ method: "GET", url: "/admin/analytics/engagement" });
  assert.equal(anon.statusCode, 403);
  const pleb = await createUser(db);
  const plebRes = await app.inject({
    method: "GET",
    url: "/admin/analytics/engagement",
    headers: auth(await tokenFor(db, pleb.id)),
  });
  assert.equal(plebRes.statusCode, 403);

  const admin = await createUser(db, { role: "masteradmin" });
  const adminHeaders = auth(await tokenFor(db, admin.id));

  const def = await app.inject({ method: "GET", url: "/admin/analytics/engagement", headers: adminHeaders });
  assert.equal(def.statusCode, 200);
  const defBody = def.json() as {
    range: number;
    series: Array<{ day: string; registrations: number; actives: number; messages: number; forumPosts: number }>;
    retention: Array<{ day: string; registrations: number; d1: number | null; d7: number | null }>;
    features: Array<{ bucket: string; serverId: string; count: number }>;
    servers: Array<{ id: string; label: string }>;
  };
  assert.equal(defBody.range, 30);
  assert.equal(defBody.series.length, 30);
  assert.equal(defBody.retention.length, 30);
  assert.ok(Array.isArray(defBody.features));
  assert.ok(Array.isArray(defBody.servers));
  const today = defBody.series[defBody.series.length - 1]!;
  assert.equal(today.day, dayKey(Date.now()));
  // Live today top-up: the two accounts created just now are visible
  // without any rollup having run.
  assert.equal(today.registrations, 2);

  const seven = await app.inject({ method: "GET", url: "/admin/analytics/engagement?range=7", headers: adminHeaders });
  assert.equal((seven.json() as { series: unknown[] }).series.length, 7);
  const clamped = await app.inject({ method: "GET", url: "/admin/analytics/engagement?range=999", headers: adminHeaders });
  assert.equal((clamped.json() as { range: number }).range, 30, "unsupported ranges clamp to 30");
  const ninety = await app.inject({ method: "GET", url: "/admin/analytics/engagement?range=90", headers: adminHeaders });
  assert.equal((ninety.json() as { series: unknown[] }).series.length, 90);

  await app.close();
});
