/**
 * Client calls for the Grimhold cabinet (Spire Arcade game #3).
 *
 * The static bundle (/games/grimhold) is untrusted; it only reports a
 * final score per finished game. These talk to the server-authoritative
 * run API under /arcade/grimhold, which validates + credits rewards. The
 * runId from `startGrimholdRun` binds every score the cabinet submits to
 * a server-owned session. See GrimholdWindow.tsx.
 */
import type { GrimholdScoreResponse, GrimholdStartResponse } from "@thekeep/shared";
import { FLAIR_GRIMHOLD } from "@thekeep/shared";
import { purchaseCosmetic } from "./earning";
import { withIdentityQuery } from "./http.js";

export type GrimholdAccess = "ok" | "locked" | "forbidden";

/** Probe play access: "ok", "locked" (needs the one-time unlock — 402), or
 *  "forbidden" (permission/auth — 401/403). Mirrors fetchUrugalAccess. */
export async function fetchGrimholdAccess(characterId: string | null): Promise<GrimholdAccess> {
  const r = await fetch(withIdentityQuery("/arcade/grimhold", characterId), { credentials: "include" });
  if (r.status === 402) return "locked";
  if (!r.ok) return "forbidden";
  return "ok";
}

/**
 * Buy the one-time cabinet unlock (a Flair) for this identity. INTENTIONALLY
 * global (Multi-Server Lift): no serverId is passed, so the flair is bought
 * on the home/default economy — matching the home-scoped access probe above
 * — which keeps the arcade a cross-server feature. Don't scope this to
 * serverId alone; the access check + rewards would have to move with it.
 */
export async function unlockGrimhold(characterId: string | null): Promise<void> {
  await purchaseCosmetic(FLAIR_GRIMHOLD, characterId);
}

async function postJson<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`grimhold ${path} → ${r.status}`);
  return (await r.json()) as T;
}

/** Open a server-authoritative run; returns the runId to hand to the bundle. */
export async function startGrimholdRun(characterId: string | null): Promise<string> {
  const res = await postJson<GrimholdStartResponse>("/arcade/grimhold/start", { characterId });
  return res.runId;
}

/** Report one finished game's score for validation + scoring. */
export async function reportGrimholdScore(
  runId: string,
  characterId: string | null,
  game: string,
  score: number,
  elapsedMs: number,
): Promise<GrimholdScoreResponse> {
  return postJson<GrimholdScoreResponse>("/arcade/grimhold/score", { runId, characterId, game, score, elapsedMs });
}

/** Retire the run (window closed). Best-effort, no payout. */
export async function endGrimholdRun(runId: string, characterId: string | null): Promise<void> {
  await postJson("/arcade/grimhold/end", { runId, characterId }).catch(() => { /* best-effort */ });
}
