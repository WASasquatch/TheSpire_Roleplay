/**
 * HTTP / session-token utilities for the web client.
 *
 * The server moved from an HttpOnly session cookie to a bearer token
 * stored client-side. The token is reachable from JavaScript, so an
 * XSS in this app would be more dangerous than it was before. The
 * bio-HTML sanitizer + the lack of inline-script dependencies mitigate
 * but do not eliminate that risk.
 *
 * Storage layering, per-tab isolation that survives mobile suspend:
 *
 *   1. `sessionStorage["tk_sid"]`, the primary holder. Lives for the
 *      page session, gives us per-tab isolation (two tabs can be
 *      signed in as two different accounts).
 *
 *   2. `localStorage["tk_sid_map"]`, a JSON object keyed by per-tab
 *      UUIDs. Acts as the recovery store when iOS / Android suspend a
 *      backgrounded tab and reclaim its JS context: on the next read,
 *      sessionStorage comes up empty, we look up this tab's UUID in the
 *      map, restore the token, and continue. Without this fallback the
 *      socket reconnect after a screen-off lands with no auth and the
 *      user gets booted to login.
 *
 *   3. Per-tab UUID, stored in BOTH `window.name` (designed to persist
 *      across navigation + tab restoration) AND in `sessionStorage`. We
 *      prefer window.name because it's part of the browsing-context
 *      state browsers preserve through memory-pressure discard/restore;
 *      sessionStorage is the in-session belt-and-suspenders backup.
 *
 * Net effect: closing a tab loses the session (sessionStorage gone,
 * window.name gone → tab id gone → orphaned map entry pruned after
 * the inactivity threshold). Backgrounding a tab and coming back,
 * even through a hard discard, restores the same session for that
 * tab without leaking it to a sibling tab signed in as someone else.
 */

const TOKEN_STORAGE_KEY = "tk_sid";
const TAB_ID_STORAGE_KEY = "tk_tab_id";
const TAB_ID_WINDOW_NAME_PREFIX = "tk-tab-";
const TOKEN_MAP_STORAGE_KEY = "tk_sid_map";

/** Prune map entries unused for this long. 90 days comfortably exceeds
 *  the server's session TTL, entries older than that wouldn't validate
 *  anyway, and an active tab updates its entry every successful
 *  setSessionToken / clearSessionToken call. */
const TOKEN_MAP_PRUNE_MS = 90 * 24 * 60 * 60 * 1000;

interface TokenMapEntry {
  token: string;
  /** Last time this entry was written. Drives the inactivity prune. */
  lastSeen: number;
}

/**
 * Return this tab's stable UUID, generating one on first call. The id
 * lives in `window.name` (browsing-context state, survives navigation
 * and most tab-restore paths) with a sessionStorage shadow as a fast
 * fallback. The window.name prefix guards against another site or a
 * stray `<a target="...">` accidentally setting a name we'd misread.
 */
function getOrCreateTabId(): string {
  if (typeof window === "undefined") return "";
  const fromName = window.name;
  if (fromName && fromName.startsWith(TAB_ID_WINDOW_NAME_PREFIX)) {
    const candidate = fromName.slice(TAB_ID_WINDOW_NAME_PREFIX.length);
    // Tolerate any uuid-shape; crypto.randomUUID emits the canonical
    // 8-4-4-4-12 lowercase hex form.
    if (/^[0-9a-f-]{8,40}$/i.test(candidate)) return candidate;
  }
  try {
    const ss = window.sessionStorage.getItem(TAB_ID_STORAGE_KEY);
    if (ss) {
      // Sync window.name back so a future discard-restore can find it.
      window.name = TAB_ID_WINDOW_NAME_PREFIX + ss;
      return ss;
    }
  } catch { /* private-mode */ }
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  try { window.sessionStorage.setItem(TAB_ID_STORAGE_KEY, id); }
  catch { /* private-mode */ }
  window.name = TAB_ID_WINDOW_NAME_PREFIX + id;
  return id;
}

function readTokenMap(): Record<string, TokenMapEntry> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(TOKEN_MAP_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, TokenMapEntry>;
  } catch {
    return {};
  }
}

/**
 * Persist the map with stale entries pruned. Always pass through this
 * helper so the prune contract is uniform, every write tidies up
 * after long-closed tabs without us needing a dedicated sweep job.
 */
function writeTokenMap(map: Record<string, TokenMapEntry>): void {
  if (typeof window === "undefined") return;
  const now = Date.now();
  for (const [k, v] of Object.entries(map)) {
    if (!v || typeof v.token !== "string" || typeof v.lastSeen !== "number") {
      delete map[k];
      continue;
    }
    if (now - v.lastSeen > TOKEN_MAP_PRUNE_MS) {
      delete map[k];
    }
  }
  try { window.localStorage.setItem(TOKEN_MAP_STORAGE_KEY, JSON.stringify(map)); }
  catch { /* quota or private-mode, recovery still works while sessionStorage holds the token */ }
}

/**
 * Pull a human-readable error message out of a non-OK Response. The server
 * returns either `{ error: "..." }` or `{ message: "..." }` depending on
 * the route, older routes use `error`, zod-validation routes use
 * `message`. Falls back to `<status> <statusText>` when the body isn't
 * JSON or doesn't carry either field.
 *
 * Single source of truth, without this, six components each rolled their
 * own copy and any future server-side change to the error shape would
 * have to land in all of them.
 */
export async function readError(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as {
      error?: string;
      message?: string;
      issues?: Array<{ path?: string; message: string }>;
    };
    // Zod validation failures come back from the server's error handler as
    // `{ error: "validation", issues: [{ path, message }] }`. The bare
    // "validation" code is meaningless to a user (the "click Save → just
    // says Validation" report), so surface the first issue's actual reason
    // — e.g. `bioHtml: String must contain at most 50000 character(s)`.
    const firstIssue = j.issues?.find((i) => typeof i?.message === "string");
    if (firstIssue) {
      return firstIssue.path ? `${firstIssue.path}: ${firstIssue.message}` : firstIssue.message;
    }
    return j.error ?? j.message ?? `${r.status} ${r.statusText}`;
  } catch {
    return `${r.status} ${r.statusText}`;
  }
}

/**
 * Fetch-response unwrapper: parse the JSON body and return it typed as `T`,
 * or throw an `Error` whose message comes from `readError` when the response
 * is non-OK. The canonical `readError`-based form — previously copied
 * verbatim into earning/emoticonSubmissions/worldEntities client libs.
 */
export async function jsonOrThrow<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(await readError(r));
  return (await r.json()) as T;
}

/**
 * Read the per-tab session token, or null if the tab isn't signed in.
 *
 * Fast path: sessionStorage hit. Recovery path: when sessionStorage is
 * empty (mobile suspend purged the JS context, freshly-restored tab),
 * look the token up in the localStorage map keyed by this tab's UUID.
 * On recovery we re-seed sessionStorage so subsequent reads in the
 * same page session stay fast and don't repeatedly hit localStorage.
 */
export function getSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const ss = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (ss) return ss;
  } catch { /* fall through to map */ }
  const tabId = getOrCreateTabId();
  if (!tabId) return null;
  const map = readTokenMap();
  const entry = map[tabId];
  if (!entry || !entry.token) return null;
  // Recovery hit, re-seed sessionStorage so the hot path takes over.
  try { window.sessionStorage.setItem(TOKEN_STORAGE_KEY, entry.token); }
  catch { /* private-mode, read still returns the token, just won't cache */ }
  return entry.token;
}

/**
 * Persist the token returned by /auth/login or /auth/register. Writes
 * to BOTH sessionStorage (per-tab fast path) and the localStorage map
 * (suspend-recovery fallback, keyed by this tab's UUID).
 */
export function setSessionToken(token: string): void {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token); }
  catch { /* private-mode: nothing to do, the tab just won't persist */ }
  const tabId = getOrCreateTabId();
  if (!tabId) return;
  const map = readTokenMap();
  map[tabId] = { token, lastSeen: Date.now() };
  writeTokenMap(map);
}

/**
 * Append `?characterId=<id>` (or `&characterId=<id>` if the URL already
 * has a query string) when the active tab is in-character. Used by
 * friend + DM fetches so the server scopes responses to the right
 * identity, Char A and Char B of the same player keep separate
 * friends lists and inboxes.
 *
 * Reads from the Zustand store at call time, so callers don't need
 * to thread the character id through props. When the user is OOC,
 * returns the URL unchanged.
 */
export function withIdentityQuery(url: string, characterId: string | null | undefined): string {
  if (!characterId) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}characterId=${encodeURIComponent(characterId)}`;
}

/**
 * Wipe the token (logout, or 401 from /auth/me). Clears BOTH the
 * sessionStorage hot path and this tab's entry in the localStorage
 * recovery map, without removing the map entry, the next read after
 * logout would re-seed sessionStorage from the recovery store and the
 * user would silently bounce back to the previous session.
 */
export function clearSessionToken(): void {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.removeItem(TOKEN_STORAGE_KEY); }
  catch { /* private-mode */ }
  const tabId = getOrCreateTabId();
  if (!tabId) return;
  const map = readTokenMap();
  if (tabId in map) {
    delete map[tabId];
    writeTokenMap(map);
  }
}

/**
 * Monkey-patch `window.fetch` once on app boot so every same-origin
 * request automatically carries `Authorization: Bearer <token>` when
 * the tab has one. The alternative would be a wrapped `apiFetch` and
 * a sweep of every fetch call site, this is fewer moving parts.
 *
 * Constraints:
 *   - Same-origin only. Third-party fetches (CDN, external APIs) must
 *     not leak the token, so we test the URL's origin before injecting.
 *   - Existing Authorization header wins. If a caller passes its own
 *     header (test harness, future OAuth flow) we leave it alone.
 *   - Idempotent. We tag the patched fetch so a hot-reload doesn't
 *     wrap it twice.
 */
const PATCH_FLAG = "__thekeepAuthPatched";
type FetchPatched = typeof fetch & { [PATCH_FLAG]?: true };

export function installAuthFetch(): void {
  if (typeof window === "undefined") return;
  const cur = window.fetch as FetchPatched;
  if (cur[PATCH_FLAG]) return;

  const original = window.fetch.bind(window);
  const patched = ((input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const token = getSessionToken();
    if (!token) return original(input, init);

    // Resolve the request URL to an absolute href so we can compare
    // origin against window.location. Relative paths ("/auth/me",
    // "rooms/foo") always count as same-origin and short-circuit.
    let isSameOrigin = true;
    try {
      const urlStr =
        typeof input === "string" ? input :
        input instanceof URL ? input.href :
        input.url;
      if (/^https?:\/\//i.test(urlStr)) {
        isSameOrigin = new URL(urlStr).origin === window.location.origin;
      }
    } catch { /* malformed url, let the original fetch surface the error */ }
    if (!isSameOrigin) return original(input, init);

    const headers = new Headers(init.headers);
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    return original(input, { ...init, headers });
  }) as FetchPatched;
  patched[PATCH_FLAG] = true;
  window.fetch = patched;
}
