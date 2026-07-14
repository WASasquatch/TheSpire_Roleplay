/**
 * Display metadata + per-device layer preferences for world-map markers.
 * A marker kind is either one of the world's entity kinds (built-in or
 * custom, resolved through the same kindDefs list the knowledge base
 * uses) or a marker-only builtin (poi/town/event/label). The layer
 * toggles persist per map in localStorage (tk:mapLayers:<mapId>) so a
 * player's "hide the shop pins" choice survives reloads without touching
 * the server.
 */
import type { WorldEntityKindDef } from "@thekeep/shared";
import type { MarkerKindMeta } from "../components/worlds/WorldMapStage.js";

/** Marker-only builtin kinds → default lucide slug + accent color.
 *  Labels localize via `worlds:maps.markerKinds.<kind>`. */
export const BUILTIN_MAP_MARKER_KIND_META: Record<string, { icon: string | null; color: string }> = {
  poi: { icon: "map", color: "#e05c5c" },
  town: { icon: "landmark", color: "#d4a44c" },
  event: { icon: "calendar", color: "#4ac6d4" },
  label: { icon: null, color: "#cfcfcf" },
};

/**
 * Build the `kindMeta` resolver the map stage consumes. `kindDefs` is the
 * viewer/editor's merged built-in + custom entity kind list (labels
 * already localized); `t` translates the marker-only builtin labels.
 */
export function makeMarkerKindMeta(
  kindDefs: WorldEntityKindDef[],
  t: (key: string) => string,
): (kind: string) => MarkerKindMeta {
  return (kind: string) => {
    // Marker builtins first: poi/town are ALSO wiki entity kinds (kind
    // parity), but their pins keep the established lucide glyphs rather
    // than switching to the wiki cards' emoji. Their keys are reserved,
    // so no custom kind can be shadowed by this ordering.
    const builtin = BUILTIN_MAP_MARKER_KIND_META[kind];
    if (builtin) return { label: t(`maps.markerKinds.${kind}`), icon: builtin.icon, color: builtin.color };
    const def = kindDefs.find((d) => d.key === kind);
    if (def) return { label: def.label, icon: def.icon || null, color: def.color };
    return { label: kind, icon: "✦", color: "#8a8a8a" };
  };
}

interface LayerPrefs {
  hidden: string[];
  secretHidden?: boolean;
}

const layerKey = (mapId: string) => `tk:mapLayers:${mapId}`;

export function readMapLayerPrefs(mapId: string): LayerPrefs {
  try {
    const raw = localStorage.getItem(layerKey(mapId));
    if (!raw) return { hidden: [] };
    const parsed = JSON.parse(raw) as LayerPrefs;
    return {
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((k): k is string => typeof k === "string") : [],
      secretHidden: !!parsed.secretHidden,
    };
  } catch {
    return { hidden: [] };
  }
}

export function writeMapLayerPrefs(mapId: string, prefs: LayerPrefs): void {
  try {
    localStorage.setItem(layerKey(mapId), JSON.stringify(prefs));
  } catch { /* private-mode storage failures are non-fatal */ }
}
