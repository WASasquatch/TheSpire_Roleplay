/**
 * URL shape helpers for the public Scriptorium routes:
 *
 *   /scriptorium                     , public catalog
 *   /scriptorium/@<handle>/<slug>    , canonical per-story permalink
 *
 * The server's splash-route registration (apps/server/src/index.ts)
 * serves the SPA shell on both paths so direct navigation and link
 * sharing both work, these helpers are what the SPA parses on first
 * paint and on `popstate` to decide which modal to mount.
 */

const STORY_DEEPLINK_RX = /^\/scriptorium\/@([^/]+)\/([^/]+)\/?$/i;
const CATALOG_PATH_RX = /^\/scriptorium\/?$/i;

export type ScriptoriumRoute =
  | { kind: "catalog" }
  | { kind: "story"; handle: string; slug: string };

/** Returns the route descriptor when the URL is a Scriptorium link,
 *  or null when it isn't. Called on first paint and popstate. */
export function parseScriptoriumFromUrl(): ScriptoriumRoute | null {
  if (typeof window === "undefined") return null;
  const path = window.location.pathname;
  if (CATALOG_PATH_RX.test(path)) return { kind: "catalog" };
  const m = STORY_DEEPLINK_RX.exec(path);
  if (m) {
    return {
      kind: "story",
      handle: decodeURIComponent(m[1]!),
      slug: decodeURIComponent(m[2]!),
    };
  }
  return null;
}

/** Build the canonical per-story permalink. Used by the reader's
 *  "share" button and the splash strip's card-click handler. */
export function storyPermalink(handle: string, slug: string): string {
  return `/scriptorium/@${encodeURIComponent(handle)}/${encodeURIComponent(slug)}`;
}

/** Build the absolute URL, used by Copy Link / share UI. */
export function storyShareUrl(handle: string, slug: string): string {
  const path = storyPermalink(handle, slug);
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
}

/** Push a new Scriptorium URL into history without forcing a full
 *  reload. Mirrors the syncProfileUrl / syncWorldUrl pattern used by
 *  the other deep-link surfaces. */
export function syncScriptoriumUrl(
  route: ScriptoriumRoute | null,
  opts: { replace?: boolean } = {},
): void {
  if (typeof window === "undefined") return;
  const current = parseScriptoriumFromUrl();
  const target = route === null
    ? "/"
    : route.kind === "catalog"
      ? "/scriptorium"
      : storyPermalink(route.handle, route.slug);
  if (sameRoute(current, route)) return;
  if (opts.replace) {
    window.history.replaceState({}, "", target);
  } else {
    window.history.pushState({}, "", target);
  }
}

function sameRoute(a: ScriptoriumRoute | null, b: ScriptoriumRoute | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "catalog" && b.kind === "catalog") return true;
  if (a.kind === "story" && b.kind === "story") {
    return a.handle === b.handle && a.slug === b.slug;
  }
  return false;
}
