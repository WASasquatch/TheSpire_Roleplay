/**
 * Mention validity cache.
 *
 * The message renderer needs to know which `@mention` names resolve
 * to a real, clickable profile so unknown names can fall through to
 * plain text. Hitting the server per-mention every render is wasted
 * work; this module caches the resolution result globally per session
 * and batches lookups for unknown names.
 *
 * Three sets:
 *   - known   — names confirmed to resolve to a real profile
 *   - unknown — names confirmed to NOT resolve (also cached so we
 *               don't keep re-asking about every typo on every render)
 *   - pending — names currently in flight; suppresses duplicate
 *               requests when multiple messages contain the same name
 *               in the same tick
 *
 * Caller flow from the renderer:
 *   1. As each message renders, collect its mention names.
 *   2. Push the names through `requestMentionResolve(names)` — this
 *      schedules a debounced batch POST for any that aren't in known
 *      OR unknown OR pending.
 *   3. Render gates the chip on `isKnownMention(name)`. The first
 *      render of a never-seen mention shows it as plain text; when
 *      the resolve resolves, the store updates and React re-renders
 *      the message lists, which now styles known names as chips.
 */

import { create } from "zustand";

interface MentionsState {
  known: Set<string>;
  unknown: Set<string>;
  pending: Set<string>;
  /** Bump on every resolution batch so selectors that read the Sets
   *  re-fire even though Zustand uses Object.is on the top-level Set
   *  reference (we mutate the same Set instance for efficiency). */
  version: number;
}

export const useMentionsCache = create<MentionsState>(() => ({
  known: new Set<string>(),
  unknown: new Set<string>(),
  pending: new Set<string>(),
  version: 0,
}));

let scheduled: number | null = null;
const pendingBatch = new Set<string>();
const BATCH_DEBOUNCE_MS = 80;
const BATCH_MAX = 64;

/**
 * Queue a list of mention names for resolution. Names already known
 * or already in flight are filtered out. A short debounce coalesces
 * the batch so a message list that renders 30 messages with mentions
 * fires one POST, not 30.
 */
export function requestMentionResolve(names: ReadonlyArray<string>): void {
  if (names.length === 0) return;
  const { known, unknown, pending } = useMentionsCache.getState();
  let queued = false;
  for (const raw of names) {
    const n = raw.toLowerCase();
    if (!n) continue;
    if (known.has(n) || unknown.has(n) || pending.has(n) || pendingBatch.has(n)) continue;
    pendingBatch.add(n);
    queued = true;
  }
  if (!queued) return;
  if (scheduled != null) return;
  scheduled = window.setTimeout(() => {
    scheduled = null;
    void flushBatch();
  }, BATCH_DEBOUNCE_MS);
}

async function flushBatch(): Promise<void> {
  if (pendingBatch.size === 0) return;
  const batch = Array.from(pendingBatch).slice(0, BATCH_MAX);
  for (const n of batch) pendingBatch.delete(n);

  // Mark as pending so concurrent renders don't re-queue while
  // the request is in flight.
  const state = useMentionsCache.getState();
  for (const n of batch) state.pending.add(n);
  useMentionsCache.setState({ version: state.version + 1 });

  try {
    const r = await fetch("/mentions/resolve", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names: batch }),
    });
    if (!r.ok) throw new Error(`/mentions/resolve ${r.status}`);
    const j = (await r.json()) as { valid?: string[] };
    const validSet = new Set((j.valid ?? []).map((s) => s.toLowerCase()));
    const next = useMentionsCache.getState();
    for (const n of batch) {
      next.pending.delete(n);
      if (validSet.has(n)) next.known.add(n);
      else next.unknown.add(n);
    }
    useMentionsCache.setState({ version: next.version + 1 });
  } catch {
    // Network blip / 401 — drop from pending so a later render can
    // retry. Don't poison the unknown set with transient failures.
    const next = useMentionsCache.getState();
    for (const n of batch) next.pending.delete(n);
    useMentionsCache.setState({ version: next.version + 1 });
  }

  // If more names piled up during the request, schedule another flush.
  if (pendingBatch.size > 0 && scheduled == null) {
    scheduled = window.setTimeout(() => {
      scheduled = null;
      void flushBatch();
    }, BATCH_DEBOUNCE_MS);
  }
}

/** Synchronous read used by the renderer. Lowercase the input first. */
export function isKnownMention(name: string): boolean {
  return useMentionsCache.getState().known.has(name.toLowerCase());
}

/**
 * Seed the cache directly with names that are already known to be
 * valid — used by the composer autocomplete when the user picks a
 * suggestion from the server-backed search. Lets the resulting
 * `@name` mention render as a chip on the FIRST render, skipping
 * the round-trip through `/mentions/resolve` that would otherwise
 * leave it briefly as plain text. Pass canonical names; we
 * lowercase here. Bumps `version` so subscribers re-render.
 */
export function markMentionKnown(...names: string[]): void {
  if (names.length === 0) return;
  const state = useMentionsCache.getState();
  let changed = false;
  for (const raw of names) {
    const n = raw.toLowerCase();
    if (!n || state.known.has(n)) continue;
    state.known.add(n);
    state.unknown.delete(n);
    changed = true;
  }
  if (changed) useMentionsCache.setState({ version: state.version + 1 });
}
