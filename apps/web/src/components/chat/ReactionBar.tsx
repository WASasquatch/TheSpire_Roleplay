import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ReactionEntry, ReactionRef, ReactionTargetKind } from "@thekeep/shared";
import { lookupUnicodeEmojiCharByName, reactionRefKey } from "@thekeep/shared";
import { useEmoticons, reactionsKey } from "../../state/emoticons.js";
import { EmoticonSprite } from "../emoticons/EmoticonSprite.js";
import { EmoticonPicker } from "../emoticons/EmoticonPicker.js";
import { Modal, MODAL_CARD_CONTENT } from "../cosmetics/Modal.js";
import { CloseButton } from "../shared/CloseButton.js";
import { animationClassForLabel } from "../../lib/emoticonMoods.js";
import { recordEmoticonPick } from "../../lib/recentEmoticons.js";

interface Props {
  targetKind: ReactionTargetKind;
  targetId: string;
  /** Render-time fallback used when the cache doesn't yet have entries
   *  for this target, typically the `reactions` field embedded in the
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
 *  server payload. Accepts a polymorphic ref, `kind: "sheet"` for
 *  legacy sticker reactions, `kind: "unicode"` for emoji-style ones
 *  added via the Unicode tab in the picker. */
export async function toggleReaction(
  targetKind: ReactionTargetKind,
  targetId: string,
  ref: ReactionRef,
  asCharacterId: string | null,
): Promise<void> {
  try {
    // Record the pick in the local recents store so the picker's
    // "Recent" row reflects user preference next time it opens.
    // Unicode picks don't have a sheet/cell to record, the picker's
    // own recents track them separately (or not at all in v1).
    if (ref.kind === "sheet") {
      recordEmoticonPick(ref.sheetSlug, ref.cellIndex);
    }
    const res = await fetch("/reactions/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetKind,
        targetId,
        ...(ref.kind === "sheet"
          ? { sheetSlug: ref.sheetSlug, cellIndex: ref.cellIndex }
          : { unicodeChar: ref.char }),
        ...(asCharacterId ? { asCharacterId } : {}),
      }),
      credentials: "include",
    });
    // Apply the authoritative summary the endpoint returns. The realtime
    // `reaction:update` event ALSO lands for viewers joined to the target's
    // room, but it does NOT reach surfaces that aren't, most importantly the
    // Forums Catalog (topics/posts are chat_message reactions, but the
    // catalog fetches over HTTP and never joins the board's socket room),
    // which is why reactions there silently did nothing. Applying the
    // returned summary is an authoritative REPLACE, idempotent with the
    // socket merge (which dedups by user), so no doubling when both land.
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as
        | { summary?: { targetKind: ReactionTargetKind; targetId: string; entries: ReactionEntry[] } }
        | null;
      if (data?.summary && Array.isArray(data.summary.entries)) {
        useEmoticons.getState().setReactions(targetKind, targetId, data.summary.entries);
      }
    }
  } catch {
    /* swallow, network blip; next reload re-syncs from backlog */
  }
}

/** Standalone "+ react" button, opens the emoticon picker anchored
 *  to itself and on pick calls toggleReaction. Lets surfaces that
 *  want the add-trigger in a DIFFERENT row than the existing chips
 *  (forum action toolbar) mount just the button without ReactionBar. */
export function ReactionAddButton({
  targetKind,
  targetId,
  asCharacterId = null,
  className,
  title,
  label = "+ 😊",
}: {
  targetKind: ReactionTargetKind;
  targetId: string;
  asCharacterId?: string | null;
  className?: string;
  title?: string;
  label?: React.ReactNode;
}) {
  const { t } = useTranslation("chat");
  const effectiveTitle = title ?? t("reactions.add");
  const [pickerOpen, setPickerOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setPickerOpen((v) => !v)}
        className={className ?? "emoticon-add-btn inline-flex items-center justify-center rounded-full border border-keep-rule bg-keep-bg text-keep-muted transition hover:scale-110 hover:border-keep-action hover:text-keep-action"}
        title={effectiveTitle}
        aria-label={effectiveTitle}
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
            void toggleReaction(
              targetKind,
              targetId,
              { kind: "sheet", sheetSlug: slug, cellIndex: idx },
              asCharacterId,
            );
          }}
          // Unicode reactions go through the same toggle endpoint
          // with the unicode_char ref shape. The picker defaults to
          // the Unicode tab when this prop is set, matching the
          // composer's behavior.
          onPickUnicode={(char) => {
            setPickerOpen(false);
            void toggleReaction(
              targetKind,
              targetId,
              { kind: "unicode", char },
              asCharacterId,
            );
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Inline bar of reaction chips beneath a message. Up to
 * `maxVisible` chips render directly (responsive, 4 on mobile, 10
 * on desktop); overflow collapses into a "+N more" chip that opens
 * the full-list modal. Each chip shows the sprite + count + a
 * hover tooltip listing the reactors; clicking a chip toggles the
 * viewer's reaction on or off.
 */
const MAX_VISIBLE_DESKTOP = 10;
const MAX_VISIBLE_MOBILE = 4;
const MOBILE_MQ = "(max-width: 639px)";

export function ReactionBar({ targetKind, targetId, initialEntries, asCharacterId = null, readOnly, hideAddButton }: Props) {
  const { t } = useTranslation("chat");
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
  // render, that path queues a setState while rendering and React
  // warns about it). The prime is a no-op when the cache already
  // holds something for this target, so backlog payloads can't
  // overwrite fresher socket-event state.
  useEffect(() => {
    if (initialEntries && cached === undefined && initialEntries.length > 0) {
      primeReactions(targetKind, targetId, initialEntries);
    }
    // Intentionally not depending on `cached`, we only want this
    // effect to run once per target/initial-payload pair. The merge
    // semantics inside the store guarantee monotonicity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKind, targetId, initialEntries]);

  // Filter to entries with a well-formed ref. Defensive against a
  // legacy/in-flight payload that's missing the discriminator; one bad
  // entry shouldn't crash the whole MessageList. Matches the
  // null-tolerance in `reactionRefKey` + `isUnicodeReaction`.
  const entries = (cached ?? initialEntries ?? []).filter(
    (e) => e.ref && typeof e.ref === "object" && (e.ref.kind === "sheet" || e.ref.kind === "unicode"),
  );

  const toggle = (ref: ReactionRef) => toggleReaction(targetKind, targetId, ref, asCharacterId);

  if (entries.length === 0 && readOnly) return null;
  // When the add button is suppressed (forum surface mounts it inside
  // the post action toolbar instead), an empty chip set means there's
  // nothing to render at all, collapse out of the layout so we don't
  // ship an empty div.
  if (entries.length === 0 && hideAddButton) return null;

  const visible = entries.slice(0, maxVisible);
  const overflowCount = Math.max(0, entries.length - maxVisible);

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {visible.map((e) => (
        <ReactionChip
          key={reactionRefKey(e.ref)}
          entry={e}
          onClick={() => !readOnly && toggle(e.ref)}
        />
      ))}
      {overflowCount > 0 ? (
        <button
          type="button"
          onClick={() => setListOpen(true)}
          className="rounded-full border border-keep-rule bg-keep-panel/40 px-2 py-0.5 text-[11px] text-keep-muted hover:text-keep-text"
          title={t("reactions.seeAll")}
        >
          {t("reactions.more", { count: overflowCount })}
        </button>
      ) : null}
      {!readOnly && !hideAddButton ? (
        <ReactionAddButton
          targetKind={targetKind}
          targetId={targetId}
          asCharacterId={asCharacterId}
          // `emoticon-add-btn-hidden` is applied UNCONDITIONALLY, the
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
 *  Reaction glyph, renders either a sheet sprite or a Unicode
 *  codepoint depending on the entry's ref shape. Reused by the chip,
 *  the tooltip, and the full-list modal so the rendering posture
 *  stays consistent.
 * ============================================================= */
/**
 * Loose runtime shape ReactionGlyph accepts. We can't strictly use
 * `ReactionEntry` because the server sometimes ships LEGACY entries
 * that don't carry a `ref` at all, instead they put `sheetSlug` +
 * `cellIndex` (sheet shape) or `char` (Unicode shape) directly on
 * the entry. The recovery pipeline below reads any combination of
 * fields that's present.
 */
type ReactionGlyphInput = {
  ref?: ReactionRef | null;
  label?: string;
  /** Legacy flat-shape sheet ref, pre-discriminated-union schema. */
  sheetSlug?: string;
  cellIndex?: number;
  /** Legacy flat-shape Unicode ref. */
  char?: string;
};

function ReactionGlyph({
  entry,
  size,
}: {
  entry: ReactionGlyphInput;
  size: number;
}) {
  const ref = entry.ref;
  const fallbackLabel = entry.label;
  // Defensive: a malformed entry (legacy wire shape, mid-flight
  // socket payload) renders the fallback chip rather than crashing
  // the whole MessageList. The defensive guards mirror those in
  // `reactionRefKey` / `isUnicodeReaction` over in shared.
  function renderFallbackText(text: string): React.ReactElement {
    // Auto-shrink the font when the fallback is long-ish text (cell
    // labels can be "100", "blush", etc.) so it actually fits inside
    // the chip's sprite slot. Each char shaves a couple px off the
    // font size, floored at ~9px.
    const fontSize = Math.max(9, Math.round(size * 0.85) - Math.max(0, text.length - 2) * 3);
    return (
      <span
        aria-hidden
        className="inline-flex items-center justify-center font-action leading-none"
        style={{
          width: `${size}px`,
          height: `${size}px`,
          fontSize: `${fontSize}px`,
          lineHeight: 1,
        }}
      >
        {text}
      </span>
    );
  }

  // Recover the sheet slug/cellIndex from either the new ref shape
  // OR the legacy flat shape that older server code still ships.
  const resolvedSheetSlug =
    ref && typeof ref === "object" && ref.kind === "sheet"
      ? ref.sheetSlug
      : typeof entry.sheetSlug === "string" && typeof entry.cellIndex === "number"
        ? entry.sheetSlug
        : null;
  const resolvedCellIndex =
    ref && typeof ref === "object" && ref.kind === "sheet"
      ? ref.cellIndex
      : typeof entry.sheetSlug === "string" && typeof entry.cellIndex === "number"
        ? entry.cellIndex
        : null;
  // Subscribe to catalog updates so a sheet sprite swaps in the
  // moment the catalog hydrates (a freshly-loaded chat page can
  // render reaction chips before `/emoticons` resolves). Selector
  // returns undefined when this isn't a sheet ref, so unrelated ref
  // shapes don't churn the component.
  const sheetCatalog = useEmoticons((s) =>
    resolvedSheetSlug ? s.getSheetBySlug(resolvedSheetSlug) : undefined,
  );

  // Aggressive last-resort recovery: derive the visible emoji from
  // whichever field carries usable signal. Tries, in order:
  //   1. ref.char as a literal codepoint
  //   2. ref.char interpreted as a catalog name (legacy bad rows)
  //   3. fallbackLabel interpreted as a catalog name
  // If none resolves, fall through to the text fallback.
  function resolveUnicodeChar(): string | null {
    const candidates = [
      typeof ref === "object" && ref && "char" in ref ? (ref as { char?: unknown }).char : undefined,
      // Legacy flat-shape Unicode field on the entry itself.
      entry.char,
      fallbackLabel,
    ];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      const t = candidate.trim();
      if (t === "") continue;
      // If this is a catalog name we recognize, the lookup returns
      // the codepoint. Otherwise treat the value as a possible
      // codepoint paste (e.g. an OS emoji picker entry that's not
      // in our curated catalog) and use it directly.
      const looked = lookupUnicodeEmojiCharByName(t);
      if (looked) return looked;
      // Heuristic: a string that's all ASCII printable is almost
      // certainly a name (and not a codepoint we want to render
      // literally). Skip to the next candidate so we can try the
      // label instead of rendering ugly text.
      const allAscii = /^[\x20-\x7E]+$/.test(t);
      if (!allAscii) return t;
    }
    return null;
  }

  // Sheet path: if we recovered a slug + cellIndex from EITHER the
  // new ref shape OR the legacy flat fields on the entry, render
  // through EmoticonSprite. The sprite has its own faint-placeholder
  // fallback while the catalog loads (the subscription above forces
  // a re-render the moment /emoticons resolves), which beats showing
  // the cell label as text.
  if (resolvedSheetSlug !== null && resolvedCellIndex !== null) {
    void sheetCatalog;
    return (
      <EmoticonSprite
        sheetSlug={resolvedSheetSlug}
        cellIndex={resolvedCellIndex}
        size={size}
      />
    );
  }
  if (!ref || typeof ref !== "object") {
    const recovered = resolveUnicodeChar();
    if (recovered) return renderUnicodeGlyph(recovered);
    return renderFallbackText(fallbackLabel?.trim() || "?");
  }
  // Unicode path (or any not-sheet ref we should treat as Unicode).
  // Run the same recovery pipeline as the missing-ref branch above:
  // try the char field, then the label, before giving up.
  const recoveredFromUnicode = resolveUnicodeChar();
  if (recoveredFromUnicode) return renderUnicodeGlyph(recoveredFromUnicode);
  return renderFallbackText(fallbackLabel?.trim() || "?");

  // Render the bare Unicode codepoint inside a sized + emoji-fonted
  // span. Hoisted into a helper because both the recovered-from-ref
  // and recovered-from-label branches above need to produce the
  // same markup.
  function renderUnicodeGlyph(glyph: string): React.ReactElement {
    return (
      <span
        aria-hidden
        className="inline-flex items-center justify-center leading-none"
        style={{
          width: `${size}px`,
          height: `${size}px`,
          // 0.72 (down from 0.85) brings the rendered emoji glyph into
          // visual parity with sticker sprites in the same chip. Emoji
          // fonts paint nearly the full em-box, while sticker PNGs are
          // exported with ~15-25% of transparent padding around the art
          //, so a glyph at 85% of the container was reading noticeably
          // BIGGER than a sprite at 100%, exactly the opposite of what
          // a side-by-side chip row should show.
          fontSize: `${Math.round(size * 0.72)}px`,
          lineHeight: 1,
          // Force the browser through its color-emoji fallback chain.
          // Without an explicit family here, the chip inherits whatever
          // font-family the chip ancestor uses (often a serif/sans
          // chosen for prose), and on some Linux + Windows setups the
          // browser sticks with that family and renders missing glyphs
          // as a blank box instead of falling through to a system emoji
          // font. Listing the major color-emoji families up front +
          // ending with the CSS `emoji` generic gives every desktop /
          // mobile platform a known-good route to a real glyph.
          fontFamily:
            '"Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", ' +
            '"Noto Color Emoji", "Twemoji Mozilla", "EmojiOne Color", ' +
            '"Android Emoji", emoji, sans-serif',
        }}
      >
        {glyph}
      </span>
    );
  }
}

/* =============================================================
 *  Chip, one (sheet, cell) reaction's count + tooltip
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
 *  anywhere on the message expands every reaction chip on it,
 *  Discord's behavior, not just the one under the cursor.
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
  t: TFunction<"chat">,
  reactors: ReadonlyArray<{ displayName: string }>,
  label: string,
): string {
  const names = reactors.map((r) => r.displayName);
  if (names.length === 1) {
    return label
      ? t("reactions.tooltipOneWith", { a: names[0], label })
      : t("reactions.tooltipOne", { a: names[0] });
  }
  if (names.length === 2) {
    return label
      ? t("reactions.tooltipTwoWith", { a: names[0], b: names[1], label })
      : t("reactions.tooltipTwo", { a: names[0], b: names[1] });
  }
  if (names.length === 3) {
    return label
      ? t("reactions.tooltipThreeWith", { a: names[0], b: names[1], c: names[2], label })
      : t("reactions.tooltipThree", { a: names[0], b: names[1], c: names[2] });
  }
  return label
    ? t("reactions.tooltipManyWith", { a: names[0], b: names[1], count: names.length - 2, label })
    : t("reactions.tooltipMany", { a: names[0], b: names[1], count: names.length - 2 });
}

function ReactionChip({ entry, onClick }: { entry: ReactionEntry; onClick: () => void }) {
  const { t } = useTranslation("chat");
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [hovered, setHovered] = useState(false);
  const tooltip = formatReactorsTooltip(t, entry.reactors, entry.label);
  // Mood class is sheet-label-driven; Unicode reactions don't carry a
  // sheet animation hint, so they render with no jiggle. Pass the
  // sheet's label only when the ref is a sheet, empty string for
  // Unicode is a safe no-op for the animationClassForLabel mapper.
  // Defensive: same null-tolerance as ReactionGlyph. A missing ref
  // resolves to "no mood class", the chip renders without a jiggle
  // animation rather than crashing the whole row.
  const moodClass = animationClassForLabel(
    entry.ref && typeof entry.ref === "object" && entry.ref.kind === "sheet" ? entry.label : "",
  );
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        // aria-label, not title, title would spawn a competing
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
          <ReactionGlyph entry={entry} size={32} />
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
 *  Reaction tooltip, portal-rendered floating preview
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
      <ReactionGlyph entry={entry} size={48} />
      <div className="text-sm leading-snug">{text}</div>
    </div>,
    document.body,
  );
}

/* =============================================================
 *  Full reaction list modal
 * ============================================================= */
function ReactionListModal({ entries, onClose }: { entries: ReactionEntry[]; onClose: () => void }) {
  const { t } = useTranslation("chat");
  return (
    <Modal onClose={onClose} zIndex={70}>
      <div className={`${MODAL_CARD_CONTENT} max-w-md rounded border border-keep-rule bg-keep-bg`} onClick={(e) => e.stopPropagation()}>
        <header className="flex shrink-0 items-center justify-between border-b border-keep-rule bg-keep-banner px-4 py-2">
          <h2 className="font-action text-base">{t("reactions.title")}</h2>
          <CloseButton onClick={onClose} />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {entries.length === 0 ? (
            <p className="text-xs italic text-keep-muted">{t("reactions.empty")}</p>
          ) : (
            <ul className="space-y-3">
              {entries.map((e) => (
                <li key={reactionRefKey(e.ref)}>
                  <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-widest text-keep-muted">
                    <ReactionGlyph entry={e} size={20} />
                    <span>{e.label || "-"}</span>
                    <span className="ml-auto tabular-nums text-keep-text">{e.reactors.length}</span>
                  </div>
                  <ul className="ml-7 space-y-0.5 text-xs">
                    {e.reactors.map((r) => (
                      <li key={r.userId + (r.characterId ?? "")} className="flex items-center gap-2">
                        <ReactionGlyph entry={e} size={14} />
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
