/**
 * URL shape helpers for the public Rules page.
 *
 *   /rules, public landing page that mounts BEFORE auth, so a
 *            registration-form visitor can read the house rules
 *            without signing up first.
 *
 * The server's not-found handler (apps/server/src/index.ts) serves
 * the SPA shell on `/rules` (intentionally OMITTED from the
 * apiPrefixes list); the JSON content endpoint moved to `/api/rules`
 * so the two slots don't shadow each other.
 *
 * Mirrors the parse / sync pattern used by other deep-link surfaces
 * (worlds.ts, profiles.ts, scriptoriumUrl.ts).
 */

const RULES_PATH_RX = /^\/rules\/?$/i;

/** True when the current URL is the public rules page. */
export function isRulesUrl(): boolean {
  if (typeof window === "undefined") return false;
  return RULES_PATH_RX.test(window.location.pathname);
}

/**
 * Push `/rules` into history without a full reload. Used when the
 * splash form's "Read the rules" link is clicked inside the SPA
 * (vs. opened in a new tab via target="_blank", which navigates
 * natively).
 */
export function navigateToRules(): void {
  if (typeof window === "undefined") return;
  if (isRulesUrl()) return;
  window.history.pushState({}, "", "/rules");
}

/**
 * Pop the rules page back to the splash / chat shell. Used by the
 * page's "← Back" header link. We push "/" rather than calling
 * history.back() because the page may have been opened in a fresh
 * tab (no prior history); going forward to "/" gives a deterministic
 * landing regardless of how the user got here.
 */
export function navigateAwayFromRules(): void {
  if (typeof window === "undefined") return;
  window.history.pushState({}, "", "/");
}
