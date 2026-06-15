/**
 * Identity-token name cache.
 *
 * The chat composer inserts `@id:<userId>` / `@cid:<characterId>` tokens
 * (see packages/shared/src/mentions.ts) so a mention points at an exact
 * identity. The raw token is an opaque nanoid, though, so while a draft
 * still contains one the author can't tell WHO it references. This module
 * resolves those tokens to display names against `/mentions/resolve-tokens`,
 * caching globally per session and batching unknown tokens, so the composer
 * can show "@cid:Kv3l… → Deina" live as they type.
 *
 * Mirrors state/mentions.ts (the @name-validity cache): three buckets
 * (resolved names / confirmed-unknown / in-flight) plus a `version`
 * counter so selectors re-fire even though we mutate the Map/Set in place.
 */

import { create } from "zustand";
import type { MentionTokenHit } from "@thekeep/shared";

/** Cache key for a token. */
function keyOf(kind: "id" | "cid", id: string): string {
  return `${kind}:${id}`;
}

interface IdentityTokensState {
  /** key → resolved display name. */
  names: Map<string, string>;
  /** keys confirmed to NOT resolve (deleted/disabled/blocked/bogus). */
  unknown: Set<string>;
  /** keys currently in flight. */
  pending: Set<string>;
  version: number;
}

export const useIdentityTokensCache = create<IdentityTokensState>(() => ({
  names: new Map<string, string>(),
  unknown: new Set<string>(),
  pending: new Set<string>(),
  version: 0,
}));

let scheduled: number | null = null;
const pendingBatch = new Map<string, MentionTokenHit>();
const BATCH_DEBOUNCE_MS = 80;
const BATCH_MAX = 64;

/**
 * Queue identity tokens for resolution. Tokens already resolved, confirmed
 * unknown, or in flight are skipped. A short debounce coalesces the batch.
 */
export function requestIdentityTokenResolve(hits: ReadonlyArray<MentionTokenHit>): void {
  if (hits.length === 0) return;
  const { names, unknown, pending } = useIdentityTokensCache.getState();
  let queued = false;
  for (const h of hits) {
    const k = keyOf(h.kind, h.id);
    if (names.has(k) || unknown.has(k) || pending.has(k) || pendingBatch.has(k)) continue;
    pendingBatch.set(k, h);
    queued = true;
  }
  if (!queued || scheduled != null) return;
  scheduled = window.setTimeout(() => {
    scheduled = null;
    void flushBatch();
  }, BATCH_DEBOUNCE_MS);
}

async function flushBatch(): Promise<void> {
  if (pendingBatch.size === 0) return;
  const entries = Array.from(pendingBatch.entries()).slice(0, BATCH_MAX);
  for (const [k] of entries) pendingBatch.delete(k);
  const batchKeys = entries.map(([k]) => k);
  const batchHits = entries.map(([, h]) => h);

  const state = useIdentityTokensCache.getState();
  for (const k of batchKeys) state.pending.add(k);
  useIdentityTokensCache.setState({ version: state.version + 1 });

  try {
    const r = await fetch("/mentions/resolve-tokens", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens: batchHits }),
    });
    if (!r.ok) throw new Error(`/mentions/resolve-tokens ${r.status}`);
    const j = (await r.json()) as { resolved?: Array<{ kind: "id" | "cid"; id: string; name: string }> };
    const got = new Map<string, string>();
    for (const e of j.resolved ?? []) got.set(keyOf(e.kind, e.id), e.name);

    const next = useIdentityTokensCache.getState();
    for (const k of batchKeys) {
      next.pending.delete(k);
      const name = got.get(k);
      if (typeof name === "string") next.names.set(k, name);
      else next.unknown.add(k); // requested but server didn't resolve it
    }
    useIdentityTokensCache.setState({ version: next.version + 1 });
  } catch {
    // Transient failure: drop from pending (not into unknown) so a later
    // render can retry.
    const next = useIdentityTokensCache.getState();
    for (const k of batchKeys) next.pending.delete(k);
    useIdentityTokensCache.setState({ version: next.version + 1 });
  }

  if (pendingBatch.size > 0 && scheduled == null) {
    scheduled = window.setTimeout(() => {
      scheduled = null;
      void flushBatch();
    }, BATCH_DEBOUNCE_MS);
  }
}

/** Resolved display name for a token, or undefined if not yet known. */
export function getIdentityTokenName(kind: "id" | "cid", id: string): string | undefined {
  return useIdentityTokensCache.getState().names.get(keyOf(kind, id));
}

/** True once the server has confirmed a token does not resolve. */
export function isUnknownIdentityToken(kind: "id" | "cid", id: string): boolean {
  return useIdentityTokensCache.getState().unknown.has(keyOf(kind, id));
}

/**
 * Seed a token → name directly, used by the composer's @-picker when it
 * inserts a token it already has the display name for, so the "Mentioning:"
 * hint shows the name instantly without the resolve round-trip. Bumps
 * `version` so subscribers re-render.
 */
export function markIdentityTokenKnown(kind: "id" | "cid", id: string, name: string): void {
  if (!name) return;
  const k = keyOf(kind, id);
  const state = useIdentityTokensCache.getState();
  if (state.names.get(k) === name) return;
  state.names.set(k, name);
  state.unknown.delete(k);
  useIdentityTokensCache.setState({ version: state.version + 1 });
}
