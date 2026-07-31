/**
 * Overlook API client: fetch and save a room's or world's canvas, and manage
 * who is allowed to draw on it.
 */
import type { OverlookDetail, OverlookEditor, OverlookScope } from "@thekeep/shared";
import { i18n } from "./i18n.js";

/** Route base for a scope. Room canvases key on id; worlds accept id-or-slug. */
function scopeUrl(scope: OverlookScope, scopeId: string): string {
  return `/overlook/${scope}/${encodeURIComponent(scopeId)}`;
}

export async function fetchOverlook(
  scope: OverlookScope,
  scopeId: string,
): Promise<OverlookDetail> {
  const r = await fetch(scopeUrl(scope, scopeId), { credentials: "include" });
  if (!r.ok) throw new Error(i18n.t("common:overlook.loadFailed"));
  const j = (await r.json()) as { overlook: OverlookDetail };
  return j.overlook;
}

/** A save that lost an optimistic-concurrency race. */
export interface OverlookSaveConflict {
  kind: "conflict";
  version: number;
  updatedByUsername: string | null;
}

export type OverlookSaveResult =
  | { kind: "ok"; version: number; elementCount: number }
  | OverlookSaveConflict;

/**
 * Persist a scene. Returns a discriminated result rather than throwing on
 * 409, because a conflict is an expected outcome the UI has a real answer
 * for ("someone else saved, reload") and not an error path.
 */
export async function saveOverlook(
  scope: OverlookScope,
  scopeId: string,
  sceneJson: string,
  version: number,
): Promise<OverlookSaveResult> {
  const r = await fetch(scopeUrl(scope, scopeId), {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sceneJson, version }),
  });
  if (r.status === 409) {
    const j = (await r.json()) as { version?: number; updatedByUsername?: string | null };
    return {
      kind: "conflict",
      version: j.version ?? version,
      updatedByUsername: j.updatedByUsername ?? null,
    };
  }
  if (!r.ok) {
    // Surface the server's own message when it sent one (the upload-disabled
    // and element-cap refusals are both actionable), else a generic failure.
    let message = i18n.t("common:overlook.saveFailed");
    try {
      const j = (await r.json()) as { error?: string };
      if (typeof j.error === "string" && j.error) message = j.error;
    } catch {
      /* non-JSON body, keep the generic message */
    }
    throw new Error(message);
  }
  const j = (await r.json()) as { version: number; elementCount: number };
  return { kind: "ok", version: j.version, elementCount: j.elementCount };
}

export async function addOverlookEditor(
  overlookId: string,
  userId: string,
): Promise<OverlookEditor[]> {
  const r = await fetch(`/overlook/${encodeURIComponent(overlookId)}/editors`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (!r.ok) throw new Error(i18n.t("errors:saveFailed"));
  const j = (await r.json()) as { editors: OverlookEditor[] };
  return j.editors;
}

export async function removeOverlookEditor(
  overlookId: string,
  userId: string,
): Promise<OverlookEditor[]> {
  const r = await fetch(
    `/overlook/${encodeURIComponent(overlookId)}/editors/${encodeURIComponent(userId)}`,
    { method: "DELETE", credentials: "include" },
  );
  if (!r.ok) throw new Error(i18n.t("errors:saveFailed"));
  const j = (await r.json()) as { editors: OverlookEditor[] };
  return j.editors;
}

/**
 * Rewrite a remote image URL to run through our same-origin proxy.
 *
 * Excalidraw renders a cross-origin image happily (its loader does a bare
 * `img.src = …` with no `data:` check) but the resulting canvas is TAINTED,
 * which makes PNG export and copy-to-clipboard throw a SecurityError. Serving
 * the bytes from our own origin is what keeps those working.
 *
 * Data URLs and already-proxied URLs pass through untouched, so this is safe
 * to run over a whole scene repeatedly.
 */
export function proxiedImageUrl(url: string): string {
  if (url.startsWith("data:") || url.startsWith("/overlook/image?")) return url;
  return `/overlook/image?u=${encodeURIComponent(url)}`;
}

/** True when a string is a plausible https image link for the add-by-URL box. */
export function looksLikeImageUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:";
  } catch {
    return false;
  }
}
