/**
 * Client calls for Urugal's Descent run sessions (Spire Arcade game #2).
 *
 * The static game bundle (/games/urugal) is untrusted; it only reports
 * progress. These talk to the server-authoritative run API under
 * /arcade/urugal, which validates + (later) credits rewards. The runId
 * returned by `startUrugalRun` is handed to the game so every event it
 * sends is bound to a server-owned session. See UrugalWindow.tsx.
 */
import type { UrugalEventResponse, UrugalEventType, UrugalStartResponse } from "@thekeep/shared";
import { FLAIR_URUGAL_DESCENT } from "@thekeep/shared";
import { purchaseCosmetic } from "./earning";

export type UrugalAccess = "ok" | "locked" | "forbidden";

/** Probe whether this identity can play: "ok", "locked" (needs the one-time
 *  unlock — 402), or "forbidden" (permission/auth — 403/401). Mirrors
 *  fetchEidolon's access tri-state so the launcher shows the right CTA. */
export async function fetchUrugalAccess(characterId: string | null): Promise<UrugalAccess> {
  const qs = characterId ? `?characterId=${encodeURIComponent(characterId)}` : "";
  const r = await fetch(`/arcade/urugal${qs}`, { credentials: "include" });
  if (r.status === 402) return "locked";
  if (!r.ok) return "forbidden";
  return "ok";
}

/**
 * Buy the one-time unlock (a Flair) for this identity. INTENTIONALLY
 * global (Multi-Server Lift): no serverId is passed, so the flair is bought
 * on the home/default economy — matching the home-scoped access probe above
 * — which keeps the arcade a cross-server feature. Don't scope this to
 * serverId alone; the access check + rewards would have to move with it.
 */
export async function unlockUrugal(characterId: string | null): Promise<void> {
  await purchaseCosmetic(FLAIR_URUGAL_DESCENT, characterId);
}

async function postJson<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`urugal ${path} → ${r.status}`);
  return (await r.json()) as T;
}

/** Open a server-authoritative run; returns the runId to hand to the game. */
export async function startUrugalRun(characterId: string | null): Promise<string> {
  const res = await postJson<UrugalStartResponse>("/arcade/urugal/start", { characterId });
  return res.runId;
}

/** Report one milestone (floor reached / boss cleared) for scoring. */
export async function reportUrugalEvent(
  runId: string,
  characterId: string | null,
  type: UrugalEventType,
  floor: number,
): Promise<UrugalEventResponse> {
  return postJson<UrugalEventResponse>("/arcade/urugal/event", { runId, characterId, type, floor });
}

/** Mark the run ended (on death, or when the window closes). No payout. */
export async function endUrugalRun(runId: string, characterId: string | null): Promise<void> {
  await postJson("/arcade/urugal/end", { runId, characterId });
}
