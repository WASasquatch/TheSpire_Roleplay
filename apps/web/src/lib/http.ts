/**
 * HTTP / session-token utilities for the web client.
 *
 * The server moved from an HttpOnly session cookie to a bearer token
 * stored client-side. The token lives in `sessionStorage` so it is
 * scoped to the individual browser tab — two tabs of the app can be
 * signed in as different accounts without interfering. The trade-off
 * compared to HttpOnly cookies is that the token is reachable from
 * JavaScript, so an XSS in this app would be more dangerous than it
 * was before. The bio-HTML sanitizer + the lack of inline-script
 * dependencies mitigate but do not eliminate that risk.
 */

const TOKEN_STORAGE_KEY = "tk_sid";

/**
 * Pull a human-readable error message out of a non-OK Response. The server
 * returns either `{ error: "..." }` or `{ message: "..." }` depending on
 * the route — older routes use `error`, zod-validation routes use
 * `message`. Falls back to `<status> <statusText>` when the body isn't
 * JSON or doesn't carry either field.
 *
 * Single source of truth — without this, six components each rolled their
 * own copy and any future server-side change to the error shape would
 * have to land in all of them.
 */
export async function readError(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { error?: string; message?: string };
    return j.error ?? j.message ?? `${r.status} ${r.statusText}`;
  } catch {
    return `${r.status} ${r.statusText}`;
  }
}

/** Read the per-tab session token, or null if the tab isn't signed in. */
export function getSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  try { return window.sessionStorage.getItem(TOKEN_STORAGE_KEY); }
  catch { return null; }
}

/** Persist the token returned by /auth/login or /auth/register. */
export function setSessionToken(token: string): void {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token); }
  catch { /* private-mode: nothing to do, the tab just won't persist */ }
}

/** Wipe the token (logout, or 401 from /auth/me). */
export function clearSessionToken(): void {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.removeItem(TOKEN_STORAGE_KEY); }
  catch { /* private-mode */ }
}

/**
 * Monkey-patch `window.fetch` once on app boot so every same-origin
 * request automatically carries `Authorization: Bearer <token>` when
 * the tab has one. The alternative would be a wrapped `apiFetch` and
 * a sweep of every fetch call site — this is fewer moving parts.
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
    } catch { /* malformed url — let the original fetch surface the error */ }
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
