/**
 * Admin analytics read endpoints (plan_ext.md §5 admin, §6).
 *
 *   GET /admin/analytics/public — hits over time, top referrers, geo, top pages,
 *                                 bot-vs-human split.
 *   GET /admin/analytics/inapp  — top modals / sub-tabs / rooms / servers /
 *                                 features + a per-day event series.
 *   GET /admin/analytics/engagement — durable per-day series (registrations,
 *                                 active users, messages, forum posts), D1/D7
 *                                 retention cohorts and the per-feature /
 *                                 per-server ledger breakdown (engagement.ts).
 *
 * Both are gated by `view_admin_analytics` via `requireSessionPermission` (same
 * helper the rest of /admin uses; the /admin preHandler in admin/routes.ts has
 * already attached `req.sessionUser`). They read the pre-aggregated
 * `analytics_daily` rollup for speed, then TOP UP "today" live from the raw
 * tables (today hasn't been rolled up yet). Rows are `WHERE is_bot = 0` by
 * default; `?includeBots=1` folds the ":bot" rollup rows / raw bot rows back in.
 * `?range=7|30|90` (days) bounds the window (default 30).
 *
 * The rollup encodes the bot flag as a ":bot" metric suffix (see rollup.ts), so
 * the base metric name is the human series and `<base>:bot` is the bot series;
 * this reader sums them per `includeBots`.
 */
import { and, gte, lt, sql, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PermissionKey } from "@thekeep/shared";
import { startOfUtcDayMs } from "@thekeep/shared";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import {
  analyticsDaily,
  analyticsEvent,
  analyticsPageView,
  rooms,
  servers,
  worlds,
  forums,
  stories,
  faqs,
} from "../db/schema.js";
import type { Db } from "../db/index.js";
import { requireSessionPermission } from "../auth/requireSessionPermission.js";
import { computeEngagementWindow } from "./engagement.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Clamp the range query to the supported 7/30/90-day windows (default 30). */
function parseRange(raw: string | undefined): 7 | 30 | 90 {
  const n = parseInt(raw ?? "", 10);
  return n === 7 ? 7 : n === 90 ? 90 : 30;
}

function parseBool(raw: string | undefined): boolean {
  return raw === "1" || raw === "true";
}

/** 'YYYY-MM-DD' (UTC) for a ms instant. */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Base + bot metric names for a metric family, honoring includeBots. When bots
 * are excluded we read only the base ("pageview"); when included we read both
 * ("pageview" + "pageview:bot") and the caller sums.
 */
function metricSet(base: string, includeBots: boolean): string[] {
  return includeBots ? [base, `${base}:bot`] : [base];
}

export async function registerAnalyticsAdminRoutes(app: FastifyInstance, db: Db): Promise<void> {
  const requirePermission = (req: FastifyRequest, reply: FastifyReply, key: PermissionKey) =>
    requireSessionPermission(req, reply, key, db);

  /* ================= PUBLIC site metrics ================= */
  app.get<{ Querystring: { range?: string; includeBots?: string } }>(
    "/admin/analytics/public",
    async (req, reply) => {
      if (!(await requirePermission(req, reply, "view_admin_analytics"))) return;
      const range = parseRange(req.query.range);
      const includeBots = parseBool(req.query.includeBots);
      const now = Date.now();
      const tStart = startOfUtcDayMs(now);
      // Rollup covers days strictly before today; the window's first day is
      // (range-1) days back so a 7-day range shows 7 buckets incl. today.
      const fromDay = dayKey(tStart - (range - 1) * DAY_MS);

      /* ----- rolled-up (historical) rows in-window, up to yesterday ----- */
      const pvMetrics = metricSet("pageview", includeBots);
      const visMetrics = metricSet("visitor", includeBots);
      const refMetrics = metricSet("referrer", includeBots);
      const geoMetrics = metricSet("geo", includeBots);

      const dailyRows = await db
        .select({
          day: analyticsDaily.day,
          metric: analyticsDaily.metric,
          dim1: analyticsDaily.dim1,
          dim2: analyticsDaily.dim2,
          count: analyticsDaily.count,
        })
        .from(analyticsDaily)
        .where(
          and(
            gte(analyticsDaily.day, fromDay),
            inArray(analyticsDaily.metric, [...pvMetrics, ...visMetrics, ...refMetrics, ...geoMetrics]),
          ),
        );

      // Per-day pageview + visitor series (seed every day in-window with 0).
      const series = new Map<string, { pageviews: number; visitors: number }>();
      for (let i = range - 1; i >= 0; i--) {
        series.set(dayKey(tStart - i * DAY_MS), { pageviews: 0, visitors: 0 });
      }
      const topPages = new Map<string, number>();
      const referrers = new Map<string, { medium: string; source: string | null; count: number }>();
      const geo = new Map<string, number>();
      let botPv = 0;
      let humanPv = 0;

      for (const r of dailyRows) {
        const base = r.metric.replace(/:bot$/, "");
        const isBot = r.metric.endsWith(":bot");
        if (base === "pageview") {
          const s = series.get(r.day);
          if (s) s.pageviews += r.count;
          if (r.dim1) topPages.set(r.dim1, (topPages.get(r.dim1) ?? 0) + r.count);
          if (isBot) botPv += r.count; else humanPv += r.count;
        } else if (base === "visitor") {
          const s = series.get(r.day);
          if (s) s.visitors += r.count;
        } else if (base === "referrer") {
          const k = `${r.dim1 ?? "direct"}|${r.dim2 ?? ""}`;
          const cur = referrers.get(k) ?? { medium: r.dim1 ?? "direct", source: r.dim2 ?? null, count: 0 };
          cur.count += r.count;
          referrers.set(k, cur);
        } else if (base === "geo") {
          if (r.dim1) geo.set(r.dim1, (geo.get(r.dim1) ?? 0) + r.count);
        }
      }

      /* ----- live "today" top-up straight from the raw table ----- */
      const todayFrom = new Date(tStart);
      const todayTo = new Date(now);
      const botFilter = includeBots ? undefined : sql`${analyticsPageView.isBot} = 0`;
      const rawWhere = (extra?: ReturnType<typeof sql> | undefined) =>
        and(gte(analyticsPageView.createdAt, todayFrom), lt(analyticsPageView.createdAt, todayTo), botFilter, extra);
      const todayKey = dayKey(now);

      const [todayPv] = await db
        .select({ n: sql<number>`count(*)` })
        .from(analyticsPageView)
        .where(rawWhere());
      const [todayVis] = await db
        .select({ n: sql<number>`count(distinct ${analyticsPageView.visitorHash})` })
        .from(analyticsPageView)
        .where(rawWhere(sql`${analyticsPageView.visitorHash} is not null`));
      const todayPageRows = await db
        .select({ path: analyticsPageView.path, n: sql<number>`count(*)` })
        .from(analyticsPageView)
        .where(rawWhere())
        .groupBy(analyticsPageView.path);
      const todayRefRows = await db
        .select({ medium: analyticsPageView.refMedium, source: analyticsPageView.refSource, n: sql<number>`count(*)` })
        .from(analyticsPageView)
        .where(rawWhere())
        .groupBy(analyticsPageView.refMedium, analyticsPageView.refSource);
      const todayGeoRows = await db
        .select({ country: analyticsPageView.geoCountry, n: sql<number>`count(*)` })
        .from(analyticsPageView)
        .where(rawWhere(sql`${analyticsPageView.geoCountry} is not null`))
        .groupBy(analyticsPageView.geoCountry);
      const [todayBots] = await db
        .select({ n: sql<number>`count(*)` })
        .from(analyticsPageView)
        .where(and(gte(analyticsPageView.createdAt, todayFrom), lt(analyticsPageView.createdAt, todayTo), sql`${analyticsPageView.isBot} = 1`));
      const [todayHumans] = await db
        .select({ n: sql<number>`count(*)` })
        .from(analyticsPageView)
        .where(and(gte(analyticsPageView.createdAt, todayFrom), lt(analyticsPageView.createdAt, todayTo), sql`${analyticsPageView.isBot} = 0`));

      // Fold today's live numbers in.
      const todaySeries = series.get(todayKey);
      if (todaySeries) {
        todaySeries.pageviews += todayPv?.n ?? 0;
        todaySeries.visitors += todayVis?.n ?? 0;
      }
      for (const r of todayPageRows) topPages.set(r.path, (topPages.get(r.path) ?? 0) + r.n);
      for (const r of todayRefRows) {
        const k = `${r.medium ?? "direct"}|${r.source ?? ""}`;
        const cur = referrers.get(k) ?? { medium: r.medium ?? "direct", source: r.source ?? null, count: 0 };
        cur.count += r.n;
        referrers.set(k, cur);
      }
      for (const r of todayGeoRows) if (r.country) geo.set(r.country, (geo.get(r.country) ?? 0) + r.n);
      botPv += todayBots?.n ?? 0;
      humanPv += todayHumans?.n ?? 0;

      const sortDesc = <T extends { count: number }>(a: T, b: T) => b.count - a.count;
      return {
        range,
        includeBots,
        series: [...series.entries()].map(([day, v]) => ({ day, ...v })),
        topPages: [...topPages.entries()].map(([path, count]) => ({ path, count })).sort(sortDesc).slice(0, 50),
        referrers: [...referrers.values()].sort(sortDesc).slice(0, 50),
        geo: [...geo.entries()].map(([country, count]) => ({ country, count })).sort(sortDesc).slice(0, 100),
        botSplit: { human: humanPv, bot: botPv },
      };
    },
  );

  /* ================= REFERRER URL DRILL-DOWN ================= */
  /**
   * GET /admin/analytics/referrer-urls?host=<domain>&range=&includeBots=
   *
   * The exact referring URLs (host + path, query/fragment already stripped
   * at ingest — plan_ext.md §7) under one referrer DOMAIN, so an admin can
   * see whether a suspicious domain's traffic comes from a telltale
   * phishing path rather than just eyeballing the bare domain. RAW-table
   * only (migration 0370): `ref_path` isn't rolled into analytics_daily and
   * is swept after analyticsRawRetentionDays, so this is a recent-window
   * tool by design — exactly the horizon that matters for live abuse.
   */
  app.get<{ Querystring: { host?: string; range?: string; includeBots?: string } }>(
    "/admin/analytics/referrer-urls",
    async (req, reply) => {
      if (!(await requirePermission(req, reply, "view_admin_analytics"))) return;
      const host = (req.query.host ?? "").trim().toLowerCase();
      if (!host || host.length > 255) { reply.code(400); return { error: "host required" }; }
      const range = parseRange(req.query.range);
      const includeBots = parseBool(req.query.includeBots);
      const now = Date.now();
      const from = new Date(startOfUtcDayMs(now) - (range - 1) * DAY_MS);
      const botFilter = includeBots ? undefined : sql`${analyticsPageView.isBot} = 0`;

      const rows = await db
        .select({ url: analyticsPageView.refPath, n: sql<number>`count(*)` })
        .from(analyticsPageView)
        .where(and(
          gte(analyticsPageView.createdAt, from),
          // Match the domain exactly OR any subdomain of it, mirroring the
          // classifier's suffix match, so "evil.example" also gathers
          // "login.evil.example". refHost is the bare hostname column.
          sql`(${analyticsPageView.refHost} = ${host} OR ${analyticsPageView.refHost} LIKE ${"%." + host})`,
          sql`${analyticsPageView.refPath} is not null`,
          botFilter,
        ))
        .groupBy(analyticsPageView.refPath);

      const urls = rows
        .map((r) => ({ url: r.url ?? host, count: Number(r.n) }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 100);
      return { host, range, includeBots, urls };
    },
  );

  /* ================= IN-APP nav metrics ================= */
  app.get<{ Querystring: { range?: string; includeBots?: string } }>(
    "/admin/analytics/inapp",
    async (req, reply) => {
      if (!(await requirePermission(req, reply, "view_admin_analytics"))) return;
      const range = parseRange(req.query.range);
      const includeBots = parseBool(req.query.includeBots);
      const now = Date.now();
      const tStart = startOfUtcDayMs(now);
      const fromDay = dayKey(tStart - (range - 1) * DAY_MS);

      const evMetrics = metricSet("event", includeBots);
      const dailyRows = await db
        .select({
          day: analyticsDaily.day,
          metric: analyticsDaily.metric,
          dim1: analyticsDaily.dim1, // event kind
          dim2: analyticsDaily.dim2, // event key
          count: analyticsDaily.count,
        })
        .from(analyticsDaily)
        .where(and(gte(analyticsDaily.day, fromDay), inArray(analyticsDaily.metric, evMetrics)));

      // Per-kind key tallies + a per-day total event series.
      const byKind = new Map<string, Map<string, number>>();
      const series = new Map<string, number>();
      for (let i = range - 1; i >= 0; i--) series.set(dayKey(tStart - i * DAY_MS), 0);

      const bump = (kind: string, key: string, n: number) => {
        let m = byKind.get(kind);
        if (!m) { m = new Map(); byKind.set(kind, m); }
        m.set(key, (m.get(key) ?? 0) + n);
      };
      for (const r of dailyRows) {
        bump(r.dim1 ?? "?", r.dim2 ?? "?", r.count);
        series.set(r.day, (series.get(r.day) ?? 0) + r.count);
      }

      /* ----- live "today" top-up from raw analytics_event ----- */
      const todayFrom = new Date(tStart);
      const todayTo = new Date(now);
      const botFilter = includeBots ? undefined : sql`${analyticsEvent.isBot} = 0`;
      const todayRows = await db
        .select({ kind: analyticsEvent.kind, key: analyticsEvent.key, n: sql<number>`count(*)` })
        .from(analyticsEvent)
        .where(and(gte(analyticsEvent.createdAt, todayFrom), lt(analyticsEvent.createdAt, todayTo), botFilter))
        .groupBy(analyticsEvent.kind, analyticsEvent.key);
      const todayKey = dayKey(now);
      for (const r of todayRows) {
        bump(r.kind, r.key, r.n);
        series.set(todayKey, (series.get(todayKey) ?? 0) + r.n);
      }

      /* ----- resolve raw id/slug keys → human labels (batch, per table) ----- */
      // One query per entity table, only for the keys that actually appear in
      // this window. Deleted/unknown entities fall back to "<key> (deleted)" so
      // the row still shows something and nothing crashes.
      const keysOf = (kind: string): string[] => [...(byKind.get(kind) ?? new Map()).keys()] as string[];
      const labelMap = async (
        keys: string[],
        table: Parameters<ReturnType<typeof db.select>["from"]>[0],
        keyCol: SQLiteColumn,
        labelCol: SQLiteColumn,
      ): Promise<Map<string, string>> => {
        const out = new Map<string, string>();
        if (keys.length === 0) return out;
        const rows = await db
          .select({ k: keyCol, v: labelCol })
          .from(table)
          .where(inArray(keyCol, keys));
        for (const r of rows) {
          if (r.k != null) out.set(String(r.k), r.v == null ? "" : String(r.v));
        }
        return out;
      };

      const [roomL, serverL, worldL, forumL, serverPageL, storyL, faqL] = await Promise.all([
        labelMap(keysOf("room"), rooms, rooms.id, rooms.name),
        labelMap(keysOf("server"), servers, servers.id, servers.name),
        labelMap(keysOf("world"), worlds, worlds.slug, worlds.name),
        labelMap(keysOf("forum"), forums, forums.slug, forums.name),
        labelMap(keysOf("serverPage"), servers, servers.slug, servers.name),
        labelMap(keysOf("story"), stories, stories.slug, stories.title),
        labelMap(keysOf("faq"), faqs, faqs.slug, faqs.question),
      ]);

      // Build ranked rows for a kind. When `labels` is provided, a missing key
      // means the entity was deleted → fall back to "<key> (deleted)". When no
      // map is given (profiles: the key is already the username; modals/tabs/
      // features/pages: raw keys ARE the label), the label is just the key.
      const topOf = (kind: string, labels?: Map<string, string>, n = 25) =>
        [...(byKind.get(kind) ?? new Map()).entries()]
          .map(([key, count]) => {
            const k = key as string;
            const resolved = labels?.get(k);
            const label = labels
              ? resolved && resolved.length
                ? resolved
                : `${k} (deleted)`
              : k;
            return { key: k, count: count as number, label };
          })
          .sort((a, b) => b.count - a.count)
          .slice(0, n);

      return {
        range,
        includeBots,
        series: [...series.entries()].map(([day, count]) => ({ day, count })),
        modals: topOf("modal"),
        tabs: topOf("tab"),
        rooms: topOf("room", roomL),
        servers: topOf("server", serverL),
        features: topOf("feature"),
        pages: topOf("page"),
        // Per-entity public-page views (label-resolved; distinct from the
        // template-collapsed `pages` aggregate above).
        profiles: topOf("profile"),
        worlds: topOf("world", worldL),
        forums: topOf("forum", forumL),
        serverPages: topOf("serverPage", serverPageL),
        stories: topOf("story", storyL),
        faqs: topOf("faq", faqL),
      };
    },
  );

  /* ================= DURABLE ENGAGEMENT metrics ================= */
  // Reads the engagement rollup families (engagement.ts) and tops "today"
  // up live from the same append-only sources. No bot dimension: every
  // source row is authenticated account activity. Retention values are
  // retained-user COUNTS (the client divides by that day's registrations);
  // a cohort whose window hasn't closed yet reports null, never 0.
  app.get<{ Querystring: { range?: string } }>(
    "/admin/analytics/engagement",
    async (req, reply) => {
      if (!(await requirePermission(req, reply, "view_admin_analytics"))) return;
      const range = parseRange(req.query.range);
      const now = Date.now();
      const tStart = startOfUtcDayMs(now);
      const fromDay = dayKey(tStart - (range - 1) * DAY_MS);

      const dailyRows = await db
        .select({
          day: analyticsDaily.day,
          metric: analyticsDaily.metric,
          dim1: analyticsDaily.dim1,
          dim2: analyticsDaily.dim2,
          count: analyticsDaily.count,
        })
        .from(analyticsDaily)
        .where(
          and(
            gte(analyticsDaily.day, fromDay),
            inArray(analyticsDaily.metric, [
              "registration",
              "activeUser",
              "message",
              "forumPost",
              "feature",
              "retention",
            ]),
          ),
        );

      interface DayBucket {
        registrations: number;
        actives: number;
        messages: number;
        forumPosts: number;
        /** null = no retention row rolled up for the cohort (distinct from
         *  an explicit zero-retained row, see rollupRetention's allowZero). */
        d1: number | null;
        d7: number | null;
      }
      const series = new Map<string, DayBucket>();
      for (let i = range - 1; i >= 0; i--) {
        series.set(dayKey(tStart - i * DAY_MS), {
          registrations: 0,
          actives: 0,
          messages: 0,
          forumPosts: 0,
          d1: null,
          d7: null,
        });
      }
      // Per (bucket, serverId) feature tallies over the window.
      const features = new Map<string, { bucket: string; serverId: string; count: number }>();
      const bumpFeature = (bucket: string, serverId: string, n: number) => {
        const k = `${bucket}|${serverId}`;
        const cur = features.get(k) ?? { bucket, serverId, count: 0 };
        cur.count += n;
        features.set(k, cur);
      };

      for (const r of dailyRows) {
        const s = series.get(r.day);
        if (!s) continue;
        if (r.metric === "registration") s.registrations += r.count;
        else if (r.metric === "activeUser") s.actives += r.count;
        else if (r.metric === "message") s.messages += r.count;
        else if (r.metric === "forumPost") s.forumPosts += r.count;
        else if (r.metric === "feature") bumpFeature(r.dim1 ?? "other", r.dim2 ?? "", r.count);
        else if (r.metric === "retention") {
          if (r.dim1 === "d1") s.d1 = (s.d1 ?? 0) + r.count;
          else if (r.dim1 === "d7") s.d7 = (s.d7 ?? 0) + r.count;
        }
      }

      /* ----- live "today" top-up from the append-only sources ----- */
      const today = await computeEngagementWindow(db, tStart, now);
      const todayBucket = series.get(dayKey(now));
      if (todayBucket) {
        todayBucket.registrations = today.registrations;
        todayBucket.actives = today.actives;
        todayBucket.messages = today.messages.reduce((a, r) => a + r.n, 0);
        todayBucket.forumPosts = today.forumPosts.reduce((a, r) => a + r.n, 0);
      }
      for (const r of today.features) bumpFeature(r.dim1, r.serverId, r.n);

      /* ----- resolve server names for the per-server feature dim ----- */
      const serverIds = [...new Set([...features.values()].map((f) => f.serverId).filter(Boolean))];
      const serverRows = serverIds.length
        ? await db
            .select({ id: servers.id, name: servers.name })
            .from(servers)
            .where(inArray(servers.id, serverIds))
        : [];
      const serverLabel = new Map(serverRows.map((r) => [r.id, r.name]));

      return {
        range,
        series: [...series.entries()].map(([day, v]) => ({
          day,
          registrations: v.registrations,
          actives: v.actives,
          messages: v.messages,
          forumPosts: v.forumPosts,
        })),
        // Cohort rows: counts + null while the D+1 / D+7 window is open.
        // A closed cohort with NO rolled-up row (rollup gap longer than the
        // retention sweep's lookback) also stays null — never a false 0.
        retention: [...series.entries()].map(([day, v]) => {
          const cohortStart = Date.parse(`${day}T00:00:00Z`);
          const d1Closed = now >= cohortStart + 2 * DAY_MS;
          const d7Closed = now >= cohortStart + 8 * DAY_MS;
          return {
            day,
            registrations: v.registrations,
            d1: d1Closed ? v.d1 : null,
            d7: d7Closed ? v.d7 : null,
          };
        }),
        features: [...features.values()].sort((a, b) => b.count - a.count),
        servers: serverIds
          .map((id) => ({ id, label: serverLabel.get(id) ?? id }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      };
    },
  );
}
