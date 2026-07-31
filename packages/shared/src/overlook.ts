/**
 * Overlook: the per-room / per-world sketch canvas (migration 0371).
 *
 * The scene itself is an Excalidraw document and is deliberately OPAQUE on
 * the wire: we ship it as a JSON string and never model its element types
 * here. Excalidraw evolves its own schema and restores forward/backward with
 * `restore()`; mirroring that schema in shared would be a permanent
 * maintenance tax for zero benefit, because nothing on our side reads an
 * element's geometry. The two things the server DOES care about (how many
 * elements there are, and whether the `files` map holds base64 uploads) are
 * derived in `summarizeOverlookScene` below, which is the only place that
 * pokes at the document's shape.
 */

/** Which side of the app owns a canvas. Exactly one scope per Overlook. */
export type OverlookScope = "room" | "world";

/** Hard cap on the serialized scene, ~4MB. Scenes ride inside a single
 *  SQLite row, so this is the practical ceiling before saves get slow and
 *  backups bloat. With uploads OFF a scene is pure vector data plus image
 *  URLs and realistically lands in the tens of KB; the cap only ever bites
 *  when uploads are ON and someone embeds photos. */
export const OVERLOOK_SCENE_MAX_BYTES = 4 * 1024 * 1024;

/** Cap on elements in one scene. Excalidraw itself gets sluggish well before
 *  this; the limit exists so a runaway paste can't wedge the save route. */
export const OVERLOOK_ELEMENTS_MAX = 5000;

/** Cap on explicit `/overlook add` grants per canvas. Implicit editors
 *  (room owner/mod, world owner/collaborator) do NOT count against it. */
export const OVERLOOK_EDITORS_MAX = 50;

/** Max bytes the image proxy will stream for one remote image. */
export const OVERLOOK_PROXY_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Content types the image proxy will pass through. SVG is deliberately
 * ABSENT: an SVG is a script-capable document, and the world-map uploader
 * (`sniffMapImage`) bans it for the same reason. Keep these two lists in
 * agreement.
 */
export const OVERLOOK_PROXY_MIME_ALLOWLIST = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
] as const;

/** One explicit editor grant. */
export interface OverlookEditor {
  userId: string;
  username: string;
  /** Epoch ms, or null on a row predating the column (none today). */
  addedAt: number | null;
}

/**
 * A canvas as the client sees it. `sceneJson` is the raw Excalidraw
 * document; the client hands it straight to `restore()` and never
 * introspects it either.
 */
export interface OverlookDetail {
  id: string;
  scope: OverlookScope;
  /** The room or world this canvas belongs to. */
  scopeId: string;
  /** Used for the window title: `<scopeName> Overlook`. */
  scopeName: string;
  sceneJson: string;
  elementCount: number;
  /** Optimistic-concurrency token. Echo it back on save. */
  version: number;
  updatedAt: number;
  updatedByUsername: string | null;
  /** True when the viewer may save. Read-only viewers still get the scene. */
  canEdit: boolean;
  /** True when the viewer may manage grants (scope authority, not a grant). */
  canManageEditors: boolean;
  /** Explicit grants. Empty for viewers who can't manage them. */
  editors: OverlookEditor[];
  /** Echo of `site_settings.overlook_uploads_enabled`, so the client can hide
   *  the upload affordance. NOT a boundary; the save route re-checks. */
  uploadsEnabled: boolean;
}

/** 409 body when a save races another editor. */
export interface OverlookConflict {
  error: "conflict";
  /** The version now on the server. */
  version: number;
  updatedAt: number;
  updatedByUsername: string | null;
}

/** What the save route derives from an otherwise-opaque scene. */
export interface OverlookSceneSummary {
  elementCount: number;
  /** True when any entry in the `files` map is a base64 `data:` payload,
   *  i.e. an embedded upload rather than a URL reference. */
  hasEmbeddedUploads: boolean;
}

/**
 * Pull the two facts the server needs out of a serialized scene.
 *
 * Tolerant by design: an Excalidraw version bump that reshapes `appState` or
 * adds element fields must not start rejecting saves. Anything we can't
 * recognize counts as zero elements and no uploads, and the byte cap is what
 * actually bounds the damage. Throws only when the payload isn't JSON at all.
 */
export function summarizeOverlookScene(sceneJson: string): OverlookSceneSummary {
  const parsed: unknown = JSON.parse(sceneJson);
  if (parsed == null || typeof parsed !== "object") {
    return { elementCount: 0, hasEmbeddedUploads: false };
  }
  const scene = parsed as { elements?: unknown; files?: unknown };
  const elementCount = Array.isArray(scene.elements) ? scene.elements.length : 0;

  let hasEmbeddedUploads = false;
  if (scene.files != null && typeof scene.files === "object") {
    for (const file of Object.values(scene.files as Record<string, unknown>)) {
      if (file == null || typeof file !== "object") continue;
      const dataUrl = (file as { dataURL?: unknown }).dataURL;
      // `dataURL` is Excalidraw's field name whatever it holds. We put plain
      // https URLs in it on purpose (the loader does a bare `img.src = …`
      // with no `data:` check), so the presence of the field means nothing,
      // only a real base64 payload counts as an upload.
      if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
        hasEmbeddedUploads = true;
        break;
      }
    }
  }
  return { elementCount, hasEmbeddedUploads };
}

/** True when a scene has nothing on it (drives "hide the world tab"). */
export function isOverlookBlank(elementCount: number): boolean {
  return elementCount <= 0;
}

/** The empty document a fresh canvas starts from. */
export const OVERLOOK_EMPTY_SCENE_JSON = '{"elements":[],"appState":{},"files":{}}';
