/**
 * Analytics write layer: throttle + batch + visitor-hash (plan_ext.md §2, §4, §5).
 *
 * Two concerns live here so the ingest route and the server-side document-GET
 * hook share one writer:
 *
 *   1. `admit()` throttle — the same in-memory Map pattern as `auth/ipLog.ts`:
 *      at most one page-view write per (visitorHash, path) per THROTTLE_MS, so a
 *      refresh storm can't flood the single SQLite writer. Events (in-app nav)
 *      are NOT throttled here (they're already client-batched + validated).
 *
 *   2. `visitorHash(ip, ua)` — sha256 over a DAILY-ROTATING in-memory salt + ip +
 *      ua (+ the UTC day). The salt is generated at process start and rolled
 *      over each UTC day; it is never persisted, so yesterday's hashes become
 *      non-reversible once the salt rotates (the GoatCounter/Plausible pattern).
 *      This yields cookieless unique counts with no stable identifier. The raw
 *      IP is consumed ONLY to build the hash + resolve geo, then discarded — it
 *      never enters the analytics tables.
 *
 * Writes are fire-and-forget: analytics must never add latency to, or fail, a
 * real request. Inserts are small batches via drizzle.
 */
import { createHash, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { analyticsEvent, analyticsPageView } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getSettings } from "../settings.js";
import { isBotUA } from "./botFilter.js";
import { classifyReferrer, hostnameOnly } from "./classify.js";
import { readFlyRegion, resolveGeo } from "./geo.js";

/** One effective page-view write per (visitorHash, path) per minute. */
const THROTTLE_MS = 60_000;
/** Garbage-collect the throttle map once it grows past this many keys. */
const GC_AT = 20_000;

const lastWrite = new Map<string, number>();

function gc(now: number): void {
  if (lastWrite.size < GC_AT) return;
  for (const [k, t] of lastWrite) {
    if (now - t > THROTTLE_MS) lastWrite.delete(k);
  }
}

/**
 * Returns true the first time `key` is seen in a THROTTLE_MS window, then false
 * until the window lapses. Mirrors `auth/ipLog.ts`'s `admit`.
 */
export function admit(key: string, now: number = Date.now()): boolean {
  const prev = lastWrite.get(key);
  if (prev !== undefined && now - prev < THROTTLE_MS) return false;
  lastWrite.set(key, now);
  gc(now);
  return true;
}

/* ---------- daily-rotating visitor-hash salt ---------- */

const utcDay = (now: number = Date.now()): string =>
  new Date(now).toISOString().slice(0, 10);

let salt = randomBytes(32).toString("hex");
let saltDay = utcDay();

/** Roll the salt when the UTC day changes so prior-day hashes go stale. */
function currentSalt(): string {
  const today = utcDay();
  if (today !== saltDay) {
    salt = randomBytes(32).toString("hex");
    saltDay = today;
  }
  return salt;
}

/**
 * Cookieless, daily-rotating visitor hash. Non-reversible once the salt rotates
 * at UTC midnight. Returns null when there's no IP to hash (nothing to dedupe
 * on) — a null `visitor_hash` row still counts as a page view, just not toward
 * unique visitors.
 */
export function visitorHash(
  ip: string | null | undefined,
  userAgent: string | null | undefined,
): string | null {
  if (!ip) return null;
  return createHash("sha256")
    .update(currentSalt())
    .update("\0")
    .update(ip)
    .update("\0")
    .update(userAgent ?? "")
    .update("\0")
    .update(saltDay)
    .digest("hex");
}

/* ---------- length caps + batched inserts ---------- */

/** Trim/cap a stored string field; null-through empty. */
export function cap(v: string | null | undefined, max: number): string | null {
  if (v == null) return null;
  const s = String(v).slice(0, max);
  return s.length ? s : null;
}

export interface PageViewRow {
  path: string;
  refHost?: string | null;
  refSource?: string | null;
  refMedium?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  geoCountry?: string | null;
  geoRegion?: string | null;
  flyRegion?: string | null;
  visitorHash?: string | null;
  isBot?: boolean;
}

export interface EventRow {
  kind: string;
  key: string;
  meta?: string | null;
  userId?: string | null;
  serverId?: string | null;
  isBot?: boolean;
}

/**
 * Insert a batch of page views. Fire-and-forget: swallows errors so telemetry
 * never surfaces to the caller. No-op on empty input.
 */
export async function insertPageViews(db: Db, rows: PageViewRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(analyticsPageView).values(
    rows.map((r) => ({
      id: nanoid(21),
      path: r.path,
      refHost: r.refHost ?? null,
      refSource: r.refSource ?? null,
      refMedium: r.refMedium ?? null,
      utmSource: r.utmSource ?? null,
      utmMedium: r.utmMedium ?? null,
      utmCampaign: r.utmCampaign ?? null,
      geoCountry: r.geoCountry ?? null,
      geoRegion: r.geoRegion ?? null,
      flyRegion: r.flyRegion ?? null,
      visitorHash: r.visitorHash ?? null,
      isBot: r.isBot ?? false,
    })),
  );
}

/** Insert a batch of in-app nav events. Same fire-and-forget contract. */
export async function insertEvents(db: Db, rows: EventRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(analyticsEvent).values(
    rows.map((r) => ({
      id: nanoid(21),
      kind: r.kind,
      key: r.key,
      meta: r.meta ?? null,
      userId: r.userId ?? null,
      serverId: r.serverId ?? null,
      isBot: r.isBot ?? false,
    })),
  );
}

/* ---------- server-side document-GET page-view hook (plan_ext.md §2a) ---------- */

/** Field length caps for stored referrer/UTM/geo columns. */
const HOST_MAX = 255;
const UTM_MAX = 128;
const GEO_MAX = 8;

/**
 * Record a single server-rendered document GET as a page view. Called from the
 * `onRequest` hook in index.ts alongside `recordHttpIp`, gated to document GETs.
 *
 * `path` is the route TEMPLATE ("/f/:slug"), never the resolved slug/id, so the
 * caller passes the matched route pattern, not `req.url`. The raw IP is used
 * only to build the daily visitor hash + resolve coarse geo, then discarded.
 *
 * Fully fire-and-forget + guarded:
 *   - master `analyticsEnabled` off → no-op
 *   - throttled per (visitorHash, path) so a refresh storm can't flood the writer
 *   - never throws (errors are swallowed)
 *
 * DNT/Sec-GPC is NOT honored here: the server-side hook records an anonymous,
 * cookieless, aggregate hit with no stable identifier, so there is nothing for
 * the opt-out to protect. The DNT gate applies to the client beacon (`/a/e`),
 * which can carry a stable userId. `is_bot` is flagged (not dropped) so counts
 * can exclude bots at read time.
 */
export function recordServerPageView(
  db: Db,
  input: {
    path: string;
    /**
     * Optional per-ENTITY hit (kind = "world"/"forum"/"profile"/… , key = the
     * real slug/name). Recorded as an `analyticsEvent` row so the admin tab can
     * break public pages out per entity instead of collapsing them into the
     * `:slug` template. Throttled on its OWN key so it still records when the
     * page-view below is throttled.
     */
    entity?: { kind: string; key: string };
    ip: string | null | undefined;
    userAgent: string | null | undefined;
    referer: string | null | undefined;
    headers: Record<string, string | string[] | undefined>;
  },
): void {
  void (async () => {
    const settings = await getSettings(db);
    if (!settings.analyticsEnabled) return;

    const ua = input.userAgent ?? null;
    const hash = visitorHash(input.ip, ua);
    const now = Date.now();
    const bot = isBotUA(ua);

    // Per-entity hit (kind/key = the real slug/name). Throttled on a SEPARATE
    // key and wrapped so it records independently of — and never blocks — the
    // page-view insert below, even when the page view is throttled away.
    if (input.entity) {
      try {
        const evKey = `ev:${hash ?? "anon:" + (ua ?? "")}:${input.entity.kind}:${input.entity.key}`;
        if (admit(evKey, now)) {
          await insertEvents(db, [
            { kind: input.entity.kind, key: input.entity.key, userId: null, isBot: bot },
          ]);
        }
      } catch {
        /* entity telemetry never blocks the page-view */
      }
    }

    // Throttle on (visitorHash, path). When there's no IP to hash we fall back
    // to a UA-scoped key so a headless flood on the same UA still throttles.
    const throttleKey = `pv:${hash ?? "anon:" + (ua ?? "")}:${input.path}`;
    if (!admit(throttleKey, now)) return;

    const refHost = hostnameOnly(input.referer);
    const cls = classifyReferrer(refHost);
    const flyRegion = readFlyRegion(input.headers);
    // Resolve coarse geo from the raw IP, then DISCARD the IP (never stored).
    const geo = resolveGeo(input.ip, flyRegion);

    await insertPageViews(db, [
      {
        path: cap(input.path, HOST_MAX) ?? input.path,
        refHost: cap(refHost, HOST_MAX),
        refSource: cap(cls.source, HOST_MAX),
        refMedium: cls.medium,
        geoCountry: cap(geo.country, GEO_MAX),
        geoRegion: cap(geo.region, UTM_MAX),
        flyRegion: cap(flyRegion, GEO_MAX),
        visitorHash: hash,
        isBot: isBotUA(ua),
      },
    ]);
  })().catch(() => {});
}
