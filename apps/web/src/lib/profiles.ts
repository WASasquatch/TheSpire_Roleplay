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

/**
 * Master usernames allow NBSP (Alt+0160) as a "fake space" inside the
 * name. To keep the shareable URL readable, and to avoid the ugly
 * `%C2%A0` byte sequence in the address bar, we present NBSP as a
 * regular space in the slug, then convert it back to NBSP on lookup
 * (see `slugToUsername`). The route regex therefore has to allow
 * regular spaces (which decode in from `%20`), plus the other
 * username-legal punctuation. Length cap mirrors the master-username
 * 40-char ceiling.
 */
const PROFILE_URL_RX = /^\/[pu]\/([\p{L}\p{N}_\-'.`  ]{1,40})\/?$/u;

/**
 * Convert a master username to its URL-slug form. NBSP collapses to a
 * regular space so the encoded URL reads as `%20` rather than `%C2%A0`.
 * Mirrored on the server in `slugToUsername`.
 */
export function usernameToSlug(name: string): string {
  // Map NBSP (U+00A0) -> regular space (U+0020) so the encoded URL
  // reads as `%20` rather than the much uglier `%C2%A0`.
  return name.replace(new RegExp(String.fromCharCode(0xA0), "g"), " ");
}

/**
 * Reverse of `usernameToSlug`, restore NBSP from a URL slug before any
 * client-side comparison. The server normalizes the same way before its
 * DB lookup; we mirror it client-side so things like "is this profile
 * me?" checks line up against the master username stored in `me`.
 */
export function slugToUsername(slug: string): string {
  // Reverse of `usernameToSlug` -- map regular space (U+0020) back to
  // NBSP (U+00A0) so the result matches the DB canonical form.
  return slug.replace(/ /g, String.fromCharCode(0xA0));
}

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
  // `window.location.pathname` keeps non-ASCII bytes percent-encoded
  // (e.g. NBSP becomes `%C2%A0`). The regex below allows literal NBSP
  // but not `%`, so an NBSP-containing username deep link like
  // `/p/The%C2%A0Doctor` failed to match, the SPA never fetched the
  // profile and the user just saw the splash. Decode first.
  let path = window.location.pathname;
  try { path = decodeURI(path); } catch { /* malformed encoding, fall back to raw */ }
  const m = path.match(PROFILE_URL_RX);
  return m?.[1] ?? null;
}

/**
 * Sync the URL when a profile modal opens or closes. Push/replace mirror
 * the lib/worlds.ts contract; pushState by default so the back button is
 * the natural way to dismiss the modal.
 */
export function syncProfileUrl(name: string | null, opts: { replace?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  // Slug form: NBSP → space so the address bar shows %20, not %C2%A0.
  const target = name ? `/p/${encodeURIComponent(usernameToSlug(name))}` : "/";
  if (window.location.pathname === target) return;
  // Closing modal: if we aren't currently on a profile path at all, don't
  // stomp the URL (preserves /w/foo etc.).
  const currentName = parseProfileFromUrl();
  if (!name && currentName === null) return;
  // If we're already viewing this same profile via an alias (e.g. /u/<name>
  // canonicalizing to /p/<name>), replace rather than push so the alias
  // doesn't leave a stray "back" entry. Compare via the slug form so an
  // NBSP-containing name matches whatever the address bar already has.
  const replace = opts.replace || (name !== null && currentName === usernameToSlug(name));
  if (replace) {
    window.history.replaceState({}, "", target);
  } else {
    window.history.pushState({}, "", target);
  }
}

/** Build the absolute URL for a profile (used by Copy Link). */
export function profileShareUrl(name: string): string {
  const path = `/p/${encodeURIComponent(usernameToSlug(name))}`;
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
}

/**
 * File a report against a whole profile (e.g. explicit imagery / rule-
 * breaking content), for moderator review. `characterId` records which
 * persona surfaced it; omit for a master/OOC profile. Throws on failure
 * (incl. 409 "already reported") so the caller can surface the message.
 */
export async function reportProfile(
  targetUserId: string,
  targetCharacterId: string | null,
  reason: string,
): Promise<void> {
  const r = await fetch("/reports", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "profile",
      targetUserId,
      ...(targetCharacterId ? { targetCharacterId } : {}),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    }),
  });
  if (!r.ok) {
    let msg = `Report failed (${r.status})`;
    try { const j = (await r.json()) as { error?: string }; if (j?.error) msg = j.error; } catch { /* non-JSON */ }
    throw new Error(msg);
  }
}
