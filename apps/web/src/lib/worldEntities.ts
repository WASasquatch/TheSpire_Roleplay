/**
 * Client helpers for world knowledge-base entries (Locations / NPCs / Items /
 * Factions / custom kinds) and the custom-kind registry. Mirrors the world
 * page/collaborator helpers in lib/worlds.ts.
 */
import type { WorldArc, WorldArcStatus, WorldEntity, WorldEntityKind, WorldSession } from "@thekeep/shared";
import { readError } from "./http.js";

export interface WorldEntityInput {
  kind?: string;
  name?: string;
  slug?: string;
  summary?: string;
  bodyHtml?: string;
  stats?: Record<string, string>;
  tags?: string[];
  imageUrl?: string | null;
  isPublic?: boolean;
  arcId?: string | null;
  sortOrder?: number;
}

export interface WorldEntityKindInput {
  key?: string;
  label?: string;
  description?: string;
  icon?: string | null;
  color?: string | null;
  sortOrder?: number;
}

async function jsonOrThrow<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(await readError(r));
  return (await r.json()) as T;
}
const wid = encodeURIComponent;

export async function fetchWorldEntity(worldId: string, eid: string): Promise<WorldEntity> {
  const j = await jsonOrThrow<{ entity: WorldEntity }>(
    await fetch(`/worlds/${wid(worldId)}/entities/${wid(eid)}`, { credentials: "include" }),
  );
  return j.entity;
}

export async function createWorldEntity(worldId: string, input: WorldEntityInput): Promise<WorldEntity> {
  const j = await jsonOrThrow<{ entity: WorldEntity }>(
    await fetch(`/worlds/${wid(worldId)}/entities`, {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    }),
  );
  return j.entity;
}

export async function updateWorldEntity(worldId: string, eid: string, input: WorldEntityInput): Promise<WorldEntity> {
  const j = await jsonOrThrow<{ entity: WorldEntity }>(
    await fetch(`/worlds/${wid(worldId)}/entities/${wid(eid)}`, {
      method: "PATCH", credentials: "include",
      headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    }),
  );
  return j.entity;
}

export async function deleteWorldEntity(worldId: string, eid: string): Promise<void> {
  const r = await fetch(`/worlds/${wid(worldId)}/entities/${wid(eid)}`, { method: "DELETE", credentials: "include" });
  if (!r.ok) throw new Error(await readError(r));
}

export async function createWorldEntityKind(worldId: string, input: WorldEntityKindInput): Promise<WorldEntityKind[]> {
  const j = await jsonOrThrow<{ entityKinds: WorldEntityKind[] }>(
    await fetch(`/worlds/${wid(worldId)}/entity-kinds`, {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    }),
  );
  return j.entityKinds;
}

export async function deleteWorldEntityKind(worldId: string, key: string): Promise<void> {
  const r = await fetch(`/worlds/${wid(worldId)}/entity-kinds/${wid(key)}`, { method: "DELETE", credentials: "include" });
  if (!r.ok) throw new Error(await readError(r));
}

/* ---------- Arcs ---------- */

export interface WorldArcInput {
  title?: string;
  slug?: string;
  summary?: string;
  status?: WorldArcStatus;
  color?: string | null;
  sortOrder?: number;
}

export async function createWorldArc(worldId: string, input: WorldArcInput): Promise<WorldArc> {
  const j = await jsonOrThrow<{ arc: WorldArc }>(await fetch(`/worlds/${wid(worldId)}/arcs`, {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }));
  return j.arc;
}
export async function updateWorldArc(worldId: string, aid: string, input: WorldArcInput): Promise<WorldArc> {
  const j = await jsonOrThrow<{ arc: WorldArc }>(await fetch(`/worlds/${wid(worldId)}/arcs/${wid(aid)}`, {
    method: "PATCH", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }));
  return j.arc;
}
export async function deleteWorldArc(worldId: string, aid: string): Promise<void> {
  const r = await fetch(`/worlds/${wid(worldId)}/arcs/${wid(aid)}`, { method: "DELETE", credentials: "include" });
  if (!r.ok) throw new Error(await readError(r));
}

/* ---------- Sessions ---------- */

export interface WorldSessionInput {
  title?: string;
  slug?: string;
  summary?: string;
  bodyHtml?: string;
  sessionDate?: number | null;
  arcId?: string | null;
  sortOrder?: number;
}

export async function fetchWorldSession(worldId: string, sid: string): Promise<WorldSession> {
  const j = await jsonOrThrow<{ session: WorldSession }>(
    await fetch(`/worlds/${wid(worldId)}/sessions/${wid(sid)}`, { credentials: "include" }),
  );
  return j.session;
}
export async function createWorldSession(worldId: string, input: WorldSessionInput): Promise<WorldSession> {
  const j = await jsonOrThrow<{ session: WorldSession }>(await fetch(`/worlds/${wid(worldId)}/sessions`, {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }));
  return j.session;
}
export async function updateWorldSession(worldId: string, sid: string, input: WorldSessionInput): Promise<WorldSession> {
  const j = await jsonOrThrow<{ session: WorldSession }>(await fetch(`/worlds/${wid(worldId)}/sessions/${wid(sid)}`, {
    method: "PATCH", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }));
  return j.session;
}
export async function deleteWorldSession(worldId: string, sid: string): Promise<void> {
  const r = await fetch(`/worlds/${wid(worldId)}/sessions/${wid(sid)}`, { method: "DELETE", credentials: "include" });
  if (!r.ok) throw new Error(await readError(r));
}
