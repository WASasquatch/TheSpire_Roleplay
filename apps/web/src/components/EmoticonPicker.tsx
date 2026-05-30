import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EmoticonSheet } from "@thekeep/shared";
import { COMMUNITY_EMOTICON_USE_COST, isEmoticonCellEmpty } from "@thekeep/shared";
import { useEmoticons } from "../state/emoticons.js";
import { useChat } from "../state/store.js";
import { EmoticonSprite } from "./EmoticonSprite.js";
import { MAX_VISIBLE_RECENT, recentPicks } from "../lib/recentEmoticons.js";
import { animationClassForLabel } from "../lib/emoticonMoods.js";
import { useCommunityEmoticon } from "../lib/emoticonSubmissions.js";

interface Props {
  /** Called when the user picks a cell. */
  onPick: (sheetSlug: string, cellIndex: number) => void;
  /** Called when the user clicks outside / presses Escape. */
  onClose: () => void;
  /** Anchor element - the picker positions itself relative to this
   *  rect. Prefers BELOW the anchor when there's room, falls back to
   *  ABOVE only when below would clip; aligned to the anchor's right
   *  edge with viewport clamping. Pass the trigger button's DOM node. */
  anchor: HTMLElement | null;
}

const PANEL_WIDTH = 380;

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
export function EmoticonPicker({ onPick, onClose, anchor }: Props) {
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
    | { kind: "community"; activeSheetId: string | null };
  const [view, setView] = useState<View>(() => ({
    kind: "system",
    activeSheetId: systemSheets[0]?.id ?? null,
  }));

  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; placeBelow: boolean }>({
    top: 0, left: 0, width: PANEL_WIDTH, placeBelow: true,
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
      const pr = panelRef.current.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const width = Math.min(PANEL_WIDTH, window.innerWidth - 2 * margin);
      const belowTop = ar.bottom + gap;
      const aboveTop = ar.top - pr.height - gap;
      const wouldClipBelow = belowTop + pr.height > window.innerHeight - margin;
      const wouldClipAbove = aboveTop < margin;
      const placeBelow = !wouldClipBelow || wouldClipAbove;
      const top = placeBelow ? belowTop : aboveTop;
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
        `Use this community emoticon for ${COMMUNITY_EMOTICON_USE_COST} Currency? ` +
          `${COMMUNITY_EMOTICON_USE_COST} Currency goes to the sheet's creator. ` +
          `You won't be asked again this session.`,
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
      setSpendError(e instanceof Error ? e.message : "could not charge");
    }
  }

  // Resolve the active sheet for the body view. When the view is
  // "system" we render the active system sheet's grid. When the view
  // is "community" with no sheet selected we show the community sheet
  // index; with a sheet selected we show its grid (with the paid-use
  // badge). The recent row sits between the toolbar and the grid in
  // both modes.
  const activeSystem = systemSheets.find((s) => s.id === view.activeSheetId) ?? systemSheets[0];
  const activeCommunity = view.kind === "community"
    ? communitySheets.find((s) => s.id === view.activeSheetId) ?? null
    : null;

  if (typeof document === "undefined") return null;

  const panel = (
    <div
      ref={panelRef}
      className="emoticon-picker-panel keep-panel flex flex-col rounded-lg shadow-2xl"
      style={{
        position: "fixed",
        zIndex: 200,
        top: pos.top,
        left: pos.left,
        width: pos.width,
        maxHeight: "calc(100vh - 16px)",
        overflowY: "auto",
        transformOrigin: pos.placeBelow ? "top center" : "bottom center",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
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
      />
      {recents.length > 0 ? (
        <RecentRow
          recents={recents}
          myUserId={me?.id ?? null}
          onPick={(sheetSlug, cellIndex) => {
            // Route Recent picks through the same dispatcher the
            // top-level grids use so a community emoticon in Recent
            // still triggers the spend flow (and an own-sheet recent
            // forwards free, etc.). Falls back to the parent's onPick
            // when the sheet has been pruned from the catalog (the
            // slug no longer resolves) - same posture the legacy
            // path took, just with kind-awareness on top.
            const sheet = sheets.find((s) => s.slug === sheetSlug);
            if (sheet?.kind === "community") {
              void pickCommunity(sheet, cellIndex);
              return;
            }
            // System path: same as the legacy direct-onPick. The
            // parent (ReactionBar / composer) decides whether to
            // close the picker after the pick.
            onPick(sheetSlug, cellIndex);
          }}
        />
      ) : null}
      {spendError ? (
        <div className="border-b border-keep-accent/40 bg-keep-accent/10 px-3 py-1 text-[11px] text-keep-accent">
          {spendError}
        </div>
      ) : null}
      {view.kind === "system" ? (
        activeSystem ? (
          <PickerGrid sheet={activeSystem} onPick={onPick} />
        ) : (
          <p className="p-3 text-xs italic text-keep-muted">No emoticon sheets installed.</p>
        )
      ) : activeCommunity ? (
        <CommunityGrid
          sheet={activeCommunity}
          isOwnSheet={!!me && activeCommunity.creatorUserId === me.id}
          onPick={(cellIndex) => void pickCommunity(activeCommunity, cellIndex)}
          onBack={() => setView({ kind: "community", activeSheetId: null })}
        />
      ) : (
        <CommunityIndex
          sheets={sortedCommunitySheets}
          sort={communitySort}
          onChangeSort={setCommunitySort}
          onSelect={(id) => setView({ kind: "community", activeSheetId: id })}
        />
      )}
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
}: {
  sheets: EmoticonSheet[];
  activeSheetId: string | null;
  onPickSystem: (id: string) => void;
  communityActive: boolean;
  onPickCommunity: () => void;
  communityCount: number;
}) {
  return (
    <div className="keep-section-header flex shrink-0 items-center gap-1 border-b border-keep-rule px-2 py-1.5">
      {/* Left side: scrolling system sheets. `min-w-0 flex-1` lets the
          flexbox shrink it so the Community button on the right stays
          visible no matter how many system sheets exist. */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
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
      {/* Right side: anchored Community button. Always visible. Hides
          the count badge when the catalog is empty so the button reads
          as "go look" rather than implying empty content with a 0. */}
      <button
        type="button"
        onClick={onPickCommunity}
        title="Community emoticons (1 Currency per use, paid to the creator)"
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
        <span className="sr-only">Community</span>
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
  const getSheetBySlug = useEmoticons((s) => s.getSheetBySlug);
  return (
    <section className="border-b border-keep-rule/60">
      <header className="keep-section-header bg-keep-panel-200/30 px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-keep-muted">
        Recent
      </header>
      <div className="grid grid-cols-6 gap-1 p-2">
        {recents.slice(0, MAX_VISIBLE_RECENT).map((r) => {
          // Look up the entry's sheet so paid community emoticons
          // surface the same hover-overlay treatment they get in
          // the sheet-specific grid below — without this, picking
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
              ? `${label ?? ""} (${COMMUNITY_EMOTICON_USE_COST} Currency per use for visitors; free for you)`.trim()
              : `${label ?? ""} (${COMMUNITY_EMOTICON_USE_COST} Currency per use)`.trim()
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
  if (sheets.length === 0) {
    return (
      <section className="p-3 text-xs text-keep-muted">
        <p className="italic">
          No community sheets yet. Approved user-submitted sheets show up here. Paid sheets cost {COMMUNITY_EMOTICON_USE_COST} Currency
          per use (goes to the creator); free sheets are marked Free.
        </p>
      </section>
    );
  }
  return (
    <section>
      <header className="keep-section-header flex flex-wrap items-center justify-between gap-1 bg-keep-panel-200/30 px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-keep-muted">
        <span>Community sheets</span>
        {/* Sort control. Three small segmented pills — keeps the
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
                key === "new" ? "Newest first" :
                key === "old" ? "Oldest first" :
                "Most-used first"
              }
            >
              {key === "top" ? "Top" : key === "new" ? "New" : "Old"}
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
                (s.creatorUsername ? ` by @${s.creatorUsername}` : "") +
                (s.commerceEnabled
                  ? ` · ${COMMUNITY_EMOTICON_USE_COST} Currency per use`
                  : " · Free") +
                ` · ${s.useCount} uses`
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
                  by @{s.creatorUsername}
                </span>
              ) : null}
              {/* Hover cost / free overlay — matches the per-cell
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
                    Free
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
          title="Back to community sheets"
        >
          {"← Back"}
        </button>
        <div className="flex flex-col items-end">
          <span>{sheet.name}</span>
          {sheet.creatorUsername ? (
            <span className="font-normal normal-case tracking-normal italic text-[9px]">
              by @{sheet.creatorUsername}
              {/* Subtitle reflects the SHEET's commerce setting (the
                  thumbnail in the index uses the same flag), with an
                  extra owner-only note about who actually pays. A
                  hardcoded "yours, free" used to ride here for any
                  owner-view, which read as the sheet being free even
                  when the owner had it set to paid — exactly the
                  contradiction the thumbnail's coin badge revealed. */}
              {sheet.commerceEnabled
                ? isOwnSheet
                  ? ` - ${COMMUNITY_EMOTICON_USE_COST} Currency per use (free for you)`
                  : ` - ${COMMUNITY_EMOTICON_USE_COST} Currency per use`
                : isOwnSheet
                  ? " - Free (yours)"
                  : " - Free"}
            </span>
          ) : null}
        </div>
      </header>
      {cells.length === 0 ? (
        <p className="p-3 text-xs italic text-keep-muted">This sheet has no labeled cells.</p>
      ) : (
        <div className="grid grid-cols-4 gap-1 p-2">
          {cells.map((c) => {
            // The overlay is keyed off the SHEET's commerce setting
            // alone, not the viewer's relationship to it. The owner
            // viewing their own paid sheet still sees the cost overlay
            // on hover — it's a preview of what visitors get, which
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
                      ? `${c.label} (${COMMUNITY_EMOTICON_USE_COST} Currency per use for visitors; free for you)`
                      : `${c.label} (${COMMUNITY_EMOTICON_USE_COST} Currency per use)`
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
