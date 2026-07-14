/**
 * Client helpers for world maps + markers. Mirrors lib/worldEntities.ts:
 * thin fetch wrappers over the /worlds/:idOrSlug/maps routes. Map data is
 * lazy — WorldDetail only carries light rows; the full map (image URL +
 * markers, secret ones pre-stripped server-side for non-editors) comes
 * from fetchWorldMap.
 */
import type {
  WorldEntityMapRef,
  WorldMap,
  WorldMapLinkableEvent,
  WorldMapMarker,
  WorldMapMarkerEvent,
  WorldMapMarkerLabelMode,
  WorldMapMarkerScaleMode,
  WorldMapMarkerSize,
} from "@thekeep/shared";
import { jsonOrThrow, readError } from "./http.js";

export interface WorldMapInput {
  name?: string;
  slug?: string;
  description?: string;
  imageUrl?: string;
  /** Base64 data URL for the admin-gated upload mode (exclusive with
   *  imageUrl; the server rejects it while uploads are off). */
  imageDataUrl?: string;
  width?: number | null;
  height?: number | null;
  sortOrder?: number;
}

export interface WorldMapMarkerInput {
  kind?: string;
  label?: string;
  x?: number;
  y?: number;
  color?: string | null;
  icon?: string | null;
  size?: WorldMapMarkerSize;
  scaleMode?: WorldMapMarkerScaleMode;
  labelMode?: WorldMapMarkerLabelMode;
  minZoom?: number | null;
  maxZoom?: number | null;
  entryKind?: string | null;
  entrySlug?: string | null;
  eventId?: string | null;
  body?: string;
  isSecret?: boolean;
  sortOrder?: number;
}

export interface WorldMapPayload {
  map: WorldMap;
  markers: WorldMapMarker[];
  /** Per-viewer event details for event-linked markers — present only for
   *  viewers who can participate in the owning community (server-resolved;
   *  absence means "render the neutral members-only line"). */
  events?: WorldMapMarkerEvent[];
}

const wid = encodeURIComponent;

export async function fetchWorldMap(worldId: string, mapIdOrSlug: string): Promise<WorldMapPayload> {
  return jsonOrThrow<WorldMapPayload>(
    await fetch(`/worlds/${wid(worldId)}/maps/${wid(mapIdOrSlug)}`, { credentials: "include" }),
  );
}

/** Which wiki entries are placed on which map (secret markers already
 *  scrubbed server-side for non-editors) — the "Show on map" lookup. */
export async function fetchWorldEntityMapRefs(worldId: string): Promise<WorldEntityMapRef[]> {
  const j = await jsonOrThrow<{ refs: WorldEntityMapRef[] }>(
    await fetch(`/worlds/${wid(worldId)}/entity-map-refs`, { credentials: "include" }),
  );
  return j.refs;
}

/** Upcoming events of communities featuring this world (editor picker). */
export async function fetchWorldMapLinkableEvents(worldId: string): Promise<WorldMapLinkableEvent[]> {
  const j = await jsonOrThrow<{ events: WorldMapLinkableEvent[] }>(
    await fetch(`/worlds/${wid(worldId)}/map-events`, { credentials: "include" }),
  );
  return j.events;
}

export async function createWorldMap(worldId: string, input: WorldMapInput): Promise<WorldMap> {
  const j = await jsonOrThrow<{ map: WorldMap }>(await fetch(`/worlds/${wid(worldId)}/maps`, {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }));
  return j.map;
}

export async function updateWorldMap(worldId: string, mapId: string, input: WorldMapInput): Promise<WorldMap> {
  const j = await jsonOrThrow<{ map: WorldMap }>(await fetch(`/worlds/${wid(worldId)}/maps/${wid(mapId)}`, {
    method: "PATCH", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }));
  return j.map;
}

export async function deleteWorldMap(worldId: string, mapId: string): Promise<void> {
  const r = await fetch(`/worlds/${wid(worldId)}/maps/${wid(mapId)}`, { method: "DELETE", credentials: "include" });
  if (!r.ok) throw new Error(await readError(r));
}

export async function createWorldMapMarker(worldId: string, mapId: string, input: WorldMapMarkerInput): Promise<WorldMapMarker> {
  const j = await jsonOrThrow<{ marker: WorldMapMarker }>(await fetch(`/worlds/${wid(worldId)}/maps/${wid(mapId)}/markers`, {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }));
  return j.marker;
}

export async function updateWorldMapMarker(worldId: string, mapId: string, markerId: string, input: WorldMapMarkerInput): Promise<WorldMapMarker> {
  const j = await jsonOrThrow<{ marker: WorldMapMarker }>(await fetch(`/worlds/${wid(worldId)}/maps/${wid(mapId)}/markers/${wid(markerId)}`, {
    method: "PATCH", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }));
  return j.marker;
}

export async function deleteWorldMapMarker(worldId: string, mapId: string, markerId: string): Promise<void> {
  const r = await fetch(`/worlds/${wid(worldId)}/maps/${wid(mapId)}/markers/${wid(markerId)}`, { method: "DELETE", credentials: "include" });
  if (!r.ok) throw new Error(await readError(r));
}
