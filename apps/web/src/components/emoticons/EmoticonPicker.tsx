import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { EmoticonSheet, UnicodeEmoji } from "@thekeep/shared";
import { COMMUNITY_EMOTICON_USE_COST, UNICODE_EMOJI_CATEGORIES, UNICODE_EMOJI_FLAT, isEmoticonCellEmpty } from "@thekeep/shared";
import { useEmoticons } from "../../state/emoticons.js";
import { useChat } from "../../state/store.js";
import { MAX_VISIBLE_RECENT, recentPicks } from "../../lib/recentEmoticons.js";
import { animationClassForLabel } from "../../lib/emoticonMoods.js";
import { useCommunityEmoticon } from "../../lib/emoticonSubmissions.js";
import { EmoticonSprite } from "./EmoticonSprite.js";

interface Props {
  /** Called when the user picks a sheet cell. */
  onPick: (sheetSlug: string, cellIndex: number) => void;
  /** Called when the user picks a Unicode emoji from the Unicode tab.
   *  Optional, call sites that haven't wired up Unicode insertion
   *  (e.g. the reaction bar, which keys reactions on sheet+cell) can
   *  omit this and the Unicode tab will stay hidden. */
  onPickUnicode?: (char: string) => void;
  /** Called when the user clicks outside / presses Escape. */
  onClose: () => void;
  /** Anchor element - the picker positions itself relative to this
   *  rect. Prefers BELOW the anchor when there's room, falls back to
   *  ABOVE only when below would clip; aligned to the anchor's right
   *  edge with viewport clamping. Pass the trigger button's DOM node. */
  anchor: HTMLElement | null;
}

const PANEL_WIDTH = 380;
/** Upper bound on the picker's height regardless of how much viewport
 *  room is available. The Unicode tab carries hundreds of entries, so
 *  letting the panel grow to fill a 1080+px screen is overwhelming,
 *  500px gives ~10 rows of emoji visible at once, which scrolls
 *  comfortably with a mouse wheel or trackpad. Tall viewports still
 *  benefit because the panel WON'T cover most of the chat behind it. */
const PANEL_MAX_HEIGHT = 500;
/** Lower bound on the picker's height when the viewport can fit it.
 *  Sized so the body grid always has room for at least two full rows
 *  of cells AFTER the toolbar (~50), recent strip (~120), and search
 *  bar (~40) take their slice. Without this floor a picker opened
 *  against the latest chat message, where roomAbove can be ~200px
 *  and roomBelow is whatever's left between the message and the
 *  composer, clamped to that tiny slice and the user saw the search
 *  field plus a single emoji row, with the rest of the grid scrolled
 *  off below the panel. The layout below allows the panel to overlap
 *  the anchor when both sides are tighter than this; covering the
 *  button the user just clicked is fine since the click already
 *  opened the picker. */
const PANEL_MIN_USABLE_HEIGHT = 360;

/** sessionStorage key for the "don't ask again this session" toggle on
 *  the community-emoticon spend confirmation. Sets the user up so a
 *  single confirm at the start of a session is enough; a fresh tab
 *  asks again. */
const ACK_KEY = "thespire.communityEmoticonSpendAck.v1";

function hasAckedSpend(): boolean {
  try { return sessionStorage.getItem(ACK_KEY) === "1"; }
  catch { return false; }
}
function setAckedSpend(): void {
  try { sessionStorage.setItem(ACK_KEY, "1"); }
  catch { /* private mode etc. - fall through, just re-prompts */ }
}

/**
 * Floating emoticon picker. Visual structure:
 *
 *   [- system sheet tabs (scroll) -]    [Community]
 *   [-------- Recent row ------------------------]
 *   [-------- Active sheet grid -----------------]
 *
 * The Community button is anchored on the right of the top bar; when
 * selected, the body swaps to a list of approved user-submitted sheets,
 * each cell of which costs `COMMUNITY_EMOTICON_USE_COST` Currency to
 * use. The fee is debited from the buyer's active identity pool and
 * credited to the sheet creator's master pool by
 * POST /emoticons/community/:sheetId/use.
 *
 * Layout policy: prefers to open BELOW the trigger when there's room,
 * falls back to opening above only when below would clip. Aligned to
 * the anchor's right edge with viewport clamping. Click-away + Escape
 * close.
 */
export function EmoticonPicker({ onPick, onPickUnicode, onClose, anchor }: Props) {
  const { t } = useTranslation("arcade");
  const sheets = useEmoticons((s) => s.sheets);
  const activeCharacterId = useChat((s) => s.activeCharacterId);
  const me = useChat((s) => s.me);

  // Split sheets by kind. System sheets get the scrolling tab row on
  // the left of the toolbar; community sheets get their own view
  // toggled by the right-anchored "Community" button.
  const systemSheets = useMemo(() => sheets.filter((s) => s.kind !== "community"), [sheets]);
  const communitySheets = useMemo(() => sheets.filter((s) => s.kind === "community"), [sheets]);

  // Community-tab sort. "new" = newest createdAt first, "old" =
  // oldest first, "top" = most-used first (server-side `useCount`).
  // Default to newest so a fresh approval surfaces immediately;
  // sticks for the open lifetime of the picker, resets next mount.
  type CommunitySort = "new" | "old" | "top";
  const [communitySort, setCommunitySort] = useState<CommunitySort>("new");
  const sortedCommunitySheets = useMemo(() => {
    const arr = [...communitySheets];
    if (communitySort === "new") {
      arr.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    } else if (communitySort === "old") {
      arr.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    } else {
      arr.sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0));
    }
    return arr;
  }, [communitySheets, communitySort]);

  type View =
    | { kind: "system"; activeSheetId: string | null }
    | { kind: "community"; activeSheetId: string | null }
    | { kind: "unicode" };
  // Default landing view. When the parent wired an `onPickUnicode`
  // callback (composer, formatting toolbar) the Unicode emoji panel
  // is the natural landing, that's the surface most chat apps open
  // to by default. When `onPickUnicode` is absent (reactions are
  // sheet-based, see ReactionBar) we fall back to the system sheet
  // grid so the picker stays useful there too.
  const [view, setView] = useState<View>(() => {
    if (onPickUnicode) return { kind: "unicode" };
    return { kind: "system", activeSheetId: systemSheets[0]?.id ?? null };
  });

  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; height: number; placeBelow: boolean }>({
    top: 0, left: 0, width: PANEL_WIDTH, height: PANEL_MAX_HEIGHT, placeBelow: true,
  });
  const [spendError, setSpendError] = useState<string | null>(null);

  // Capture recents ONCE on mount - the picker doesn't need to
  // re-render when the user picks (it closes immediately on pick).
  // A live subscription would also flash the just-picked emoticon
  // into the recent row right before the close animation, which
  // reads as visual jank.
  const recents = useMemo(() => recentPicks(), []);

  useLayoutEffect(() => {
    function layout() {
      if (!anchor || !panelRef.current) return;
      const ar = anchor.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const width = Math.min(PANEL_WIDTH, window.innerWidth - 2 * margin);
      // Compute the available vertical room in both directions FIRST,
      // independent of the panel's intrinsic content height. The panel
      // gets an explicit height (not just a ceiling) so the body's
      // `flex-1 overflow-y-auto` has a fixed parent to grow into and
      // internal scroll actually engages on long grids, the Unicode
      // tab in particular needs that or the cells just spill past the
      // visible area.
      const roomBelow = Math.max(0, window.innerHeight - ar.bottom - gap - margin);
      const roomAbove = Math.max(0, ar.top - gap - margin);
      // Largest height the viewport can possibly host (one shared cap
      // for either side; the panel can overlap the anchor below).
      const viewportMax = Math.max(0, window.innerHeight - 2 * margin);
      // Prefer opening below when below has comfortable room; flip to
      // above when above does; otherwise pick the side with more room
      // and accept that the panel will likely overlap the anchor.
      const placeBelow =
        roomBelow >= PANEL_MIN_USABLE_HEIGHT
          ? true
          : roomAbove >= PANEL_MIN_USABLE_HEIGHT
          ? false
          : roomBelow >= roomAbove;
      // Target height: prefer the larger of (the chosen side's room,
      // the comfort floor) so a tight slice doesn't squash the body
      // down to one row of cells. Capped at the panel ceiling and at
      // the viewport so we never clip off-screen. When the floor
      // exceeds the chosen side's room, the position math below shifts
      // the panel until it fits, which means it overlaps the anchor
      // button. That tradeoff is fine: the user just clicked that
      // button to open the picker, so re-covering it doesn't hide
      // anything they were trying to keep visible.
      const height = Math.min(
        PANEL_MAX_HEIGHT,
        viewportMax,
        Math.max(placeBelow ? roomBelow : roomAbove, PANEL_MIN_USABLE_HEIGHT),
      );
      let top: number;
      if (placeBelow) {
        top = ar.bottom + gap;
        // If the panel would spill past the viewport bottom, shift it
        // up, even into the anchor's row, so the entire panel sits
        // on-screen and stays usable.
        const overflowBottom = top + height - (window.innerHeight - margin);
        if (overflowBottom > 0) top -= overflowBottom;
        top = Math.max(top, margin);
      } else {
        top = ar.top - gap - height;
        // Same clamp going the other way: if the comfort floor would
        // push the top above the viewport, snap it to the top margin
        // (and let the panel cover part of the anchor below).
        top = Math.max(top, margin);
      }
      let left = ar.left + ar.width / 2 - width / 2;
      const minLeft = margin;
      const maxLeft = window.innerWidth - width - margin;
      if (left < minLeft) left = minLeft;
      if (left > maxLeft) left = Math.max(minLeft, maxLeft);
      setPos({ top, left, width, height, placeBelow });
    }
    layout();
    // Resize stays, a window resize legitimately changes the
    // viewport bounds, and the picker needs to reflow inside the
    // new frame.
    //
    // Scroll is INTENTIONALLY NOT tracked: chat panels reflow as
    // new messages arrive, which scrolls the anchor button under
    // a stationary picker. If we re-ran layout() on every scroll
    // event, the picker would chase the anchor mid-click, the
    // user goes to tap an emoji, a new message arrives, the chat
    // scrolls, the anchor button moves, the picker re-anchors to
    // the new position, and the click lands on a different cell
    // (or empty space) than what was under the cursor. Pinning
    // the picker to its initial computed position for the rest
    // of its lifetime keeps the target stable; click-away dismiss
    // still works because mousedown outside the panel closes it.
    window.addEventListener("resize", layout);
    return () => {
      window.removeEventListener("resize", layout);
    };
  }, [anchor]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchor?.contains(target)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  /**
   * Handle a click on a community-sheet cell: confirm spend (once per
   * session), charge the server, then forward to the parent's onPick
   * so the emoticon lands wherever it was destined (composer / reaction).
   * The recently-used localStorage record is bumped in the caller's
   * onPick handler chain, same as for system emoticons - so a community
   * emoticon shows up in Recent next time the picker opens.
   */
  async function pickCommunity(sheet: EmoticonSheet, cellIndex: number) {
    if (!me) return; // anonymous viewers can't spend
    if (sheet.creatorUserId === me.id) {
      // The owner can't pay themselves; let them use their own sheet
      // free of charge. We don't call the server endpoint at all -
      // just forward the pick.
      onPick(sheet.slug, cellIndex);
      onClose();
      return;
    }
    // Free path: creator has commerce disabled on this sheet. Skip
    // both the confirmation modal AND the charge call; just forward
    // the pick. The server's /use endpoint also short-circuits when
    // commerceEnabled is false so the wire roundtrip would be a
    // wasted no-op anyway.
    if (!sheet.commerceEnabled) {
      onPick(sheet.slug, cellIndex);
      onClose();
      return;
    }
    if (!hasAckedSpend()) {
      const ok = window.confirm(
        t("emoticons.picker.confirmSpend", { cost: COMMUNITY_EMOTICON_USE_COST }),
      );
      if (!ok) return;
      setAckedSpend();
    }
    setSpendError(null);
    try {
      await useCommunityEmoticon(sheet.id, cellIndex, activeCharacterId);
      onPick(sheet.slug, cellIndex);
      onClose();
    } catch (e) {
      setSpendError(e instanceof Error ? e.message : t("emoticons.picker.chargeFailed"));
    }
  }

  // Resolve the active sheet for the body view. When the view is
  // "system" we render the active system sheet's grid. When the view
  // is "community" with no sheet selected we show the community sheet
  // index; with a sheet selected we show its grid (with the paid-use
  // badge). The recent row sits between the toolbar and the grid in
  // both modes. Unicode view has no `activeSheetId`, so we read it
  // only when the view kind actually carries one.
  const viewActiveSheetId = view.kind === "unicode" ? null : view.activeSheetId;
  const activeSystem = systemSheets.find((s) => s.id === viewActiveSheetId) ?? systemSheets[0];
  const activeCommunity = view.kind === "community"
    ? communitySheets.find((s) => s.id === view.activeSheetId) ?? null
    : null;

  if (typeof document === "undefined") return null;

  const panel = (
    <div
      ref={panelRef}
      // Three-zone layout: a sticky toolbar/recents/error header (no
      // scroll), a scrolling body, and an implicit footer (none today
      // but the layout supports it). `min-h-0` is what enables the
      // body's `flex-1 overflow-y-auto` to actually clamp inside the
      // parent's `maxHeight`. Without it the body would push the
      // panel past its declared height because flex children default
      // to `min-height: auto`.
      className="emoticon-picker-panel keep-panel flex min-h-0 flex-col overflow-hidden rounded-lg shadow-2xl"
      style={{
        position: "fixed",
        zIndex: 200,
        top: pos.top,
        left: pos.left,
        width: pos.width,
        // Explicit height (not maxHeight) so the body's `flex-1
        // overflow-y-auto` has a fixed parent to expand into. With
        // only `maxHeight` set the panel sized to its intrinsic
        // content, so a tight `pos.height` left the Unicode grid
        // collapsed to a single visible row even when the layout
        // had earmarked more space for it.
        height: pos.height,
        transformOrigin: pos.placeBelow ? "top center" : "bottom center",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header zone, toolbar + recents + error notice. `shrink-0`
          pins them at the top so they stay visible while the body
          scrolls (important for the Unicode grid where the user
          might scroll through hundreds of entries and still need the
          sheet tabs / search reachable). */}
      <div className="shrink-0">
        <SheetToolbar
          sheets={systemSheets}
          activeSheetId={view.kind === "system" ? (activeSystem?.id ?? null) : null}
          onPickSystem={(id) => { setView({ kind: "system", activeSheetId: id }); setSpendError(null); }}
          communityActive={view.kind === "community"}
          onPickCommunity={() => {
            setView({ kind: "community", activeSheetId: null });
            setSpendError(null);
          }}
          communityCount={communitySheets.length}
          unicodeAvailable={!!onPickUnicode}
          unicodeActive={view.kind === "unicode"}
          onPickUnicodeTab={() => {
            setView({ kind: "unicode" });
            setSpendError(null);
          }}
        />
        {recents.length > 0 ? (
          <RecentRow
            recents={recents}
            myUserId={me?.id ?? null}
            onPick={(sheetSlug, cellIndex) => {
              const sheet = sheets.find((s) => s.slug === sheetSlug);
              if (sheet?.kind === "community") {
                void pickCommunity(sheet, cellIndex);
                return;
              }
              onPick(sheetSlug, cellIndex);
            }}
          />
        ) : null}
        {spendError ? (
          <div className="border-b border-keep-accent/40 bg-keep-accent/10 px-3 py-1 text-[11px] text-keep-accent">
            {spendError}
          </div>
        ) : null}
      </div>

      {/* Body zone, the actual grid. `flex-1 min-h-0 overflow-y-auto`
          clamps the body to the leftover panel height and scrolls
          inside. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {view.kind === "system" ? (
          activeSystem ? (
            <PickerGrid sheet={activeSystem} onPick={onPick} />
          ) : (
            <p className="p-3 text-xs italic text-keep-muted">{t("emoticons.picker.noSheets")}</p>
          )
        ) : view.kind === "unicode" && onPickUnicode ? (
          <UnicodeGrid
            onPick={(char) => {
              onPickUnicode(char);
              onClose();
            }}
          />
        ) : view.kind === "community" && activeCommunity ? (
          <CommunityGrid
            sheet={activeCommunity}
            isOwnSheet={!!me && activeCommunity.creatorUserId === me.id}
            onPick={(cellIndex) => void pickCommunity(activeCommunity, cellIndex)}
            onBack={() => setView({ kind: "community", activeSheetId: null })}
          />
        ) : view.kind === "community" ? (
          <CommunityIndex
            sheets={sortedCommunitySheets}
            sort={communitySort}
            onChangeSort={setCommunitySort}
            onSelect={(id) => setView({ kind: "community", activeSheetId: id })}
          />
        ) : null}
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}

/* =============================================================
 *  Sheet toolbar - system tabs (scroll) + anchored Community button
 * ============================================================= */
function SheetToolbar({
  sheets,
  activeSheetId,
  onPickSystem,
  communityActive,
  onPickCommunity,
  communityCount,
  unicodeAvailable,
  unicodeActive,
  onPickUnicodeTab,
}: {
  sheets: EmoticonSheet[];
  activeSheetId: string | null;
  onPickSystem: (id: string) => void;
  communityActive: boolean;
  onPickCommunity: () => void;
  communityCount: number;
  /** Whether the parent passed an `onPickUnicode` callback. The Unicode
   *  tab is hidden when this is false so call sites that don't support
   *  raw-character insertion (e.g. ReactionBar) don't expose a button
   *  that would silently no-op on click. */
  unicodeAvailable: boolean;
  unicodeActive: boolean;
  onPickUnicodeTab: () => void;
}) {
  const { t } = useTranslation("arcade");
  return (
    <div className="keep-section-header flex shrink-0 items-center gap-1 border-b border-keep-rule px-2 py-1.5">
      {/* Left side: horizontally scrolling/swipable strip of system
          sheets. `min-w-0 flex-1` lets the flexbox shrink the strip
          so the Unicode + Community chips on the right (which are
          `shrink-0`) stay anchored no matter how many sheets exist.
          `keep-scroll-strip` hides the scrollbar on touch (swipe is
          the natural gesture there) and swaps in a slim themed
          scrollbar on md+ so the affordance is discoverable on
          desktop. `scroll-smooth` makes any future programmatic
          scroll-into-view (e.g. clicking a deep-linked sheet)
          animate instead of jumping. */}
      <div className="keep-scroll-strip flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scroll-smooth">
        {sheets.map((s) => {
          const firstCellIdx = s.cells.findIndex((c) => !isEmoticonCellEmpty(c));
          const active = !communityActive && activeSheetId === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onPickSystem(s.id)}
              title={s.name}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded transition ${
                active
                  ? "border border-keep-action bg-keep-action/15"
                  : "border border-transparent hover:bg-keep-panel-200/40"
              }`}
            >
              {firstCellIdx >= 0 ? (
                <EmoticonSprite sheetSlug={s.slug} cellIndex={firstCellIdx} size={30} />
              ) : (
                <span className="text-[10px] uppercase tracking-widest text-keep-muted">{s.name.slice(0, 2)}</span>
              )}
            </button>
          );
        })}
      </div>
      {/* Unicode button, between the scrolling system tabs and the
          Community button. Hidden when the parent didn't pass an
          `onPickUnicode` callback (reactions are sheet-based so the
          ReactionBar omits the prop). Same chip styling as Community
          so the right-side tabs read as one group. */}
      {unicodeAvailable ? (
        <button
          type="button"
          onClick={onPickUnicodeTab}
          title={t("emoticons.picker.unicodeTabTitle")}
          className={`ml-2 inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-[10px] font-action uppercase tracking-widest transition ${
            unicodeActive
              ? "border-keep-action bg-keep-action/15 text-keep-action"
              : "border-keep-rule bg-keep-bg text-keep-muted hover:bg-keep-panel-200/40 hover:text-keep-text"
          }`}
        >
          <span aria-hidden>😀</span>
          <span className="sr-only">{t("emoticons.picker.unicodeTabLabel")}</span>
        </button>
      ) : null}
      {/* Right side: anchored Community button. Always visible. Hides
          the count badge when the catalog is empty so the button reads
          as "go look" rather than implying empty content with a 0. */}
      <button
        type="button"
        onClick={onPickCommunity}
        title={t("emoticons.picker.communityTabTitle")}
        className={`ml-2 inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-[10px] font-action uppercase tracking-widest transition ${
          communityActive
            ? "border-keep-action bg-keep-action/15 text-keep-action"
            : "border-keep-rule bg-keep-bg text-keep-muted hover:bg-keep-panel-200/40 hover:text-keep-text"
        }`}
      >
        {/* Lucide users glyph (inlined; no Lucide React dep needed for
            a one-off). Sized at 14px to match the surrounding 10px
            label without crowding it. `currentColor` so the active /
            idle text-color classes above carry to the stroke. */}
        <svg
          aria-hidden
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <path d="M16 3.128a4 4 0 0 1 0 7.744" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <circle cx="9" cy="7" r="4" />
        </svg>
        {/* Visually-hidden text label so the button still has an
            accessible name for screen readers / voice control even
            though the design is icon-only. The `title` above gives
            sighted users a tooltip; sr-only keeps everyone else
            served without adding visual weight back. */}
        <span className="sr-only">{t("emoticons.picker.communityTabLabel")}</span>
        {communityCount > 0 ? (
          <span className="rounded-full bg-keep-panel-200/40 px-1 text-[9px] text-keep-text">{communityCount}</span>
        ) : null}
      </button>
    </div>
  );
}

/* =============================================================
 *  Recent row - viewer's most-frequently-used emoticons
 * ============================================================= */
function RecentRow({
  recents,
  myUserId,
  onPick,
}: {
  recents: Array<{ sheetSlug: string; cellIndex: number }>;
  /** Master account id of the viewer, used to render the
   *  owner-friendly tooltip variant on Recent entries that belong to
   *  the viewer's own community sheet. Null = anonymous viewer. */
  myUserId: string | null;
  onPick: (sheetSlug: string, cellIndex: number) => void;
}) {
  const { t } = useTranslation("arcade");
  const getSheetBySlug = useEmoticons((s) => s.getSheetBySlug);
  return (
    <section className="border-b border-keep-rule/60">
      <header className="keep-section-header bg-keep-panel-200/30 px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-keep-muted">
        {t("emoticons.picker.recent")}
      </header>
      <div className="grid grid-cols-6 gap-1 p-2">
        {recents.slice(0, MAX_VISIBLE_RECENT).map((r) => {
          // Look up the entry's sheet so paid community emoticons
          // surface the same hover-overlay treatment they get in
          // the sheet-specific grid below, without this, picking
          // from Recent would burn coins with no advance warning
          // because the dispatcher routes Recent clicks through the
          // standard spend flow. Sheets pruned from the catalog
          // (stale localStorage entry) render bare; the
          // dispatcher's null fallback already handles those picks
          // gracefully.
          const sheet = getSheetBySlug(r.sheetSlug) ?? null;
          const label = sheet?.cells[r.cellIndex] ?? null;
          const isCommunity = sheet?.kind === "community";
          const showsCost = !!sheet && isCommunity && sheet.commerceEnabled;
          const isOwnSheet = !!sheet && !!myUserId && sheet.creatorUserId === myUserId;
          const titleText = showsCost
            ? isOwnSheet
              ? t("emoticons.picker.cellCostOwner", { label: label ?? "", cost: COMMUNITY_EMOTICON_USE_COST }).trim()
              : t("emoticons.picker.cellCostVisitor", { label: label ?? "", cost: COMMUNITY_EMOTICON_USE_COST }).trim()
            : (label ?? undefined);
          return (
            <button
              key={`${r.sheetSlug}:${r.cellIndex}`}
              type="button"
              onClick={() => onPick(r.sheetSlug, r.cellIndex)}
              title={titleText}
              className={`emoticon-picker-cell ${animationClassForLabel(label)} group relative flex items-center justify-center rounded p-1 hover:bg-keep-action/10`}
            >
              <EmoticonSprite sheetSlug={r.sheetSlug} cellIndex={r.cellIndex} size={48} />
              {showsCost ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 hidden items-end justify-end gap-0.5 rounded bg-black/55 p-0.5 group-hover:flex group-focus-visible:flex"
                >
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-keep-bg/85 px-1 text-[10px] font-semibold tabular-nums text-keep-text shadow-sm">
                    <img
                      src="/assets/earning/cache_pouch.png"
                      alt=""
                      aria-hidden
                      className="h-3 w-3 select-none"
                      draggable={false}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                    <span>{COMMUNITY_EMOTICON_USE_COST}</span>
                  </span>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* =============================================================
 *  Picker grid - the active sheet's non-empty cells (system view)
 * ============================================================= */
function PickerGrid({ sheet, onPick }: { sheet: EmoticonSheet; onPick: (slug: string, cellIndex: number) => void }) {
  const { t } = useTranslation("arcade");
  const cells: Array<{ cellIndex: number; label: string }> = [];
  sheet.cells.forEach((label, i) => {
    if (!isEmoticonCellEmpty(label)) cells.push({ cellIndex: i, label });
  });
  if (cells.length === 0) {
    return <p className="p-3 text-xs italic text-keep-muted">{t("emoticons.picker.noLabeledCellsYet")}</p>;
  }
  return (
    <section>
      <header className="keep-section-header bg-keep-panel-200/30 px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-keep-muted">
        {sheet.name}
      </header>
      <div className="grid grid-cols-4 gap-1 p-2">
        {cells.map((c) => (
          <button
            key={c.cellIndex}
            type="button"
            onClick={() => onPick(sheet.slug, c.cellIndex)}
            title={c.label}
            className={`emoticon-picker-cell ${animationClassForLabel(c.label)} flex items-center justify-center rounded p-1 hover:bg-keep-action/10`}
          >
            <EmoticonSprite sheetSlug={sheet.slug} cellIndex={c.cellIndex} size={64} />
          </button>
        ))}
      </div>
    </section>
  );
}

/* =============================================================
 *  Community index - grid of community sheets to pick from
 * ============================================================= */
function CommunityIndex({
  sheets,
  sort,
  onChangeSort,
  onSelect,
}: {
  sheets: EmoticonSheet[];
  sort: "new" | "old" | "top";
  onChangeSort: (next: "new" | "old" | "top") => void;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation("arcade");
  if (sheets.length === 0) {
    return (
      <section className="p-3 text-xs text-keep-muted">
        <p className="italic">
          {t("emoticons.picker.communityEmpty", { cost: COMMUNITY_EMOTICON_USE_COST })}
        </p>
      </section>
    );
  }
  return (
    <section>
      <header className="keep-section-header flex flex-wrap items-center justify-between gap-1 bg-keep-panel-200/30 px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-keep-muted">
        <span>{t("emoticons.picker.communityHeader")}</span>
        {/* Sort control. Three small segmented pills, keeps the
            header compact and lets the viewer flip cheaply. The
            "Top" sort reads from the server-side useCount tally. */}
        <div className="flex items-center gap-0.5 font-normal normal-case tracking-normal">
          {(["new", "top", "old"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => onChangeSort(key)}
              className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-widest transition ${
                sort === key
                  ? "bg-keep-action/20 text-keep-action"
                  : "text-keep-muted hover:bg-keep-panel-200/40 hover:text-keep-text"
              }`}
              title={
                key === "new" ? t("emoticons.picker.sortNewTitle") :
                key === "old" ? t("emoticons.picker.sortOldTitle") :
                t("emoticons.picker.sortTopTitle")
              }
            >
              {key === "top" ? t("emoticons.picker.sortTop") : key === "new" ? t("emoticons.picker.sortNew") : t("emoticons.picker.sortOld")}
            </button>
          ))}
        </div>
      </header>
      <div className="grid grid-cols-3 gap-2 p-2">
        {sheets.map((s) => {
          const firstCellIdx = s.cells.findIndex((c) => !isEmoticonCellEmpty(c));
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(s.id)}
              title={
                `${s.name}` +
                (s.creatorUsername ? ` ${t("emoticons.picker.byAuthor", { name: s.creatorUsername })}` : "") +
                (s.commerceEnabled
                  ? ` · ${t("emoticons.picker.costPerUse", { cost: COMMUNITY_EMOTICON_USE_COST })}`
                  : ` · ${t("emoticons.picker.free")}`) +
                ` · ${t("emoticons.picker.uses", { count: s.useCount })}`
              }
              className="group relative flex flex-col items-center gap-1 rounded border border-keep-rule p-2 hover:border-keep-action hover:bg-keep-action/10"
            >
              {firstCellIdx >= 0 ? (
                <EmoticonSprite sheetSlug={s.slug} cellIndex={firstCellIdx} size={48} />
              ) : (
                <span className="text-[10px] uppercase tracking-widest text-keep-muted">
                  {s.name.slice(0, 2)}
                </span>
              )}
              <span className="line-clamp-1 w-full text-center text-[10px] text-keep-text">{s.name}</span>
              {s.creatorUsername ? (
                <span className="line-clamp-1 w-full text-center text-[9px] italic text-keep-muted">
                  {t("emoticons.picker.byAuthor", { name: s.creatorUsername })}
                </span>
              ) : null}
              {/* Hover cost / free overlay, matches the per-cell
                  treatment so the entire community surface reads with
                  one visual vocabulary. Paid: currency icon + cost.
                  Free: muted "Free" chip. The default state is bare
                  so the user can read the sheet name without a
                  notification-looking pill competing for attention. */}
              <span
                aria-hidden
                className="pointer-events-none absolute right-1 top-1 hidden group-hover:flex group-focus-visible:flex"
              >
                {s.commerceEnabled ? (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-keep-bg/85 px-1 text-[10px] font-semibold tabular-nums text-keep-text shadow-sm">
                    <img
                      src="/assets/earning/cache_pouch.png"
                      alt=""
                      aria-hidden
                      className="h-3 w-3 select-none"
                      draggable={false}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                    <span>{COMMUNITY_EMOTICON_USE_COST}</span>
                  </span>
                ) : (
                  <span className="rounded-full bg-keep-bg/85 px-1.5 text-[10px] font-semibold uppercase tracking-widest text-keep-muted shadow-sm">
                    {t("emoticons.picker.free")}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* =============================================================
 *  Community grid - the selected community sheet's non-empty cells
 *  with the paid-use badge. Clicking a cell triggers the spend flow.
 * ============================================================= */
function CommunityGrid({
  sheet,
  isOwnSheet,
  onPick,
  onBack,
}: {
  sheet: EmoticonSheet;
  isOwnSheet: boolean;
  onPick: (cellIndex: number) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation("arcade");
  const cells: Array<{ cellIndex: number; label: string }> = [];
  sheet.cells.forEach((label, i) => {
    if (!isEmoticonCellEmpty(label)) cells.push({ cellIndex: i, label });
  });
  return (
    <section>
      <header className="keep-section-header flex items-center justify-between bg-keep-panel-200/30 px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-keep-muted">
        <button
          type="button"
          onClick={onBack}
          className="rounded px-1 text-keep-muted hover:bg-keep-panel-200/40 hover:text-keep-text"
          title={t("emoticons.picker.backTitle")}
        >
          {t("emoticons.picker.back")}
        </button>
        <div className="flex flex-col items-end">
          <span>{sheet.name}</span>
          {sheet.creatorUsername ? (
            <span className="font-normal normal-case tracking-normal italic text-[9px]">
              {t("emoticons.picker.byAuthor", { name: sheet.creatorUsername })}
              {/* Subtitle reflects the SHEET's commerce setting (the
                  thumbnail in the index uses the same flag), with an
                  extra owner-only note about who actually pays. A
                  hardcoded "yours, free" used to ride here for any
                  owner-view, which read as the sheet being free even
                  when the owner had it set to paid, exactly the
                  contradiction the thumbnail's coin badge revealed. */}
              {sheet.commerceEnabled
                ? isOwnSheet
                  ? ` - ${t("emoticons.picker.costPerUseOwner", { cost: COMMUNITY_EMOTICON_USE_COST })}`
                  : ` - ${t("emoticons.picker.costPerUse", { cost: COMMUNITY_EMOTICON_USE_COST })}`
                : isOwnSheet
                  ? ` - ${t("emoticons.picker.freeYours")}`
                  : ` - ${t("emoticons.picker.free")}`}
            </span>
          ) : null}
        </div>
      </header>
      {cells.length === 0 ? (
        <p className="p-3 text-xs italic text-keep-muted">{t("emoticons.picker.noLabeledCells")}</p>
      ) : (
        <div className="grid grid-cols-4 gap-1 p-2">
          {cells.map((c) => {
            // The overlay is keyed off the SHEET's commerce setting
            // alone, not the viewer's relationship to it. The owner
            // viewing their own paid sheet still sees the cost overlay
            // on hover, it's a preview of what visitors get, which
            // gives the owner a quick way to confirm their commerce
            // toggle is doing what they think. The actual charge path
            // in `pickCommunity` still short-circuits for the owner
            // so the preview is purely visual. Free sheets render
            // bare on hover regardless of who's looking.
            const showsCost = sheet.commerceEnabled;
            return (
              <button
                key={c.cellIndex}
                type="button"
                onClick={() => onPick(c.cellIndex)}
                title={
                  showsCost
                    ? isOwnSheet
                      ? t("emoticons.picker.cellCostOwner", { label: c.label, cost: COMMUNITY_EMOTICON_USE_COST })
                      : t("emoticons.picker.cellCostVisitor", { label: c.label, cost: COMMUNITY_EMOTICON_USE_COST })
                    : c.label
                }
                className={`emoticon-picker-cell ${animationClassForLabel(c.label)} group relative flex items-center justify-center rounded p-1 hover:bg-keep-action/10`}
              >
                <EmoticonSprite sheetSlug={sheet.slug} cellIndex={c.cellIndex} size={64} />
                {showsCost ? (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 hidden items-end justify-end gap-0.5 rounded bg-black/55 p-0.5 group-hover:flex group-focus-visible:flex"
                  >
                    <span className="inline-flex items-center gap-0.5 rounded-full bg-keep-bg/85 px-1 text-[10px] font-semibold tabular-nums text-keep-text shadow-sm">
                      <img
                        src="/assets/earning/cache_pouch.png"
                        alt=""
                        aria-hidden
                        className="h-3 w-3 select-none"
                        draggable={false}
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                      <span>{COMMUNITY_EMOTICON_USE_COST}</span>
                    </span>
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* =============================================================
 *  Unicode emoji grid, categorized + searchable. Renders the raw
 *  character; the browser's system emoji font handles the glyph,
 *  matching the user's OS rendering (iOS/Android/Win/Linux each
 *  look native). The catalog lives in `@thekeep/shared`
 *  (unicodeEmoji.ts) as a curated ~400-entry subset; entries
 *  carry searchable name + tags so common synonyms find the right
 *  emoji.
 * ============================================================= */
function UnicodeGrid({ onPick }: { onPick: (char: string) => void }) {
  const { t } = useTranslation("arcade");
  const [query, setQuery] = useState("");
  const trimmed = query.trim().toLowerCase();
  // Pre-compute the search index once per query so the render path
  // doesn't iterate the catalog per row. Empty query → fall through
  // to the categorized rendering below.
  const searchResults = useMemo(() => {
    if (trimmed.length === 0) return null;
    return UNICODE_EMOJI_FLAT.filter((e) => {
      if (e.name.includes(trimmed)) return true;
      if (e.tags?.some((t) => t.includes(trimmed))) return true;
      return false;
    });
  }, [trimmed]);

  return (
    <section className="flex flex-col">
      {/* Search bar sits sticky at the top of the picker body so the
          input stays reachable while the category list scrolls. */}
      <header className="keep-section-header sticky top-0 z-10 border-b border-keep-rule/60 bg-keep-panel-200/70 px-2 py-1.5 backdrop-blur-sm">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("emoticons.picker.searchPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs"
          aria-label={t("emoticons.picker.searchAria")}
        />
      </header>
      {searchResults !== null ? (
        searchResults.length === 0 ? (
          <p className="p-3 text-xs italic text-keep-muted">
            {t("emoticons.picker.noMatch", { query })}
          </p>
        ) : (
          <UnicodeRow emoji={searchResults} onPick={onPick} />
        )
      ) : (
        UNICODE_EMOJI_CATEGORIES.map((cat) => (
          <div key={cat.id}>
            <header className="keep-section-header bg-keep-panel-200/30 px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-keep-muted">
              {cat.label}
            </header>
            <UnicodeRow emoji={cat.emoji} onPick={onPick} />
          </div>
        ))
      )}
    </section>
  );
}

function UnicodeRow({
  emoji,
  onPick,
}: {
  emoji: readonly UnicodeEmoji[];
  onPick: (char: string) => void;
}) {
  return (
    <div className="grid grid-cols-8 gap-0.5 p-2">
      {emoji.map((e) => (
        <button
          key={e.char + e.name}
          type="button"
          onClick={() => onPick(e.char)}
          title={e.name}
          // Larger font-size on the emoji glyph so each button reads
          // at sticker scale rather than inline-text scale. `leading-none`
          // keeps the row compact.
          className="flex h-9 items-center justify-center rounded text-2xl leading-none hover:bg-keep-action/10 focus-visible:bg-keep-action/15"
        >
          <span aria-hidden>{e.char}</span>
          <span className="sr-only">{e.name}</span>
        </button>
      ))}
    </div>
  );
}
