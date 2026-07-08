/**
 * Analytics ingest route (plan_ext.md §3 transport, §5).
 *
 * `POST /a/e` accepts the client `sendBeacon` JSON batch: page views + in-app
 * nav events. Modeled on `registerStatsRoutes` (routes/stats.ts):
 *
 *   - Anonymous-safe: a bearer/session is OPTIONAL. When a valid session is
 *     present, `userId` is attached to events (and a beacon-supplied `serverId`
 *     is kept); otherwise both stay null. Auth NEVER gates the route.
 *   - Rate-limited 120/min/IP, reusing the exact `limit` config shape from
 *     stats.ts.
 *   - Validated + length-capped + field-whitelisted (zod). Unknown fields drop.
 *   - `is_bot` set via the built-in UA filter (referrer-spam nulls the source).
 *   - Honors DNT / Sec-GPC when `analyticsRespectDnt` — a set signal → accept
 *     the request (200) but record nothing.
 *   - Resolves coarse geo from the request IP, then DISCARDS the IP (never
 *     stored). Classifies the referrer host. Computes the daily visitor hash.
 *   - Batched insert into analytics_page_view / analytics_event.
 *
 * Fire-and-forget: the handler ALWAYS returns 200 `{ ok: true }` quickly and
 * does the DB work off the response path, so a slow/failing write can never
 * block or fail the caller's beacon.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { sessions, users } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { readBearerToken } from "../routes/auth.js";
import { getSettings } from "../settings.js";
import { isBotUA } from "./botFilter.js";
import { classifyReferrer, hostnameOnly } from "./classify.js";
import { readFlyRegion, resolveGeo } from "./geo.js";
import {
  cap,
  insertEvents,
  insertPageViews,
  visitorHash,
  type EventRow,
  type PageViewRow,
} from "./recorder.js";

/** Field length caps. */
const PATH_MAX = 255;
const HOST_MAX = 255;
const UTM_MAX = 128;
const GEO_MAX = 8;
const KEY_MAX = 128;
const META_MAX = 2048;
/** Cap the batch so one beacon can't smuggle an unbounded insert. */
const MAX_ITEMS = 50;

/** Allowed in-app event kinds (whitelist; anything else is dropped). */
const EVENT_KINDS = ["modal", "tab", "room", "server", "page", "feature"] as const;

const pageViewSchema = z.object({
  t: z.literal("pv"),
  /** Route TEMPLATE, e.g. "/f/:slug". */
  path: z.string().min(1).max(PATH_MAX),
  /** Referrer (host is extracted server-side; path/query dropped). */
  ref: z.string().max(1024).optional().nullable(),
  utmSource: z.string().max(UTM_MAX).optional().nullable(),
  utmMedium: z.string().max(UTM_MAX).optional().nullable(),
  utmCampaign: z.string().max(UTM_MAX).optional().nullable(),
});

const eventSchema = z.object({
  t: z.literal("ev"),
  kind: z.enum(EVENT_KINDS),
  key: z.string().min(1).max(KEY_MAX),
  /** Small scrubbed JSON prop bag (stringified client-side). */
  meta: z.string().max(META_MAX).optional().nullable(),
  /** Active server at event time; attached only for authed events. */
  serverId: z.string().max(64).optional().nullable(),
});

const batchSchema = z.object({
  items: z.array(z.union([pageViewSchema, eventSchema])).max(MAX_ITEMS),
});

/** True when the request carries a DNT / Sec-GPC opt-out signal. */
function hasOptOut(req: FastifyRequest): boolean {
  const dnt = req.headers["dnt"];
  const gpc = req.headers["sec-gpc"];
  const v = (h: string | string[] | undefined): boolean => {
    const s = Array.isArray(h) ? h[0] : h;
    return s === "1" || s === "true";
  };
  return v(dnt) || v(gpc);
}

export async function registerAnalyticsRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // Same amplification-guard budget as /stats: generous for a real beacon
  // (flush every ~10s + on tab-hide) while capping abuse. Reused verbatim.
  const limit = {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  } as const;

  app.post("/a/e", limit, async (req) => {
    // Snapshot everything we need off the request synchronously, then do the
    // DB work fire-and-forget so the beacon returns immediately. `req.ip` is
    // the real client address behind Fly's edge (trustProxy is on).
    const ip = req.ip;
    const userAgent = req.headers["user-agent"] ?? null;
    const referer = (req.headers["referer"] ?? req.headers["referrer"] ?? null) as string | null;
    const headers = req.headers;
    const optOut = hasOptOut(req);
    const bearer = readBearerToken(req);
    const body = req.body;

    void (async () => {
      const settings = await getSettings(db);
      // Master switch off → accept + record nothing.
      if (!settings.analyticsEnabled) return;
      // DNT/Sec-GPC honored → accept + record nothing.
      if (settings.analyticsRespectDnt && optOut) return;

      const parsed = batchSchema.safeParse(body);
      if (!parsed.success) return;
      const { items } = parsed.data;
      if (items.length === 0) return;

      // Resolve session ONCE (cheap) so authed events can attach userId. A
      // missing/expired bearer → anonymous (userId stays null). Never gates.
      let userId: string | null = null;
      if (bearer) {
        const row = (await db
          .select({ userId: sessions.userId, expiresAt: sessions.expiresAt })
          .from(sessions)
          .where(eq(sessions.id, bearer))
          .limit(1))[0];
        if (row && +row.expiresAt >= Date.now()) {
          const u = (await db
            .select({ id: users.id, disabledAt: users.disabledAt })
            .from(users)
            .where(eq(users.id, row.userId))
            .limit(1))[0];
          if (u && !u.disabledAt) userId = u.id;
        }
      }

      const isBot = isBotUA(userAgent);
      const hash = visitorHash(ip, userAgent);
      const flyRegion = readFlyRegion(headers);
      const geo = resolveGeo(ip, flyRegion); // IP consumed here, then discarded.

      const pageViews: PageViewRow[] = [];
      const events: EventRow[] = [];

      for (const item of items) {
        if (item.t === "pv") {
          const refHost = hostnameOnly(item.ref ?? null);
          const cls = classifyReferrer(refHost, {
            source: item.utmSource ?? null,
            medium: item.utmMedium ?? null,
          });
          pageViews.push({
            path: cap(item.path, PATH_MAX) ?? item.path,
            refHost: cap(refHost, HOST_MAX),
            refSource: cap(cls.source, HOST_MAX),
            refMedium: cls.medium,
            utmSource: cap(item.utmSource ?? null, UTM_MAX)?.toLowerCase() ?? null,
            utmMedium: cap(item.utmMedium ?? null, UTM_MAX)?.toLowerCase() ?? null,
            utmCampaign: cap(item.utmCampaign ?? null, UTM_MAX),
            geoCountry: cap(geo.country, GEO_MAX),
            geoRegion: cap(geo.region, UTM_MAX),
            flyRegion: cap(flyRegion, GEO_MAX),
            visitorHash: hash,
            isBot,
          });
        } else {
          events.push({
            kind: item.kind,
            key: cap(item.key, KEY_MAX) ?? item.key,
            meta: cap(item.meta ?? null, META_MAX),
            // Only attach identity for authenticated beacons.
            userId,
            serverId: userId ? cap(item.serverId ?? null, 64) : null,
            isBot,
          });
        }
      }

      await insertPageViews(db, pageViews);
      await insertEvents(db, events);
    })().catch(() => {});

    // Always OK, always fast — never leak DB state or block the beacon.
    return { ok: true };
  });
}
