/**
 * Client helpers for "Buy a Copy" of a Scriptorium story. A copy costs the
 * buyer currency (a royalty goes to the author) and can be showcased on the
 * buyer's profile Library. The buying identity is the active character when
 * one is selected, else the master/OOC pool — passed as `characterId`.
 */

export interface StoryCopyState {
  owned: boolean;
  showcased: boolean;
  isAuthor: boolean;
  price: number;
  canBuy: boolean;
}

export interface BuyStoryCopyResult {
  owned: boolean;
  price: number;
  royaltyPaid: number;
}

async function readError(r: Response): Promise<string> {
  try {
    const j = await r.json();
    if (j && typeof j.error === "string") return j.error;
  } catch { /* fall through */ }
  return `Request failed (${r.status})`;
}

export async function fetchStoryCopyState(storyId: string, characterId: string | null): Promise<StoryCopyState> {
  const qs = characterId ? `?characterId=${encodeURIComponent(characterId)}` : "";
  const r = await fetch(`/stories/${encodeURIComponent(storyId)}/copy${qs}`, { credentials: "include" });
  if (!r.ok) throw new Error(await readError(r));
  return (await r.json()) as StoryCopyState;
}

export async function buyStoryCopy(storyId: string, characterId: string | null): Promise<BuyStoryCopyResult> {
  const r = await fetch(`/stories/${encodeURIComponent(storyId)}/copy`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId }),
  });
  if (!r.ok) throw new Error(await readError(r));
  return (await r.json()) as BuyStoryCopyResult;
}

export async function setStoryShowcase(
  storyId: string,
  characterId: string | null,
  shown: boolean,
): Promise<{ shown: boolean; slot: number | null }> {
  const r = await fetch(`/stories/${encodeURIComponent(storyId)}/copy/showcase`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId, shown }),
  });
  if (!r.ok) throw new Error(await readError(r));
  return (await r.json()) as { shown: boolean; slot: number | null };
}
