/**
 * Helpers for the /p/<username> shareable profile URL. Mirror the world
 * URL helpers in lib/worlds.ts so the two share the same patterns:
 *   - parse on first paint to seed the modal state
 *   - sync the URL when the modal opens / closes (pushState)
 *   - replaceState to canonicalize when the modal loads its content
 *
 * Username characters mirror the registration validator (and the @username
 * mention regex): Unicode letters, digits, underscore, hyphen. We keep the
 * route greedy on shape so a typo'd path still hits the SPA fallback rather
 * than the static-file 404 page.
 *
 * /u/<username> is accepted as an alias on parse so the more conventional
 * "user page" URL also opens the modal; syncProfileUrl canonicalizes back
 * to /p/<username> via replaceState when an alias is loaded, so share
 * links and bookmarks all converge on a single form.
 */

const PROFILE_URL_RX = /^\/[pu]\/([\p{L}\p{N}_\-]{1,32})\/?$/u;

/** What the API returns for a restricted profile (HTTP 200, signaled by the `private` flag). */
export interface PrivateProfileStub {
  private: true;
  name: string;
  kind: "master" | "character";
  /** True iff the viewer is anonymous and signing in would unlock access. */
  requiresAuth: boolean;
}

/** Returns the username slice of /p/<username>, or null if the URL isn't a profile link. */
export function parseProfileFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const m = window.location.pathname.match(PROFILE_URL_RX);
  return m?.[1] ?? null;
}

/**
 * Sync the URL when a profile modal opens or closes. Push/replace mirror
 * the lib/worlds.ts contract; pushState by default so the back button is
 * the natural way to dismiss the modal.
 */
export function syncProfileUrl(name: string | null, opts: { replace?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  const target = name ? `/p/${encodeURIComponent(name)}` : "/";
  if (window.location.pathname === target) return;
  // Closing modal: if we aren't currently on a profile path at all, don't
  // stomp the URL (preserves /w/foo etc.).
  const currentName = parseProfileFromUrl();
  if (!name && currentName === null) return;
  // If we're already viewing this same profile via an alias (e.g. /u/<name>
  // canonicalizing to /p/<name>), replace rather than push so the alias
  // doesn't leave a stray "back" entry.
  const replace = opts.replace || (name !== null && currentName === name);
  if (replace) {
    window.history.replaceState({}, "", target);
  } else {
    window.history.pushState({}, "", target);
  }
}

/** Build the absolute URL for a profile (used by Copy Link). */
export function profileShareUrl(name: string): string {
  if (typeof window === "undefined") return `/p/${encodeURIComponent(name)}`;
  return `${window.location.origin}/p/${encodeURIComponent(name)}`;
}
