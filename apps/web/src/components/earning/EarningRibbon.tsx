/**
 * Persistent rank-up ribbon.
 *
 * Per the project ethos memory: no video-game toasts, no popup
 * ceremonies. This component renders as a dismissible strip pinned
 * between the chat top-bar and the message list, visible until
 * acknowledged so a user who ranks up mid-scene doesn't lose the
 * notification on the next reload.
 *
 * Stacks multiple unacknowledged rank-ups (rare, most users get one
 * at a time). "Dismiss" acks one and the next slides into place;
 * "Open Earning" both opens the dashboard and clears the ribbon.
 */

import { useState } from "react";
import { useEarning } from "../../state/earning.js";

interface Props {
  /** Click handler for the "Open Earning" affordance. */
  onOpenEarning: () => void;
}

// Stable empty-array sentinels live outside the component so the
// Zustand selectors below can return them on snapshot=null without
// minting a new reference each render. With a literal `?? []` in the
// selector, useSyncExternalStore sees a "changed" snapshot every
// render → re-renders → mints another empty array → infinite loop.
// Same array identity across renders breaks the cycle.
const NO_RANKS: never[] = [];
const NO_TIERS: never[] = [];
const NO_CHARS: never[] = [];

export function EarningRibbon({ onOpenEarning }: Props) {
  // Select the snapshot ONCE (a stable reference from the store) and
  // derive the slices outside the selector. This avoids the
  // returns-a-new-array-per-render hazard above.
  const snapshot = useEarning((s) => s.snapshot);
  const unack = useEarning((s) => s.unackRankUps);
  const dismissOne = useEarning((s) => s.dismissRankUp);
  const dismissAll = useEarning((s) => s.dismissAllRankUps);
  const ranks = snapshot?.catalog.ranks ?? NO_RANKS;
  const tiers = snapshot?.catalog.rankTiers ?? NO_TIERS;
  const characters = snapshot?.characters ?? NO_CHARS;
  const [collapsed, setCollapsed] = useState(false);

  if (unack.length === 0) return null;

  const top = unack[0]!;
  const rank = ranks.find((r) => r.key === top.toRankKey);
  const tierLabel = tiers.find((t) => t.rankKey === top.toRankKey && t.tier === top.toTier)?.label ?? `${top.toTier}`;
  const onBehalfOf = top.scope === "character" && top.characterId
    ? (characters.find((c) => c.ownerId === top.characterId)?.displayName ?? "your character")
    : null;
  const borderHint = top.newlyEligibleBorderKeys.length > 0
    ? ` Border unlocked for ${top.newlyEligibleBorderKeys.map((k) => ranks.find((r) => r.key === k)?.name ?? k).join(", ")}.`
    : "";

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="keep-notice keep-notice-accent flex w-full items-center justify-center gap-2 px-4 py-1 text-xs uppercase tracking-widest text-keep-action hover:brightness-110"
        title="Show earning notification"
      >
        <span>★</span>
        <span>{unack.length} new rank{unack.length === 1 ? "" : " ups"}</span>
      </button>
    );
  }

  return (
    <div className="keep-notice keep-notice-accent flex w-full items-start gap-3 px-4 py-2 text-sm">
      <span className="mt-0.5 text-keep-action">★</span>
      <div className="min-w-0 flex-1">
        <div>
          {onBehalfOf ? <span className="text-keep-muted">({onBehalfOf}) </span> : null}
          <span className="font-semibold">
            You've reached {rank?.name ?? top.toRankKey} {tierLabel}.
          </span>
          {borderHint ? <span className="text-keep-muted">{borderHint}</span> : null}
          {unack.length > 1 ? (
            <span className="ml-2 text-xs text-keep-muted">
              (+{unack.length - 1} more)
            </span>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          onOpenEarning();
          // Don't auto-clear, the dashboard now lets the user see what
          // was new. Caller (or the user) can dismiss explicitly.
        }}
        className="shrink-0 rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs uppercase tracking-widest text-keep-action hover:bg-keep-action/25"
      >
        Open Earning
      </button>
      <button
        type="button"
        onClick={() => void dismissOne(top.id)}
        className="shrink-0 rounded border border-keep-rule px-2 py-0.5 text-xs uppercase tracking-widest text-keep-muted hover:bg-keep-bg/60 hover:text-keep-text"
        title="Dismiss this notification"
      >
        Dismiss
      </button>
      {unack.length > 1 ? (
        <button
          type="button"
          onClick={() => void dismissAll()}
          className="shrink-0 rounded border border-keep-rule px-2 py-0.5 text-xs uppercase tracking-widest text-keep-muted hover:bg-keep-bg/60 hover:text-keep-text"
          title="Dismiss all"
        >
          All
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => setCollapsed(true)}
        className="shrink-0 text-keep-muted hover:text-keep-text"
        title="Collapse"
        aria-label="Collapse"
      >
        −
      </button>
    </div>
  );
}
