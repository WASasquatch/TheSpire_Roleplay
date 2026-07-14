/**
 * Durable engagement rollup — the second half of the analytics pipeline
 * (extends analytics/rollup.ts; same `analytics_daily` table, new metric
 * names). Every metric here derives from APPEND-ONLY sources so history
 * survives the pruning that eats the raw tables:
 *
 *   - `users.created_at`     — registrations (full history)
 *   - `earning_ledger`       — messages / forum posts / feature usage /
 *                              presence (append-only reward audit)
 *   - `user_ip_log`          — activity endpoints per (user, ip)
 *
 * Never derive these from `messages` (retention-pruned) or `sessions`
 * (swept every 60s) — that is the exact undercount this module fixes.
 *
 * Metric families written per UTC day (no ":bot" variants; all sources
 * are authenticated account activity):
 *
 *   - "registration" dim1=null   dim2=null      → accounts created
 *   - "activeUser"   dim1=null   dim2=null      → distinct active accounts
 *   - "message"      dim1=ic|ooc dim2=serverId  → chat messages credited
 *   - "forumPost"    dim1=topic|reply dim2=serverId
 *   - "feature"      dim1=bucket dim2=serverId  → ledger-reason buckets
 *   - "retention"    dim1=d1|d7  dim2=null      → retained users for the
 *                     cohort registered on `day` (counts, not percents —
 *                     the reader divides by that day's "registration")
 *
 * Message counts dedupe on the ledger metadata's messageId because the IC
 * fan-out writes one ledger row per voiced character for a single message.
 *
 * One-time backfill: `ensureEngagementBackfill` walks the whole history of
 * the append-only sources once (guarded by a marker row in analytics_daily)
 * so the charts have history the moment this ships. Upserts are keyed on
 * the unique (day, metric, dim1, dim2) index, so re-runs replace rather
 * than double — the whole module is idempotent.
 */
import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { startOfUtcDayMs } from "@thekeep/shared";
import { analyticsDaily } from "../db/schema.js";
import type { Db } from "../db/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' for a ms-epoch instant, UTC. */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Upsert one (day, metric, dim1, dim2) count. Dims are stored as "" (never
 * NULL): SQLite UNIQUE indexes treat NULLs as DISTINCT, so a NULL-dim row
 * would never hit the conflict target and re-runs would duplicate instead
 * of replace. `keepMax` guards the cells derived from the mutable
 * `user_ip_log.last_seen_at` (active users, retention): a later recompute
 * of a closed day can only see FEWER active traces than the run that
 * computed it right after the window closed — never overwrite a closed
 * day's count with a smaller one. `allowZero` writes an explicit 0 row
 * (used for retention so readers can tell "zero retained" apart from
 * "this cohort was never rolled up").
 */
async function upsertDaily(
  db: Db,
  day: string,
  metric: string,
  dim1: string | null,
  dim2: string | null,
  count: number,
  opts: { keepMax?: boolean; allowZero?: boolean } = {},
): Promise<void> {
  if (count < 0 || (count === 0 && !opts.allowZero)) return;
  await db
    .insert(analyticsDaily)
    .values({ id: nanoid(21), day, metric, dim1: dim1 ?? "", dim2: dim2 ?? "", count })
    .onConflictDoUpdate({
      target: [analyticsDaily.day, analyticsDaily.metric, analyticsDaily.dim1, analyticsDaily.dim2],
      set: {
        count: opts.keepMax
          ? sql`max(${analyticsDaily.count}, excluded.count)`
          : count,
      },
    });
}

/* =============================================================
 * Feature-bucket taxonomy over earning_ledger.reason
 * ============================================================= */

/**
 * Collapse the ledger reason vocabulary into a small, stable bucket set
 * for the per-feature breakdown. Returns null for reasons that are either
 * tracked by their own metric (messages, forum posts) or are bookkeeping
 * noise rather than user feature usage (admin grants, migrations).
 */
export function featureBucketForReason(reason: string): string | null {
  if (reason.startsWith("presence_")) return "presence";
  if (reason.startsWith("message_")) return null; // own metric family
  if (reason === "forum_topic" || reason === "forum_reply") return null; // own metric family
  if (reason.startsWith("scriptorium_")) return "scriptorium";
  if (reason.startsWith("purchase_raffle")) return "games";
  // Purchase prefixes must run BEFORE the generic _win/_loss game heuristic:
  // a cosmetic key ending in "_win" would otherwise be bucketed as games.
  if (
    reason.startsWith("item_purchase_") ||
    reason.startsWith("purchase_") ||
    reason.startsWith("border_purchase_")
  ) {
    return "purchases";
  }
  if (reason.startsWith("item_use_") || reason.startsWith("command_")) return "items";
  if (
    reason.startsWith("urugal_") ||
    reason.startsWith("grimhold_") ||
    reason.startsWith("eidolon_") ||
    reason.startsWith("raffle_") ||
    reason.endsWith("_win") ||
    reason.endsWith("_loss")
  ) {
    return "games";
  }
  if (reason === "currency_send_out" || reason === "currency_send_in") return "transfers";
  if (
    reason.startsWith("admin_") ||
    reason.startsWith("backfill_") ||
    reason === "character_deleted_currency_rollover"
  ) {
    return null; // bookkeeping, not user activity
  }
  return "other";
}

/* =============================================================
 * Per-window aggregate readers (shared by rollup, backfill and
 * the admin endpoint's live "today" top-up)
 * ============================================================= */

export interface EngagementDimRow {
  dim1: string;
  serverId: string;
  n: number;
}

export interface EngagementWindow {
  registrations: number;
  actives: number;
  messages: EngagementDimRow[]; // dim1 = "ic" | "ooc"
  forumPosts: EngagementDimRow[]; // dim1 = "topic" | "reply"
  features: EngagementDimRow[]; // dim1 = feature bucket
}

/**
 * Compute every engagement aggregate for [start, end). Raw SQL because the
 * active-user union spans three sources and the ledger columns are plain
 * ms integers (no Date marshaling needed).
 */
export async function computeEngagementWindow(
  db: Db,
  start: number,
  end: number,
): Promise<EngagementWindow> {
  const reg = db.get<{ n: number }>(
    sql`SELECT count(*) AS n FROM users WHERE created_at >= ${start} AND created_at < ${end}`,
  );

  // Distinct accounts with ANY recorded activity trace in the window:
  // ip-log endpoints (first/last seen) plus ledger actors on either scope.
  const act = db.get<{ n: number }>(sql`
    SELECT count(*) AS n FROM (
      SELECT user_id AS uid FROM user_ip_log
        WHERE last_seen_at >= ${start} AND last_seen_at < ${end}
      UNION
      SELECT user_id FROM user_ip_log
        WHERE first_seen_at >= ${start} AND first_seen_at < ${end}
      UNION
      SELECT owner_id FROM earning_ledger
        WHERE scope = 'user' AND created_at >= ${start} AND created_at < ${end}
      UNION
      SELECT c.user_id FROM earning_ledger el
        JOIN characters c ON c.id = el.owner_id
        WHERE el.scope = 'character' AND el.created_at >= ${start} AND el.created_at < ${end}
    )
  `);

  // Messages: dedupe on metadata.messageId — the IC fan-out writes one
  // ledger row per voiced character for a single chat message. The award
  // engine's reason vocabulary is message_<say|action|whisper> (the source
  // kind, earning/award.ts); IC vs OOC is the routing scope — character
  // pool = IC, user (master) pool = OOC.
  const msgRows = db.all<{ scope: string; server_id: string; n: number }>(sql`
    SELECT scope, server_id,
           count(DISTINCT coalesce(json_extract(metadata_json, '$.messageId'), id)) AS n
    FROM earning_ledger
    WHERE reason IN ('message_say', 'message_action', 'message_whisper')
      AND created_at >= ${start} AND created_at < ${end}
    GROUP BY scope, server_id
  `);

  const forumRows = db.all<{ reason: string; server_id: string; n: number }>(sql`
    SELECT reason, server_id, count(*) AS n
    FROM earning_ledger
    WHERE reason IN ('forum_topic', 'forum_reply')
      AND created_at >= ${start} AND created_at < ${end}
    GROUP BY reason, server_id
  `);

  const reasonRows = db.all<{ reason: string; server_id: string; n: number }>(sql`
    SELECT reason, server_id, count(*) AS n
    FROM earning_ledger
    WHERE created_at >= ${start} AND created_at < ${end}
    GROUP BY reason, server_id
  `);
  const featureMap = new Map<string, EngagementDimRow>();
  for (const r of reasonRows) {
    const bucket = featureBucketForReason(r.reason);
    if (!bucket) continue;
    const k = `${bucket}|${r.server_id}`;
    const cur = featureMap.get(k);
    if (cur) cur.n += r.n;
    else featureMap.set(k, { dim1: bucket, serverId: r.server_id, n: r.n });
  }

  return {
    registrations: reg?.n ?? 0,
    actives: act?.n ?? 0,
    messages: msgRows.map((r) => ({
      dim1: r.scope === "character" ? "ic" : "ooc",
      serverId: r.server_id,
      n: r.n,
    })),
    forumPosts: forumRows.map((r) => ({
      dim1: r.reason === "forum_topic" ? "topic" : "reply",
      serverId: r.server_id,
      n: r.n,
    })),
    features: [...featureMap.values()],
  };
}

/**
 * Users registered in [cohortStart, cohortEnd) with an activity trace in
 * [winStart, winEnd), from the same three append-only sources as the
 * active-user count.
 */
function retainedCount(
  db: Db,
  cohortStart: number,
  cohortEnd: number,
  winStart: number,
  winEnd: number,
): number {
  const row = db.get<{ n: number }>(sql`
    SELECT count(*) AS n FROM users u
    WHERE u.created_at >= ${cohortStart} AND u.created_at < ${cohortEnd}
      AND (
        EXISTS (
          SELECT 1 FROM user_ip_log l WHERE l.user_id = u.id
            AND ((l.last_seen_at >= ${winStart} AND l.last_seen_at < ${winEnd})
              OR (l.first_seen_at >= ${winStart} AND l.first_seen_at < ${winEnd}))
        )
        OR EXISTS (
          SELECT 1 FROM earning_ledger el WHERE el.scope = 'user' AND el.owner_id = u.id
            AND el.created_at >= ${winStart} AND el.created_at < ${winEnd}
        )
        OR EXISTS (
          SELECT 1 FROM earning_ledger el
            JOIN characters c ON c.id = el.owner_id
            WHERE el.scope = 'character' AND c.user_id = u.id
              AND el.created_at >= ${winStart} AND el.created_at < ${winEnd}
        )
      )
  `);
  return row?.n ?? 0;
}

/* =============================================================
 * Daily rollup steps
 * ============================================================= */

/** Roll one UTC day's engagement aggregates into analytics_daily. */
export async function rollupEngagementDay(db: Db, dayStartMs: number): Promise<void> {
  const start = startOfUtcDayMs(dayStartMs);
  const end = start + DAY_MS;
  const day = dayKey(start);
  const w = await computeEngagementWindow(db, start, end);

  await upsertDaily(db, day, "registration", null, null, w.registrations);
  // keepMax: the active count is partly derived from the mutable
  // user_ip_log.last_seen_at, and the scheduler re-rolls yesterday on every
  // boot — a recount after last_seen_at moved past midnight can only be
  // smaller than the one taken right after the day closed.
  await upsertDaily(db, day, "activeUser", null, null, w.actives, { keepMax: true });
  for (const r of w.messages) await upsertDaily(db, day, "message", r.dim1, r.serverId, r.n);
  for (const r of w.forumPosts) await upsertDaily(db, day, "forumPost", r.dim1, r.serverId, r.n);
  for (const r of w.features) await upsertDaily(db, day, "feature", r.dim1, r.serverId, r.n);
}

/**
 * Roll retention cohorts whose windows have CLOSED. For a cohort
 * registered on day D:
 *   - d1 window is [D+1d, D+2d) — closed once `now` reaches D+2d
 *   - d7 window is [D+1d, D+8d) — closed once `now` reaches D+8d
 * Counts (not percents) are stored so the reader can divide by that day's
 * "registration" row. `lookbackDays` bounds the daily sweep; the backfill
 * passes the full span.
 */
export async function rollupRetention(
  db: Db,
  now: number,
  opts: { lookbackDays?: number } = {},
): Promise<void> {
  const lookback = Math.max(1, opts.lookbackDays ?? 10);
  const todayStart = startOfUtcDayMs(now);
  for (let i = lookback; i >= 1; i--) {
    const cohortStart = todayStart - i * DAY_MS;
    const cohortEnd = cohortStart + DAY_MS;
    const day = dayKey(cohortStart);
    // allowZero: a closed cohort ALWAYS leaves a row, even when nobody came
    // back — the endpoint reads a missing row as "never rolled up" (null),
    // not 0, so gaps (server offline past the sweep) render as unknown.
    if (now >= cohortStart + 2 * DAY_MS) {
      const d1 = retainedCount(db, cohortStart, cohortEnd, cohortEnd, cohortEnd + DAY_MS);
      await upsertDaily(db, day, "retention", "d1", null, d1, { keepMax: true, allowZero: true });
    }
    if (now >= cohortStart + 8 * DAY_MS) {
      const d7 = retainedCount(db, cohortStart, cohortEnd, cohortEnd, cohortEnd + 7 * DAY_MS);
      await upsertDaily(db, day, "retention", "d7", null, d7, { keepMax: true, allowZero: true });
    }
  }
}

/* =============================================================
 * One-time historical backfill
 * ============================================================= */

/** Marker row: presence in analytics_daily means the backfill already ran.
 *  The metric name carries a version suffix — bump it whenever a computation
 *  bug means already-backfilled DBs must recompute (the upserts replace, so a
 *  re-run corrects history in place). v2: message reason vocabulary fix. */
const BACKFILL_MARKER_DAY = "1970-01-01";
const BACKFILL_MARKER_METRIC = "engagement:backfill:v2";
/** Hard bound on the historical walk so a very old install can't stall boot. */
const BACKFILL_MAX_DAYS = 730;

/**
 * Compute the historical dailies for every engagement metric from the
 * append-only sources, once. Guarded by a marker row; each day's write is
 * an idempotent upsert, so an interrupted run simply resumes/replaces on
 * the next attempt. Returns whether a backfill actually ran.
 */
export async function ensureEngagementBackfill(db: Db, now: number = Date.now()): Promise<boolean> {
  const marker = db.get<{ n: number }>(
    sql`SELECT count(*) AS n FROM analytics_daily
        WHERE day = ${BACKFILL_MARKER_DAY} AND metric = ${BACKFILL_MARKER_METRIC}`,
  );
  if ((marker?.n ?? 0) > 0) return false;

  const earliest = db.get<{ t: number | null }>(sql`
    SELECT min(t) AS t FROM (
      SELECT min(created_at) AS t FROM users
      UNION ALL SELECT min(created_at) FROM earning_ledger
      UNION ALL SELECT min(first_seen_at) FROM user_ip_log
    ) WHERE t IS NOT NULL
  `);

  const todayStart = startOfUtcDayMs(now);
  if (earliest?.t != null) {
    const floor = todayStart - BACKFILL_MAX_DAYS * DAY_MS;
    let cursor = Math.max(startOfUtcDayMs(earliest.t), floor);
    // Every complete day strictly before today; the daily scheduler owns
    // "yesterday" onward but re-covering it here is a harmless upsert.
    while (cursor < todayStart) {
      await rollupEngagementDay(db, cursor);
      cursor += DAY_MS;
    }
    const spanDays = Math.ceil((todayStart - Math.max(startOfUtcDayMs(earliest.t), floor)) / DAY_MS);
    await rollupRetention(db, now, { lookbackDays: spanDays + 8 });
  }

  await upsertDaily(db, BACKFILL_MARKER_DAY, BACKFILL_MARKER_METRIC, null, null, 1);
  return true;
}

/**
 * The daily engagement pass, called from rollupYesterday: run the guarded
 * one-time backfill, roll yesterday's aggregates, then sweep the recently
 * closed retention cohorts.
 */
export async function rollupEngagementYesterday(db: Db, now: number = Date.now()): Promise<void> {
  await ensureEngagementBackfill(db, now);
  await rollupEngagementDay(db, startOfUtcDayMs(now - DAY_MS));
  await rollupRetention(db, now);
}
