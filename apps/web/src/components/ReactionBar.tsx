import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactionEntry, ReactionTargetKind } from "@thekeep/shared";
import { useEmoticons, reactionsKey } from "../state/emoticons.js";
import { EmoticonSprite } from "./EmoticonSprite.js";
import { EmoticonPicker } from "./EmoticonPicker.js";
import { Modal, MODAL_CARD_CONTENT } from "./Modal.js";
import { CloseButton } from "./CloseButton.js";
import { animationClassForLabel } from "../lib/emoticonMoods.js";
import { recordEmoticonPick } from "../lib/recentEmoticons.js";

interface Props {
  targetKind: ReactionTargetKind;
  targetId: string;
  /** Render-time fallback used when the cache doesn't yet have entries
   *  for this target — typically the `reactions` field embedded in the
   *  inline message payload. The bar primes the cache from this so
   *  realtime deltas merge correctly. */
  initialEntries?: ReactionEntry[];
  /** Identity to react AS when the user adds a reaction here. Master
   *  handle = null. Mirrors the chat composer's identity selection. */
  asCharacterId?: string | null;
  /** Hide the "+ react" button. Used when the target is in a read-only
   *  context (admin-soft-deleted message, etc.). */
  readOnly?: boolean;
  /** Render JUST the chips, no inline "+ react" trigger. Used by
   *  forum posts which place the add-reaction trigger in the action
   *  toolbar (Reply/Quote/Edit/...) instead of as a separate chip.
   *  When true AND there are no chips, the bar renders nothing. */
  hideAddButton?: boolean;
}

/** Hit the reactions toggle endpoint. Shared by ReactionBar (inline
 *  + button) and ReactionAddButton (toolbar standalone) so both code
 *  paths record the same emoticon-pick locally and send the same
 *  server payload. */
export async function toggleReaction(
  targetKind: ReactionTargetKind,
  targetId: string,
  sheetSlug: string,
  cellIndex: number,
  asCharacterId: string | null,
): Promise<void> {
  try {
    // Record the pick in the local recents store so the picker's
    // "Recent" row reflects user preference next time it opens.
    recordEmoticonPick(sheetSlug, cellIndex);
    await fetch("/reactions/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetKind,
        targetId,
        sheetSlug,
        cellIndex,
        ...(asCharacterId ? { asCharacterId } : {}),
      }),
      credentials: "include",
    });
    // The cache will update from the realtime `reaction:update` event.
    // No manual merge here — that would risk doubling reactor entries
    // when the socket event races the fetch response.
  } catch {
    /* swallow — network blip; next reload re-syncs from backlog */
  }
}

/** Standalone "+ react" button — opens the emoticon picker anchored
 *  to itself and on pick calls toggleReaction. Lets surfaces that
 *  want the add-trigger in a DIFFERENT row than the existing chips
 *  (forum action toolbar) mount just the button without ReactionBar. */
export function ReactionAddButton({
  targetKind,
  targetId,
  asCharacterId = null,
  className,
  title = "Add reaction",
  label = "+ 😊",
}: {
  targetKind: ReactionTargetKind;
  targetId: string;
  asCharacterId?: string | null;
  className?: string;
  title?: string;
  label?: React.ReactNode;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setPickerOpen((v) => !v)}
        className={className ?? "emoticon-add-btn inline-flex items-center justify-center rounded-full border border-keep-rule bg-keep-bg text-keep-muted transition hover:scale-110 hover:border-keep-action hover:text-keep-action"}
        title={title}
        aria-label={title}
        onMouseDown={(e) => e.preventDefault()}
      >
        {label}
      </button>
      {pickerOpen ? (
        <EmoticonPicker
          anchor={triggerRef.current}
          onClose={() => setPickerOpen(false)}
          onPick={(slug, idx) => {
            setPickerOpen(false);
            void toggleReaction(targetKind, targetId, slug, idx, asCharacterId);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Inline bar of reaction chips beneath a message. Up to
 * `maxVisible` chips render directly (responsive — 4 on mobile, 10
 * on desktop); overflow collapses into a "+N more" chip that opens
 * the full-list modal. Each chip shows the sprite + count + a
 * hover tooltip listing the reactors; clicking a chip toggles the
 * viewer's reaction on or off.
 */
const MAX_VISIBLE_DESKTOP = 10;
const MAX_VISIBLE_MOBILE = 4;
const MOBILE_MQ = "(max-width: 639px)";

export function ReactionBar({ targetKind, targetId, initialEntries, asCharacterId = null, readOnly, hideAddButton }: Props) {
  const cached = useEmoticons((s) => s.reactions[reactionsKey(targetKind, targetId)]);
  const primeReactions = useEmoticons((s) => s.primeReactions);
  const [listOpen, setListOpen] = useState(false);
  // Responsive cap: 4 chips below sm, 10 at sm+. matchMedia (not a
  // resize listener) so we re-render only when crossing the
  // breakpoint, not on every viewport pixel change. SSR-safe init
  // via the typeof window check.
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== "undefined" && window.matchMedia(MOBILE_MQ).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MQ);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  const maxVisible = isMobile ? MAX_VISIBLE_MOBILE : MAX_VISIBLE_DESKTOP;

  // Prime the store from `initialEntries` in an effect (NOT during
  // render — that path queues a setState while rendering and React
  // warns about it). The prime is a no-op when the cache already
  // holds something for this target, so backlog payloads can't
  // overwrite fresher socket-event state.
  useEffect(() => {
    if (initialEntries && cached === undefined && initialEntries.length > 0) {
      primeReactions(targetKind, targetId, initialEntries);
    }
    // Intentionally not depending on `cached` — we only want this
    // effect to run once per target/initial-payload pair. The merge
    // semantics inside the store guarantee monotonicity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKind, targetId, initialEntries]);

  const entries = cached ?? initialEntries ?? [];

  const toggle = (slug: string, idx: number) => toggleReaction(targetKind, targetId, slug, idx, asCharacterId);

  if (entries.length === 0 && readOnly) return null;
  // When the add button is suppressed (forum surface mounts it inside
  // the post action toolbar instead), an empty chip set means there's
  // nothing to render at all — collapse out of the layout so we don't
  // ship an empty div.
  if (entries.length === 0 && hideAddButton) return null;

  const visible = entries.slice(0, maxVisible);
  const overflowCount = Math.max(0, entries.length - maxVisible);

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {visible.map((e) => (
        <ReactionChip
          key={`${e.sheetSlug}:${e.cellIndex}`}
          entry={e}
          onClick={() => !readOnly && toggle(e.sheetSlug, e.cellIndex)}
        />
      ))}
      {overflowCount > 0 ? (
        <button
          type="button"
          onClick={() => setListOpen(true)}
          className="rounded-full border border-keep-rule bg-keep-panel/40 px-2 py-0.5 text-[11px] text-keep-muted hover:text-keep-text"
          title="See all reactions"
        >
          +{overflowCount} more
        </button>
      ) : null}
      {!readOnly && !hideAddButton ? (
        <ReactionAddButton
          targetKind={targetKind}
          targetId={targetId}
          asCharacterId={asCharacterId}
          // `emoticon-add-btn-hidden` is applied UNCONDITIONALLY — the
          // button hides whether or not the message already has
          // reactions. CSS reveals it on `.group:hover` (desktop
          // hover) and `.group:focus-within` (mobile tap routes
          // through MessageList's `activateRow`, which focuses the
          // row on click → focus-within triggers). Keeps the chat
          // feed from being broken up by a faint pill under every
          // message.
          className="emoticon-add-btn emoticon-add-btn-hidden inline-flex items-center justify-center rounded-full border border-keep-rule bg-keep-bg text-keep-muted transition hover:scale-110 hover:border-keep-action hover:text-keep-action"
        />
      ) : null}
      {listOpen ? (
        <ReactionListModal
          entries={entries}
          onClose={() => setListOpen(false)}
        />
      ) : null}
    </div>
  );
}

/* =============================================================
 *  Chip — one (sheet, cell) reaction's count + tooltip
 * =============================================================
 *
 *  Sizing model (per design spec):
 *    - Resting state: 24px sprite, 11px count, comfortable for a
 *      crowded row of reactions without dominating the line.
 *    - Hover / focus / message-hover state: chip grows to 42px
 *      sprite with 1rem count so it reads as a clear "click me"
 *      target. The chip animates the size change so the growth
 *      reads as deliberate rather than as a layout jitter.
 *
 *  The hover-grow trigger uses both `:hover` on the chip itself
 *  AND `.group:hover` on the ancestor message row, so hovering
 *  anywhere on the message expands every reaction chip on it —
 *  Discord's behavior — not just the one under the cursor.
 */
/** Prose tooltip describing who reacted with what:
 *    1 → "Alice reacted with happy"
 *    2 → "Alice and Bob reacted with happy"
 *    3 → "Alice, Bob, and Carol reacted with happy"
 *   4+ → "Alice, Bob, and 3 others reacted with happy"
 *  When the cell has no label (sheet not categorized) we drop the
 *  trailing "with …" so the tooltip doesn't end with a dangling
 *  preposition. */
function formatReactorsTooltip(
  reactors: ReadonlyArray<{ displayName: string }>,
  label: string,
): string {
  const names = reactors.map((r) => r.displayName);
  let prefix: string;
  if (names.length === 1) prefix = `${names[0]} reacted`;
  else if (names.length === 2) prefix = `${names[0]} and ${names[1]} reacted`;
  else if (names.length === 3) prefix = `${names[0]}, ${names[1]}, and ${names[2]} reacted`;
  else prefix = `${names[0]}, ${names[1]}, and ${names.length - 2} others reacted`;
  return label ? `${prefix} with ${label}` : prefix;
}

function ReactionChip({ entry, onClick }: { entry: ReactionEntry; onClick: () => void }) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [hovered, setHovered] = useState(false);
  const tooltip = formatReactorsTooltip(entry.reactors, entry.label);
  const moodClass = animationClassForLabel(entry.label);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        // aria-label, not title — title would spawn a competing
        // native tooltip alongside the custom ReactionTooltip
        // below. The aria-label still announces the full reactor
        // list to screen readers.
        aria-label={tooltip}
        className={`emoticon-chip ${moodClass} reaction-chip flex items-center gap-1 rounded-full border ${
          entry.viewerReacted
            ? "border-keep-action bg-keep-action/15 text-keep-action"
            : "border-keep-rule bg-keep-panel/40 text-keep-text hover:border-keep-action/60"
        }`}
      >
        <span className="reaction-chip-sprite shrink-0">
          {/* Sprite + count don't receive their own pointer events
              (see `.reaction-chip > *` rule in styles.css); the
              chip-level mouseenter/leave drives the tooltip from a
              single source. */}
          <EmoticonSprite sheetSlug={entry.sheetSlug} cellIndex={entry.cellIndex} size={32} />
        </span>
        {/* `key={count}` re-mounts the span on every count change so the
            one-shot pulse animation in styles.css re-triggers without
            needing JS to toggle the class. */}
        <span key={entry.reactors.length} className="reaction-chip-count emoticon-chip-count tabular-nums">
          {entry.reactors.length}
        </span>
      </button>
      {hovered && buttonRef.current ? (
        <ReactionTooltip anchor={buttonRef.current} entry={entry} text={tooltip} />
      ) : null}
    </>
  );
}

/* =============================================================
 *  Reaction tooltip — portal-rendered floating preview
 * =============================================================
 *
 *  Replaces the native `title` attribute so we can render a
 *  larger sprite preview alongside the reactor list. Portal'd to
 *  document.body so ancestor `overflow: hidden` / `transform`
 *  stacking contexts (forum post containers, the message row's
 *  bookmark-flash, the splash card) can't clip it.
 *
 *  Positioning prefers ABOVE the chip; falls back to below if
 *  there's not enough room. Horizontally centered on the chip,
 *  clamped into the viewport with an 8px margin.
 *
 *  Pointer-events disabled so the tooltip can't intercept the
 *  hover-out (which would cause flicker as the mouse crosses
 *  between chip and tooltip).
 */
function ReactionTooltip({
  anchor,
  entry,
  text,
}: {
  anchor: HTMLElement;
  entry: ReactionEntry;
  text: string;
}) {
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; ready: boolean }>({
    top: 0,
    left: 0,
    ready: false,
  });

  useLayoutEffect(() => {
    function layout() {
      if (!tooltipRef.current) return;
      const ar = anchor.getBoundingClientRect();
      const tr = tooltipRef.current.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const aboveTop = ar.top - tr.height - gap;
      const belowTop = ar.bottom + gap;
      const placeBelow = aboveTop < margin;
      const top = placeBelow ? belowTop : aboveTop;
      let left = ar.left + ar.width / 2 - tr.width / 2;
      const minLeft = margin;
      const maxLeft = window.innerWidth - tr.width - margin;
      if (left < minLeft) left = minLeft;
      if (left > maxLeft) left = Math.max(minLeft, maxLeft);
      setPos({ top, left, ready: true });
    }
    layout();
    window.addEventListener("scroll", layout, true);
    window.addEventListener("resize", layout);
    return () => {
      window.removeEventListener("scroll", layout, true);
      window.removeEventListener("resize", layout);
    };
  }, [anchor]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={tooltipRef}
      role="tooltip"
      className="reaction-tooltip pointer-events-none flex items-center gap-3 rounded-lg border border-keep-rule bg-keep-panel px-3 py-2 text-keep-text shadow-2xl"
      style={{
        position: "fixed",
        zIndex: 200,
        top: pos.top,
        left: pos.left,
        maxWidth: "min(360px, calc(100vw - 16px))",
        // Hide on first paint (ready=false) so users don't see the
        // tooltip render at (0,0) before useLayoutEffect measures
        // and repositions it.
        opacity: pos.ready ? 1 : 0,
        transition: "opacity 120ms ease",
      }}
    >
      <EmoticonSprite sheetSlug={entry.sheetSlug} cellIndex={entry.cellIndex} size={48} />
      <div className="text-sm leading-snug">{text}</div>
    </div>,
    document.body,
  );
}

/* =============================================================
 *  Full reaction list modal
 * ============================================================= */
function ReactionListModal({ entries, onClose }: { entries: ReactionEntry[]; onClose: () => void }) {
  return (
    <Modal onClose={onClose} zIndex={70}>
      <div className={`${MODAL_CARD_CONTENT} max-w-md rounded border border-keep-rule bg-keep-bg`} onClick={(e) => e.stopPropagation()}>
        <header className="flex shrink-0 items-center justify-between border-b border-keep-rule bg-keep-banner px-4 py-2">
          <h2 className="font-action text-base">Reactions</h2>
          <CloseButton onClick={onClose} />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {entries.length === 0 ? (
            <p className="text-xs italic text-keep-muted">No reactions yet.</p>
          ) : (
            <ul className="space-y-3">
              {entries.map((e) => (
                <li key={`${e.sheetSlug}:${e.cellIndex}`}>
                  <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-widest text-keep-muted">
                    <EmoticonSprite sheetSlug={e.sheetSlug} cellIndex={e.cellIndex} size={20} />
                    <span>{e.label || "—"}</span>
                    <span className="ml-auto tabular-nums text-keep-text">{e.reactors.length}</span>
                  </div>
                  <ul className="ml-7 space-y-0.5 text-xs">
                    {e.reactors.map((r) => (
                      <li key={r.userId + (r.characterId ?? "")} className="flex items-center gap-2">
                        <EmoticonSprite sheetSlug={e.sheetSlug} cellIndex={e.cellIndex} size={14} />
                        <span>{r.displayName}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
