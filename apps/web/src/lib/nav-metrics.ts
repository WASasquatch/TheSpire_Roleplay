/**
 * First-party navigation metrics — the single client tracking layer
 * (plan_ext.md §3). ONE module, NO per-component `track()` sprinkling.
 *
 * Design constraints (all deliberate):
 *
 *   - Lives ENTIRELY outside React render. It's a plain module with a
 *     module-level buffer + timers; nothing here subscribes to or mutates
 *     React state, so recording a nav can never trigger a re-render.
 *   - `recordNav(kind, key, meta?)` is the ONLY entry point. It buffers an
 *     event, coalesces bursts (~150ms), and flushes on: buffer ≥ ~15, a ~10s
 *     timer, and — crucially — `document` `visibilitychange → hidden` via
 *     `navigator.sendBeacon`. NEVER `beforeunload`/`unload` (unreliable on
 *     mobile; MDN recommends visibilitychange + sendBeacon instead).
 *   - `fetch({keepalive:true})` is used ONLY for mid-session flushes; the
 *     tab-hide flush always uses `sendBeacon` (no response needed, survives
 *     the tab going away).
 *   - A `beforeSend` PII scrub runs on every event before it enters the wire
 *     batch: event kind + a small typed prop bag + route TEMPLATE only. No
 *     id-bearing URLs, no query strings, no free text.
 *   - Opt-out: respects `navigator.doNotTrack` / `globalPrivacyControl`. When
 *     set, every entry point is a no-op (nothing buffered, nothing sent). The
 *     server independently honors DNT/Sec-GPC too; this is the client half.
 *
 * The wire format mirrors the server ingest schema (analytics/ingest.ts):
 *   POST /a/e  { items: Array<PvItem | EvItem> }
 *     PvItem = { t:"pv", path, ref?, utmSource?, utmMedium?, utmCampaign? }
 *     EvItem = { t:"ev", kind, key, meta?, serverId? }
 */

/** In-app nav event kinds. Mirrors the server whitelist (EVENT_KINDS). */
export type NavKind = "modal" | "tab" | "room" | "server" | "page" | "feature";

/** Small typed prop bag. Scalar values only — scrubbed before send. */
export type NavMeta = Record<string, string | number | boolean | null | undefined>;

/** Wire items (match the server zod schema exactly). */
type EvItem = {
  t: "ev";
  kind: NavKind;
  key: string;
  meta?: string | null;
  serverId?: string | null;
};
type PvItem = {
  t: "pv";
  path: string;
  ref?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
};
type WireItem = EvItem | PvItem;

const INGEST_URL = "/a/e";
const FLUSH_AT = 15; // buffer size that forces a flush
const FLUSH_MS = 10_000; // periodic flush cadence
const COALESCE_MS = 150; // burst coalescing window
const MAX_BUFFER = 50; // matches server MAX_ITEMS; drop oldest past this
const KEY_MAX = 128;
const META_MAX = 2048;

/** Module-level buffer — the whole point is to keep this out of React. */
const buffer: WireItem[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

/**
 * Opt-out check. Respects the browser's Do-Not-Track and Global Privacy
 * Control signals. Cached per module load (these don't change mid-session).
 */
let optedOut: boolean | null = null;
function isOptedOut(): boolean {
  if (optedOut !== null) return optedOut;
  if (typeof navigator === "undefined" && typeof window === "undefined") {
    optedOut = true; // SSR / no DOM — never track.
    return optedOut;
  }
  const dnt =
    (typeof navigator !== "undefined" &&
      ((navigator as unknown as { doNotTrack?: string }).doNotTrack ??
        (window as unknown as { doNotTrack?: string }).doNotTrack)) ||
    null;
  const gpc =
    typeof navigator !== "undefined"
      ? (navigator as unknown as { globalPrivacyControl?: boolean }).globalPrivacyControl
      : undefined;
  optedOut = dnt === "1" || dnt === "yes" || gpc === true;
  return optedOut;
}

/**
 * beforeSend PII scrub. Runs on the typed meta bag before it's stringified
 * onto the wire. Keeps only scalar values, drops anything that looks like a
 * URL / query string / long free text, and truncates the JSON to the server
 * cap. Returns null when there's nothing meaningful left (so `meta` stays
 * absent rather than an empty "{}"). The KEY itself is caller-controlled and
 * expected to be a stable template token (e.g. "admin:users"), never a raw
 * id-bearing URL — we length-cap it here as a backstop.
 */
function scrubMeta(meta?: NavMeta): string | null {
  if (!meta) return null;
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v == null) continue;
    if (typeof v === "number" || typeof v === "boolean") {
      clean[k] = v;
      continue;
    }
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) continue;
      // Drop id-bearing URLs / query strings / anything long enough to be
      // free text. Small stable tokens (slugs, tab ids, kinds) pass.
      if (s.length > 64) continue;
      if (/[?#]/.test(s)) continue;
      if (/^https?:\/\//i.test(s) || s.includes("://")) continue;
      clean[k] = s;
    }
  }
  const keys = Object.keys(clean);
  if (keys.length === 0) return null;
  let json = JSON.stringify(clean);
  if (json.length > META_MAX) json = json.slice(0, META_MAX);
  return json;
}

/** Cap a key defensively (server also caps). */
function capKey(key: string): string {
  const s = String(key).trim();
  return s.length > KEY_MAX ? s.slice(0, KEY_MAX) : s;
}

/**
 * Serialize + POST the current buffer via `fetch({keepalive:true})`. Used for
 * mid-session flushes only (size / timer). Fire-and-forget: any failure is
 * swallowed so tracking never surfaces to the user.
 */
function flushViaFetch(): void {
  if (buffer.length === 0) return;
  const items = buffer.splice(0, buffer.length);
  const body = JSON.stringify({ items });
  try {
    void fetch(INGEST_URL, {
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body,
      // No credentials header needed for the anonymous path; the server
      // attaches userId from the bearer if the app sets one globally. We
      // include credentials so a same-origin session cookie (if any) rides
      // along without exposing tokens here.
      credentials: "same-origin",
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}

/**
 * Flush via `navigator.sendBeacon`. This is the reliable last-moment path used
 * on `visibilitychange → hidden`; the browser guarantees delivery attempt even
 * as the tab is backgrounded/closed. Falls back to keepalive fetch if beacon
 * is unavailable or the queue is rejected.
 */
function flushViaBeacon(): void {
  if (buffer.length === 0) return;
  const items = buffer.splice(0, buffer.length);
  const body = JSON.stringify({ items });
  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      const ok = navigator.sendBeacon(INGEST_URL, blob);
      if (ok) return;
    }
  } catch {
    /* fall through to fetch */
  }
  // Beacon unavailable / rejected — put items back and use keepalive fetch.
  buffer.unshift(...items);
  flushViaFetch();
}

/**
 * Lazily install the periodic timer + visibilitychange listener the first
 * time anything is recorded. Idempotent. NO React, NO unload handlers.
 */
function ensureStarted(): void {
  if (started) return;
  started = true;
  if (typeof window === "undefined") return;

  flushTimer = setInterval(() => {
    flushViaFetch();
  }, FLUSH_MS);

  // The reliable "user is leaving" signal on every platform including mobile.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushViaBeacon();
  });
  // `pagehide` is the mobile-Safari companion to visibilitychange; also a
  // beacon (NOT unload). Cheap belt-and-suspenders, still never blocks nav.
  window.addEventListener("pagehide", () => {
    flushViaBeacon();
  });
}

/** Coalesce a burst of records into one size-check tick (~150ms). */
function scheduleCoalescedFlushCheck(): void {
  if (coalesceTimer) return;
  coalesceTimer = setTimeout(() => {
    coalesceTimer = null;
    if (buffer.length >= FLUSH_AT) flushViaFetch();
  }, COALESCE_MS);
}

/**
 * Record one in-app navigation event. THE single public entry point.
 *
 * @param kind  one of the whitelisted NavKind values
 * @param key   a STABLE template token (e.g. "admin:users", a roomId, a modal
 *              token). Never pass a raw id-bearing URL or free text.
 * @param meta  optional small scalar prop bag; scrubbed before send.
 *
 * No-ops entirely when the user has opted out (DNT / GPC) or off-DOM.
 */
export function recordNav(kind: NavKind, key: string, meta?: NavMeta): void {
  if (typeof window === "undefined") return;
  if (isOptedOut()) return;
  const k = capKey(key);
  if (!k) return;
  ensureStarted();

  const item: EvItem = { t: "ev", kind, key: k };
  const scrubbed = scrubMeta(meta);
  if (scrubbed) item.meta = scrubbed;
  buffer.push(item);

  // Cap the buffer so a runaway producer can't grow it unbounded; drop the
  // OLDEST (least useful) entries past the cap.
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);

  if (buffer.length >= FLUSH_AT) flushViaFetch();
  else scheduleCoalescedFlushCheck();
}

/**
 * Record a public / unauth SPA page view. Same buffer + transport; separate
 * wire item shape (t:"pv"). The caller passes a route TEMPLATE (already
 * classified — see recordPageView usage in App.tsx), plus the raw referrer
 * (server reduces it to a bare hostname). Query strings must NOT be included
 * in `path`. No-ops on opt-out.
 */
export function recordPageView(path: string): void {
  if (typeof window === "undefined") return;
  if (isOptedOut()) return;
  const p = String(path).trim();
  if (!p) return;
  ensureStarted();

  const item: PvItem = { t: "pv", path: p };
  // Referrer + UTM are read here (off render) and classified server-side.
  try {
    if (document.referrer) item.ref = document.referrer;
    const params = new URLSearchParams(window.location.search);
    const us = params.get("utm_source");
    const um = params.get("utm_medium");
    const uc = params.get("utm_campaign");
    if (us) item.utmSource = us.slice(0, 128);
    if (um) item.utmMedium = um.slice(0, 128);
    if (uc) item.utmCampaign = uc.slice(0, 128);
  } catch {
    /* ignore */
  }
  buffer.push(item);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  if (buffer.length >= FLUSH_AT) flushViaFetch();
  else scheduleCoalescedFlushCheck();
}

/**
 * Classify a raw `window.location.pathname` into a stable route TEMPLATE for
 * the public / unauth SPA surfaces (plan_ext.md §3 hook 5). Returns null for
 * paths we don't want to count as a distinct public page (so the caller skips
 * recording). Templates collapse ids/slugs to `:param` so no id-bearing path
 * ever enters analytics.
 */
export function classifyPublicPath(pathname: string): string | null {
  const p = (pathname || "/").toLowerCase().replace(/\/+$/, "") || "/";
  if (p === "/") return "/";
  if (p === "/login") return "/login";
  if (p === "/rules") return "/rules";
  if (p === "/faqs") return "/faqs";
  if (/^\/faq\/[^/]+$/.test(p)) return "/faq/:slug";
  if (p === "/top-communities") return "/top-communities";
  if (p === "/scriptorium") return "/scriptorium";
  // Public deep-link viewers.
  if (/^\/p\/[^/]+$/.test(p)) return "/p/:name";
  if (/^\/w\/[^/]+$/.test(p)) return "/w/:slug";
  if (/^\/f\/[^/]+$/.test(p)) return "/f/:slug";
  // Scriptorium story permalinks: /<handle>/story/<slug> or similar deep links.
  if (/^\/[^/]+\/[^/]+$/.test(p)) return "/:handle/:slug";
  // Unknown public path — record a single catch-all template rather than the
  // raw path so we never leak an id.
  return "/other";
}
