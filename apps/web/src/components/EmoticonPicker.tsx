import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EmoticonSheet } from "@thekeep/shared";
import { isEmoticonCellEmpty } from "@thekeep/shared";
import { useEmoticons } from "../state/emoticons.js";
import { EmoticonSprite } from "./EmoticonSprite.js";
import { MAX_VISIBLE_RECENT, recentPicks } from "../lib/recentEmoticons.js";
import { animationClassForLabel } from "../lib/emoticonMoods.js";

interface Props {
  /** Called when the user picks a cell. */
  onPick: (sheetSlug: string, cellIndex: number) => void;
  /** Called when the user clicks outside / presses Escape. */
  onClose: () => void;
  /** Anchor element — the picker positions itself relative to this
   *  rect. Prefers BELOW the anchor when there's room, falls back to
   *  ABOVE only when below would clip; aligned to the anchor's right
   *  edge with viewport clamping. Pass the trigger button's DOM node. */
  anchor: HTMLElement | null;
}

const PANEL_WIDTH = 380;

/**
 * Floating emoticon picker. Visual structure:
 *
 *   ┌─ Sheet preview toolbar ─────────────────────────────────┐
 *   │  [first cell of sheet A] [first cell of sheet B] ...    │
 *   ├─ Recent ────────────────────────────────────────────────┤
 *   │  most-used 12 emoticons (LRU + frequency)               │
 *   ├─ Active sheet grid ─────────────────────────────────────┤
 *   │  4-column grid of the selected sheet's non-empty cells  │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Layout policy: prefers to open BELOW the trigger when there's
 * room (the user expects a dropdown), falls back to opening above
 * only when below would clip the viewport. Aligned to the anchor's
 * right edge with viewport clamping. Click-away + Escape close.
 */
export function EmoticonPicker({ onPick, onClose, anchor }: Props) {
  const sheets = useEmoticons((s) => s.sheets);
  const [activeSheetId, setActiveSheetId] = useState<string | null>(
    sheets[0]?.id ?? null,
  );
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; placeBelow: boolean }>({
    top: 0, left: 0, width: PANEL_WIDTH, placeBelow: true,
  });

  // Capture recents ONCE on mount — the picker doesn't need to
  // re-render when the user picks (it closes immediately on pick).
  // A live subscription would also flash the just-picked emoticon
  // into the recent row right before the close animation, which
  // reads as visual jank.
  const recents = useMemo(() => recentPicks(), []);

  useLayoutEffect(() => {
    function layout() {
      if (!anchor || !panelRef.current) return;
      const ar = anchor.getBoundingClientRect();
      const pr = panelRef.current.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      // Shrink the panel to fit narrow viewports (mobile, side-by-
      // side splits). At PANEL_WIDTH the panel literally can't fit a
      // <396px viewport and the clamp logic below would just pin the
      // left edge with the right edge bleeding off-screen. Compute
      // width FROM the viewport so the picker stays fully visible.
      const width = Math.min(PANEL_WIDTH, window.innerWidth - 2 * margin);
      // Prefer BELOW. Fall back to above only when below would
      // clip the bottom of the viewport.
      const belowTop = ar.bottom + gap;
      const aboveTop = ar.top - pr.height - gap;
      const wouldClipBelow = belowTop + pr.height > window.innerHeight - margin;
      const wouldClipAbove = aboveTop < margin;
      const placeBelow = !wouldClipBelow || wouldClipAbove;
      const top = placeBelow ? belowTop : aboveTop;
      // Align to anchor center horizontally so the picker visually
      // sprouts FROM the trigger button, not off to one side. Use
      // the COMPUTED width (not pr.width) for clamping because the
      // first measurement happens before our width-state has been
      // applied — pr.width would reflect the stale 380px until the
      // next render.
      let left = ar.left + ar.width / 2 - width / 2;
      const minLeft = margin;
      const maxLeft = window.innerWidth - width - margin;
      if (left < minLeft) left = minLeft;
      if (left > maxLeft) left = Math.max(minLeft, maxLeft);
      setPos({ top, left, width, placeBelow });
    }
    layout();
    window.addEventListener("resize", layout);
    window.addEventListener("scroll", layout, true);
    return () => {
      window.removeEventListener("resize", layout);
      window.removeEventListener("scroll", layout, true);
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

  const active = sheets.find((s) => s.id === activeSheetId) ?? sheets[0];

  // Render through a portal to document.body so the picker escapes
  // every ancestor stacking context. Without this, ancestors that
  // set `transform` / `filter` / `will-change` (the forum scroll
  // container, the splash card, etc.) trap `position: fixed` and
  // clip the picker behind sibling forum sections. SSR-safe via
  // the typeof window check.
  if (typeof document === "undefined") return null;

  const panel = (
    <div
      ref={panelRef}
      className="emoticon-picker-panel keep-panel flex flex-col rounded-lg shadow-2xl"
      style={{
        // `position: 'fixed'` inline because the `.keep-panel` rules
        // applied by every theme-style scope carry `position: relative`
        // and beat the Tailwind `.fixed` utility on specificity.
        // Z-index has to win over modal stacks too (chat shell modals
        // sit at z-50; emoticon picker opened from inside a DM modal
        // still has to land on top of it).
        position: "fixed",
        zIndex: 200,
        top: pos.top,
        left: pos.left,
        width: pos.width,
        // Cap height to the viewport so a tall picker (sheet toolbar
        // + recents + a long grid) can't run off the bottom on
        // shorter screens / landscape phones — the inner content
        // scrolls instead. Pairs with the responsive `width` above.
        maxHeight: "calc(100vh - 16px)",
        overflowY: "auto",
        transformOrigin: pos.placeBelow ? "top center" : "bottom center",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <SheetToolbar
        sheets={sheets}
        activeSheetId={active?.id ?? null}
        onPick={setActiveSheetId}
      />
      {recents.length > 0 ? (
        <RecentRow recents={recents} onPick={onPick} />
      ) : null}
      {active ? (
        <PickerGrid sheet={active} onPick={onPick} />
      ) : (
        <p className="p-3 text-xs italic text-keep-muted">No emoticon sheets installed.</p>
      )}
    </div>
  );

  return createPortal(panel, document.body);
}

/* =============================================================
 *  Sheet toolbar — first non-empty cell of each sheet as the tab
 * ============================================================= */
function SheetToolbar({
  sheets,
  activeSheetId,
  onPick,
}: {
  sheets: EmoticonSheet[];
  activeSheetId: string | null;
  onPick: (id: string) => void;
}) {
  if (sheets.length === 0) return null;
  return (
    <div className="keep-section-header flex shrink-0 items-center gap-1 overflow-x-auto border-b border-keep-rule px-2 py-1.5">
      {sheets.map((s) => {
        const firstCellIdx = s.cells.findIndex((c) => !isEmoticonCellEmpty(c));
        const active = activeSheetId === s.id;
        // Sheet-toolbar tabs are NAVIGATION — pick which sheet's grid
        // shows below — not reaction targets. The mood-animation
        // treatment (`emoticon-picker-cell` + an `emoticon-anim-…`
        // class) is intentionally NOT applied here so the tabs stay
        // calm: a row of pulsing animated borders along the top of
        // every picker open read as visual chaos before the user even
        // got to the actual grid. The cells below in the active
        // sheet still get the full treatment.
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onPick(s.id)}
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
  );
}

/* =============================================================
 *  Recent row — viewer's most-frequently-used emoticons
 * ============================================================= */
function RecentRow({
  recents,
  onPick,
}: {
  recents: Array<{ sheetSlug: string; cellIndex: number }>;
  onPick: (sheetSlug: string, cellIndex: number) => void;
}) {
  // Resolve each recent's label from the sheet catalog so the cell
  // button picks up the right mood-animation class. Falls back to a
  // null label (→ default mood) when the sheet has been pruned
  // since the recent was recorded.
  const getSheetBySlug = useEmoticons((s) => s.getSheetBySlug);
  return (
    <section className="border-b border-keep-rule/60">
      <header className="keep-section-header bg-keep-panel-200/30 px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-keep-muted">
        Recent
      </header>
      <div className="grid grid-cols-6 gap-1 p-2">
        {recents.slice(0, MAX_VISIBLE_RECENT).map((r) => {
          const label = getSheetBySlug(r.sheetSlug)?.cells[r.cellIndex] ?? null;
          return (
            <button
              key={`${r.sheetSlug}:${r.cellIndex}`}
              type="button"
              onClick={() => onPick(r.sheetSlug, r.cellIndex)}
              className={`emoticon-picker-cell ${animationClassForLabel(label)} flex items-center justify-center rounded p-1 hover:bg-keep-action/10`}
            >
              <EmoticonSprite sheetSlug={r.sheetSlug} cellIndex={r.cellIndex} size={48} />
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* =============================================================
 *  Picker grid — the active sheet's non-empty cells
 * ============================================================= */
function PickerGrid({ sheet, onPick }: { sheet: EmoticonSheet; onPick: (slug: string, cellIndex: number) => void }) {
  const cells: Array<{ cellIndex: number; label: string }> = [];
  sheet.cells.forEach((label, i) => {
    if (!isEmoticonCellEmpty(label)) cells.push({ cellIndex: i, label });
  });
  if (cells.length === 0) {
    return <p className="p-3 text-xs italic text-keep-muted">This sheet has no labeled cells yet.</p>;
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
