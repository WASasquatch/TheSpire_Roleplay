/**
 * Nightly analytics rollup + retention sweep (plan_ext.md §4 retention, §5).
 *
 * `rollupYesterday(db)`:
 *   1. Aggregates yesterday's (UTC) raw rows from analytics_page_view /
 *      analytics_event into `analytics_daily` (day, metric, dim1, dim2, count),
 *      upserting on the unique (day, metric, dim1, dim2) index so a re-run is
 *      idempotent (adds are additive but keyed, so re-aggregating replaces).
 *   2. Deletes raw rows older than `analytics_daily` is the reporting source,
 *      raw is short-lived) than `site_settings.analyticsRawRetentionDays`.
 *
 * Metrics emitted per day:
 *   - "pageview"  dim1=path,        dim2=null            → hits per page template
 *   - "visitor"   dim1=null,        dim2=null            → distinct visitor hashes
 *   - "referrer"  dim1=refMedium,   dim2=refSource       → referrer breakdown
 *   - "geo"       dim1=geoCountry,  dim2=null            → country breakdown
 *   - "event"     dim1=kind,        dim2=key             → in-app nav breakdown
 *
 * Bots are counted separately so the dashboard can include/exclude them: every
 * metric above is emitted with a bot flag folded into `metric` as a suffix
 * ("pageview" vs "pageview:bot"), keeping the rollup a single pass and the
 * unique index intact. The admin reader knows the convention.
 *
 * Scheduling: `startAnalyticsRollupScheduler` runs it at most once per UTC day
 * via a guarded interval (mirrors `startAnnouncementScheduler`). It self-checks
 * the last-run day so a process that restarts mid-day doesn't re-run, and a
 * long-lived process rolls over exactly once per day.
 *
 * Fire-and-forget + idempotent: never throws out to the scheduler.
 */
import { and, gte, lt, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";
import { startOfUtcDayMs } from "@thekeep/shared";
import {
  analyticsDaily,
  analyticsEvent,
  analyticsPageView,
} from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getSettings } from "../settings.js";

/** 'YYYY-MM-DD' for a ms-epoch instant, UTC. */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** [startMs, endMs) covering the whole UTC day that `ref` falls in. */
function utcDayBounds(ref: number): { start: number; end: number; day: string } {
  const start = startOfUtcDayMs(ref);
  return { start, end: start + 24 * 60 * 60 * 1000, day: dayKey(start) };
}

/** metric name with a ":bot" suffix when the source rows were bot hits. */
function metricName(base: string, isBot: boolean): string {
  return isBot ? `${base}:bot` : base;
}

/** Upsert a single (day, metric, dim1, dim2) count, replacing any prior value. */
async function upsertDaily(
  db: Db,
  day: string,
  metric: string,
  dim1: string | null,
  dim2: string | null,
  count: number,
): Promise<void> {
  if (count <= 0) return;
  await db
    .insert(analyticsDaily)
    .values({ id: nanoid(21), day, metric, dim1, dim2, count })
    .onConflictDoUpdate({
      target: [analyticsDaily.day, analyticsDaily.metric, analyticsDaily.dim1, analyticsDaily.dim2],
      // Re-run replaces (not adds) so a repeated rollup of the same day is
      // idempotent rather than doubling counts.
      set: { count },
    });
}

/**
 * Aggregate the raw rows for the UTC day BEFORE `now` (default: yesterday) into
 * analytics_daily, then sweep raw rows past the retention window. Idempotent.
 */
export async function rollupYesterday(db: Db, now: number = Date.now()): Promise<void> {
  const { start, end, day } = utcDayBounds(now - 24 * 60 * 60 * 1000);
  const from = new Date(start);
  const to = new Date(end);
  const inDay = (col: AnySQLiteColumn) => and(gte(col, from), lt(col, to));

  /* ---- page views: hits per path, split by bot flag ---- */
  const pvByPath = await db
    .select({
      path: analyticsPageView.path,
      isBot: analyticsPageView.isBot,
      n: sql<number>`count(*)`,
    })
    .from(analyticsPageView)
    .where(inDay(analyticsPageView.createdAt))
    .groupBy(analyticsPageView.path, analyticsPageView.isBot);
  for (const r of pvByPath) {
    await upsertDaily(db, day, metricName("pageview", r.isBot), r.path, null, r.n);
  }

  /* ---- unique visitors (distinct non-null hash), split by bot flag ---- */
  const visByBot = await db
    .select({
      isBot: analyticsPageView.isBot,
      n: sql<number>`count(distinct ${analyticsPageView.visitorHash})`,
    })
    .from(analyticsPageView)
    .where(and(inDay(analyticsPageView.createdAt), sql`${analyticsPageView.visitorHash} is not null`))
    .groupBy(analyticsPageView.isBot);
  for (const r of visByBot) {
    await upsertDaily(db, day, metricName("visitor", r.isBot), null, null, r.n);
  }

  /* ---- referrer breakdown: medium x source ---- */
  const refRows = await db
    .select({
      medium: analyticsPageView.refMedium,
      source: analyticsPageView.refSource,
      isBot: analyticsPageView.isBot,
      n: sql<number>`count(*)`,
    })
    .from(analyticsPageView)
    .where(inDay(analyticsPageView.createdAt))
    .groupBy(analyticsPageView.refMedium, analyticsPageView.refSource, analyticsPageView.isBot);
  for (const r of refRows) {
    await upsertDaily(db, day, metricName("referrer", r.isBot), r.medium ?? "direct", r.source, r.n);
  }

  /* ---- geo breakdown by country (null country skipped) ---- */
  const geoRows = await db
    .select({
      country: analyticsPageView.geoCountry,
      isBot: analyticsPageView.isBot,
      n: sql<number>`count(*)`,
    })
    .from(analyticsPageView)
    .where(and(inDay(analyticsPageView.createdAt), sql`${analyticsPageView.geoCountry} is not null`))
    .groupBy(analyticsPageView.geoCountry, analyticsPageView.isBot);
  for (const r of geoRows) {
    await upsertDaily(db, day, metricName("geo", r.isBot), r.country, null, r.n);
  }

  /* ---- in-app events: kind x key ---- */
  const evRows = await db
    .select({
      kind: analyticsEvent.kind,
      key: analyticsEvent.key,
      isBot: analyticsEvent.isBot,
      n: sql<number>`count(*)`,
    })
    .from(analyticsEvent)
    .where(inDay(analyticsEvent.createdAt))
    .groupBy(analyticsEvent.kind, analyticsEvent.key, analyticsEvent.isBot);
  for (const r of evRows) {
    await upsertDaily(db, day, metricName("event", r.isBot), r.kind, r.key, r.n);
  }

  /* ---- retention sweep: delete raw rows past the window ---- */
  const settings = await getSettings(db);
  const retentionDays = Math.max(1, settings.analyticsRawRetentionDays || 30);
  const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000);
  await db.delete(analyticsPageView).where(lt(analyticsPageView.createdAt, cutoff));
  await db.delete(analyticsEvent).where(lt(analyticsEvent.createdAt, cutoff));
}

/* ---------- scheduler ---------- */

/** Check cadence: hourly. The run itself is gated to once per UTC day. */
const TICK_MS = 60 * 60 * 1000;

let rollupTimer: NodeJS.Timeout | null = null;
let lastRunDay: string | null = null;

/**
 * Run the rollup at most once per UTC day. Guarded so a hot-reload / restart
 * doesn't stack timers or re-run within the same day. First tick fires on the
 * next event-loop turn (never blocks boot); subsequent checks are hourly and
 * only actually roll up when the UTC day has advanced past the last run.
 */
export function startAnalyticsRollupScheduler(deps: { db: Db }): () => void {
  const { db } = deps;
  if (rollupTimer) return () => stopAnalyticsRollupScheduler();

  const tick = () => {
    const today = dayKey(Date.now());
    if (lastRunDay === today) return; // already rolled up for this UTC day
    lastRunDay = today;
    void rollupYesterday(db).catch(() => {});
  };

  // eslint-disable-next-line no-console
  console.info("[analytics] rollup scheduler started", { tickMs: TICK_MS });
  rollupTimer = setInterval(tick, TICK_MS);
  setImmediate(tick);
  return () => stopAnalyticsRollupScheduler();
}

export function stopAnalyticsRollupScheduler(): void {
  if (rollupTimer) {
    clearInterval(rollupTimer);
    rollupTimer = null;
  }
}
