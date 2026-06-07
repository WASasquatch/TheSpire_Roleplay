/**
 * Spire Arcade client fetchers (game #1: the Eidolon Tamer). Mirrors the
 * native-fetch + credentials pattern used across lib/earning.ts. The
 * server gates every call two ways: the `use_arcade`/`use_eidolon_tamer`
 * permissions and a one-time `flair_eidolon_tamer` purchase. A 402 means
 * "permission OK but not yet unlocked"; a 403 means "not allowed at all".
 */
import type { EidolonHallEntry, EidolonProfileSummary, EidolonSnapshot, EidolonStateResponse } from "@thekeep/shared";
import { FLAIR_EIDOLON_TAMER } from "@thekeep/shared";
import { purchaseCosmetic } from "./earning";

export type ArcadeAccess = "ok" | "locked" | "forbidden";

export interface EidolonFetchResult {
  access: ArcadeAccess;
  eidolon: EidolonSnapshot | null;
}

/** Thrown by the action calls; carries the HTTP status + parsed body so
 *  callers can distinguish "not enough currency" (402) etc. */
export class ArcadeError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === "string" ? body.error : `arcade error ${status}`);
    this.name = "ArcadeError";
    this.status = status;
    this.body = body;
  }
}

async function readBody(r: Response): Promise<Record<string, unknown>> {
  try { return (await r.json()) as Record<string, unknown>; } catch { return {}; }
}

function qsFor(characterId: string | null): string {
  return characterId ? `?characterId=${encodeURIComponent(characterId)}` : "";
}

async function post(path: string, body: Record<string, unknown>): Promise<EidolonSnapshot> {
  const r = await fetch(`/arcade/eidolon/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const parsed = await readBody(r);
  if (!r.ok) throw new ArcadeError(r.status, parsed);
  return (parsed as unknown as { eidolon: EidolonSnapshot }).eidolon;
}

/** GET the current familiar. Distinguishes locked/forbidden from a real
 *  (possibly null = never hatched) snapshot, so the launcher can show the
 *  right CTA without reading the earning snapshot. */
export async function fetchEidolon(characterId: string | null): Promise<EidolonFetchResult> {
  const r = await fetch(`/arcade/eidolon${qsFor(characterId)}`, { credentials: "include" });
  if (r.status === 402) return { access: "locked", eidolon: null };
  if (r.status === 403) return { access: "forbidden", eidolon: null };
  const parsed = await readBody(r);
  if (!r.ok) throw new ArcadeError(r.status, parsed);
  return { access: "ok", eidolon: (parsed as unknown as EidolonStateResponse).eidolon };
}

export interface HatchSpecies { kind: "species"; speciesId: string; name?: string }
export interface HatchPet { kind: "pet"; petItemKey: string; name?: string }

export async function hatchEidolon(characterId: string | null, choice: HatchSpecies | HatchPet): Promise<EidolonSnapshot> {
  return post("hatch", { characterId, ...choice });
}

export async function eidolonAction(characterId: string | null, kind: "play" | "clean" | "rest"): Promise<EidolonSnapshot> {
  return post("action", { characterId, kind });
}

export async function feedEidolon(characterId: string | null, itemKey: string): Promise<EidolonSnapshot> {
  return post("feed", { characterId, itemKey });
}

/** Play with a REUSABLE toy (a `category:'toy'` item key the identity owns) for
 *  a bigger, varied joy boost than the free Play gesture. Not consumed. */
export async function playToyEidolon(characterId: string | null, itemKey: string): Promise<EidolonSnapshot> {
  return post("toy", { characterId, itemKey });
}

/** Remedy: pass a potion (magic) item key for a full cure + big heal, or
 *  omit it for the currency-charged basic heal. A 402 ArcadeError means
 *  "not enough currency" (its body carries `required`/`balance`). */
export async function remedyEidolon(characterId: string | null, itemKey?: string): Promise<EidolonSnapshot> {
  return post("remedy", { characterId, ...(itemKey ? { itemKey } : {}) });
}

/** Revive a DORMANT familiar with a Potion (a magic-category item key) — the
 *  chosen death model. Restores it to a fragile second life with its level/XP
 *  intact; refuses (409) a living familiar, 400 if the item isn't a Potion. */
export async function reviveEidolon(characterId: string | null, itemKey: string): Promise<EidolonSnapshot> {
  return post("revive", { characterId, itemKey });
}

/** Release a DORMANT (or legacy-dead) familiar so the egg-select screen sticks
 *  ("Summon Anew"). Server-side delete of the row; refuses (409) a living one. */
export async function releaseEidolon(characterId: string | null): Promise<void> {
  const r = await fetch(`/arcade/eidolon/release`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ characterId }),
  });
  if (!r.ok) throw new ArcadeError(r.status, await readBody(r));
}

export interface SellResult { value: number; level: number }

/** Sell a LIVING familiar for currency (scaled by its level/XP) and clear
 *  it. Returns the payout; the familiar becomes null afterward. */
export async function sellEidolon(characterId: string | null): Promise<SellResult> {
  const r = await fetch(`/arcade/eidolon/sell`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ characterId }),
  });
  const parsed = await readBody(r);
  if (!r.ok) throw new ArcadeError(r.status, parsed);
  const sold = (parsed as { sold?: { value: number; level: number } }).sold;
  return { value: sold?.value ?? 0, level: sold?.level ?? 1 };
}

/** Public-view summary of an identity's familiar, for their profile card.
 *  Returns null when they have no familiar (or on any error — display only). */
export async function fetchEidolonSummary(scope: "user" | "character", ownerId: string): Promise<EidolonProfileSummary | null> {
  try {
    const r = await fetch(`/arcade/eidolon/summary?scope=${scope}&ownerId=${encodeURIComponent(ownerId)}`, { credentials: "include" });
    if (!r.ok) return null;
    const parsed = await readBody(r);
    return (parsed as { eidolon: EidolonProfileSummary | null }).eidolon ?? null;
  } catch { return null; }
}

/** Pat another player's familiar: a small +joy social gesture (24h cooldown).
 *  Throws ArcadeError on 429 (cooldown), 409 (own/departed), etc. */
export async function patFamiliar(scope: "user" | "character", ownerId: string): Promise<{ joyDelta: number }> {
  const r = await fetch(`/arcade/eidolon/visit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ scope, ownerId }),
  });
  const parsed = await readBody(r);
  if (!r.ok) throw new ArcadeError(r.status, parsed);
  return { joyDelta: typeof (parsed as { joyDelta?: number }).joyDelta === "number" ? (parsed as { joyDelta: number }).joyDelta : 0 };
}

/** Toggle the opt-in "your familiar needs you" daily push nudges. */
export async function setEidolonNudgeOptin(characterId: string | null, on: boolean): Promise<EidolonSnapshot> {
  return post("nudge-optin", { characterId, on });
}

/** The Hall — this identity's departed familiars (most recent first), for the
 *  memorial gallery. Returns [] on any error (display-only). */
export async function fetchEidolonHall(characterId: string | null): Promise<EidolonHallEntry[]> {
  try {
    const r = await fetch(`/arcade/eidolon/hall${qsFor(characterId)}`, { credentials: "include" });
    if (!r.ok) return [];
    const parsed = await readBody(r);
    return (parsed as { hall?: EidolonHallEntry[] }).hall ?? [];
  } catch { return []; }
}

/** Buy the one-time unlock (a Flair) for this identity. */
export async function unlockEidolon(characterId: string | null): Promise<void> {
  await purchaseCosmetic(FLAIR_EIDOLON_TAMER, characterId);
}
