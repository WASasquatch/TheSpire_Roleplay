import { create } from "zustand";
import type {
  EmoticonSheet,
  ReactionEntry,
  ReactionEvent,
  ReactionTargetKind,
} from "@thekeep/shared";
import { isEmoticonCellEmpty, reactionRefKey } from "@thekeep/shared";

/**
 * Cached emoticon catalog + live reaction state. One zustand store
 * because the picker, the ReactionBar, and the admin sheet editor all
 * need to look at sheets keyed by slug; multiple subscribers is the
 * point.
 *
 * Reactions are stored keyed by `${targetKind}:${targetId}` rather
 * than threaded into per-message arrays so the realtime
 * `reaction:update` handler can merge a delta without touching the
 * MessageList state. Chat / DM rendering pulls from this map; the
 * inline `message.reactions` array embedded in backlog payloads
 * primes the cache on first paint.
 */
interface EmoticonState {
  sheets: EmoticonSheet[];
  /** Map: "<targetKind>:<targetId>" → reactions array (or empty). */
  reactions: Record<string, ReactionEntry[]>;
  /** True after the first /emoticons load completes (so consumers know
   *  whether "no sheets yet" means "still loading" vs "really empty"). */
  loaded: boolean;
  /** Replace the entire catalog (called after /emoticons fetch). */
  setSheets: (sheets: EmoticonSheet[]) => void;
  /** Prime the reactions cache for a target (from inline message payload). */
  primeReactions: (kind: ReactionTargetKind, targetId: string, entries: ReactionEntry[] | undefined) => void;
  /** Drop cached reactions for a target (used when the message is deleted). */
  dropReactions: (kind: ReactionTargetKind, targetId: string) => void;
  /** Merge a realtime add/remove into the cache. */
  applyReactionEvent: (event: ReactionEvent, viewerUserId: string | null) => void;
  /** Lookup helper — sheet by slug. */
  getSheetBySlug: (slug: string) => EmoticonSheet | undefined;
}

export function reactionsKey(kind: ReactionTargetKind, targetId: string): string {
  return `${kind}:${targetId}`;
}

export const useEmoticons = create<EmoticonState>((set, get) => ({
  sheets: [],
  reactions: {},
  loaded: false,
  setSheets: (sheets) => set({ sheets, loaded: true }),
  primeReactions: (kind, targetId, entries) => {
    if (!entries || entries.length === 0) {
      // Don't touch the cache for empty primes — if the user reacted
      // and our cache shows the bar, a backlog payload with the field
      // absent (server only ships the field when non-empty) shouldn't
      // wipe their fresh reaction.
      return;
    }
    set((s) => ({
      reactions: { ...s.reactions, [reactionsKey(kind, targetId)]: entries },
    }));
  },
  dropReactions: (kind, targetId) => {
    set((s) => {
      const k = reactionsKey(kind, targetId);
      if (!(k in s.reactions)) return s;
      const next = { ...s.reactions };
      delete next[k];
      return { reactions: next };
    });
  },
  applyReactionEvent: (event, viewerUserId) => {
    set((s) => {
      const k = reactionsKey(event.targetKind, event.targetId);
      const current = s.reactions[k] ?? [];
      const next = mergeReactionEvent(current, event, viewerUserId);
      return { reactions: { ...s.reactions, [k]: next } };
    });
  },
  getSheetBySlug: (slug) => get().sheets.find((s) => s.slug === slug),
}));

/**
 * Merge a single add/remove event into a reaction list. Pure function
 * so it's easy to test and so the store's setter stays a one-liner.
 *
 *   - add: find the (sheetSlug, cellIndex) entry. Create it if absent,
 *     then append the actor (deduping by userId). Sort by reactedAt.
 *   - remove: find the entry, drop the actor by userId. If the entry
 *     is now empty, drop it from the list entirely.
 */
function mergeReactionEvent(
  current: ReactionEntry[],
  event: ReactionEvent,
  viewerUserId: string | null,
): ReactionEntry[] {
  // Match by normalized ref key — same string the server's COALESCE
  // unique index uses — so the merge correctly identifies the same
  // emoji across the two ref shapes.
  const eventKey = reactionRefKey(event.ref);
  const idx = current.findIndex((e) => reactionRefKey(e.ref) === eventKey);
  if (event.op === "add") {
    if (idx === -1) {
      return [
        ...current,
        {
          ref: event.ref,
          label: event.label,
          reactors: [event.actor],
          viewerReacted: viewerUserId === event.actor.userId,
        },
      ];
    }
    const existing = current[idx]!;
    if (existing.reactors.some((r) => r.userId === event.actor.userId)) return current; // dedupe
    const reactors = [...existing.reactors, event.actor].sort((a, b) => a.reactedAt - b.reactedAt);
    const next = [...current];
    next[idx] = {
      ...existing,
      reactors,
      viewerReacted: existing.viewerReacted || viewerUserId === event.actor.userId,
    };
    return next;
  }
  // remove
  if (idx === -1) return current;
  const existing = current[idx]!;
  const reactors = existing.reactors.filter((r) => r.userId !== event.actor.userId);
  if (reactors.length === 0) {
    const next = [...current];
    next.splice(idx, 1);
    return next;
  }
  const next = [...current];
  next[idx] = {
    ...existing,
    reactors,
    viewerReacted: existing.viewerReacted && viewerUserId !== event.actor.userId,
  };
  return next;
}

/**
 * Fetch the public catalog. Called once on app boot and again whenever
 * the server pushes `emoticons:updated`. Failures are swallowed (the
 * picker just won't show new sheets); next page load retries.
 */
export async function fetchEmoticonCatalog(): Promise<void> {
  try {
    const r = await fetch("/emoticons");
    if (!r.ok) return;
    const j = (await r.json()) as { sheets: EmoticonSheet[] };
    useEmoticons.getState().setSheets(j.sheets ?? []);
  } catch {
    /* swallow */
  }
}

/**
 * Convenience: flat list of every NON-EMPTY emoticon across every
 * sheet, in sheet → row-major order. Used by the picker's "all" tab
 * and by callers that want to render the active grid without a sheet
 * sub-selector. Re-computed cheaply (catalog is at most a few sheets
 * × 16 cells).
 */
export function visibleEmoticons(sheets: EmoticonSheet[]): Array<{ sheet: EmoticonSheet; cellIndex: number; label: string }> {
  const out: Array<{ sheet: EmoticonSheet; cellIndex: number; label: string }> = [];
  for (const s of sheets) {
    s.cells.forEach((label, i) => {
      if (!isEmoticonCellEmpty(label)) out.push({ sheet: s, cellIndex: i, label });
    });
  }
  return out;
}
