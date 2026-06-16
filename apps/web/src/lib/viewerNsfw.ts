/**
 * Per-VIEWER image censoring, persisted in localStorage.
 *
 * Distinct from the owner/mod `nsfw` flag on a portrait (which blurs an
 * image for EVERYONE): this is a private, viewer-only "I don't want to
 * see this" mark. A viewer can hide any image they dislike on someone's
 * profile and it stays censored for them across sessions until they
 * toggle it back, no effect on what anyone else sees, and nothing sent
 * to the server.
 *
 * Keyed by the stable portrait id, so a mark follows the image wherever
 * it appears. Per-device (localStorage); that's the right scope for a
 * personal viewing preference and keeps it server-free.
 */
const KEY = "tk:viewerHiddenImages:v1";

export function loadViewerHiddenImageIds(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr)
      ? new Set(arr.filter((x): x is string => typeof x === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

export function saveViewerHiddenImageIds(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    /* private mode / quota, the in-memory set still works this session */
  }
}
