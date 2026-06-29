/**
 * Earning dashboard modal, the user-facing surface for the
 * XP / Currency / Ranks system.
 *
 * Phase 1 ships sections 1 (header), 2 (wallets), 3 (ledger), and 7
 * (settings). Sections 4 (name styles), 5 (borders), and 6 (cosmetics)
 * are stubbed with "coming in a later phase" placeholders so the tab
 * routing is in place from day one.
 *
 * Opens from the Banner's "Earning" link. Same `Modal` shell every
 * other modal uses.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, MODAL_CARD_CONTENT } from "./Modal.js";
import { DisplayPrivacyRow } from "./DisplayPrivacyRow.js";
import { useEarning, lookupRankTier, progressToNextTier } from "../state/earning.js";
import { useChat } from "../state/store.js";
import {
  buyItem,
  equipCosmetic,
  fetchEarningCatalog,
  fetchEarningLedger,
  fetchGameRankings,
  fetchFamiliarRankings,
  fetchScriptoriumRankings,
  fetchRankings,
  formatItemName,
  formatLedgerEntry,
  patchFreeformBorderConfig,
  patchNameStyleConfig,
  patchEarningSettings,
  purchaseBorder,
  purchaseFreeformBorder,
  patchProfileBannerUrl,
  patchRoomPresenceTemplates,
  patchSessionPresenceTemplates,
  patchTypingPhrase,
  purchaseCosmetic,
  purchaseTransition,
  setActiveRoomTransition,
  purchaseNameStyle,
  setActiveNameStyle,
  setCollectionSlots,
  setPetCollectionSlots,
  setPetNickname,
  ITEM_CATEGORIES,
  ITEM_CATEGORY_LABELS,
  fetchFlashSale,
  type CatalogResponse,
  type CollectionEntry,
  type FlashSalePick,
  type FlashSaleResponse,
  type FreeformBorderRow,
  type InventoryEntry,
  type ItemCatalogRow,
  type ItemCategory,
  type LedgerEntry,
  type NameStyleCatalogRow,
  type OwnedStyle,
  type PoolView,
  type RankingsResponse,
  type RankingBoard,
  type RankingChampion,
  type RankingBoardKey,
  type RankingPoolEntry,
  type RankingDisplayEntry,
  type RankTierRow,
  type GameRankingsResponse,
  type GameRankingRow,
  type OverallRankingRow,
  type FamiliarRankingsResponse,
  type FamiliarRankingRow,
  type ScriptoriumRankingsResponse,
  type ScriptoriumBookRow,
} from "../lib/earning.js";
import { BorderedAvatar } from "./BorderedAvatar.js";
import { EmoticonSubmissionModal } from "./EmoticonSubmissionModal.js";
import { CoinAmount } from "./CoinAmount.js";
import { StyledName } from "./StyledName.js";
import { CloseButton } from "./CloseButton.js";
import { extractFreeformBorderVarsWithDefaults, parseFreeformBorderConfig } from "@thekeep/shared";
import { ROOM_TRANSITIONS, type RoomTransition } from "@thekeep/shared";
import { previewRoomTransition } from "../lib/transitions/orchestrator.js";
import { getServer } from "../lib/servers.js";

type DashboardTab = "overview" | "ledger" | "settings" | "styles" | "borders" | "transitions" | "cosmetics" | "items" | "rankings";
type ItemsSubTab = "inventory" | "shop" | "collection" | "pets";

interface Props {
  onClose: () => void;
  /**
   * Tab to land on when the dashboard opens. Used by the
   * `/earnings` / `/shop` / `/collection` / `/pets` builtin commands
   * (and any other future deep-link). Defaults to "overview".
   */
  initialTab?: DashboardTab;
  /**
   * Sub-tab within the Items tab to land on. Only meaningful when
   * `initialTab === "items"`; the prop threads through to ItemsTab.
   */
  initialItemSubTab?: ItemsSubTab;
  /**
   * Board to scroll to + flash within the Rankings tab. Set by the
   * `{ranking:<board>}` UI-route chips; only meaningful when
   * `initialTab === "rankings"`.
   */
  initialBoard?: RankingBoardKey;
}

export function EarningDashboard({ onClose, initialTab, initialItemSubTab, initialBoard }: Props) {
  const snapshot = useEarning((s) => s.snapshot);
  const loading = useEarning((s) => s.loading);
  const error = useEarning((s) => s.error);
  const refresh = useEarning((s) => s.refresh);
  const me = useChat((s) => s.me);
  // Multi-Server Lift: which server's economy are we viewing? The
  // snapshot is scoped to the room's server (`currentServerId`). With
  // the flag off — or before a server resolves — `currentServerId` is
  // null and the fetch falls back to the literal `/earning/me`, so the
  // dashboard is byte-identical to today. `defaultServerId` lets us
  // tell "viewing a guest server" from "viewing home" so the label
  // only appears when it adds information.
  const serversEnabled = useChat((s) => s.branding.serversEnabled === true);
  const currentServerId = useChat((s) => s.currentServerId);
  const defaultServerId = useChat((s) => s.defaultServerId);
  const [tab, setTab] = useState<DashboardTab>(initialTab ?? "overview");
  // Flash Sale → shop tab nav. When the user clicks a sale card, we
  // jump to the matching tab AND stash the catalog row key the card
  // referenced. The receiving tab finds the corresponding row via
  // `data-shop-row="<key>"` and scrolls it into view + briefly
  // highlights it so the user lands on the exact row they came to
  // buy instead of dumping them at the top of a long catalog.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  function navigateTo(nextTab: DashboardTab, key: string | null = null): void {
    setTab(nextTab);
    setFocusKey(key);
  }

  // Re-fetch on mount (and whenever the active server changes) so a
  // freshly-opened dashboard reflects any earnings that landed while
  // the modal was closed (rank-up events already updated the unack list
  // live; this catches wallet drift if a credit somehow missed the live
  // event), AND so switching servers swaps to that server's economy.
  // `currentServerId` is null with the flag off → refresh() hits the
  // literal `/earning/me`, unchanged from today.
  useEffect(() => {
    void refresh(currentServerId);
  }, [refresh, currentServerId]);

  // Today's flash sale, hoisted here so every tab (Overview hero,
  // Name Styles / Cosmetics / Items shop pips) reads from the same
  // payload. Single fetch on dashboard mount; cheap warm-path reads
  // afterwards. Tabs that don't render until clicked still get the
  // up-to-date sale because we re-fetch when the snapshot refreshes
  // (purchase, equip, /char switch all trigger refresh → this effect
  // would NOT re-run because its dep is empty, so we explicitly
  // refresh on refresh-completion below).
  const [flashSale, setFlashSale] = useState<FlashSaleResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchFlashSale()
      .then((r) => { if (!cancelled) setFlashSale(r); })
      .catch(() => { /* silent, sale info is decoration */ });
    return () => { cancelled = true; };
  }, []);

  return (
    <Modal onClose={onClose} zIndex={50} variant="mobile-fullscreen">
      <div
        onClick={(e) => e.stopPropagation()}
        className={`${MODAL_CARD_CONTENT} keep-frame rounded bg-keep-parchment`}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-keep-rule bg-keep-banner px-4 py-2">
          <h2 className="shrink-0 font-action text-lg">Your Earning</h2>
          {/* Mobile: a single full-width dropdown for the active tab,
              with the X button flush to its right. The horizontal
              tab strip was hard to scan at <lg widths, even the
              `overflow-x-auto` scroll didn't help when six labels
              crowded the same space the header title + close button
              wanted. */}
          <select
            value={tab}
            onChange={(e) => setTab(e.target.value as typeof tab)}
            className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs uppercase tracking-widest text-keep-text outline-none focus:border-keep-action lg:hidden"
            aria-label="Earning section"
          >
            <option value="overview">Overview</option>
            <option value="ledger">Activity</option>
            <option value="rankings">Rankings</option>
            <option value="styles">Name Styles</option>
            <option value="borders">Borders</option>
            <option value="transitions">Room Transitions</option>
            <option value="cosmetics">Flair</option>
            <option value="items">Items</option>
            <option value="settings">Settings</option>
          </select>
          {/* Desktop: the horizontal tab strip stays as the primary
              affordance. Hidden on mobile (lg:flex pairs with the
              `lg:hidden` on the select above). */}
          <nav className="keep-scroll-strip hidden min-w-0 flex-1 gap-1 overflow-x-auto text-xs uppercase tracking-widest lg:flex">
            <TabBtn active={tab === "overview"} onClick={() => setTab("overview")}>Overview</TabBtn>
            <TabBtn active={tab === "ledger"} onClick={() => setTab("ledger")}>Activity</TabBtn>
            <TabBtn active={tab === "rankings"} onClick={() => setTab("rankings")}>Rankings</TabBtn>
            <TabBtn active={tab === "styles"} onClick={() => setTab("styles")}>Name Styles</TabBtn>
            <TabBtn active={tab === "borders"} onClick={() => setTab("borders")}>Borders</TabBtn>
            <TabBtn active={tab === "transitions"} onClick={() => setTab("transitions")}>Room Transitions</TabBtn>
            <TabBtn active={tab === "cosmetics"} onClick={() => setTab("cosmetics")}>Flair</TabBtn>
            <TabBtn active={tab === "items"} onClick={() => setTab("items")}>Items</TabBtn>
            <TabBtn active={tab === "settings"} onClick={() => setTab("settings")}>Settings</TabBtn>
          </nav>
          <CloseButton onClick={onClose} />
        </div>

        {/* Multi-Server Lift: which server's economy is this? Only
            renders when the servers flag is on AND the viewer is on a
            non-default (guest) server, so the home-server / flag-off
            dashboard looks exactly like today (the bar is absent). */}
        {serversEnabled && currentServerId && currentServerId !== defaultServerId ? (
          <ActiveServerLabel serverId={currentServerId} />
        ) : null}

        {/* `min-h-0 flex-1` so the body fills the remaining card
            height. Earlier `max-h-[78vh]` capped against the viewport
            directly, which didn't compose with the new
            `MODAL_CARD_CONTENT` height (`h-full` mobile / `lg:h-[90vh]`).
            With flex-1 the body grows to match whatever the card
            allots, regardless of viewport. */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error ? (
            <div className="mb-3 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-sm text-keep-accent">
              {error}
            </div>
          ) : null}
          {!snapshot && loading ? (
            <p className="text-sm text-keep-muted">Loading your earning…</p>
          ) : null}
          {!snapshot && !loading && !error ? (
            <p className="text-sm text-keep-muted">No earning record yet, earn XP from chat or forums to start.</p>
          ) : null}

          {snapshot && tab === "overview" ? <OverviewTab snapshot={snapshot} flashSale={flashSale} onNavigate={navigateTo} /> : null}
          {snapshot && tab === "ledger" ? (
            <LedgerTab
              characters={snapshot.characters.map((c) => ({ id: c.ownerId, name: c.displayName }))}
              itemCatalog={snapshot.catalog.items}
            />
          ) : null}
          {snapshot && tab === "settings" ? <SettingsTab snapshot={snapshot} myId={me?.id ?? null} /> : null}
          {tab === "rankings" ? <RankingsTab {...(initialBoard ? { initialBoard } : {})} /> : null}
          {snapshot && tab === "styles" ? <NameStylesTab snapshot={snapshot} flashSale={flashSale} focusKey={focusKey} /> : null}
          {snapshot && tab === "borders" ? <BordersTab snapshot={snapshot} flashSale={flashSale} focusKey={focusKey} /> : null}
          {snapshot && tab === "transitions" ? <RoomTransitionsTab snapshot={snapshot} /> : null}
          {snapshot && tab === "cosmetics" ? <CosmeticsTab snapshot={snapshot} flashSale={flashSale} focusKey={focusKey} /> : null}
          {snapshot && tab === "items" ? (
            <ItemsTab
              snapshot={snapshot}
              flashSale={flashSale}
              focusKey={focusKey}
              {...(initialItemSubTab ? { initialSubTab: initialItemSubTab } : {})}
            />
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

/**
 * Thin "you're viewing <Server>'s economy" sub-bar shown under the
 * header when the Multi-Server Lift flag is on and the viewer is on a
 * non-default server (the parent gates rendering). Resolves the server
 * name lazily via `getServer` so we don't have to thread the rail's
 * server catalog down into the dashboard's file set; until the name
 * lands it shows a neutral "this server" so there's never a flash of a
 * raw id. Failures fall back silently to the same neutral copy — the
 * label is informational, not load-bearing.
 */
function ActiveServerLabel({ serverId }: { serverId: string }) {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setName(null);
    getServer(serverId)
      .then((r) => { if (!cancelled) setName(r.server.name); })
      .catch(() => { /* silent — label is decoration */ });
    return () => { cancelled = true; };
  }, [serverId]);
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-keep-rule bg-keep-bg/40 px-4 py-1.5 text-[11px] uppercase tracking-widest text-keep-muted">
      <span aria-hidden>🏰</span>
      <span>Viewing {name ?? "this server"}&rsquo;s economy</span>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 whitespace-nowrap rounded border border-keep-rule px-2 py-0.5 ${active ? "bg-keep-bg" : "bg-keep-banner/40 hover:bg-keep-banner"}`}
    >
      {children}
    </button>
  );
}

/**
 * Shop-row focus utility. When a shop tab opens with a `focusKey`
 * (set by a Flash Sale card click on the Overview), find the matching
 * row via its `data-shop-row="<key>"` attribute, scroll it into view,
 * and apply a brief CSS pulse so the user sees exactly which row they
 * came to buy. `scrollIntoView` walks up to the nearest scrollable
 * ancestor automatically, the modal body's `overflow-y-auto` div
 * is what ends up scrolling.
 *
 * The pulse class set is applied via direct DOM mutation rather than
 * a state-driven rerender, so it works regardless of how the tab
 * structures its rows. Cleaned up after 2.5s, enough for the user's
 * eye to land on it without lingering after they start interacting.
 *
 * Retries on rAF for ~1.5s to handle tabs that fetch their catalog
 * on mount and need a tick for rows to land in the DOM.
 */
function useShopRowFocus(focusKey: string | null | undefined): void {
  useEffect(() => {
    if (!focusKey) return;
    let cancelled = false;
    let attempts = 0;
    let raf = 0;
    function tick(): void {
      if (cancelled) return;
      const el = document.querySelector<HTMLElement>(`[data-shop-row="${CSS.escape(focusKey!)}"]`);
      if (el) { focus(el); return; }
      attempts++;
      if (attempts < 90) raf = requestAnimationFrame(tick);
    }
    function focus(el: HTMLElement): void {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const cls = ["ring-2", "ring-keep-action", "shadow-[0_0_24px_-4px_rgba(255,128,0,0.6)]", "transition-shadow"];
      el.classList.add(...cls);
      window.setTimeout(() => { el.classList.remove(...cls); }, 2500);
    }
    raf = requestAnimationFrame(tick);
    return () => { cancelled = true; cancelAnimationFrame(raf); };
  }, [focusKey]);
}

/* =========================================================
 *  Section 1 (header) + Section 2 (wallets)
 * ========================================================= */

function OverviewTab({ snapshot, flashSale, onNavigate }: {
  snapshot: ReturnType<typeof useEarning.getState>["snapshot"] & {};
  flashSale: FlashSaleResponse | null;
  /** Combined tab + focus-key navigator. Flash Sale cards call this
   *  with both the target tab and the catalog row key the user came
   *  to buy; the receiving tab scrolls that row into view and
   *  briefly highlights it. */
  onNavigate: (tab: DashboardTab, focusKey?: string | null) => void;
}) {
  const masterRank = lookupRankTier(snapshot, snapshot.master.rankKey, snapshot.master.tier);
  // Viewer's actual avatar URL, feeds the Flash Sale border preview
  // so the showcase shows what the border will look like on the
  // user's own portrait instead of a stand-in initials chip (which
  // makes the ring blend into its own backdrop and reads as
  // "inset"). Same source the Borders tab uses.
  //
  // CRITICAL: the lookup MUST filter on (userId, characterId) tuple,
  // not just userId. The occupants cache holds one row per
  // (userId, characterId) tuple, a master with three open tabs
  // voicing OOC, character A, and character B has THREE rows
  // matching `o.userId === me.id`. Iterating `Object.values(...)`
  // without the characterId filter returns the FIRST tuple that
  // happens to land first in the rooms map, which is non-
  // deterministic. That manifested as: a user shopping on OOC
  // (Darkest Thoughts) with another tab parked as Sister_Rosalina
  // (character) seeing Sister_Rosalina's portrait painted onto the
  // OOC dashboard's border previews, and the purchase actually
  // charged from OOC, so the visual identity didn't match the wallet
  // the buy was hitting. Refreshing the tab cleared the cross-tab
  // state and the lookup landed on the right row. Now scoped to
  // (me.id, activeCharacterId) so the lookup ONLY matches the
  // identity this tab is currently voicing.
  const me = useChat((s) => s.me);
  const activeCharacterId = useChat((s) => s.activeCharacterId);
  const viewerAvatarUrl = useChat((s) => {
    if (!me) return null;
    for (const list of Object.values(s.occupants)) {
      const row = list.find((o) => o.userId === me.id && o.characterId === activeCharacterId);
      if (row?.avatarUrl) return row.avatarUrl;
    }
    return null;
  });
  // Zero-state detection: brand-new account, never earned anything,
  // owns nothing. Surfaces an explainer card so the dashboard doesn't
  // read as "everything is empty and I don't know what this is."
  const isFreshAccount =
    snapshot.master.xp === 0 &&
    snapshot.master.currency === 0 &&
    !snapshot.master.rankKey &&
    snapshot.characters.every((c) => c.xp === 0 && c.currency === 0) &&
    snapshot.ownedStyles.length === 0 &&
    snapshot.ownedBorders.length === 0;
  return (
    <div className="space-y-4">
      {/* Hero band, sigil renders LEFT at 11rem so the chevron art
          reads as the primary visual element (the chevron points
          right, so left-aligning it with the identity text to its
          right reads as a single lockup pointing at the user's
          name). Earlier layouts shrank the sigil to 3rem (unreadable
          chevron detail) or stacked it center-aligned above the text
          (broke the chevron's natural direction). The hero variant of
          RankSigil uses the same lookup as the rest of the dashboard
          and self-hides when the user is unranked, in which case the
          band falls back to the initials fallback. */}
      <header className="flex items-center gap-5 rounded border border-keep-rule bg-keep-banner/40 p-4">
        <SigilOrFallback
          url={snapshot.master.sigilImageUrl}
          fallback={snapshot.master.displayName.slice(0, 1).toUpperCase()}
          size="hero"
        />
        <div className="min-w-0 flex-1">
          <div className="font-action text-2xl">{snapshot.master.displayName}</div>
          <div className="mt-1 text-sm uppercase tracking-widest text-keep-muted">
            {masterRank.rank ? `${masterRank.rank.name} ${masterRank.tierRow?.label ?? ""}`.trim() : "No rank yet"}
          </div>
        </div>
      </header>

      {isFreshAccount ? <ZeroStateCard /> : null}

      <FlashSaleSection
        flashSale={flashSale}
        previewName={snapshot.master.displayName}
        previewAvatarUrl={viewerAvatarUrl}
        onNavigate={onNavigate}
      />

      <section>
        <h3 className="mb-2 font-action text-sm uppercase tracking-widest text-keep-muted">Wallets</h3>
        <div className="grid gap-3">
          <PoolCard pool={snapshot.master} snapshot={snapshot} label="Master (OOC)" />
          {snapshot.characters.length > 0 ? (
            snapshot.characters.map((c) => (
              <PoolCard key={c.ownerId} pool={c} snapshot={snapshot} label={c.displayName} />
            ))
          ) : (
            <p className="text-xs text-keep-muted">No character pools yet. Post as a character in chat to start one.</p>
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * Today's flash sale, surfaced on the Overview tab so it's the first
 * thing a user sees when they open Earning. Hides itself entirely
 * when nothing's on sale today (admin disabled every category, or
 * every enabled category had an empty catalog), empty state would
 * read as broken UI, not as "nothing today."
 *
 * The category strip uses the same shape the per-tab shop cards use
 * (avatar/name on the left, base→sale price stacked on the right)
 * so the visual maps cleanly from "see today's pick" → "open
 * Name Styles tab to buy it." Clicking a card jumps to the matching
 * tab; we don't deep-link the row itself because the tab handles
 * its own "active" highlight and re-fetches on entry.
 */
function FlashSaleSection({ flashSale, previewName, previewAvatarUrl, onNavigate }: {
  flashSale: FlashSaleResponse | null;
  previewName: string;
  /** Viewer's actual avatar URL, passed to the border-preview card
   *  so the showcase paints the freeform frame around the user's real
   *  portrait, matching the Borders tab. Null falls back to the
   *  initials-chip path; the ring becomes hard to see without an
   *  opaque inner circle to contrast against. */
  previewAvatarUrl: string | null;
  /** Card-click navigator. Jumps to the matching shop tab AND tells
   *  it which catalog row to focus, so the user lands on the exact
   *  on-sale row instead of the top of a long catalog. */
  onNavigate: (tab: DashboardTab, focusKey?: string | null) => void;
}) {
  type Pick = { kind: "nameStyle" | "item" | "cosmetic" | "freeformBorder"; label: string; pick: FlashSalePick };
  const picks: Pick[] = [];
  if (flashSale?.nameStyle) picks.push({ kind: "nameStyle", label: "Name Style", pick: flashSale.nameStyle });
  if (flashSale?.freeformBorder) picks.push({ kind: "freeformBorder", label: "Border", pick: flashSale.freeformBorder });
  if (flashSale?.item) picks.push({ kind: "item", label: "Item", pick: flashSale.item });
  if (flashSale?.cosmetic) picks.push({ kind: "cosmetic", label: "Cosmetic", pick: flashSale.cosmetic });

  // Hide until the parent fetch lands (avoids a layout pop) and
  // also hide when nothing's on sale.
  if (!flashSale || picks.length === 0) return null;

  // Grid column count tracks the number of picks so a 4-pick day fills
  // the row without leaving a gap. Mobile stays single-column so each
  // card gets enough room for its big preview to breathe.
  const colsClass = picks.length === 1
    ? ""
    : picks.length === 2
      ? "sm:grid-cols-2"
      : picks.length === 3
        ? "sm:grid-cols-2 lg:grid-cols-3"
        : "sm:grid-cols-2 lg:grid-cols-4";

  return (
    <section className="relative overflow-hidden rounded-lg border-2 border-keep-action/60 bg-gradient-to-br from-keep-action/15 via-keep-bg/20 to-keep-bg/40 p-5 shadow-[0_0_28px_-6px_var(--keep-action,rgba(255,128,0,0.45))]">
      {/* Radial glow accent, top-right corner, gives the hero a
          "deal of the day" warmth without the gradient swallowing
          the cards. Decorative, no pointer interaction. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 h-48 w-48 rounded-full bg-keep-action/20 blur-3xl"
      />
      <header className="relative mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {/* Animated lightning bolt, replaces the static `⚡` emoji
              with a strike-from-above loop (streak descends, bolt
              lands with a flash + ground impact, holds with an
              afterglow, resets). Scoped to its own 44px box via
              `.flash-bolt` so the flash overlay never paints outside
              the chip. Honors `prefers-reduced-motion` (handled in
              styles.css). */}
          <span aria-hidden className="flash-bolt">
            <span className="flash-bolt-flash" />
            <span className="flash-bolt-streak" />
            <span className="flash-bolt-glyph">⚡</span>
            <span className="flash-bolt-ground" />
          </span>
          <div>
            <h3 className="font-action text-xl uppercase tracking-widest text-keep-action sm:text-2xl">
              Flash Sale
            </h3>
            <p className="text-[10px] uppercase tracking-widest text-keep-muted">
              {prettyDate(flashSale.forDate)} · Resets at midnight UTC
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-keep-action px-3 py-1 text-[11px] font-black uppercase tracking-widest text-keep-bg shadow-md animate-pulse">
          <span aria-hidden>🔥</span>
          <span>Today Only</span>
        </span>
      </header>
      <div className={`relative grid gap-3 ${colsClass}`}>
        {picks.map(({ kind, label, pick }) => (
          <FlashSaleCard
            key={label}
            kind={kind}
            kindLabel={label}
            pick={pick}
            previewName={previewName}
            previewAvatarUrl={previewAvatarUrl}
            onClick={() => onNavigate(
              kind === "nameStyle" ? "styles"
              : kind === "freeformBorder" ? "borders"
              : kind === "item" ? "items"
              : "cosmetics",
              pick.key,
            )}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * Reusable "ON SALE -N%" badge. Used on shop catalog cards across
 * Name Styles / Cosmetics / Items so the user can see today's
 * discounted rows while browsing, not just on the Overview hero.
 * Returns null when no sale applies, so callers can render it
 * unconditionally without scaffolding `{discount ? ... : null}`.
 */
function SalePip({ discountPct }: { discountPct: number | null | undefined }) {
  if (!discountPct || discountPct <= 0) return null;
  return (
    <span
      title={`${discountPct}% off today only`}
      className="inline-flex items-center gap-0.5 rounded-full bg-keep-action px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-keep-bg"
    >
      <span aria-hidden>🔥</span>
      <span>SALE -{discountPct}%</span>
    </span>
  );
}

/**
 * Price display for a shop card. When the row is on sale, renders the
 * base price struck through next to the discounted sale price in the
 * accent color. When not on sale, falls back to a single CoinAmount
 * matching the previous design. Centralized so every shop catalog
 * (Items / Name Styles / Cosmetics) shows the discount the same way.
 */
function PriceBlock({
  basePrice,
  effectivePrice,
  onSale,
}: {
  basePrice: number;
  effectivePrice: number;
  onSale: boolean;
}) {
  if (!onSale || basePrice === effectivePrice) {
    return <CoinAmount amount={basePrice} className="text-xs uppercase tracking-widest text-keep-muted" />;
  }
  return (
    <span className="inline-flex items-baseline gap-1 text-xs uppercase tracking-widest">
      <span className="text-keep-muted line-through">
        <CoinAmount amount={basePrice} />
      </span>
      <span className="font-semibold text-keep-action">
        <CoinAmount amount={effectivePrice} />
      </span>
    </span>
  );
}

/**
 * Helper that combines a base price with the day's flash-sale snapshot.
 * Returns the effective unit price + the matching discount %, or null
 * when the row isn't on sale today. Pure compute against the cached
 * `flashSale` prop, never re-fetches, so it's cheap to call per row.
 */
function flashSalePriceFor(
  flashSale: FlashSaleResponse | null,
  category: "nameStyle" | "item" | "cosmetic" | "freeformBorder",
  key: string,
  basePrice: number,
): { effectivePrice: number; discountPct: number | null } {
  if (!flashSale) return { effectivePrice: basePrice, discountPct: null };
  const slot = flashSale[category];
  if (!slot || slot.key !== key) return { effectivePrice: basePrice, discountPct: null };
  return { effectivePrice: slot.salePrice, discountPct: slot.discountPct };
}

function FlashSaleCard({
  kind,
  kindLabel,
  pick,
  previewName,
  previewAvatarUrl,
  onClick,
}: {
  kind: "nameStyle" | "item" | "cosmetic" | "freeformBorder";
  kindLabel: string;
  pick: FlashSalePick;
  /** Preview rendering uses the viewer's display name for the
   *  name-style preview so the user can see what it would look like
   *  on their own row. Falls back to "Username" if none is supplied. */
  previewName: string;
  /** Viewer's actual avatar URL for the border preview, null falls
   *  back to the initials chip. Only consumed by the freeformBorder
   *  branch; other kinds ignore it. */
  previewAvatarUrl: string | null;
  /** Card-level click handler, jumps to the matching shop tab. */
  onClick: () => void;
}) {
  // Per-kind preview affordance:
  //   - nameStyle    → render <StyledName> at the pick's key so the
  //                    user sees the actual font/glow rather than an
  //                    icon. Catalog CSS is already injected globally.
  //   - freeformBorder → render a <BorderedAvatar> with the freeform
  //                    key applied so the actual frame is visible at
  //                    a glance.
  //   - cosmetic / item → keep the `iconUrl` thumbnail behavior.
  //
  // All previews share a fixed-height showcase strip (h-28 = 112px)
  // centered horizontally, so the four card types align even when
  // their underlying preview elements differ in intrinsic size.
  // Previously each card used a different preview size which made
  // the row look ragged and the visual hierarchy unclear.
  // Cosmetic-key → emoji fallback when the catalog row has no iconUrl
  // set (most flairs ship as text/config rather than art). Beats the
  // bland "no preview" copy that read as broken UI on the original
  // build.
  const cosmeticFallbackGlyph =
    pick.key === "inline_avatar" ? "🖼️"
    : pick.key === "flair_profile_banner" ? "🪧"
    : pick.key === "flair_typing_phrase" ? "💬"
    : pick.key === "flair_lurking_master" ? "🥷"
    : pick.key === "flair_reaction_sheet" ? "😀"
    : pick.key === "flair_room_presence" ? "🚪"
    : pick.key === "flair_session_presence" ? "✨"
    : pick.key === "flair_profile_visitors" ? "👀"
    : pick.key === "flair_profile_marquee" ? "💭"
    : "🎁";

  const preview = kind === "nameStyle" ? (
    <div className="name-style-preview flex h-full w-full items-center justify-center rounded bg-keep-bg/50 px-4 text-4xl font-bold lg:text-5xl">
      <StyledName displayName={previewName} styleKey={pick.key} config={null} preview />
    </div>
  ) : kind === "freeformBorder" ? (
    <div className="flex h-full w-full items-center justify-center rounded bg-keep-bg/50 py-2">
      <BorderedAvatar
        avatarUrl={previewAvatarUrl}
        name={previewName}
        freeformBorderKey={pick.key}
        size="xl"
        preview
      />
    </div>
  ) : pick.iconUrl ? (
    <div className="flex h-full w-full items-center justify-center rounded bg-keep-bg/50 p-2">
      <img
        src={pick.iconUrl}
        alt=""
        className="h-full w-full object-contain drop-shadow-[0_0_10px_rgba(255,128,0,0.4)]"
      />
    </div>
  ) : (
    <div className="flex h-full w-full items-center justify-center rounded bg-keep-bg/50 text-6xl lg:text-7xl">
      <span aria-hidden className="drop-shadow-[0_0_10px_rgba(255,128,0,0.35)]">{cosmeticFallbackGlyph}</span>
    </div>
  );

  const savings = pick.basePrice - pick.salePrice;

  return (
    <button
      type="button"
      onClick={onClick}
      title={`Open in the ${kindLabel} shop`}
      className="group relative flex flex-col overflow-hidden rounded-lg border border-keep-action/40 bg-gradient-to-b from-keep-bg/80 to-keep-bg/50 text-left transition-all hover:border-keep-action hover:shadow-[0_0_16px_-4px_rgba(255,128,0,0.45)] focus:outline-none focus-visible:ring-2 focus-visible:ring-keep-action"
    >
      {/* Big diagonal discount tag, top-right corner. Bold, high-
          contrast, slightly rotated so it reads as a sticker slapped
          onto the card. Z-index lifts it above the preview's drop
          shadow so it never gets visually buried. */}
      {pick.discountPct != null ? (
        <div className="absolute right-2 top-2 z-10 rounded-md bg-keep-action px-2.5 py-1 text-base font-black uppercase leading-none tracking-tight text-keep-bg shadow-lg ring-2 ring-keep-action/40">
          -{pick.discountPct}%
        </div>
      ) : null}

      {/* Preview strip, fixed height per breakpoint so cards align
          and the showcase art has room to breathe. Mobile keeps it
          modest (128px) so the card stays roughly square; tablet+
          bumps to 160px and desktop to 192px so the actual icons
          fill the showcase rather than rattle around in a too-large
          well. */}
      <div className="h-32 w-full p-2 sm:h-40 lg:h-48">
        {preview}
      </div>

      {/* Info block, kind tag, name, prices, savings line. */}
      <div className="flex flex-1 flex-col gap-1 border-t border-keep-action/20 bg-keep-banner/30 px-3 py-2.5">
        <div className="text-[10px] font-bold uppercase tracking-widest text-keep-action/80">
          {kindLabel}
        </div>
        <div className="truncate text-base font-semibold text-keep-text">{pick.name}</div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-xs text-keep-muted line-through">
            <CoinAmount amount={pick.basePrice} />
          </span>
          <span className="text-xl font-black text-keep-action">
            <CoinAmount amount={pick.salePrice} size="md" />
          </span>
        </div>
        {savings > 0 ? (
          <div className="text-[10px] uppercase tracking-widest text-keep-action/70">
            You save <CoinAmount amount={savings} />
          </div>
        ) : null}
      </div>
    </button>
  );
}

function prettyDate(yyyyMmDd: string): string {
  // Render the ISO date in the viewer's locale without dragging in
  // a date library. "2026-05-27" → "May 27" on en-US, "27 May" on
  // en-GB, locale-respectful without needing the year (it's today).
  const [y, m, d] = yyyyMmDd.split("-").map((n) => Number.parseInt(n, 10));
  if (!y || !m || !d) return yyyyMmDd;
  const dt = new Date(Date.UTC(y, m - 1, d));
  try {
    return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  } catch {
    return yyyyMmDd;
  }
}

/**
 * Welcome / explainer card shown when a fresh account opens the
 * dashboard for the first time and everything is zero. Fades out
 * naturally once any pool earns its first XP.
 *
 * Drops the user onto the "what does this even do" footing without
 * forcing them to leave the modal, the longer-form Earning guide
 * lives in /help → Guides → Earning for anyone who wants more.
 */
function ZeroStateCard() {
  return (
    <section className="rounded border border-keep-action/40 bg-keep-action/5 p-3 text-sm">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="font-action text-base text-keep-action">Welcome to your Earning.</h3>
        <span className="text-[10px] uppercase tracking-widest text-keep-muted">Auto-hides once you earn</span>
      </div>
      <p className="text-keep-text">
        Earning is the long-term reward layer for being part of the community. Two counters
        grow side by side as you participate:
      </p>
      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[12px] text-keep-text">
        <li><b>XP</b> grows your <b>rank</b>, the sigil shown next to your name in chat and the userlist.</li>
        <li><b>Currency</b> goes into your wallet, ready to spend on name styles, avatar borders, and other cosmetics here in the dashboard.</li>
      </ul>
      <p className="mt-2 text-keep-text">You earn both at the same time from:</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12px] text-keep-text">
        <li>Chat messages (long enough to be meaningful, a single "ok" doesn't count)</li>
        <li>Forum topics and replies</li>
        <li>Being active in a room (we award a small amount every few minutes you're present)</li>
      </ul>
      <p className="mt-2 text-[11px] text-keep-muted">
        Just chat normally. You'll see your first rank within a session or two. The Help modal's
        Earning guide has the full picture if you want more.
      </p>
    </section>
  );
}

function SigilOrFallback({
  url,
  fallback,
  size = "default",
}: {
  url: string | null;
  fallback: string;
  /**
   * `default` (h-12 w-12) is the legacy size used by the lower
   * cards. `hero` (h-44 ~= 11rem) is the dashboard's left-aligned
   * rank lockup at the top of the modal, sized large enough that
   * the chevron art reads clearly. Add new entries here rather than
   * inlining classNames at call sites so the dashboard's sigil
   * sizing stays in one place.
   */
  size?: "default" | "hero";
}) {
  const dims = size === "hero" ? "h-44 w-44" : "h-12 w-12";
  const textSize = size === "hero" ? "text-5xl" : "text-base";
  if (url) {
    return (
      <img
        src={url}
        alt=""
        className={`${dims} shrink-0 select-none`}
        draggable={false}
        // onError fallback: a bad URL (admin uploaded then deleted the
        // file, asset rename in flight) shouldn't leave a broken image
        // icon. Swap to the text fallback by setting display: none and
        // letting the sibling render, done inline via a CSS handle.
        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
      />
    );
  }
  return (
    <div className={`flex ${dims} shrink-0 items-center justify-center rounded-full border border-keep-rule bg-keep-bg/70 ${textSize} font-action uppercase`}>
      {fallback}
    </div>
  );
}

function PoolCard({ pool, snapshot, label }: { pool: PoolView; snapshot: ReturnType<typeof useEarning.getState>["snapshot"] & {}; label: string }) {
  const progress = useMemo(() => progressToNextTier(snapshot, pool), [snapshot, pool]);
  const { rank, tierRow } = lookupRankTier(snapshot, pool.rankKey, pool.tier);
  const hideCurrency = pool.scope === "user" && pool.hideCurrencyCount;
  return (
    <div className="rounded border border-keep-rule bg-keep-bg/40 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-semibold">{label}</span>
        <span className="text-xs uppercase tracking-widest text-keep-muted">
          {rank ? `${rank.name} ${tierRow?.label ?? ""}`.trim() : "Unranked"}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span>
          <span className="font-action text-lg">{pool.xp.toLocaleString()}</span>
          <span className="ml-1 text-xs uppercase tracking-widest text-keep-muted">XP</span>
        </span>
        <span>
          <span className="font-action text-lg">{pool.currency.toLocaleString()}</span>
          <span className="ml-1 text-xs uppercase tracking-widest text-keep-muted">
            Currency{hideCurrency ? " · private" : ""}
          </span>
        </span>
      </div>
      {progress ? (
        <div className="mt-2">
          <div className="h-1.5 w-full overflow-hidden rounded bg-keep-rule/40">
            <div
              className="h-full bg-keep-action"
              style={{ width: `${Math.round(progress.pct * 100)}%` }}
            />
          </div>
          <div className="mt-1 flex justify-between text-[10px] uppercase tracking-widest text-keep-muted">
            <span>{progress.inTier.toLocaleString()} / {progress.tierSpan.toLocaleString()}</span>
            <span>→ {progress.nextLabel ?? "Top of ladder"}</span>
          </div>
        </div>
      ) : (
        <div className="mt-2 text-[10px] uppercase tracking-widest text-keep-muted">
          Top of the ladder.
        </div>
      )}
    </div>
  );
}

/* =========================================================
 *  Rankings tab, public leaderboards across the nine boards
 *
 *  Fetches /earning/rankings on mount, paints:
 *    1. A rotating "Spotlight" hero at the top, auto-cycles
 *       through each board's #1 entry every 5 seconds.
 *    2. A grid of board cards underneath, each showing the
 *       board's top N entries as RankingEntryCard rows.
 *
 *  Clicking any entry opens that user's profile via the chat
 *  store's `setOpenProfile`, same path the userlist click uses,
 *  so the rankings act as a profile-discovery surface.
 * ========================================================= */

function RankingsTab({ initialBoard }: { initialBoard?: RankingBoardKey }) {
  const [data, setData] = useState<RankingsResponse | null>(null);
  const [gameData, setGameData] = useState<GameRankingsResponse | null>(null);
  const [familiarData, setFamiliarData] = useState<FamiliarRankingsResponse | null>(null);
  const [scriptoriumData, setScriptoriumData] = useState<ScriptoriumRankingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Deep-link: once the boards have rendered, scroll to + briefly flash
  // the board a {ranking:<board>} chip targeted. Direct DOM (mirrors the
  // help-guide jump) so it works inside the modal's own scroll pane.
  useEffect(() => {
    if (!initialBoard || !data) return;
    const el = document.getElementById(`ranking-board-${initialBoard}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.add("tk-ranking-flash");
    const t = window.setTimeout(() => el.classList.remove("tk-ranking-flash"), 1600);
    return () => window.clearTimeout(t);
  }, [initialBoard, data]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Game rankings load alongside the main pool boards. A failure
    // on the game-rankings fetch shouldn't block the main board
    // render, so it's caught separately and rendered as a soft
    // "no data" later. The pool-board fetch failing is still a
    // hard error because the page is mostly empty without it.
    Promise.all([
      fetchRankings(),
      fetchGameRankings().catch(() => null),
      fetchFamiliarRankings().catch(() => null),
      fetchScriptoriumRankings().catch(() => null),
    ])
      .then(([r, g, f, s]) => {
        if (cancelled) return;
        setData(r);
        setGameData(g);
        setFamiliarData(f);
        setScriptoriumData(s);
      })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load rankings"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  if (loading) return <p className="text-sm text-keep-muted">Loading rankings…</p>;
  if (err) return <p className="text-sm text-keep-accent">{err}</p>;
  if (!data) return <p className="text-sm text-keep-muted">No rankings available.</p>;
  return (
    <div className="space-y-6">
      <RankingsSpotlight champions={data.champions} />
      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {data.boards.map((board) =>
          board.entries.length > 0 ? <RankingBoardCard key={board.key} board={board} /> : null,
        )}
      </div>
      {gameData && (gameData.games.length > 0 || gameData.overall.length > 0) ? (
        <GameRankingsSection data={gameData} />
      ) : null}
      {familiarData && (familiarData.byLevel.length > 0 || familiarData.byAge.length > 0 || familiarData.byStreak.length > 0 || familiarData.byHealth.length > 0) ? (
        <FamiliarRankingsSection data={familiarData} />
      ) : null}
      {scriptoriumData && (
        scriptoriumData.authorBoards.some((b) => b.entries.length > 0) ||
        scriptoriumData.bookBoards.some((b) => b.entries.length > 0)
      ) ? (
        <ScriptoriumRankingsSection data={scriptoriumData} />
      ) : null}
    </div>
  );
}

/**
 * Scriptorium leaderboards — AUTHOR boards (Top Publishers / Most Words) rank
 * writing identities and reuse the shared entry renderer; BOOK boards (Top
 * Books / Highest Rated) rank the books themselves with a cover tile that opens
 * the reader. Auto-populates from published stories; no registration step.
 */
function ScriptoriumRankingsSection({ data }: { data: ScriptoriumRankingsResponse }) {
  const authorBoards = data.authorBoards.filter((b) => b.entries.length > 0);
  const bookBoards = data.bookBoards.filter((b) => b.entries.length > 0);
  return (
    <section className="space-y-3">
      <header className="flex items-baseline justify-between">
        <h3 className="font-action text-base">Scriptorium Rankings</h3>
        <span className="text-[10px] uppercase tracking-widest text-keep-muted">Books & Authors</span>
      </header>
      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {authorBoards.map((b) => (
          <section key={b.key} className="rounded border border-keep-rule bg-keep-bg/40 p-3">
            <header className="mb-2 flex items-baseline justify-between">
              <h4 className="font-action text-sm uppercase tracking-widest text-keep-muted">{b.label}</h4>
              <span className="text-[10px] uppercase tracking-widest text-keep-muted">{b.metric}</span>
            </header>
            <ol className="space-y-1.5">
              {b.entries.map((e, i) => (
                <li key={`${e.scope}::${e.ownerId}`}>
                  <RankingEntryCard rank={i + 1} entry={e} metric={b.metric} />
                </li>
              ))}
            </ol>
          </section>
        ))}
        {bookBoards.map((b) => (
          <section key={b.key} className="rounded border border-keep-rule bg-keep-bg/40 p-3">
            <header className="mb-2 flex items-baseline justify-between">
              <h4 className="font-action text-sm uppercase tracking-widest text-keep-muted">{b.label}</h4>
              <span className="text-[10px] uppercase tracking-widest text-keep-muted">{b.metric}</span>
            </header>
            <ol className="space-y-1.5">
              {b.entries.map((r, i) => (
                <li key={r.storyId}>
                  <BookRankingEntry rank={i + 1} book={r} boardKey={b.key} />
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </section>
  );
}

/** A book-board row: rank pill + cover thumbnail + title/author + metric. The
 *  whole row opens the story in the reader (via the store bridge). */
function BookRankingEntry({ rank, book, boardKey }: { rank: number; book: ScriptoriumBookRow; boardKey: "applause" | "rated" }) {
  const setOpenStoryReader = useChat((s) => s.setOpenStoryReader);
  const byline = book.author.characterName ?? book.author.masterUsername;
  const primary = boardKey === "rated"
    ? (book.avgRating != null ? `${book.avgRating.toFixed(1)}★` : "—")
    : book.applauseCount.toLocaleString();
  const primaryLabel = boardKey === "rated" ? `${book.reviewCount} reviews` : "applause";
  return (
    <button
      type="button"
      onClick={() => setOpenStoryReader(book.storyId)}
      title={`Read "${book.title}"`}
      className="flex w-full items-center gap-2 rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-1.5 text-left hover:border-keep-action/40"
    >
      <div className={`w-6 shrink-0 text-center font-bold tabular-nums ${rank <= 3 ? "text-keep-action" : "text-keep-muted"}`}>{rank}</div>
      <div className="h-10 w-7 shrink-0 overflow-hidden rounded-sm border border-keep-rule/60 bg-keep-panel/60">
        {book.coverImageUrl ? (
          <img src={book.coverImageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[12px] text-keep-muted">📖</div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{book.title}</div>
        <div className="truncate text-[10px] uppercase tracking-wide text-keep-muted">by {byline}</div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-sm font-semibold tabular-nums">{primary}</div>
        <div className="text-[10px] uppercase tracking-widest text-keep-muted">{primaryLabel}</div>
      </div>
    </button>
  );
}

/**
 * Eidolon Tamer leaderboards — four boards (level / eldest / longest streak /
 * best-kept) that auto-populate from any hatched familiar. Living familiars
 * rank above dormant ones (which carry a 💤 badge).
 */
function FamiliarRankingsSection({ data }: { data: FamiliarRankingsResponse }) {
  const allBoards: Array<{ key: string; label: string; rows: FamiliarRankingRow[]; metric: (r: FamiliarRankingRow) => number; unit: string }> = [
    { key: "level", label: "Highest Level", rows: data.byLevel, metric: (r: FamiliarRankingRow) => r.level, unit: "level" },
    { key: "age", label: "Eldest", rows: data.byAge, metric: (r: FamiliarRankingRow) => Math.floor(r.ageHours / 24), unit: "days" },
    { key: "streak", label: "Longest Streak", rows: data.byStreak, metric: (r: FamiliarRankingRow) => r.bestStreak, unit: "day streak" },
    { key: "health", label: "Best-Kept", rows: data.byHealth, metric: (r: FamiliarRankingRow) => Math.round(r.health), unit: "health" },
  ];
  const boards = allBoards.filter((b) => b.rows.length > 0);
  if (boards.length === 0) return null;
  return (
    <section className="space-y-3">
      <header className="flex items-baseline justify-between">
        <h3 className="font-action text-base">Familiar Rankings</h3>
        <span className="text-[10px] uppercase tracking-widest text-keep-muted">Eidolon Tamer</span>
      </header>
      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {boards.map((b) => (
          <section key={b.key} className="rounded border border-keep-rule bg-keep-bg/40 p-3">
            <header className="mb-2 flex items-baseline justify-between">
              <h4 className="font-action text-sm uppercase tracking-widest text-keep-muted">{b.label}</h4>
              <span className="text-[10px] uppercase tracking-widest text-keep-muted">{b.unit}</span>
            </header>
            <ol className="space-y-1.5">
              {b.rows.map((r, i) => (
                <li key={`${r.ownerScope}::${r.ownerId}`}>
                  <FamiliarRankingEntry rank={i + 1} entry={r} primary={b.metric(r)} primaryLabel={b.unit} />
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </section>
  );
}

function FamiliarRankingEntry({ rank, entry, primary, primaryLabel }: { rank: number; entry: FamiliarRankingRow; primary: number; primaryLabel: string }) {
  return (
    <div className="flex items-center gap-2 rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-1.5 hover:border-keep-action/40">
      <div className={`w-6 shrink-0 text-center font-bold tabular-nums ${rank <= 3 ? "text-keep-action" : "text-keep-muted"}`}>{rank}</div>
      <ProfileLinkAvatar entry={entry} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="min-w-0 overflow-clip whitespace-nowrap text-ellipsis text-sm font-semibold [overflow-clip-margin:1.75em]">
          <StyledEntryName entry={entry} />
        </div>
        <div className="truncate text-[10px] uppercase tracking-wide text-keep-muted">
          {entry.dead ? "💤 " : "🥚 "}{entry.familiarName}
          {entry.kind === "pet" ? " · pet" : entry.speciesId ? ` · ${entry.speciesId}` : ""}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-sm font-semibold tabular-nums">{primary.toLocaleString()}</div>
        <div className="text-[10px] uppercase tracking-widest text-keep-muted">{primaryLabel}</div>
      </div>
    </div>
  );
}

/**
 * Per-social-game leaderboards. Rendered below the main earning
 * boards in the Rankings tab. Shows one card per game kind plus an
 * "overall" card aggregating wins across all games.
 *
 * The set of games comes from the API at read time, so a newly
 * added social game appears here the moment its first winner is
 * recorded; no UI registration step is needed.
 */
function GameRankingsSection({ data }: { data: GameRankingsResponse }) {
  return (
    <section className="space-y-3">
      <header className="flex items-baseline justify-between">
        <h3 className="font-action text-base">Social Game Rankings</h3>
        <span className="text-[10px] uppercase tracking-widest text-keep-muted">
          {data.games.length} {data.games.length === 1 ? "game" : "games"} tracked
        </span>
      </header>
      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {data.overall.length > 0 ? <OverallGameBoardCard rows={data.overall} /> : null}
        {data.games.map((g) => (
          <PerGameBoardCard key={g.gameKind} gameKind={g.gameKind} label={g.label} rows={g.leaderboard} />
        ))}
      </div>
    </section>
  );
}

function OverallGameBoardCard({ rows }: { rows: OverallRankingRow[] }) {
  return (
    <section className="rounded border border-keep-action/40 bg-gradient-to-br from-keep-action/10 to-keep-bg/40 p-3">
      <header className="mb-2 flex items-baseline justify-between">
        <h4 className="font-action text-sm uppercase tracking-widest text-keep-action">All Games</h4>
        <span className="text-[10px] uppercase tracking-widest text-keep-muted">total wins</span>
      </header>
      <ol className="space-y-1.5">
        {rows.map((r, i) => (
          <li key={`${r.ownerScope}::${r.ownerId}`}>
            <GameRankingEntry rank={i + 1} entry={r} primary={r.totalWins} primaryLabel="wins" secondary={r.totalPoints > r.totalWins ? r.totalPoints : null} secondaryLabel="points" />
          </li>
        ))}
      </ol>
    </section>
  );
}

function PerGameBoardCard({ gameKind, label, rows }: { gameKind: string; label: string; rows: GameRankingRow[] }) {
  return (
    <section className="rounded border border-keep-rule bg-keep-bg/40 p-3">
      <header className="mb-2 flex items-baseline justify-between">
        <h4 className="font-action text-sm uppercase tracking-widest text-keep-muted">{label}</h4>
        <span className="text-[10px] uppercase tracking-widest text-keep-muted">{gameKind}</span>
      </header>
      <ol className="space-y-1.5">
        {rows.map((r, i) => (
          <li key={`${r.ownerScope}::${r.ownerId}`}>
            <GameRankingEntry
              rank={i + 1}
              entry={r}
              primary={r.wins}
              primaryLabel={r.wins === 1 ? "win" : "wins"}
              secondary={r.points > r.wins ? r.points : null}
              secondaryLabel="points"
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

function GameRankingEntry({
  rank,
  entry,
  primary,
  primaryLabel,
  secondary,
  secondaryLabel,
}: {
  rank: number;
  /** A game-ranking row: the cosmetic display fields the avatar +
   *  styled-name renderers read, plus the owner scope + optional rank
   *  name for the subtitle. Mirrors RankingEntryCard's row look. */
  entry: RankingDisplayEntry & { ownerScope: "user" | "character"; rankName: string | null };
  primary: number;
  primaryLabel: string;
  secondary: number | null;
  secondaryLabel: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-1.5 hover:border-keep-action/40">
      <div className={`w-6 shrink-0 text-center font-bold tabular-nums ${rank <= 3 ? "text-keep-action" : "text-keep-muted"}`}>
        {rank}
      </div>
      <ProfileLinkAvatar entry={entry} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="min-w-0 overflow-clip whitespace-nowrap text-ellipsis text-sm font-semibold [overflow-clip-margin:1.75em]">
          <StyledEntryName entry={entry} />
        </div>
        {entry.ownerScope === "character" || entry.rankName ? (
          <div className="truncate text-[10px] uppercase tracking-wide text-keep-muted">
            {entry.ownerScope === "character" ? <span>character</span> : null}
            {entry.ownerScope === "character" && entry.rankName ? <span> · </span> : null}
            {entry.rankName ?? null}
          </div>
        ) : null}
      </div>
      <div className="shrink-0 text-right">
        <div className="text-sm font-semibold tabular-nums">{primary.toLocaleString()}</div>
        <div className="text-[10px] uppercase tracking-widest text-keep-muted">{primaryLabel}</div>
        {secondary !== null ? (
          <div className="text-[10px] text-keep-muted">{secondary.toLocaleString()} {secondaryLabel}</div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Spotlight hero, large card that rotates through each board's
 * champion every 5 seconds. Pauses on hover so a viewer who wants
 * to read the current entry's tagline isn't yanked away mid-read.
 *
 * Renders the entry as a big bordered avatar + styled name with
 * the board label + metric prominent. Clicking opens the profile.
 */
function RankingsSpotlight({ champions }: { champions: RankingChampion[] }) {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (champions.length === 0 || paused) return;
    const id = window.setInterval(() => {
      setIdx((i) => (i + 1) % champions.length);
    }, 5000);
    return () => window.clearInterval(id);
  }, [champions.length, paused]);
  // Reset to slot 0 when the champion list changes (refresh / nav).
  useEffect(() => { setIdx(0); }, [champions.length]);
  if (champions.length === 0) {
    return null;
  }
  const cur = champions[Math.min(idx, champions.length - 1)]!;
  return (
    <section
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className="relative rounded border border-keep-action/40 bg-gradient-to-br from-keep-action/10 to-keep-bg/40 p-4"
    >
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="font-action text-sm uppercase tracking-widest text-keep-action">Spotlight</h3>
        <div className="flex items-center gap-1.5">
          {champions.map((c, i) => (
            <button
              key={c.boardKey}
              type="button"
              onClick={() => setIdx(i)}
              aria-label={`Show ${c.boardLabel} champion`}
              className={`h-1.5 rounded-full transition-all ${i === idx ? "w-6 bg-keep-action" : "w-1.5 bg-keep-rule hover:bg-keep-muted"}`}
            />
          ))}
        </div>
      </div>
      <div className="flex flex-col items-center gap-3 text-center sm:flex-row sm:gap-5 sm:text-left">
        {/* `key` tied to the champion pool id forces a full remount of
            the avatar on rotation. Without this, React reuses the
            BorderedAvatar instance and only swaps the template HTML
            via dangerouslySetInnerHTML, the simultaneous inline
            `<style>` update + innerHTML swap can leave the .av spin
            and .pic counter-rotation momentarily desynced, which
            visually reads as the avatar IMG spinning until the
            counter-rotation re-aligns. Remount guarantees both
            animations start at t=0 together. */}
        <ProfileLinkAvatar
          key={`${cur.entry.scope}::${cur.entry.ownerId}`}
          entry={cur.entry}
          size="xl"
        />
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-widest text-keep-muted">
            #1 · {cur.boardLabel}
          </div>
          <div className="mt-1 text-2xl font-bold leading-tight">
            <StyledEntryName entry={cur.entry} />
          </div>
          {cur.entry.rankName ? (
            <div className="mt-1 text-xs text-keep-muted">
              {cur.entry.rankName}
              {cur.entry.tierLabel ? <span> · {cur.entry.tierLabel}</span> : null}
              {cur.entry.scope === "character" ? <span> · character</span> : null}
            </div>
          ) : null}
          <div className="mt-2 text-base text-keep-text">
            <span className="font-semibold tabular-nums">{cur.entry.value.toLocaleString()}</span>
            <span className="ml-1.5 text-xs uppercase tracking-widest text-keep-muted">{cur.boardMetric}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Rendered grid card for a single leaderboard. Header strip names
 *  the board + its metric; the body lists the entries top-down. */
function RankingBoardCard({ board }: { board: RankingBoard }) {
  return (
    <section id={`ranking-board-${board.key}`} className="rounded border border-keep-rule bg-keep-bg/40 p-3 scroll-mt-2">
      <header className="mb-2 flex items-baseline justify-between">
        <h4 className="font-action text-sm uppercase tracking-widest text-keep-muted">{board.label}</h4>
        <span className="text-[10px] uppercase tracking-widest text-keep-muted">{board.metric}</span>
      </header>
      <ol className="space-y-1.5">
        {board.entries.map((e, i) => (
          <li key={`${e.scope}::${e.ownerId}`}>
            <RankingEntryCard rank={i + 1} entry={e} metric={board.metric} />
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Single ranking row, rank pill + avatar (with effects) + styled
 *  name + metric value. The whole row is a profile-open click target. */
function RankingEntryCard({ rank, entry, metric }: { rank: number; entry: RankingPoolEntry; metric: string }) {
  return (
    <div className="flex items-center gap-2 rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-1.5 hover:border-keep-action/40">
      <div className={`w-6 shrink-0 text-center font-bold tabular-nums ${rank <= 3 ? "text-keep-action" : "text-keep-muted"}`}>
        {rank}
      </div>
      <ProfileLinkAvatar entry={entry} size="sm" />
      <div className="min-w-0 flex-1">
        {/* `overflow-clip` + a 1.75em margin matches the userlist's
            UserNameTag pattern: still ellipsizes long names, but the
            margin lets glow / drop-shadow / pseudo-element decoration
            from the name style render past the box edge instead of
            being chopped at the text baseline. Plain `truncate`
            (overflow:hidden) clipped the Synthwave glow off mid-stroke. */}
        <div className="min-w-0 overflow-clip whitespace-nowrap text-ellipsis text-sm font-semibold [overflow-clip-margin:1.75em]">
          <StyledEntryName entry={entry} />
        </div>
        {entry.scope === "character" || entry.rankName ? (
          <div className="truncate text-[10px] uppercase tracking-wide text-keep-muted">
            {entry.scope === "character" ? <span>character</span> : null}
            {entry.scope === "character" && entry.rankName ? <span> · </span> : null}
            {entry.rankName ?? null}
          </div>
        ) : null}
      </div>
      <div className="shrink-0 text-right">
        <div className="text-sm font-semibold tabular-nums">{entry.value.toLocaleString()}</div>
        <div className="text-[10px] uppercase tracking-widest text-keep-muted">{metric}</div>
      </div>
    </div>
  );
}

/** Avatar with cosmetic context (border + freeform config) that
 *  opens the entry's profile on click. Mirrors the userlist's
 *  click-to-profile affordance using the chat store's setOpenProfile. */
function ProfileLinkAvatar({ entry, size }: { entry: RankingDisplayEntry; size: "sm" | "xl" }) {
  const setOpenProfile = useChat((s) => s.setOpenProfile);
  const freeformConfig = useMemo(() => {
    const json = entry.freeformBorderConfigJson;
    if (!json) return null;
    const parsed = parseFreeformBorderConfig(json);
    return Object.keys(parsed).length > 0 ? parsed : null;
  }, [entry.freeformBorderConfigJson]);
  async function openProfile() {
    try {
      const r = await fetch(`/profiles/${encodeURIComponent(entry.displayName)}`, { credentials: "include" });
      if (!r.ok) return;
      const j = await r.json();
      if (j && "kind" in j) setOpenProfile(j);
    } catch { /* network blip, silent */ }
  }
  return (
    <BorderedAvatar
      avatarUrl={entry.avatarUrl}
      name={entry.displayName}
      borderRankKey={entry.borderRankKey}
      freeformBorderKey={entry.freeformBorderKey}
      freeformConfig={freeformConfig}
      size={size}
      onClick={() => void openProfile()}
      title={`View ${entry.displayName}'s profile`}
    />
  );
}

/** Render an entry's display name with their active name-style
 *  applied. Falls back to a plain span when no style is equipped. */
function StyledEntryName({ entry }: { entry: RankingDisplayEntry }) {
  const config = useMemo<Record<string, unknown> | null>(() => {
    if (!entry.nameStyleConfigJson) return null;
    try { return JSON.parse(entry.nameStyleConfigJson) as Record<string, unknown>; }
    catch { return null; }
  }, [entry.nameStyleConfigJson]);
  if (!entry.activeNameStyleKey) {
    return <span>{entry.displayName}</span>;
  }
  return (
    <StyledName
      displayName={entry.displayName}
      styleKey={entry.activeNameStyleKey}
      config={config}
    />
  );
}

/* =========================================================
 *  Section 3, Activity ledger
 * ========================================================= */

function LedgerTab({
  characters,
  itemCatalog,
}: {
  characters: Array<{ id: string; name: string }>;
  /** Item rows from the live catalog snapshot. Indexed by key for
   *  the metadata-aware ledger formatter so a "command_give_received"
   *  entry renders as "Received 2 × Cookie from WAS" instead of the
   *  bare opaque reason code. */
  itemCatalog: ItemCatalogRow[];
}) {
  // Memoize the catalog index so formatLedgerEntry's per-row lookup
  // is O(1) instead of an array.find() per render.
  const itemByKey = useMemo(
    () => new Map(itemCatalog.map((i) => [i.key, { name: i.name, namePlural: i.namePlural }])),
    [itemCatalog],
  );
  const [scope, setScope] = useState<{ kind: "user" } | { kind: "character"; id: string; name: string }>({ kind: "user" });
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // Live tick from the earning store. Bumps every time the socket
  // delivers an `earning:earned` event. The fetch effect below uses
  // it as a dep so the feed catches up to new ledger rows without a
  // manual reload, previously the activity log silently froze at
  // whatever was there when the dashboard was first opened.
  const earnedTick = useEarning((s) => s.earnedTick);

  // Re-fetch from scratch whenever scope changes OR a new credit
  // lands. Scope changes reset the cursor + clear the list; a live
  // tick refetches the first page in place so the user keeps their
  // scroll position (the upstream limit is small enough that the
  // newest credit will land in the first page).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    // Only blank the visible list on a SCOPE change, a live-tick
    // refetch keeps the previous page mounted so the user doesn't
    // see a flash of empty between credits.
    if (cursor === null) {
      setEntries([]);
    }
    fetchEarningLedger({
      scope: scope.kind,
      characterId: scope.kind === "character" ? scope.id : null,
    })
      .then((page) => {
        if (cancelled) return;
        setEntries(page.entries);
        setCursor(page.nextCursor);
        setDone(page.nextCursor === null);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load activity");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
    // `cursor` intentionally NOT a dep, loadMore drives pagination
    // and would otherwise re-trigger this effect into an infinite
    // refetch loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, earnedTick]);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const page = await fetchEarningLedger({
        scope: scope.kind,
        characterId: scope.kind === "character" ? scope.id : null,
        cursor,
      });
      setEntries((cur) => [...cur, ...page.entries]);
      setCursor(page.nextCursor);
      setDone(page.nextCursor === null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load more");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-widest text-keep-muted">Scope:</span>
        <button
          type="button"
          onClick={() => setScope({ kind: "user" })}
          className={`rounded border border-keep-rule px-2 py-0.5 text-xs ${scope.kind === "user" ? "bg-keep-bg" : "bg-keep-banner/40 hover:bg-keep-banner"}`}
        >
          Master
        </button>
        {characters.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setScope({ kind: "character", id: c.id, name: c.name })}
            className={`rounded border border-keep-rule px-2 py-0.5 text-xs ${scope.kind === "character" && scope.id === c.id ? "bg-keep-bg" : "bg-keep-banner/40 hover:bg-keep-banner"}`}
          >
            {c.name}
          </button>
        ))}
      </div>

      {err ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-sm text-keep-accent">{err}</div>
      ) : null}

      {entries.length === 0 && !loading ? (
        <p className="text-sm text-keep-muted">No activity yet.</p>
      ) : null}

      <ul className="divide-y divide-keep-rule/40 rounded border border-keep-rule bg-keep-bg/30">
        {entries.map((e) => (
          <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <div>{formatLedgerEntry(e, itemByKey)}</div>
              <div className="text-[10px] uppercase tracking-widest text-keep-muted">
                {new Date(e.createdAt).toLocaleString()}
              </div>
            </div>
            <div className="shrink-0 text-right">
              {e.xpDelta !== 0 ? (
                <div className={e.xpDelta > 0 ? "text-keep-system" : "text-keep-accent"}>
                  {e.xpDelta > 0 ? "+" : ""}{e.xpDelta} XP
                </div>
              ) : null}
              {e.currencyDelta !== 0 ? (
                <div className={e.currencyDelta > 0 ? "text-keep-system" : "text-keep-accent"}>
                  {e.currencyDelta > 0 ? "+" : ""}{e.currencyDelta} Currency
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {!done ? (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loading || cursor === null}
          className="rounded border border-keep-rule bg-keep-bg px-3 py-1 text-sm disabled:opacity-50 hover:bg-keep-banner"
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </div>
  );
}

/* =========================================================
 *  Section 7, Settings (privacy toggle)
 * ========================================================= */

function SettingsTab({ snapshot, myId }: { snapshot: ReturnType<typeof useEarning.getState>["snapshot"] & {}; myId: string | null }) {
  // Both privacy flags share one save handler, patchEarningSettings
  // accepts either or both. We track them locally so the user can
  // toggle without each click round-tripping through the snapshot
  // refetch (which would briefly flicker the checkbox).
  const [hideCurrency, setHideCurrency] = useState<boolean>(!!snapshot.master.hideCurrencyCount);
  const [hideXp, setHideXp] = useState<boolean>(!!snapshot.master.hideXpCount);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const refresh = useEarning((s) => s.refresh);

  async function save(kind: "currency" | "xp", next: boolean) {
    if (kind === "currency") setHideCurrency(next); else setHideXp(next);
    setSaving(true);
    setErr(null);
    try {
      await patchEarningSettings(
        kind === "currency" ? { hideCurrencyCount: next } : { hideXpCount: next },
      );
      setSavedFlash(true);
      void refresh();
      window.setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
      // Revert optimistic state on failure.
      if (kind === "currency") setHideCurrency(!next); else setHideXp(!next);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 max-w-lg">
      <section>
        <h3 className="mb-2 font-action text-sm uppercase tracking-widest text-keep-muted">Privacy</h3>
        <p className="mb-2 text-xs text-keep-muted">
          Rank, tier, and sigil are always visible, rank is a public identity tag. XP and Currency
          totals are hidden independently when their respective toggle is on.
        </p>
        <label className="mb-2 flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={hideCurrency}
            disabled={saving}
            onChange={(e) => void save("currency", e.target.checked)}
          />
          <span>
            <span className="font-semibold">Hide my Currency from other users</span>
            <br />
            <span className="text-xs text-keep-muted">
              Other people see "private" instead of your Currency total in <code>/currency {snapshot.master.displayName}</code> and on your public profile.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={hideXp}
            disabled={saving}
            onChange={(e) => void save("xp", e.target.checked)}
          />
          <span>
            <span className="font-semibold">Hide my XP from other users</span>
            <br />
            <span className="text-xs text-keep-muted">
              Other people see "private" instead of your XP total on your profile and in <code>/exp {snapshot.master.displayName}</code>.
            </span>
          </span>
        </label>
        {err ? (
          <div className="mt-2 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{err}</div>
        ) : null}
        {savedFlash ? (
          <div className="mt-2 text-xs text-keep-system">Saved.</div>
        ) : null}
      </section>

      {/* Display + per-metric privacy. Identical UI to the Profile
          Editor's Privacy tab, the component is shared from
          [DisplayPrivacyRow.tsx](./DisplayPrivacyRow.tsx) so the two
          surfaces stay in 1:1 parity. The user asked for the toggles
          to live in BOTH the Earning Modal Settings AND Profile
          Privacy without drift; sharing the component is the only
          way to guarantee that copy edits, new fields, and bug
          fixes propagate to both at once. */}
      <DisplayPrivacyRow />

      {myId === snapshot.master.ownerId ? (
        <section>
          <h3 className="mb-2 font-action text-sm uppercase tracking-widest text-keep-muted">Slash commands</h3>
          <ul className="space-y-1 text-sm">
            <li><code>/currency</code>, show your wallets</li>
            <li><code>/currency [user]</code>, look up another user's Currency (honors their privacy)</li>
            <li><code>/currency send [target] [amount]</code>, transfer Currency to a user or character</li>
            <li><code>/exp</code>, show your XP, rank, and any borders you can buy</li>
            <li><code>/exp [user]</code>, look up another user's rank</li>
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/* =========================================================
 *  Phase 3/4 stub tabs
 * ========================================================= */

function StubTab({ title, phase }: { title: string; phase: string }) {
  return (
    <div className="rounded border border-keep-rule bg-keep-bg/40 p-4 text-sm text-keep-muted">
      <p className="font-semibold text-keep-text">{title}</p>
      <p className="mt-1">Coming in {phase}. The data plumbing is already in place, only the buy / equip UI is pending.</p>
    </div>
  );
}

/* =========================================================
 *  Section 4, Name Styles
 *
 *  Three tabs by ownership state:
 *    Owned    , the user owns these. Equip / unequip + per-style
 *                color picker. Live preview against the user's
 *                own display name.
 *    Available, enabled catalog styles the user doesn't own yet.
 *                Shows the buy button + cost.
 *    Locked   , placeholder for future "earn-only" gating. Empty
 *                in Phase 3 (every style is buyable).
 * ========================================================= */

function NameStylesTab({ snapshot, flashSale, focusKey }: {
  snapshot: ReturnType<typeof useEarning.getState>["snapshot"] & {};
  flashSale: FlashSaleResponse | null;
  focusKey: string | null;
}) {
  useShopRowFocus(focusKey);
  const me = useChat((s) => s.me);
  // The tab's equip / unequip writes scope to the user's CURRENTLY
  // ACTIVE identity (master/OOC when no character is selected;
  // otherwise that character). Reading the active character id from
  // the chat store keeps the dashboard in lockstep with whatever
  // identity the user is voicing, switching characters via /char
  // re-keys this tab to that character's owned/equipped state.
  const activeCharacterId = useChat((s) => s.activeCharacterId);
  const refresh = useEarning((s) => s.refresh);
  const [tab, setTab] = useState<"owned" | "available">("owned");
  const [err, setErr] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const styles = snapshot.catalog.nameStyles;
  // Owned list for the CURRENT identity (master = `ownedStyles`,
  // character = `ownedStylesByCharacter[id]`). Each identity owns
  // separately since migration 0086, a master who bought Embers
  // does NOT make their characters own it; characters have to buy
  // from their own pool.
  const ownedStylesForIdentity = useMemo(() => {
    if (activeCharacterId) {
      return snapshot.ownedStylesByCharacter?.[activeCharacterId] ?? [];
    }
    return snapshot.ownedStyles;
  }, [activeCharacterId, snapshot.ownedStyles, snapshot.ownedStylesByCharacter]);
  const ownedKeys = useMemo(
    () => new Set(ownedStylesForIdentity.map((o) => o.styleKey)),
    [ownedStylesForIdentity],
  );
  // Flash Sale → Name Styles deep-link: switch to whichever sub-tab
  // contains the row the user came to buy. Without this, an
  // unowned-sale row click lands on the "Owned" tab and the scroll
  // hook's row query whiffs because the row only exists in the
  // "Available" tab's render branch.
  useEffect(() => {
    if (!focusKey) return;
    setTab(ownedKeys.has(focusKey) ? "owned" : "available");
  }, [focusKey, ownedKeys]);
  const available = styles.filter((s) => !ownedKeys.has(s.key));
  // Active equipped style for the CURRENT identity.
  const activeKey = activeCharacterId
    ? (snapshot.activeCosmetics.byCharacter?.[activeCharacterId]?.activeNameStyleKey ?? null)
    : snapshot.activeCosmetics.activeNameStyleKey;
  // Owned list, with the equipped style floated to the top. Rest of
  // the list keeps the catalog's existing order so the user's mental
  // map of "where is X?" stays stable when nothing's equipped. Sort
  // is computed AFTER `activeKey` resolves so a `/char switch` that
  // changes which identity's `activeKey` is in scope re-floats the
  // correct row without a refetch.
  const owned = useMemo(() => {
    const filtered = styles.filter((s) => ownedKeys.has(s.key));
    if (!activeKey) return filtered;
    const activeIdx = filtered.findIndex((s) => s.key === activeKey);
    if (activeIdx <= 0) return filtered;
    const next = filtered.slice();
    const [hit] = next.splice(activeIdx, 1);
    return [hit!, ...next];
  }, [styles, ownedKeys, activeKey]);
  const ownedConfigByKey = useMemo(() => {
    const out = new Map<string, Record<string, unknown> | null>();
    for (const o of ownedStylesForIdentity) {
      let cfg: Record<string, unknown> | null = null;
      if (o.configJson) {
        try { cfg = JSON.parse(o.configJson) as Record<string, unknown>; }
        catch { cfg = null; }
      }
      out.set(o.styleKey, cfg);
    }
    return out;
  }, [ownedStylesForIdentity]);
  // Affordability gates against the pool the server will actually
  // debit on Buy: the active character's pool when voicing a
  // character, the master pool when on OOC. Previously this used
  // `snapshot.master.currency` unconditionally, a user with 4000
  // on master and 0 on the active character saw Buy enabled at 1000
  // Currency, clicked, and got "insufficient funds" from the server.
  const activeWallet = activeCharacterId
    ? (snapshot.characters.find((c) => c.ownerId === activeCharacterId)?.currency ?? 0)
    : snapshot.master.currency;

  async function buy(key: string, cost: number) {
    const who = activeCharacterId ? "this character" : "your master account";
    if (!window.confirm(`Buy this style for ${cost} Currency from ${who}'s pool?`)) return;
    setBusyKey(key);
    setErr(null);
    try {
      // Pool drain scopes to current identity: character-active
      // debits character_earning, OOC debits user_earning.
      await purchaseNameStyle(key, activeCharacterId);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Purchase failed");
    } finally {
      setBusyKey(null);
    }
  }
  async function equip(key: string | null) {
    setBusyKey(key ?? "__unequip__");
    setErr(null);
    try {
      // Scope the equip to the current identity. Server validates
      // ownership of the character before writing the slot.
      await setActiveNameStyle(key, activeCharacterId);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Equip failed");
    } finally {
      setBusyKey(null);
    }
  }
  async function saveConfig(key: string, config: Record<string, unknown> | null) {
    setBusyKey(key);
    setErr(null);
    try {
      await patchNameStyleConfig(key, config, activeCharacterId);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusyKey(null);
    }
  }

  // Preview name reflects the current identity, the active
  // character's display name when one is active, otherwise the
  // master username. The character display name comes from the
  // snapshot's `characters[]` pool view (ownerId === characterId
  // for character pools).
  const activeCharacterDisplayName = useMemo(() => {
    if (!activeCharacterId) return null;
    return snapshot.characters.find((c) => c.ownerId === activeCharacterId)?.displayName ?? null;
  }, [activeCharacterId, snapshot.characters]);
  const previewName = activeCharacterDisplayName || me?.username || "Username";

  return (
    <div className="space-y-3">
      <div className="flex gap-2 border-b border-keep-rule pb-2 text-xs uppercase tracking-widest">
        <button
          type="button"
          onClick={() => setTab("owned")}
          className={`rounded border border-keep-rule px-2 py-0.5 ${tab === "owned" ? "bg-keep-bg" : "bg-keep-banner/40 hover:bg-keep-banner"}`}
        >
          Owned ({owned.length})
        </button>
        <button
          type="button"
          onClick={() => setTab("available")}
          className={`rounded border border-keep-rule px-2 py-0.5 ${tab === "available" ? "bg-keep-bg" : "bg-keep-banner/40 hover:bg-keep-banner"}`}
        >
          Available ({available.length})
        </button>
      </div>

      {err ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-sm text-keep-accent">{err}</div>
      ) : null}

      {tab === "owned" ? (
        <div className="space-y-3">
          {activeKey ? (
            <button
              type="button"
              onClick={() => void equip(null)}
              disabled={busyKey !== null}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs text-keep-muted hover:bg-keep-banner disabled:opacity-50"
            >
              Unequip
            </button>
          ) : null}
          {owned.length === 0 ? (
            <p className="text-sm text-keep-muted">You don't own any styles yet. Switch to "Available" to browse.</p>
          ) : (
            // Two-column grid on md+ so the catalog stops being a
            // tall vertical scroll. Stays one column on mobile where
            // each card's preview + color row needs the full width.
            // `auto-rows-fr` keeps the per-row card heights aligned
            // so a card with no description doesn't run shorter than
            // its neighbor and break the visual rhythm.
            <div className="grid auto-rows-fr gap-3 md:grid-cols-2">
              {owned.map((s) => (
                <div key={s.key} data-shop-row={s.key} className="rounded">
                  <OwnedStyleCard
                    style={s}
                    config={ownedConfigByKey.get(s.key) ?? null}
                    previewName={previewName}
                    isActive={s.key === activeKey}
                    busy={busyKey === s.key}
                    onEquip={() => void equip(s.key === activeKey ? null : s.key)}
                    onSaveConfig={(cfg) => void saveConfig(s.key, cfg)}
                    flashSale={flashSale}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {tab === "available" ? (
        <div className="space-y-3">
          {available.length === 0 ? (
            <p className="text-sm text-keep-muted">You own every available style. Nice.</p>
          ) : (
            <div className="grid auto-rows-fr gap-3 md:grid-cols-2">
              {available.map((s) => (
                <div key={s.key} data-shop-row={s.key} className="rounded">
                  <AvailableStyleCard
                    style={s}
                    previewName={previewName}
                    busy={busyKey === s.key}
                    affordable={activeWallet >= flashSalePriceFor(flashSale, "nameStyle", s.key, s.cost).effectivePrice}
                    onBuy={() => void buy(s.key, flashSalePriceFor(flashSale, "nameStyle", s.key, s.cost).effectivePrice)}
                    flashSale={flashSale}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function OwnedStyleCard({
  style,
  config,
  previewName,
  isActive,
  busy,
  onEquip,
  onSaveConfig,
  flashSale,
}: {
  style: NameStyleCatalogRow;
  config: Record<string, unknown> | null;
  previewName: string;
  isActive: boolean;
  busy: boolean;
  onEquip: () => void;
  onSaveConfig: (config: Record<string, unknown> | null) => void;
  flashSale: FlashSaleResponse | null;
}) {
  // Local draft so the color picker can stage changes without a
  // per-keystroke server roundtrip. Persisted via Save below.
  const [draft, setDraft] = useState<Record<string, unknown>>(config ?? {});
  // Sync the local draft when the prop changes (e.g. another tab
  // edited the same row and the snapshot refetched).
  useEffect(() => { setDraft(config ?? {}); }, [config]);

  // Heuristic: any draft key whose value looks color-ish gets a
  // color input. Three named slots (color1, color2, glow) cover the
  // seeded styles' configs; unknown keys remain editable as text.
  const colorKeys: Array<{ key: string; label: string }> = [
    { key: "color1", label: "Color 1" },
    { key: "color2", label: "Color 2" },
    { key: "glow", label: "Glow" },
  ];

  const sale = flashSalePriceFor(flashSale, "nameStyle", style.key, style.cost);
  return (
    <div className={`relative flex flex-col rounded border ${isActive ? "border-keep-action" : "border-keep-rule"} bg-keep-bg/40 p-3`}>
      {/* `ns-card-controls` lifts the Equip/Unequip row above the
          preview's stacking context. Without it, when the user's
          equipped style was the SAME card being rendered (so this
          card carried `isActive`), any decoration that escaped the
          preview, even subtly, landed over the Equip row and ate
          the click. Reports surfaced as "owned name style is
          invisible and can't be interacted with" specifically on the
          equipped style; the workaround was unequipping to "default
          appearance." Pairing this class with `name-style-preview`'s
          `contain: paint; isolation: isolate;` is the belt-and-
          suspenders fix. */}
      <div className="ns-card-controls flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 font-semibold">
            <span className="truncate">{style.name}</span>
            <SalePip discountPct={sale.discountPct} />
          </div>
          {style.description ? <div className="text-xs text-keep-muted">{style.description}</div> : null}
        </div>
        {isActive ? (
          <span className="rounded bg-keep-action/15 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-action">Equipped</span>
        ) : null}
        <button
          type="button"
          onClick={onEquip}
          disabled={busy}
          className={`rounded border px-2 py-0.5 text-xs disabled:opacity-50 ${isActive ? "border-keep-rule bg-keep-bg text-keep-muted hover:bg-keep-banner" : "border-keep-action bg-keep-action/15 text-keep-action hover:bg-keep-action/25"}`}
        >
          {isActive ? "Unequip" : "Equip"}
        </button>
      </div>

      {/* Preview is read-only, `name-style-preview` is the hook the
          stylesheet uses to (a) clip decoration overflow to the
          preview box, so a name-style with sprawling pseudo-elements
          (the "Fog" overlay was the reported case) can't drape over
          the Equip button below and intercept its clicks, and (b)
          force `pointer-events: none` on every descendant so even
          decorations escaping the box don't capture pointer input.
          The Equip button is a sibling above this div, not inside,
          so it stays clickable. */}
      <div className="name-style-preview mt-3 rounded border border-keep-rule/60 bg-keep-bg/60 px-3 py-2 text-2xl font-bold">
        <StyledName displayName={previewName} styleKey={style.key} config={draft} preview />
      </div>

      <div className="ns-card-controls mt-3 flex flex-wrap gap-3">
        {colorKeys.map(({ key, label }) => {
          const cur = typeof draft[key] === "string" ? (draft[key] as string) : "#ff7a45";
          return (
            <label key={key} className="flex items-center gap-1 text-xs">
              <span className="text-keep-muted">{label}</span>
              <input
                type="color"
                value={normalizeHex(cur)}
                onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                className="h-6 w-10 cursor-pointer rounded border border-keep-rule bg-keep-bg"
              />
            </label>
          );
        })}
        <button
          type="button"
          onClick={() => onSaveConfig(Object.keys(draft).length === 0 ? null : draft)}
          disabled={busy}
          className="ml-auto rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
        >
          Save colors
        </button>
      </div>
    </div>
  );
}

function AvailableStyleCard({
  style,
  previewName,
  busy,
  affordable,
  onBuy,
  flashSale,
}: {
  style: NameStyleCatalogRow;
  previewName: string;
  busy: boolean;
  affordable: boolean;
  onBuy: () => void;
  flashSale: FlashSaleResponse | null;
}) {
  const sale = flashSalePriceFor(flashSale, "nameStyle", style.key, style.cost);
  return (
    <div className="relative flex flex-col rounded border border-keep-rule bg-keep-bg/40 p-3">
      <div className="ns-card-controls flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 font-semibold">
            <span className="truncate">{style.name}</span>
            <SalePip discountPct={sale.discountPct} />
          </div>
          {style.description ? <div className="text-xs text-keep-muted">{style.description}</div> : null}
        </div>
        <PriceBlock basePrice={style.cost} effectivePrice={sale.effectivePrice} onSale={sale.discountPct != null} />
        <button
          type="button"
          onClick={onBuy}
          disabled={busy || !affordable}
          title={affordable ? "Buy this style" : "Not enough Currency"}
          className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
        >
          {busy ? "Working…" : "Buy"}
        </button>
      </div>
      <div className="name-style-preview mt-3 rounded border border-keep-rule/60 bg-keep-bg/60 px-3 py-2 text-2xl font-bold">
        {/* No config override, each style paints in its catalog
            defaults (Embers → fire orange, Neon Sign → neon pink,
            Aurora → tropical, etc.). The Available preview used to
            hardcode an orange palette which made every style look
            like a fire variant regardless of its actual design.
            `name-style-preview` is the same hook the Owned card uses,
            see comment there for the click-shielding rationale. */}
        <StyledName displayName={previewName} styleKey={style.key} config={null} preview />
      </div>
    </div>
  );
}

function normalizeHex(s: string): string {
  // <input type="color"> wants 7-char #rrggbb. We round-trip the
  // user's draft via this normalizer so a CSS `rgba(...)` glow value
  // doesn't trip the color input.
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return "#" + s.slice(1).split("").map((c) => c + c).join("");
  }
  return "#ff7a45";
}

/* =========================================================
 *  Section 5, Rank Borders (Phase 4)
 *
 *  Three buckets:
 *    Eligible to buy, Tier IV of this rank reached at some
 *                      point but the user hasn't purchased the
 *                      border yet.
 *    Owned         , borders the user already bought. Equip one
 *                      via /earning/me/settings { selectedBorderRankKey }
 *                      (handled by the existing patchEarningSettings).
 *    Locked        , borders the user isn't eligible for yet
 *                      (haven't crossed Tier IV). Shown muted with
 *                      a "Reach <rank> IV" hint.
 *
 *  Eligibility check mirrors the server: peak >= this rank's order
 *  AND at least Tier IV on the peak (or the peak is higher than
 *  this rank, in which case every lower rank's capstone was
 *  necessarily traversed).
 * ========================================================= */

function BordersTab({ snapshot, flashSale, focusKey }: {
  snapshot: ReturnType<typeof useEarning.getState>["snapshot"] & {};
  flashSale: FlashSaleResponse | null;
  focusKey: string | null;
}) {
  useShopRowFocus(focusKey);
  const refresh = useEarning((s) => s.refresh);
  // Per-identity scope: borders are partitioned the same way name
  // styles are. The active character buys / equips from its own
  // character_earning pool; the master/OOC buys / equips from
  // user_earning. Ownership lives in `character_owned_borders` or
  // `user_owned_borders` accordingly.
  const activeCharacterId = useChat((s) => s.activeCharacterId);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Pull the viewer's own avatar from the room-occupant cosmetics
  // cache (same source that drives the chat-line inline avatars).
  // Lets every preview show the user's actual portrait inside the
  // frame, not an initials chip stand-in. Falls back to null when
  // the user has no occupant row in any open room yet, in which
  // case the BorderedAvatar shows initials.
  //
  // Scoped to (me.id, activeCharacterId) so a sibling tab voicing a
  // different identity can't poison this lookup, see the long-form
  // comment on the dashboard hero's `viewerAvatarUrl` for the full
  // failure mode this guards against.
  const me = useChat((s) => s.me);
  const viewerAvatarUrl = useChat((s) => {
    if (!me) return null;
    for (const list of Object.values(s.occupants)) {
      const row = list.find((o) => o.userId === me.id && o.characterId === activeCharacterId);
      if (row?.avatarUrl) return row.avatarUrl;
    }
    return null;
  });

  // Owned + equipped border for the CURRENT identity. Character
  // active = pull from `ownedBordersByCharacter[id]` and
  // `characters[i].selectedBorderRankKey`; OOC/master = pull from
  // `ownedBorders` and `master.selectedBorderRankKey`.
  const activeCharacterView = useMemo(() => {
    if (!activeCharacterId) return null;
    return snapshot.characters.find((c) => c.ownerId === activeCharacterId) ?? null;
  }, [activeCharacterId, snapshot.characters]);
  const ownedBordersForIdentity = useMemo(() => {
    if (activeCharacterId) {
      return snapshot.ownedBordersByCharacter?.[activeCharacterId] ?? [];
    }
    return snapshot.ownedBorders;
  }, [activeCharacterId, snapshot.ownedBorders, snapshot.ownedBordersByCharacter]);
  const ownedKeys = useMemo(
    () => new Set(ownedBordersForIdentity.map((b) => b.rankKey)),
    [ownedBordersForIdentity],
  );
  const selectedKey = activeCharacterId
    ? (activeCharacterView?.selectedBorderRankKey ?? null)
    : snapshot.master.selectedBorderRankKey;

  // Free-form border parallel state, same per-identity partitioning
  // rules. Ownership is independent of rank-tier ownership; the
  // equip slot is also independent (the BorderedAvatar resolver
  // checks the freeform slot first and falls back to the rank slot).
  const ownedFreeformForIdentity = useMemo(() => {
    if (activeCharacterId) {
      return snapshot.ownedFreeformBordersByCharacter?.[activeCharacterId] ?? [];
    }
    return snapshot.ownedFreeformBorders;
  }, [activeCharacterId, snapshot.ownedFreeformBorders, snapshot.ownedFreeformBordersByCharacter]);
  const ownedFreeformKeys = useMemo(
    () => new Set(ownedFreeformForIdentity.map((b) => b.borderKey)),
    [ownedFreeformForIdentity],
  );
  const selectedFreeformKey = activeCharacterId
    ? (activeCharacterView?.selectedFreeformBorderKey ?? null)
    : snapshot.master.selectedFreeformBorderKey;

  // Capstone tiers (Tier IV with a borderImageUrl + cost).
  const capstones = useMemo(() => {
    return snapshot.catalog.rankTiers
      .filter((t) => t.tier === 4 && !!t.borderImageUrl)
      .map((t) => ({
        tier: t,
        rank: snapshot.catalog.ranks.find((r) => r.key === t.rankKey) ?? null,
      }))
      .filter((x) => !!x.rank)
      .sort((a, b) => a.rank!.order - b.rank!.order);
  }, [snapshot.catalog]);

  // Eligibility against the CURRENT identity's peak rank/tier, a
  // character that hasn't peaked at Tier IV can't buy its own
  // border even when the master has. Mirrors the server-side check
  // in the border purchase handler.
  const eligibleKeys = useMemo(() => {
    const peakKey = activeCharacterId
      ? (activeCharacterView?.maxRankKeyEverHeld ?? null)
      : snapshot.master.maxRankKeyEverHeld;
    const peakTier = activeCharacterId
      ? (activeCharacterView?.maxTierEverHeld ?? 0)
      : (snapshot.master.maxTierEverHeld ?? 0);
    if (!peakKey) return new Set<string>();
    const peakRank = snapshot.catalog.ranks.find((r) => r.key === peakKey);
    if (!peakRank) return new Set<string>();
    const out = new Set<string>();
    for (const r of snapshot.catalog.ranks) {
      if (r.order < peakRank.order) out.add(r.key);
      else if (r.order === peakRank.order && peakTier >= 4) out.add(r.key);
    }
    return out;
  }, [activeCharacterId, activeCharacterView, snapshot.master, snapshot.catalog.ranks]);

  async function buy(rankKey: string) {
    const who = activeCharacterId ? "this character" : "your master account";
    if (!window.confirm(`Buy this rank's border from ${who}'s pool?`)) return;
    setBusyKey(rankKey);
    setErr(null);
    try {
      await purchaseBorder(rankKey, activeCharacterId);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Purchase failed");
    } finally {
      setBusyKey(null);
    }
  }

  async function equip(rankKey: string | null) {
    setBusyKey(rankKey ?? "__unequip__");
    setErr(null);
    try {
      await patchEarningSettings({ selectedBorderRankKey: rankKey, characterId: activeCharacterId });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Equip failed");
    } finally {
      setBusyKey(null);
    }
  }

  async function buyFreeform(borderKey: string) {
    const who = activeCharacterId ? "this character" : "your master account";
    if (!window.confirm(`Buy this border from ${who}'s pool?`)) return;
    setBusyKey(`freeform:${borderKey}`);
    setErr(null);
    try {
      await purchaseFreeformBorder(borderKey, activeCharacterId);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Purchase failed");
    } finally {
      setBusyKey(null);
    }
  }

  async function equipFreeform(borderKey: string | null) {
    setBusyKey(borderKey ? `freeform:${borderKey}` : "__unequip_freeform__");
    setErr(null);
    try {
      await patchEarningSettings({ selectedFreeformBorderKey: borderKey, characterId: activeCharacterId });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Equip failed");
    } finally {
      setBusyKey(null);
    }
  }

  async function saveFreeformConfig(borderKey: string, config: Record<string, string> | null) {
    setBusyKey(`freeform:${borderKey}`);
    setErr(null);
    try {
      await patchFreeformBorderConfig(borderKey, config, activeCharacterId);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusyKey(null);
    }
  }

  const owned: typeof capstones = [];
  const available: typeof capstones = [];
  const locked: typeof capstones = [];
  for (const c of capstones) {
    if (ownedKeys.has(c.tier.rankKey)) owned.push(c);
    else if (eligibleKeys.has(c.tier.rankKey)) available.push(c);
    else locked.push(c);
  }

  // Free-form catalog rows partitioned the same way: owned vs
  // available. There's no "locked" bucket, free-form borders have
  // no eligibility gate. Rarity-sorted within each bucket so the
  // user sees common/rare/etc. cluster predictably.
  const freeformCatalog = snapshot.catalog.freeformBorders;
  const ownedFreeform: FreeformBorderRow[] = [];
  const availableFreeform: FreeformBorderRow[] = [];
  for (const b of freeformCatalog) {
    if (ownedFreeformKeys.has(b.key)) ownedFreeform.push(b);
    else availableFreeform.push(b);
  }
  // Index per-identity color customizations by border key so the
  // "owned" / "equipped" cards can preview with the user's actual
  // color picks instead of the catalog row's CSS fallbacks.
  const ownedFreeformConfigByKey = useMemo(() => {
    const out = new Map<string, string | null>();
    for (const row of ownedFreeformForIdentity) {
      out.set(row.borderKey, row.configJson ?? null);
    }
    return out;
  }, [ownedFreeformForIdentity]);

  return (
    <div className="space-y-4">
      {err ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-sm text-keep-accent">{err}</div>
      ) : null}

      {selectedKey ? (
        <div className="flex items-center gap-2 text-xs text-keep-muted">
          <span>Currently equipped:</span>
          <strong className="text-keep-text">{snapshot.catalog.ranks.find((r) => r.key === selectedKey)?.name ?? selectedKey}</strong>
          <button
            type="button"
            onClick={() => void equip(null)}
            disabled={busyKey !== null}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-keep-muted hover:bg-keep-banner disabled:opacity-50"
          >
            Unequip
          </button>
        </div>
      ) : null}

      <section>
        <h3 className="mb-2 font-action text-sm uppercase tracking-widest text-keep-muted">
          Owned ({owned.length})
        </h3>
        {owned.length === 0 ? (
          <p className="text-sm text-keep-muted">You don't own any borders yet.</p>
        ) : (
          <div className="grid auto-rows-fr gap-3 md:grid-cols-2">
            {owned.map(({ tier, rank }) => (
              <BorderCard
                key={tier.rankKey}
                tier={tier}
                rankName={rank!.name}
                state={selectedKey === tier.rankKey ? "equipped" : "owned"}
                busy={busyKey === tier.rankKey}
                onAction={() => void equip(selectedKey === tier.rankKey ? null : tier.rankKey)}
                userDisplayName={snapshot.master.displayName}
                userAvatarUrl={viewerAvatarUrl}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-2 font-action text-sm uppercase tracking-widest text-keep-muted">
          Available ({available.length})
        </h3>
        {available.length === 0 ? (
          <p className="text-sm text-keep-muted">No borders available to purchase right now. Climb the ladder to unlock more.</p>
        ) : (
          <div className="grid auto-rows-fr gap-3 md:grid-cols-2">
            {available.map(({ tier, rank }) => (
              <BorderCard
                key={tier.rankKey}
                tier={tier}
                rankName={rank!.name}
                state="available"
                busy={busyKey === tier.rankKey}
                affordable={(activeCharacterView?.currency ?? snapshot.master.currency) >= (tier.borderCost ?? 0)}
                onAction={() => void buy(tier.rankKey)}
                userDisplayName={snapshot.master.displayName}
                userAvatarUrl={viewerAvatarUrl}
              />
            ))}
          </div>
        )}
      </section>

      {locked.length > 0 ? (
        <section>
          <h3 className="mb-2 font-action text-sm uppercase tracking-widest text-keep-muted">
            Locked ({locked.length})
          </h3>
          <div className="grid auto-rows-fr gap-3 md:grid-cols-2">
            {locked.map(({ tier, rank }) => (
              <BorderCard
                key={tier.rankKey}
                tier={tier}
                rankName={rank!.name}
                state="locked"
                userDisplayName={snapshot.master.displayName}
                userAvatarUrl={viewerAvatarUrl}
              />
            ))}
          </div>
        </section>
      ) : null}

      {freeformCatalog.length > 0 ? (
        <>
          {/* Divider + section header. Free-form (non-rank-tied)
              borders live in a parallel catalog with their own
              ownership ledger and equip slot. The chip below the
              header shows whichever freeform border is currently
              equipped, independent of the rank-tier equip state
              displayed at the top of this tab. */}
          <div className="border-t border-keep-rule pt-4">
            <h3 className="mb-2 font-action text-sm uppercase tracking-widest text-keep-muted">
              Free-form
            </h3>
            {selectedFreeformKey ? (
              <div className="mb-3 flex items-center gap-2 text-xs text-keep-muted">
                <span>Currently equipped:</span>
                <strong className="text-keep-text">
                  {freeformCatalog.find((b) => b.key === selectedFreeformKey)?.name ?? selectedFreeformKey}
                </strong>
                <button
                  type="button"
                  onClick={() => void equipFreeform(null)}
                  disabled={busyKey !== null}
                  className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-keep-muted hover:bg-keep-banner disabled:opacity-50"
                >
                  Unequip
                </button>
              </div>
            ) : null}
          </div>

          {ownedFreeform.length > 0 ? (
            <section>
              <h4 className="mb-2 font-action text-xs uppercase tracking-widest text-keep-muted">
                Owned ({ownedFreeform.length})
              </h4>
              <div className="grid auto-rows-fr gap-3 md:grid-cols-2">
                {ownedFreeform.map((b) => (
                  <div key={b.key} data-shop-row={b.key} className="rounded">
                    <FreeformBorderCard
                      border={b}
                      state={selectedFreeformKey === b.key ? "equipped" : "owned"}
                      busy={busyKey === `freeform:${b.key}`}
                      onAction={() => void equipFreeform(selectedFreeformKey === b.key ? null : b.key)}
                      onSaveConfig={(cfg) => void saveFreeformConfig(b.key, cfg)}
                      userDisplayName={snapshot.master.displayName}
                      userAvatarUrl={viewerAvatarUrl}
                      configJson={ownedFreeformConfigByKey.get(b.key) ?? null}
                    />
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {availableFreeform.length > 0 ? (
            <section>
              <h4 className="mb-2 font-action text-xs uppercase tracking-widest text-keep-muted">
                Available ({availableFreeform.length})
              </h4>
              <div className="grid auto-rows-fr gap-3 md:grid-cols-2">
                {availableFreeform.map((b) => {
                  const sale = flashSalePriceFor(flashSale, "freeformBorder", b.key, b.cost);
                  return (
                    <div key={b.key} data-shop-row={b.key} className="rounded">
                      <FreeformBorderCard
                        border={b}
                        state="available"
                        busy={busyKey === `freeform:${b.key}`}
                        affordable={(activeCharacterView?.currency ?? snapshot.master.currency) >= sale.effectivePrice}
                        onAction={() => void buyFreeform(b.key)}
                        userDisplayName={snapshot.master.displayName}
                        userAvatarUrl={viewerAvatarUrl}
                        effectivePrice={sale.effectivePrice}
                        discountPct={sale.discountPct}
                      />
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Pill color per rarity, open string in the catalog row, so
 *  unknown values fall back to the common-tier palette. */
function rarityPalette(rarity: string): { ring: string; text: string; label: string } {
  switch (rarity.toLowerCase()) {
    case "rare":      return { ring: "border-blue-400/60",   text: "text-blue-300",   label: "Rare" };
    case "epic":      return { ring: "border-purple-400/60", text: "text-purple-300", label: "Epic" };
    case "legendary": return { ring: "border-amber-400/60",  text: "text-amber-300",  label: "Legendary" };
    case "mythic":    return { ring: "border-pink-400/60",   text: "text-pink-300",   label: "Mythic" };
    case "exotic":    return { ring: "border-cyan-400/60",   text: "text-cyan-300",   label: "Exotic" };
    case "atmospheric":
    case "atmos":     return { ring: "border-slate-400/60",  text: "text-slate-300",  label: "Atmospheric" };
    default:          return { ring: "border-keep-rule",     text: "text-keep-muted", label: rarity || "Common" };
  }
}

function FreeformBorderCard({
  border,
  state,
  busy,
  affordable,
  onAction,
  onSaveConfig,
  userDisplayName,
  userAvatarUrl,
  configJson,
  effectivePrice,
  discountPct,
}: {
  border: FreeformBorderRow;
  state: "equipped" | "owned" | "available";
  busy?: boolean;
  affordable?: boolean;
  onAction?: () => void;
  /** Save the per-identity color customization. Only relevant for
   *  owned/equipped state. Pass `null` to clear all overrides
   *  (renderer falls back to the catalog row's CSS fallbacks). */
  onSaveConfig?: (config: Record<string, string> | null) => void;
  userDisplayName: string;
  userAvatarUrl?: string | null;
  /** Owned-row's saved color customization (raw JSON string). Renders
   *  the preview with the user's actual picks for owned/equipped
   *  cards; null on available cards (catalog fallbacks). */
  configJson?: string | null;
  /** Resolved sale price for the Available state. Defaults to the
   *  border's base cost; only diverges when this row is today's
   *  flash-sale pick. */
  effectivePrice?: number;
  /** Flash-sale discount % to display alongside the price chip. */
  discountPct?: number | null;
}) {
  const palette = rarityPalette(border.rarity);
  const savedConfig = useMemo(() => {
    if (!configJson) return {} as Record<string, string>;
    return parseFreeformBorderConfig(configJson);
  }, [configJson]);
  // Customizable slots, names AND default fallback colors extracted
  // from the row's styleCss. Empty when the catalog row defines no
  // `--c-*` references; we hide the color picker entirely in that
  // case so cards without user-customizable slots don't display a
  // misleading empty editor. The defaultColor for each slot is the
  // `var(--c-name, <default>)` fallback the picker shows as the
  // starting swatch when the user hasn't yet picked an override.
  const slots = useMemo(
    () => extractFreeformBorderVarsWithDefaults(border.styleCss ?? ""),
    [border.styleCss],
  );
  const [draft, setDraft] = useState<Record<string, string>>(savedConfig);
  useEffect(() => { setDraft(savedConfig); }, [savedConfig]);
  // Live preview uses the draft (instant feedback on color picks)
  // rather than the saved config, saved config only re-renders the
  // border after the user clicks Save.
  const previewConfig = useMemo(() => {
    const merged: Record<string, string> = { ...draft };
    return Object.keys(merged).length > 0 ? merged : null;
  }, [draft]);
  // Only the EQUIPPED card gets the color editor, owned-but-not-
  // equipped cards would otherwise duplicate the same long picker
  // grid for every collected border, spamming the catalog. Equipping
  // a card flips it into the editor state; unequipping hides it again.
  const canCustomize = state === "equipped" && slots.length > 0 && onSaveConfig;
  const isDirty = useMemo(() => {
    if (Object.keys(draft).length !== Object.keys(savedConfig).length) return true;
    for (const k of Object.keys(draft)) {
      if (draft[k] !== savedConfig[k]) return true;
    }
    return false;
  }, [draft, savedConfig]);
  return (
    <div className={`flex flex-col gap-3 rounded border p-3 ${state === "equipped" ? "border-keep-action bg-keep-action/5" : `${palette.ring} bg-keep-bg/40`}`}>
      <div className="flex items-center gap-3">
        <BorderedAvatar
          avatarUrl={userAvatarUrl ?? null}
          name={userDisplayName}
          freeformBorderKey={border.key}
          freeformConfig={previewConfig}
          size="xl"
          preview
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="font-semibold">{border.name}</div>
            <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${palette.ring} ${palette.text}`}>
              {palette.label}
            </span>
          </div>
          {border.description ? (
            <div className="text-xs text-keep-muted">{border.description}</div>
          ) : null}
          <div className="flex items-center gap-1.5 text-xs text-keep-muted">
            {state === "available" ? (
              <>
                <PriceBlock
                  basePrice={border.cost}
                  effectivePrice={effectivePrice ?? border.cost}
                  onSale={discountPct != null}
                />
                <SalePip discountPct={discountPct ?? null} />
              </>
            ) : null}
          </div>
        </div>
        {state === "equipped" ? (
          <button
            type="button"
            onClick={onAction}
            disabled={busy}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs text-keep-muted hover:bg-keep-banner disabled:opacity-50"
          >
            Unequip
          </button>
        ) : state === "owned" ? (
          <button
            type="button"
            onClick={onAction}
            disabled={busy}
            className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
          >
            Equip
          </button>
        ) : (
          <button
            type="button"
            onClick={onAction}
            disabled={busy || !affordable}
            title={affordable ? "Buy this border" : "Not enough Currency"}
            className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
          >
            {busy ? "Working…" : "Buy"}
          </button>
        )}
      </div>
      {/* Color picker, one `<input type="color">` per `--c-*` slot
          discovered in the row's styleCss. Mirrors the name-style
          OwnedStyleCard pattern: stage in local draft, persist via
          Save button. Reset clears all customization back to the
          catalog row's CSS fallbacks.

          Laid out as a responsive uniform grid (auto-fill, min 8rem
          per cell) so any number of slots wraps cleanly instead of
          the previous flex-wrap row whose ragged break points read
          as chaos when a border like Hearth Flame exposed ~20 slots.
          Each slot is a compact swatch + name pair, with the
          action row pinned at the bottom. */}
      {canCustomize ? (
        <div className="border-t border-keep-rule/40 pt-3">
          <div className="mb-2 flex items-baseline justify-between">
            <h5 className="text-[10px] font-action uppercase tracking-widest text-keep-muted">
              Customize colors
            </h5>
            <span className="text-[10px] text-keep-muted">
              {slots.length} slot{slots.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="grid gap-2 sm:grid-cols-[repeat(auto-fill,minmax(8rem,1fr))]">
            {slots.map(({ name: slot, defaultColor }) => {
              // Starting swatch precedence:
              //   1. User's current draft pick (if set).
              //   2. The catalog row's `var(--c-slot, <default>)`
              //      fallback, the actual color the border renders
              //      with when no override is saved.
              //   3. A neutral grey for slots whose fallback isn't a
              //      parseable color (named colors, hsl(), color-mix,
              //      etc., rare in our catalog).
              const cur = typeof draft[slot] === "string"
                ? draft[slot]
                : (defaultColor ?? "#808080");
              return (
                <label
                  key={slot}
                  title={defaultColor ? `${slot} (default: ${defaultColor})` : slot}
                  className="flex items-center gap-2 rounded border border-keep-rule/60 bg-keep-bg/40 px-2 py-1 text-[11px] hover:border-keep-rule"
                >
                  <input
                    type="color"
                    value={normalizeHex(cur)}
                    onChange={(e) => setDraft((d) => ({ ...d, [slot]: e.target.value }))}
                    aria-label={`Color for ${slot}`}
                    className="h-5 w-7 shrink-0 cursor-pointer rounded border border-keep-rule bg-keep-bg"
                  />
                  <span className="min-w-0 truncate text-keep-muted">{slot}</span>
                </label>
              );
            })}
          </div>
          <div className="mt-2 flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={() => { setDraft({}); onSaveConfig?.(null); }}
              disabled={busy || (!isDirty && Object.keys(savedConfig).length === 0)}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs text-keep-muted hover:bg-keep-banner disabled:opacity-40"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={() => onSaveConfig?.(Object.keys(draft).length === 0 ? null : draft)}
              disabled={busy || !isDirty}
              className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
            >
              Save colors
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BorderCard({
  tier,
  rankName,
  state,
  busy,
  affordable,
  onAction,
  userDisplayName,
  userAvatarUrl,
}: {
  tier: RankTierRow;
  rankName: string;
  state: "equipped" | "owned" | "available" | "locked";
  busy?: boolean;
  affordable?: boolean;
  onAction?: () => void;
  userDisplayName: string;
  /** Viewer's real avatar URL so the preview shows what the border
   *  will look like on their actual portrait, not on a stand-in
   *  initials chip. */
  userAvatarUrl?: string | null;
}) {
  const muted = state === "locked";
  return (
    <div className={`flex items-center gap-3 rounded border p-3 ${state === "equipped" ? "border-keep-action bg-keep-action/5" : "border-keep-rule bg-keep-bg/40"}`}>
      {/* `xl` slot: 124px avatar centered inside a 186px frame
          container, the avatar fills the frame's inner ring so the
          preview shows the border on the user's actual portrait.
          The frame is intentionally NOT muted on locked tiles,
          earlier we wrapped the whole card in `opacity-60`, which
          washed out the gold/silver detailing of the frames the
          user is trying to evaluate. Only the text (rank name +
          unlock copy) dims to signal locked state. */}
      <BorderedAvatar
        avatarUrl={userAvatarUrl ?? null}
        name={userDisplayName}
        borderRankKey={tier.rankKey}
        size="xl"
        preview
      />
      <div className={`min-w-0 flex-1 ${muted ? "opacity-60" : ""}`}>
        <div className="font-semibold">{rankName}</div>
        <div className="text-xs text-keep-muted">
          {state === "locked"
            ? `Reach ${rankName} ${tier.label} to unlock.`
            : tier.borderCost != null
              ? <CoinAmount amount={tier.borderCost} />
              : "Free"}
        </div>
      </div>
      {state === "equipped" ? (
        <button
          type="button"
          onClick={onAction}
          disabled={busy}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs text-keep-muted hover:bg-keep-banner disabled:opacity-50"
        >
          Unequip
        </button>
      ) : state === "owned" ? (
        <button
          type="button"
          onClick={onAction}
          disabled={busy}
          className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
        >
          Equip
        </button>
      ) : state === "available" ? (
        <button
          type="button"
          onClick={onAction}
          disabled={busy || !affordable}
          title={affordable ? "Buy this border" : "Not enough Currency"}
          className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
        >
          {busy ? "Working…" : "Buy"}
        </button>
      ) : null}
    </div>
  );
}

/* =========================================================
 *  Section 6, Cosmetics (Phase 4)
 *
 *  Currently a single row: `inline_avatar`. Buy + on/off toggle.
 *  Purchase is one-time; the toggle is free to flip after.
 * ========================================================= */

function CosmeticsTab({ snapshot, flashSale, focusKey }: {
  snapshot: ReturnType<typeof useEarning.getState>["snapshot"] & {};
  flashSale: FlashSaleResponse | null;
  focusKey: string | null;
}) {
  useShopRowFocus(focusKey);
  const refresh = useEarning((s) => s.refresh);
  // Same per-identity story as the Name Styles tab: the toggle
  // scopes to the user's currently-active character (or OOC/master
  // when none is active). Inline-avatar purchase is still account-
  // wide (one ownership ledger row covers all the user's
  // identities); only the EQUIPPED toggle is per-identity.
  const activeCharacterId = useChat((s) => s.activeCharacterId);
  // Used by the profile-flair buy cards to deep-link the buyer to
  // Edit Profile → Flair where they actually configure the purchase.
  // Without the deep-link they had to find the editor and the right
  // tab manually, and the post-purchase pointer copy was too quiet
  // to land.
  const openEditor = useChat((s) => s.openEditor);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The cosmetic-catalog isn't on /earning/me yet; fetch it once.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchEarningCatalog()
      .then((r) => { if (!cancelled) setCatalog(r); })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load catalog"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <p className="text-sm text-keep-muted">Loading flair…</p>;
  const inlineAvatarRow = catalog?.cosmetics.find((c) => c.key === "inline_avatar");
  const profileBannerRow = catalog?.cosmetics.find((c) => c.key === "flair_profile_banner");
  const typingPhraseRow = catalog?.cosmetics.find((c) => c.key === "flair_typing_phrase");
  const reactionSheetRow = catalog?.cosmetics.find((c) => c.key === "flair_reaction_sheet");
  const lurkingMasterRow = catalog?.cosmetics.find((c) => c.key === "flair_lurking_master");
  const roomPresenceRow = catalog?.cosmetics.find((c) => c.key === "flair_room_presence");
  const sessionPresenceRow = catalog?.cosmetics.find((c) => c.key === "flair_session_presence");
  // Migration 0192 flairs, same shape as the other catalog rows.
  // Both surfaces are config-only (no inline preview / equip toggle
  // here), so the cards use the compact `ProfileFlairBuyCard`
  // shared at the bottom of this section. Editor lives in the
  // ProfileEditor Flair tab; this card only handles the purchase.
  const profileVisitorsRow = catalog?.cosmetics.find((c) => c.key === "flair_profile_visitors");
  const profileMarqueeRow = catalog?.cosmetics.find((c) => c.key === "flair_profile_marquee");
  if (!inlineAvatarRow && !profileBannerRow && !typingPhraseRow && !reactionSheetRow
      && !lurkingMasterRow && !roomPresenceRow && !sessionPresenceRow
      && !profileVisitorsRow && !profileMarqueeRow) {
    return <p className="text-sm text-keep-muted">No flair available right now.</p>;
  }

  // Ownership is PER-IDENTITY: the server's purchase ledger writes a
  // row scoped to (user|character, ownerId), so master buying a
  // cosmetic does NOT make any character own it (and vice versa).
  // The snapshot exposes the currently-enabled flag per identity; we
  // use it as a proxy for ownership because the purchase endpoint
  // auto-equips on first buy. If the user later disables, the proxy
  // flips back to "Buy", `doBuy` below catches the resulting
  // "already owned" response and auto-equips instead, so the UX
  // stays clean. Previously this combined master + every character's
  // flag into a single "owns", a master who bought it made every
  // character show "Owned (off)" with an Equip toggle that failed
  // server-side because the character's own ledger had no purchase.
  const masterEnabled = snapshot.activeCosmetics.inlineAvatarEnabled;
  const perCharacterMap = snapshot.activeCosmetics.byCharacter ?? {};
  const equipped = activeCharacterId
    ? (perCharacterMap[activeCharacterId]?.inlineAvatarEnabled ?? false)
    : masterEnabled;
  const owns = equipped;
  const activeWallet = activeCharacterId
    ? (snapshot.characters.find((c) => c.ownerId === activeCharacterId)?.currency ?? 0)
    : snapshot.master.currency;

  async function doBuy() {
    const who = activeCharacterId ? "this character" : "your master account";
    if (!window.confirm(`Buy "${inlineAvatarRow!.name}" for ${inlineAvatarRow!.cost} Currency from ${who}'s pool?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await purchaseCosmetic("inline_avatar", activeCharacterId);
      await refresh();
    } catch (e) {
      // Server says this identity already bought it (they disabled
      // it, then clicked Buy again). Skip the cost prompt, flip
      // the equip on for them and re-sync. The server's equip
      // route enforces ownership, so a true never-purchased
      // identity still hits the proper rejection.
      const msg = e instanceof Error ? e.message : "Purchase failed";
      if (/already owned/i.test(msg)) {
        try {
          await equipCosmetic("inline_avatar", true, activeCharacterId);
          await refresh();
        } catch (eq) {
          setErr(eq instanceof Error ? eq.message : "Equip failed");
        }
      } else {
        setErr(msg);
      }
    } finally {
      setBusy(false);
    }
  }
  async function doToggle(next: boolean) {
    setBusy(true);
    setErr(null);
    try {
      // Scope to the current identity, same partition as the
      // name-style equip path. Server validates character ownership.
      await equipCosmetic("inline_avatar", next, activeCharacterId);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setBusy(false);
    }
  }

  // Flash-sale price for the inline_avatar cosmetic if it's today's
  // pick. Pure compute against the cached flashSale prop, server
  // applies the same discount on the actual purchase, so this is
  // faithful to what `doBuy()` will end up debiting.
  const inlineAvatarSale = inlineAvatarRow
    ? flashSalePriceFor(flashSale, "cosmetic", inlineAvatarRow.key, inlineAvatarRow.cost)
    : null;

  // Banner-cosmetic state for the current identity. `profileBannerOwned`
  // gates the URL form (must purchase first); `profileBannerUrl` is
  // the saved value the form is initialized from.
  const bannerOwned = activeCharacterId
    ? (perCharacterMap[activeCharacterId]?.profileBannerOwned ?? false)
    : (snapshot.activeCosmetics.profileBannerOwned ?? false);
  const bannerUrl = activeCharacterId
    ? (perCharacterMap[activeCharacterId]?.profileBannerUrl ?? null)
    : (snapshot.activeCosmetics.profileBannerUrl ?? null);
  const bannerSale = profileBannerRow
    ? flashSalePriceFor(flashSale, "cosmetic", profileBannerRow.key, profileBannerRow.cost)
    : null;

  async function doBuyBanner() {
    if (!profileBannerRow) return;
    const who = activeCharacterId ? "this character" : "your master account";
    if (!window.confirm(`Buy "${profileBannerRow.name}" for ${bannerSale!.effectivePrice} Currency from ${who}'s pool?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await purchaseCosmetic("flair_profile_banner", activeCharacterId);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Purchase failed");
    } finally {
      setBusy(false);
    }
  }

  // Typing-phrase Flair state for the current identity, same
  // shape as the banner state above.
  const typingPhraseOwned = activeCharacterId
    ? (perCharacterMap[activeCharacterId]?.typingPhraseOwned ?? false)
    : (snapshot.activeCosmetics.typingPhraseOwned ?? false);
  const typingPhrase = activeCharacterId
    ? (perCharacterMap[activeCharacterId]?.typingPhrase ?? null)
    : (snapshot.activeCosmetics.typingPhrase ?? null);
  const typingPhraseSale = typingPhraseRow
    ? flashSalePriceFor(flashSale, "cosmetic", typingPhraseRow.key, typingPhraseRow.cost)
    : null;

  async function doBuyTypingPhrase() {
    if (!typingPhraseRow || !typingPhraseSale) return;
    const who = activeCharacterId ? "this character" : "your master account";
    if (!window.confirm(`Buy "${typingPhraseRow.name}" for ${typingPhraseSale.effectivePrice} Currency from ${who}'s pool?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await purchaseCosmetic("flair_typing_phrase", activeCharacterId);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Purchase failed");
    } finally {
      setBusy(false);
    }
  }

  // Phase 6 Lurking Master state for the current identity.
  const lurkingMasterOwned = activeCharacterId
    ? (perCharacterMap[activeCharacterId]?.lurkingMasterOwned ?? false)
    : (snapshot.activeCosmetics.lurkingMasterOwned ?? false);
  const lurkingMasterEnabled = activeCharacterId
    ? (perCharacterMap[activeCharacterId]?.lurkingMasterEnabled ?? false)
    : (snapshot.activeCosmetics.lurkingMasterEnabled ?? false);
  const lurkingMasterSale = lurkingMasterRow
    ? flashSalePriceFor(flashSale, "cosmetic", lurkingMasterRow.key, lurkingMasterRow.cost)
    : null;

  async function doBuyLurkingMaster() {
    if (!lurkingMasterRow || !lurkingMasterSale) return;
    const who = activeCharacterId ? "this character" : "your master account";
    if (!window.confirm(`Buy "${lurkingMasterRow.name}" for ${lurkingMasterSale.effectivePrice} Currency from ${who}'s pool?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await purchaseCosmetic("flair_lurking_master", activeCharacterId);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Purchase failed");
    } finally {
      setBusy(false);
    }
  }
  async function doToggleLurking(next: boolean) {
    setBusy(true);
    setErr(null);
    try {
      await equipCosmetic("flair_lurking_master", next, activeCharacterId);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setBusy(false);
    }
  }

  // Phase 7 (migration 0161), room-presence Flair state for the
  // current identity. Templates are per-identity; the broadcaster
  // reads the active character's row when voicing a character, the
  // master's row otherwise.
  const roomPresenceOwned = activeCharacterId
    ? (perCharacterMap[activeCharacterId]?.roomPresenceOwned ?? false)
    : (snapshot.activeCosmetics.roomPresenceOwned ?? false);
  const roomJoinTemplate = activeCharacterId
    ? (perCharacterMap[activeCharacterId]?.roomJoinTemplate ?? null)
    : (snapshot.activeCosmetics.roomJoinTemplate ?? null);
  const roomLeaveTemplate = activeCharacterId
    ? (perCharacterMap[activeCharacterId]?.roomLeaveTemplate ?? null)
    : (snapshot.activeCosmetics.roomLeaveTemplate ?? null);
  const roomPresenceSale = roomPresenceRow
    ? flashSalePriceFor(flashSale, "cosmetic", roomPresenceRow.key, roomPresenceRow.cost)
    : null;
  async function doBuyRoomPresence() {
    if (!roomPresenceRow || !roomPresenceSale) return;
    const who = activeCharacterId ? "this character" : "your master account";
    if (!window.confirm(`Buy "${roomPresenceRow.name}" for ${roomPresenceSale.effectivePrice} Currency from ${who}'s pool?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await purchaseCosmetic("flair_room_presence", activeCharacterId);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Purchase failed");
    } finally {
      setBusy(false);
    }
  }

  // Session-presence is master-only, no character partition. Read
  // straight off the top-level snapshot fields.
  const sessionPresenceOwned = snapshot.activeCosmetics.sessionPresenceOwned ?? false;
  const sessionConnectTemplate = snapshot.activeCosmetics.sessionConnectTemplate ?? null;
  const sessionExitTemplate = snapshot.activeCosmetics.sessionExitTemplate ?? null;
  const sessionPresenceSale = sessionPresenceRow
    ? flashSalePriceFor(flashSale, "cosmetic", sessionPresenceRow.key, sessionPresenceRow.cost)
    : null;
  async function doBuySessionPresence() {
    if (!sessionPresenceRow || !sessionPresenceSale) return;
    // Always charges the master pool, session presence is account-
    // level, not per-character. Pass `null` to scope to master.
    if (!window.confirm(`Buy "${sessionPresenceRow.name}" for ${sessionPresenceSale.effectivePrice} Currency from your master account's pool?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await purchaseCosmetic("flair_session_presence", null);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Purchase failed");
    } finally {
      setBusy(false);
    }
  }

  // Migration 0192, profile flair purchase state. Ownership flows
  // through the snapshot (set on the matching identity row); the
  // actual editor + config lives in ProfileEditor → Flair tab,
  // so the card here is a single "Buy" CTA with a short
  // description pointing the buyer to the editor for setup.
  const profileVisitorsOwned = activeCharacterId
    ? (perCharacterMap[activeCharacterId]?.profileVisitorsOwned ?? false)
    : (snapshot.activeCosmetics.profileVisitorsOwned ?? false);
  const profileVisitorsSale = profileVisitorsRow
    ? flashSalePriceFor(flashSale, "cosmetic", profileVisitorsRow.key, profileVisitorsRow.cost)
    : null;
  async function doBuyProfileVisitors() {
    if (!profileVisitorsRow || !profileVisitorsSale) return;
    const who = activeCharacterId ? "this character" : "your master account";
    if (!window.confirm(`Buy "${profileVisitorsRow.name}" for ${profileVisitorsSale.effectivePrice} Currency from ${who}'s pool?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await purchaseCosmetic("flair_profile_visitors", activeCharacterId);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Purchase failed");
    } finally {
      setBusy(false);
    }
  }

  const profileMarqueeOwned = activeCharacterId
    ? (perCharacterMap[activeCharacterId]?.profileMarqueeOwned ?? false)
    : (snapshot.activeCosmetics.profileMarqueeOwned ?? false);
  const profileMarqueeSale = profileMarqueeRow
    ? flashSalePriceFor(flashSale, "cosmetic", profileMarqueeRow.key, profileMarqueeRow.cost)
    : null;
  async function doBuyProfileMarquee() {
    if (!profileMarqueeRow || !profileMarqueeSale) return;
    const who = activeCharacterId ? "this character" : "your master account";
    if (!window.confirm(`Buy "${profileMarqueeRow.name}" for ${profileMarqueeSale.effectivePrice} Currency from ${who}'s pool?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await purchaseCosmetic("flair_profile_marquee", activeCharacterId);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Purchase failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {err ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-sm text-keep-accent">{err}</div>
      ) : null}
      {/* Grid container, pre-arranges so adding a Flair row in admin
          auto-fills the next grid slot rather than requiring another
          layout pass. */}
      <div className="grid auto-rows-fr gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {inlineAvatarRow && inlineAvatarSale ? (
          <section data-shop-row={inlineAvatarRow.key} className="flex flex-col rounded border border-keep-rule bg-keep-bg/40 p-3">
            <header className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 font-semibold">
                  <span className="truncate">{inlineAvatarRow.name}</span>
                  <SalePip discountPct={inlineAvatarSale.discountPct} />
                </div>
                {inlineAvatarRow.description ? (
                  <p className="text-xs text-keep-muted">{inlineAvatarRow.description}</p>
                ) : null}
              </div>
              {!owns ? (
                <>
                  <PriceBlock
                    basePrice={inlineAvatarRow.cost}
                    effectivePrice={inlineAvatarSale.effectivePrice}
                    onSale={inlineAvatarSale.discountPct != null}
                  />
                  <button
                    type="button"
                    onClick={() => void doBuy()}
                    disabled={busy || activeWallet < inlineAvatarSale.effectivePrice}
                    title={activeWallet >= inlineAvatarSale.effectivePrice ? "Buy + auto-equip" : "Not enough Currency"}
                    className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
                  >
                    {busy ? "Working…" : "Buy"}
                  </button>
                </>
              ) : (
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={equipped}
                    onChange={(e) => void doToggle(e.target.checked)}
                    disabled={busy}
                  />
                  <span>{equipped ? "Equipped" : "Owned (off)"}</span>
                </label>
              )}
            </header>
          </section>
        ) : null}

        {profileBannerRow && bannerSale ? (
          <div data-shop-row={profileBannerRow.key} className="rounded">
            <ProfileBannerFlairCard
              row={profileBannerRow}
              sale={bannerSale}
              owned={bannerOwned}
              currentUrl={bannerUrl}
              activeCharacterId={activeCharacterId}
              activeWallet={activeWallet}
              busy={busy}
              onBuy={() => void doBuyBanner()}
              onSaved={() => void refresh()}
              onError={(message) => setErr(message)}
            />
          </div>
        ) : null}

        {typingPhraseRow && typingPhraseSale ? (
          <div data-shop-row={typingPhraseRow.key} className="rounded">
            <TypingPhraseFlairCard
              row={typingPhraseRow}
              sale={typingPhraseSale}
              owned={typingPhraseOwned}
              currentPhrase={typingPhrase}
              activeCharacterId={activeCharacterId}
              activeWallet={activeWallet}
              busy={busy}
              onBuy={() => void doBuyTypingPhrase()}
              onSaved={() => void refresh()}
              onError={(message) => setErr(message)}
            />
          </div>
        ) : null}

        {reactionSheetRow ? (
          <div data-shop-row={reactionSheetRow.key} className="rounded">
            <ReactionSheetFlairCard
              row={reactionSheetRow}
              activeWallet={activeWallet}
              onRefreshEarning={() => void refresh()}
            />
          </div>
        ) : null}

        {roomPresenceRow && roomPresenceSale ? (
          <div data-shop-row={roomPresenceRow.key} className="rounded">
            <PresenceTemplatesFlairCard
              row={roomPresenceRow}
            sale={roomPresenceSale}
            owned={roomPresenceOwned}
            firstLabel="Join"
            firstTemplate={roomJoinTemplate}
            firstDefault="{name} has entered the room."
            firstPlaceholder="{name} strolls into {room}."
            secondLabel="Leave"
            secondTemplate={roomLeaveTemplate}
            secondDefault="{name} has left the room."
            secondPlaceholder="{name} fades out of {room}."
            supportsRoomPlaceholder
            activeCharacterId={activeCharacterId}
            activeWallet={activeWallet}
            busy={busy}
            onBuy={() => void doBuyRoomPresence()}
            onSave={async (next) => {
              await patchRoomPresenceTemplates({
                joinTemplate: next.firstTemplate,
                leaveTemplate: next.secondTemplate,
                characterId: activeCharacterId,
              });
            }}
              onSaved={() => void refresh()}
              onError={(message) => setErr(message)}
            />
          </div>
        ) : null}

        {sessionPresenceRow && sessionPresenceSale ? (
          <div data-shop-row={sessionPresenceRow.key} className="rounded">
            <PresenceTemplatesFlairCard
              row={sessionPresenceRow}
              sale={sessionPresenceSale}
              owned={sessionPresenceOwned}
              firstLabel="Connect"
              firstTemplate={sessionConnectTemplate}
              firstDefault="{name} has connected."
              firstPlaceholder="{name} arrives at the Keep."
              secondLabel="Exit"
              secondTemplate={sessionExitTemplate}
              secondDefault="{name} has disconnected."
              secondPlaceholder="{name} fades into the night."
              supportsRoomPlaceholder={false}
              /* Session presence is master-only, pass null so the card
                 doesn't show a "this character" badge. */
              activeCharacterId={null}
              activeWallet={snapshot.master.currency}
              busy={busy}
              onBuy={() => void doBuySessionPresence()}
              onSave={async (next) => {
                await patchSessionPresenceTemplates({
                  connectTemplate: next.firstTemplate,
                  exitTemplate: next.secondTemplate,
                });
              }}
              onSaved={() => void refresh()}
              onError={(message) => setErr(message)}
            />
          </div>
        ) : null}

        {lurkingMasterRow && lurkingMasterSale ? (
          <section data-shop-row={lurkingMasterRow.key} className="flex flex-col rounded border border-keep-rule bg-keep-bg/40 p-3">
            <header className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 font-semibold">
                  <span className="truncate">{lurkingMasterRow.name}</span>
                  <SalePip discountPct={lurkingMasterSale.discountPct} />
                </div>
                {lurkingMasterRow.description ? (
                  <p className="text-xs text-keep-muted">{lurkingMasterRow.description}</p>
                ) : null}
              </div>
              {!lurkingMasterOwned ? (
                <>
                  <PriceBlock
                    basePrice={lurkingMasterRow.cost}
                    effectivePrice={lurkingMasterSale.effectivePrice}
                    onSale={lurkingMasterSale.discountPct != null}
                  />
                  <button
                    type="button"
                    onClick={() => void doBuyLurkingMaster()}
                    disabled={busy || activeWallet < lurkingMasterSale.effectivePrice}
                    title={activeWallet >= lurkingMasterSale.effectivePrice ? "Buy the Lurking Master cosmetic" : "Not enough Currency"}
                    className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
                  >
                    {busy ? "Working…" : "Buy"}
                  </button>
                </>
              ) : (
                <label className="flex items-center gap-2 text-xs" title="Hide your typing status from peers (admins still see it)">
                  <input
                    type="checkbox"
                    checked={lurkingMasterEnabled}
                    onChange={(e) => void doToggleLurking(e.target.checked)}
                    disabled={busy}
                  />
                  <span>{lurkingMasterEnabled ? "Lurking" : "Owned (off)"}</span>
                </label>
              )}
            </header>
            {lurkingMasterOwned && lurkingMasterEnabled ? (
              <p className="mt-2 text-[10px] italic text-keep-muted">
                You're hidden from peers' "is typing…" indicators. Admins still see you for moderation.
              </p>
            ) : null}
          </section>
        ) : null}

        {profileVisitorsRow && profileVisitorsSale ? (
          <ProfileFlairBuyCard
            row={profileVisitorsRow}
            sale={profileVisitorsSale}
            owned={profileVisitorsOwned}
            ownedCopy="Show your visitor count on your profile and read the member / external breakdown."
            buyDisabled={busy || activeWallet < profileVisitorsSale.effectivePrice}
            onBuy={() => void doBuyProfileVisitors()}
            onOpenConfig={() => openEditor({
              mode: activeCharacterId ? "character" : "master",
              characterId: activeCharacterId,
              initialTab: "flair",
            })}
          />
        ) : null}

        {profileMarqueeRow && profileMarqueeSale ? (
          <ProfileFlairBuyCard
            row={profileMarqueeRow}
            sale={profileMarqueeSale}
            owned={profileMarqueeOwned}
            ownedCopy="Configure your rotating quotes. Up to 10 lines, Markdown supported."
            buyDisabled={busy || activeWallet < profileMarqueeSale.effectivePrice}
            onBuy={() => void doBuyProfileMarquee()}
            onOpenConfig={() => openEditor({
              mode: activeCharacterId ? "character" : "master",
              characterId: activeCharacterId,
              initialTab: "flair",
            })}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Room Transitions tab (migration 0219). Top-level shop tab, parallel to Name
 * Styles + Borders. Self-only effects that play when YOU change rooms, bought
 * + equipped per identity. The buy/equip is gated server-side by the
 * `use_room_transitions` permission.
 */
function RoomTransitionsTab({ snapshot }: {
  snapshot: ReturnType<typeof useEarning.getState>["snapshot"] & {};
}) {
  const me = useChat((s) => s.me);
  const activeCharacterId = useChat((s) => s.activeCharacterId);
  const setMyActiveTransitionKey = useChat((s) => s.setMyActiveTransitionKey);
  const refresh = useEarning((s) => s.refresh);
  // Each transition's Preview plays the rite ON that transition's own card,
  // so the flourish is shown in context (no shared box you scroll away from).
  const cardRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!me?.permissions?.includes("use_room_transitions")) {
    return <p className="text-sm text-keep-muted">Room transitions have been disabled for your role by an admin.</p>;
  }

  const identity = activeCharacterId
    ? snapshot.activeCosmetics.byCharacter?.[activeCharacterId]
    : snapshot.activeCosmetics;
  const owned = new Set<string>(identity?.ownedTransitionKeys ?? []);
  const equippedKey = identity?.activeRoomTransitionKey ?? null;
  const wallet = activeCharacterId
    ? (snapshot.characters.find((c) => c.ownerId === activeCharacterId)?.currency ?? 0)
    : snapshot.master.currency;
  const who = activeCharacterId ? "this character" : "your master account";

  async function buy(t: RoomTransition) {
    if (!window.confirm(`Buy "${t.label}" for ${t.cost.toLocaleString()} Currency from ${who}'s pool?`)) return;
    setBusyKey(t.key); setErr(null);
    try { await purchaseTransition(t.key, activeCharacterId); await refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Purchase failed"); }
    finally { setBusyKey(null); }
  }
  async function equip(key: string | null) {
    setBusyKey(key ?? "__off"); setErr(null);
    try {
      await setActiveRoomTransition(key, activeCharacterId);
      setMyActiveTransitionKey(key);
      await refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : "Equip failed"); }
    finally { setBusyKey(null); }
  }

  return (
    <section>
      <h3 className="font-action text-lg text-keep-text">Room Transitions</h3>
      <p className="mt-1 text-xs text-keep-muted">
        A flourish that plays for YOU when you switch rooms — only you see it. Equipped per identity
        ({activeCharacterId ? "this character" : "your OOC / master account"}). Off = instant.
        Hit Preview on any rite to watch it play right on its card.
      </p>
      {err ? <p className="mt-2 text-xs text-keep-accent">{err}</p> : null}
      <div className="mt-3">
        <button
          type="button"
          onClick={() => void equip(null)}
          disabled={busyKey !== null}
          className={`rounded border px-3 py-1 text-xs ${equippedKey === null ? "border-keep-action text-keep-action" : "border-keep-rule text-keep-muted hover:text-keep-text"} disabled:opacity-50`}
        >
          {equippedKey === null ? "Off · instant ✓" : "Turn off (instant)"}
        </button>
      </div>
      <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {ROOM_TRANSITIONS.map((t) => {
          const isOwned = owned.has(t.key);
          const isEquipped = equippedKey === t.key;
          const rowBusy = busyKey === t.key;
          return (
            <li
              key={t.key}
              ref={(el) => {
                if (el) cardRefs.current.set(t.key, el);
                else cardRefs.current.delete(t.key);
              }}
              className="flex flex-col gap-1.5 overflow-hidden rounded-lg border border-keep-rule bg-keep-panel/30 p-3"
            >
              <div className="font-semibold text-keep-text">{t.label}</div>
              <p className="line-clamp-3 text-[11px] leading-snug text-keep-muted">{t.description}</p>
              <div className="mt-auto flex items-center gap-1.5 pt-1">
                <button
                  type="button"
                  onClick={() => void previewRoomTransition(t.key, cardRefs.current.get(t.key) ?? null)}
                  className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-[11px] text-keep-muted hover:text-keep-text"
                >
                  Preview
                </button>
                {isEquipped ? (
                  <span className="ml-auto text-[11px] font-semibold uppercase tracking-widest text-keep-action">Equipped ✓</span>
                ) : isOwned ? (
                  <button
                    type="button"
                    onClick={() => void equip(t.key)}
                    disabled={busyKey !== null}
                    className="ml-auto rounded border border-keep-action bg-keep-action/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-action disabled:opacity-50"
                  >
                    {rowBusy ? "…" : "Equip"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void buy(t)}
                    disabled={busyKey !== null || wallet < t.cost}
                    title={wallet < t.cost ? "Not enough currency" : undefined}
                    className="ml-auto rounded border border-keep-action bg-keep-action px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
                  >
                    {rowBusy ? "…" : `Buy · ${t.cost.toLocaleString()}`}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Minimal Flair card used by the two profile-customization flairs
 * (visitors counter + quote marquee) added in migration 0192.
 * Identical visual posture to the inline-avatar / banner cards but
 * no inline equip toggle or config form, the actual editor lives
 * in ProfileEditor → Flair, so this card just owns the Buy CTA +
 * a one-line "configure it here" pointer for buyers.
 */
function ProfileFlairBuyCard({
  row,
  sale,
  owned,
  ownedCopy,
  buyDisabled,
  onBuy,
  onOpenConfig,
}: {
  row: { key: string; name: string; description: string; cost: number };
  sale: ReturnType<typeof flashSalePriceFor>;
  owned: boolean;
  ownedCopy: string;
  buyDisabled: boolean;
  onBuy: () => void;
  /**
   * Optional deep-link to Edit Profile → Flair, the actual home of
   * this flair's configuration. When supplied, the owned-state card
   * surfaces a visible button instead of a `text-[10px] italic muted`
   * caption that buyers used to miss entirely (and report the
   * feature as broken).
   */
  onOpenConfig?: () => void;
}) {
  return (
    <section data-shop-row={row.key} className="flex flex-col rounded border border-keep-rule bg-keep-bg/40 p-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 font-semibold">
            <span className="truncate">{row.name}</span>
            <SalePip discountPct={sale.discountPct} />
          </div>
          {row.description ? (
            <p className="text-xs text-keep-muted">{row.description}</p>
          ) : null}
        </div>
        {!owned ? (
          <>
            <PriceBlock
              basePrice={row.cost}
              effectivePrice={sale.effectivePrice}
              onSale={sale.discountPct != null}
            />
            <button
              type="button"
              onClick={onBuy}
              disabled={buyDisabled}
              title={buyDisabled ? "Not enough Currency, or a purchase is already in flight" : `Buy ${row.name}`}
              className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
            >
              Buy
            </button>
          </>
        ) : (
          <span className="text-[11px] uppercase tracking-widest text-keep-system">Owned</span>
        )}
      </header>
      {owned ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded border border-keep-action/30 bg-keep-action/5 p-2">
          <p className="flex-1 text-xs text-keep-text">{ownedCopy}</p>
          {onOpenConfig ? (
            <button
              type="button"
              onClick={onOpenConfig}
              title="Open Edit Profile and jump to the Flair tab where this is configured."
              className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs font-semibold text-keep-action hover:bg-keep-action/25"
            >
              Configure in Edit Profile → Flair
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Banner-URL Flair card. Two render modes depending on ownership:
 *   - Not owned → "Buy" button + price (sale-aware). Same purchase
 *     flow as inline_avatar.
 *   - Owned → URL text input + Save button + Clear button. Live
 *     preview strip shows what the banner will look like on the
 *     profile modal. Empty input clears the slot on save.
 *
 * Per-identity scoping mirrors the rest of the Flair tab, the
 * active character's purchase is independent of master's, and a
 * user voicing a character writes to that character's slot.
 */
function ProfileBannerFlairCard({
  row,
  sale,
  owned,
  currentUrl,
  activeCharacterId,
  activeWallet,
  busy,
  onBuy,
  onSaved,
  onError,
}: {
  row: { key: string; name: string; description: string; cost: number };
  sale: ReturnType<typeof flashSalePriceFor>;
  owned: boolean;
  currentUrl: string | null;
  activeCharacterId: string | null;
  activeWallet: number;
  busy: boolean;
  onBuy: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState<string>(currentUrl ?? "");
  const [saving, setSaving] = useState(false);
  // Sync local draft when the prop changes (e.g. another tab edited
  // the URL, or the user switched identities and the active card
  // now reflects a different person's slot).
  useEffect(() => { setDraft(currentUrl ?? ""); }, [currentUrl]);

  async function save(next: string | null) {
    setSaving(true);
    try {
      await patchProfileBannerUrl(next, activeCharacterId);
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const trimmed = draft.trim();
  const dirty = trimmed !== (currentUrl ?? "");

  return (
    <section className="flex flex-col gap-2 rounded border border-keep-rule bg-keep-bg/40 p-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 font-semibold">
            <span className="truncate">{row.name}</span>
            <SalePip discountPct={sale.discountPct} />
          </div>
          {row.description ? (
            <p className="text-xs text-keep-muted">{row.description}</p>
          ) : null}
        </div>
        {!owned ? (
          <>
            <PriceBlock
              basePrice={row.cost}
              effectivePrice={sale.effectivePrice}
              onSale={sale.discountPct != null}
            />
            <button
              type="button"
              onClick={onBuy}
              disabled={busy || activeWallet < sale.effectivePrice}
              title={activeWallet >= sale.effectivePrice ? "Buy the banner slot" : "Not enough Currency"}
              className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
            >
              {busy ? "Working…" : "Buy"}
            </button>
          </>
        ) : null}
      </header>

      {owned ? (
        <>
          {/* Inline editor kept compact, paired with a tiny thumbnail
              that just confirms a link resolves. The full-size preview
              lives in Profile » Appearance, where the field reads as a
              banner-shaped strip at the size visitors actually see.
              Going small here keeps the Flair grid's columns aligned
              with the rest of the cosmetic cards. */}
          <div className="flex items-end gap-2">
            <label className="min-w-0 flex-1 block text-xs text-keep-muted">
              Image link
              <input
                type="url"
                inputMode="url"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="https://example.com/banner.png"
                className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm text-keep-text"
              />
            </label>
            {trimmed ? (
              <img
                src={trimmed}
                alt=""
                loading="lazy"
                className="block h-9 w-24 shrink-0 rounded border border-keep-rule bg-keep-banner/40 object-cover"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            ) : null}
          </div>
          <p className="text-[10px] text-keep-muted">
            Manage from Profile » Appearance to see a full-size preview.
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {currentUrl ? (
              <button
                type="button"
                onClick={() => void save(null)}
                disabled={saving}
                className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs text-keep-muted hover:bg-keep-banner disabled:opacity-50"
              >
                Clear
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void save(trimmed.length === 0 ? null : trimmed)}
              disabled={saving || !dirty}
              className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

/** Hard cap mirrored from the server's TYPING_PHRASE_MAX. Keeping
 *  it as a literal here (not a fetched value) is fine, the server
 *  re-clamps on save, this is purely for the live char-count hint
 *  and the textarea maxLength. */
const TYPING_PHRASE_MAX_CLIENT = 60;

/**
 * Custom typing-phrase Flair card. Two render modes depending on
 * ownership:
 *   - Not owned → "Buy" button + price (sale-aware).
 *   - Owned → text input + Save/Clear with a live preview of how
 *     the indicator will read ("YourName <phrase>").
 *
 * Mirrors the banner card's per-identity scoping rules, the
 * active character's phrase is independent of master's, and a user
 * voicing a character writes to that character's slot.
 */
function TypingPhraseFlairCard({
  row,
  sale,
  owned,
  currentPhrase,
  activeCharacterId,
  activeWallet,
  busy,
  onBuy,
  onSaved,
  onError,
}: {
  row: { key: string; name: string; description: string; cost: number };
  sale: ReturnType<typeof flashSalePriceFor>;
  owned: boolean;
  currentPhrase: string | null;
  activeCharacterId: string | null;
  activeWallet: number;
  busy: boolean;
  onBuy: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState<string>(currentPhrase ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(currentPhrase ?? ""); }, [currentPhrase]);

  // Active identity's display name, drives the live preview so
  // the user sees the same "Name <phrase>" shape peers will see.
  const meName = useChat((s) => {
    const me = s.me;
    if (!me) return "You";
    if (activeCharacterId) {
      for (const list of Object.values(s.occupants)) {
        const row = list.find((o) => o.userId === me.id && o.characterId === activeCharacterId);
        if (row) return row.displayName;
      }
    }
    return me.username;
  });

  async function save(next: string | null) {
    setSaving(true);
    try {
      await patchTypingPhrase(next, activeCharacterId);
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const trimmed = draft.trim();
  const dirty = trimmed !== (currentPhrase ?? "");
  const tooLong = trimmed.length > TYPING_PHRASE_MAX_CLIENT;

  return (
    <section className="flex flex-col gap-2 rounded border border-keep-rule bg-keep-bg/40 p-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 font-semibold">
            <span className="truncate">{row.name}</span>
            <SalePip discountPct={sale.discountPct} />
          </div>
          {row.description ? (
            <p className="text-xs text-keep-muted">{row.description}</p>
          ) : null}
        </div>
        {!owned ? (
          <>
            <PriceBlock
              basePrice={row.cost}
              effectivePrice={sale.effectivePrice}
              onSale={sale.discountPct != null}
            />
            <button
              type="button"
              onClick={onBuy}
              disabled={busy || activeWallet < sale.effectivePrice}
              title={activeWallet >= sale.effectivePrice ? "Buy the typing-phrase slot" : "Not enough Currency"}
              className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
            >
              {busy ? "Working…" : "Buy"}
            </button>
          </>
        ) : null}
      </header>

      {owned ? (
        <>
          <label className="block text-xs text-keep-muted">
            <div className="flex items-center justify-between">
              <span>Phrase</span>
              <span className={tooLong ? "text-keep-accent" : ""}>
                {trimmed.length}/{TYPING_PHRASE_MAX_CLIENT}
              </span>
            </div>
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={TYPING_PHRASE_MAX_CLIENT * 2 /* allow over-paste so the user sees the count flag */}
              placeholder="is scheming…"
              className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm text-keep-text"
            />
          </label>
          {/* Live preview, same shape peers will see in the
              indicator strip when this identity is the sole typer.
              Falls back to the default suffix on empty drafts so
              the user can compare. */}
          <div className="rounded border border-keep-rule bg-keep-banner/40 px-2 py-1 text-xs italic text-keep-muted">
            {trimmed
              ? `${meName} ${trimmed}`
              : `${meName} is typing… (default)`}
          </div>
          <p className="text-[10px] text-keep-muted">
            Up to {TYPING_PHRASE_MAX_CLIENT} characters. Replaces the default "is typing…" suffix when you're the only person typing. Admins can clear abusive phrases.
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {currentPhrase ? (
              <button
                type="button"
                onClick={() => void save(null)}
                disabled={saving}
                className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs text-keep-muted hover:bg-keep-banner disabled:opacity-50"
              >
                Clear
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void save(trimmed.length === 0 ? null : trimmed)}
              disabled={saving || !dirty || tooLong}
              className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

/** Hard cap on a single presence template. Matches PRESENCE_TEMPLATE_MAX
 *  in shared/presenceTemplate.ts; the textarea uses it for the
 *  character-count badge and a generous maxLength (× 2 so the user
 *  sees the count flag instead of being silently truncated). */
const PRESENCE_TEMPLATE_MAX_CLIENT = 100;

/**
 * Generic two-template Flair card, drives both the Custom Room
 * Entrance and Custom Session Greeting cards. Mirrors the
 * TypingPhraseFlairCard shape (Buy → Set/Clear input → live preview)
 * but lays out TWO inputs side by side (or stacked on narrow widths)
 * because each flair owns an enter/exit PAIR unlocked by the single
 * purchase.
 *
 * The room variant accepts `{room}` in addition to `{name}`; the
 * session variant accepts only `{name}`. `supportsRoomPlaceholder`
 * gates the help text + preview substitution.
 */
function PresenceTemplatesFlairCard({
  row,
  sale,
  owned,
  firstLabel,
  firstTemplate,
  firstDefault,
  firstPlaceholder,
  secondLabel,
  secondTemplate,
  secondDefault,
  secondPlaceholder,
  supportsRoomPlaceholder,
  activeCharacterId,
  activeWallet,
  busy,
  onBuy,
  onSave,
  onSaved,
  onError,
}: {
  row: { key: string; name: string; description: string; cost: number };
  sale: ReturnType<typeof flashSalePriceFor>;
  owned: boolean;
  firstLabel: string;
  firstTemplate: string | null;
  firstDefault: string;
  firstPlaceholder: string;
  secondLabel: string;
  secondTemplate: string | null;
  secondDefault: string;
  secondPlaceholder: string;
  supportsRoomPlaceholder: boolean;
  /** Null = master-only flair (session presence) OR room presence
   *  with no character active; a string = per-character scope. The
   *  card uses it only for the preview's identity name; the parent
   *  handler reads it directly for the PATCH call. */
  activeCharacterId: string | null;
  activeWallet: number;
  busy: boolean;
  onBuy: () => void;
  /** Caller wires this to the matching PATCH fetcher. Receives the
   *  draft pair (null = clear, string = set, but the caller only sees
   *  the resolved fields after normalize). */
  onSave: (next: {
    firstTemplate: string | null;
    secondTemplate: string | null;
  }) => Promise<void>;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [firstDraft, setFirstDraft] = useState<string>(firstTemplate ?? "");
  const [secondDraft, setSecondDraft] = useState<string>(secondTemplate ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => { setFirstDraft(firstTemplate ?? ""); }, [firstTemplate]);
  useEffect(() => { setSecondDraft(secondTemplate ?? ""); }, [secondTemplate]);

  // Active identity's display name, feeds the preview so the user
  // sees the same `{name}` substitution peers will see.
  const meName = useChat((s) => {
    const me = s.me;
    if (!me) return "You";
    if (activeCharacterId) {
      for (const list of Object.values(s.occupants)) {
        const r = list.find((o) => o.userId === me.id && o.characterId === activeCharacterId);
        if (r) return r.displayName;
      }
    }
    return me.username;
  });
  // Preview room name only used when supportsRoomPlaceholder. Picks
  // the user's current room from the chat store so the preview reads
  // realistically; falls back to a stand-in when not in any room.
  const previewRoom = useChat((s) => {
    if (!supportsRoomPlaceholder) return "";
    const cur = s.currentRoomId;
    if (!cur) return "the Keep";
    return s.rooms[cur]?.name ?? "the Keep";
  });

  function render(template: string, fallback: string): string {
    const src = template.trim().length > 0 ? template : fallback;
    return src
      .replace(/\{name\}/g, meName)
      .replace(/\{room\}/g, previewRoom);
  }

  const firstTrim = firstDraft.trim();
  const secondTrim = secondDraft.trim();
  const firstTooLong = firstTrim.length > PRESENCE_TEMPLATE_MAX_CLIENT;
  const secondTooLong = secondTrim.length > PRESENCE_TEMPLATE_MAX_CLIENT;
  const dirty = firstTrim !== (firstTemplate ?? "") || secondTrim !== (secondTemplate ?? "");
  const tooLong = firstTooLong || secondTooLong;

  async function save(opts: { clearAll?: boolean } = {}) {
    setSaving(true);
    try {
      if (opts.clearAll) {
        await onSave({ firstTemplate: null, secondTemplate: null });
      } else {
        await onSave({
          firstTemplate: firstTrim.length === 0 ? null : firstTrim,
          secondTemplate: secondTrim.length === 0 ? null : secondTrim,
        });
      }
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded border border-keep-rule bg-keep-bg/40 p-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 font-semibold">
            <span className="truncate">{row.name}</span>
            <SalePip discountPct={sale.discountPct} />
          </div>
          {row.description ? (
            <p className="text-xs text-keep-muted">{row.description}</p>
          ) : null}
        </div>
        {!owned ? (
          <>
            <PriceBlock
              basePrice={row.cost}
              effectivePrice={sale.effectivePrice}
              onSale={sale.discountPct != null}
            />
            <button
              type="button"
              onClick={onBuy}
              disabled={busy || activeWallet < sale.effectivePrice}
              title={activeWallet >= sale.effectivePrice ? `Buy ${row.name}` : "Not enough Currency"}
              className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
            >
              {busy ? "Working…" : "Buy"}
            </button>
          </>
        ) : null}
      </header>

      {owned ? (
        <>
          {(["first", "second"] as const).map((slot) => {
            const isFirst = slot === "first";
            const label = isFirst ? firstLabel : secondLabel;
            const value = isFirst ? firstDraft : secondDraft;
            const setValue = isFirst ? setFirstDraft : setSecondDraft;
            const trim = isFirst ? firstTrim : secondTrim;
            const long = isFirst ? firstTooLong : secondTooLong;
            const fallback = isFirst ? firstDefault : secondDefault;
            const ph = isFirst ? firstPlaceholder : secondPlaceholder;
            return (
              <div key={slot}>
                <label className="block text-xs text-keep-muted">
                  <div className="flex items-center justify-between">
                    <span>{label}</span>
                    <span className={long ? "text-keep-accent" : ""}>
                      {trim.length}/{PRESENCE_TEMPLATE_MAX_CLIENT}
                    </span>
                  </div>
                  <input
                    type="text"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    maxLength={PRESENCE_TEMPLATE_MAX_CLIENT * 2}
                    placeholder={ph}
                    className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm text-keep-text"
                  />
                </label>
                <div className="mt-1 rounded border border-keep-rule bg-keep-banner/40 px-2 py-1 text-xs italic text-keep-muted">
                  {render(value, fallback)}
                  {value.trim().length === 0 ? <span className="not-italic text-[10px]"> (default)</span> : null}
                </div>
              </div>
            );
          })}
          <p className="text-[10px] text-keep-muted">
            Use <code className="rounded bg-keep-banner px-1">{"{name}"}</code> for your name
            {supportsRoomPlaceholder ? <> and <code className="rounded bg-keep-banner px-1">{"{room}"}</code> for the room name</> : null}.
            Up to {PRESENCE_TEMPLATE_MAX_CLIENT} characters each. Admins can clear abusive templates.
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {(firstTemplate || secondTemplate) ? (
              <button
                type="button"
                onClick={() => void save({ clearAll: true })}
                disabled={saving}
                className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs text-keep-muted hover:bg-keep-banner disabled:opacity-50"
              >
                Clear both
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !dirty || tooLong}
              className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

/**
 * Custom Reaction Sheet Flair card (Phase 3). Unlike the banner /
 * typing-phrase cards, this is NOT a one-time purchase with a
 * subsequent "set your content" form. Each submission re-pays the
 * cost; the catalog row exists only as the pricing slot. The card's
 * single button opens the submission modal which contains the full
 * form + history list.
 */
function ReactionSheetFlairCard({
  row,
  activeWallet,
  onRefreshEarning,
}: {
  row: { key: string; name: string; description: string; cost: number };
  activeWallet: number;
  onRefreshEarning: () => void;
}) {
  // The modal pulls the active character from the chat store
  // directly, so the card doesn't need to thread the id through,
  // matches how the picker and chat composer scope their identity.
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col gap-2 rounded border border-keep-rule bg-keep-bg/40 p-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 font-semibold">
            <span className="truncate">{row.name}</span>
          </div>
          {row.description ? (
            <p className="text-xs text-keep-muted">{row.description}</p>
          ) : null}
        </div>
        <div className="text-xs text-keep-muted">
          <CoinAmount amount={row.cost} /> per submission
        </div>
      </header>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/25"
        >
          Submit / Manage…
        </button>
      </div>
      {open ? (
        <EmoticonSubmissionModal
          onClose={() => setOpen(false)}
          costAtSubmission={row.cost}
          activeWallet={activeWallet}
          onRefreshEarning={onRefreshEarning}
        />
      ) : null}
    </section>
  );
}

/* =========================================================
 *  Items tab, Shop + Inventory for the active identity.
 *
 *  Identity is the currently-voiced one (OOC master when no
 *  character is active, otherwise the active character). Each
 *  identity has its own inventory and its own currency pool, so
 *  switching identity via /char swaps BOTH the inventory list AND
 *  the wallet shown above the buy button. Nothing is shared
 *  across identities, the only legal way to move items is via
 *  the /give command (handled by the chat composer, not here).
 *
 *  Two sub-views:
 *    Inventory, items the active identity currently holds, with
 *                quantity and the per-item available commands so
 *                the user knows which /give /throw /drop work.
 *    Shop     , every enabled+forSale+in-window catalog row,
 *                with quantity stepper + Buy. Stack-cap respected
 *                client-side; server enforces too.
 * ========================================================= */

function ItemsTab({
  snapshot,
  initialSubTab,
  flashSale,
  focusKey,
}: {
  snapshot: ReturnType<typeof useEarning.getState>["snapshot"] & {};
  /** Deep-link landing sub-tab, defaults to "inventory" when omitted.
   *  Plumbed in from the `/shop` / `/collection` / `/pets` builtin
   *  commands via EarningDashboard's prop. */
  initialSubTab?: "inventory" | "shop" | "collection" | "pets";
  flashSale: FlashSaleResponse | null;
  focusKey: string | null;
}) {
  useShopRowFocus(focusKey);
  const me = useChat((s) => s.me);
  const activeCharacterId = useChat((s) => s.activeCharacterId);
  const refresh = useEarning((s) => s.refresh);
  // Flash Sale → Items deep-link lands on the shop sub-tab by default
  // (otherwise the user clicks an item-sale card and gets the
  // inventory tab where the item likely isn't yet, no scroll target).
  const [tab, setTab] = useState<"inventory" | "shop" | "collection" | "pets">(initialSubTab ?? (focusKey ? "shop" : "inventory"));
  // When arriving via Flash Sale, also reset the shop filters so the
  // target item isn't hidden by a leftover category chip or search
  // term, the user came here to buy a specific row, surface it
  // unconditionally.
  useEffect(() => {
    if (!focusKey) return;
    setTab("shop");
    setShopCategory("all");
    setShopQuery("");
  }, [focusKey]);
  // Shop category chip, "all" shows everything, otherwise filter to
  // that bucket. Stored in component state so flipping chips doesn't
  // round-trip through the URL or persist between dashboard opens.
  const [shopCategory, setShopCategory] = useState<ItemCategory | "all">("all");
  // Free-text shop search. Matches name / namePlural / description /
  // aliases (aliases aren't on the public catalog row, so we fall
  // back to name-only on the user side, see the filter below).
  const [shopQuery, setShopQuery] = useState("");
  // Inventory filter mirrors the shop's category + search pattern.
  // Independent state so flipping between tabs preserves each
  // filter independently, a user filtering inventory to "pet" can
  // pop over to shop without losing their inventory filter, and
  // vice versa.
  const [inventoryCategory, setInventoryCategory] = useState<ItemCategory | "all">("all");
  const [inventoryQuery, setInventoryQuery] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Resolve the active identity's display label + inventory + wallet.
  // Identity-switching reshapes EVERY field on this view, currency
  // pool drained on Buy, inventory rendered, wallet shown, and the
  // identity label in the header.
  const activeIdentity = useMemo(() => {
    if (activeCharacterId) {
      const c = snapshot.characters.find((x) => x.ownerId === activeCharacterId);
      return {
        label: c?.displayName ?? "Character",
        scope: "character" as const,
        currency: c?.currency ?? 0,
      };
    }
    return {
      label: snapshot.master.displayName,
      scope: "user" as const,
      currency: snapshot.master.currency,
    };
  }, [activeCharacterId, snapshot.characters, snapshot.master]);

  const inventory: InventoryEntry[] = useMemo(() => {
    if (activeCharacterId) {
      return snapshot.inventoryByCharacter?.[activeCharacterId] ?? [];
    }
    return snapshot.inventory ?? [];
  }, [activeCharacterId, snapshot.inventory, snapshot.inventoryByCharacter]);
  const inventoryByKey = useMemo(() => {
    const m = new Map<string, InventoryEntry>();
    for (const e of inventory) m.set(e.itemKey, e);
    return m;
  }, [inventory]);

  // Catalog. `shopItems` are the purchasable ones; `inventoryItems`
  // resolves each inventory row against the full catalog so disabled
  // items still render with their last-known name/icon (the entry
  // persists even if the admin disabled the item after acquisition).
  const catalog = snapshot.catalog.items ?? [];
  const catalogByKey = useMemo(() => {
    const m = new Map<string, ItemCatalogRow>();
    for (const c of catalog) m.set(c.key, c);
    return m;
  }, [catalog]);
  const shopItems = useMemo(() => catalog.filter((c) => c.enabled), [catalog]);

  // Collection pins for the active identity. Sparse 0..9; rendered
  // as a 10-tile grid with the entries overlaid by slot index.
  const collection: CollectionEntry[] = useMemo(() => {
    if (activeCharacterId) {
      return snapshot.collectionByCharacter?.[activeCharacterId] ?? [];
    }
    return snapshot.collection ?? [];
  }, [activeCharacterId, snapshot.collection, snapshot.collectionByCharacter]);
  // Pet Collection pins, sparse 0..4. Independent from the item
  // collection; only items with `category='pet'` are pinnable here.
  const petCollection: CollectionEntry[] = useMemo(() => {
    if (activeCharacterId) {
      return snapshot.petCollectionByCharacter?.[activeCharacterId] ?? [];
    }
    return snapshot.petCollection ?? [];
  }, [activeCharacterId, snapshot.petCollection, snapshot.petCollectionByCharacter]);

  async function doBuy(itemKey: string, quantity: number) {
    setBusyKey(itemKey);
    setErr(null);
    try {
      await buyItem(itemKey, quantity, activeCharacterId);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Purchase failed");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="space-y-3">
      {/* Active-identity strip so the user is never confused about
          which inventory + wallet they're acting on. Matches the
          framing used by NameStylesTab's "owned by THIS identity"
          subtext. */}
      <div className="rounded border border-keep-rule bg-keep-banner/40 px-3 py-2 text-xs">
        <div className="text-keep-muted">
          Showing <span className="font-semibold text-keep-text">{activeIdentity.label}</span>'s inventory.
          {activeCharacterId
            ? " Switch identity via /char to view another character's inventory."
            : " Switch to a character via /char to view that character's inventory."}
        </div>
      </div>

      {/* Mobile (<md): single dropdown for the sub-tabs + wallet
          inline. Same select-on-mobile pattern the rest of the
          dashboard / admin panel uses to keep tab strips from
          overflowing tight viewports. */}
      <div className="flex items-center gap-2 border-b border-keep-rule pb-2 md:hidden">
        <select
          value={tab}
          onChange={(e) => setTab(e.target.value as typeof tab)}
          aria-label="Items section"
          className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
        >
          <option value="inventory">Inventory ({inventory.length})</option>
          <option value="shop">▸ Shop ({shopItems.length})</option>
          <option value="collection">Collection ({collection.length}/10)</option>
          <option value="pets">Pets ({petCollection.length}/5)</option>
        </select>
        <span className="shrink-0 text-xs text-keep-muted">
          <CoinAmount amount={activeIdentity.currency} className="text-xs" />
        </span>
      </div>

      {/* Desktop (md+): button strip. Shop gets the action-color
          treatment to read as a primary CTA, Inventory / Collection
          / Pets are about MANAGING what you own; Shop is about
          acquiring. Even when not active, Shop is visually distinct
          from the muted "manage" tabs so a user opening this view
          for the first time spots the shop entry point without
          hunting through the strip. */}
      <div className="hidden flex-wrap items-center gap-2 border-b border-keep-rule pb-2 text-xs uppercase tracking-widest md:flex">
        <button
          type="button"
          onClick={() => setTab("inventory")}
          className={`rounded border border-keep-rule px-2 py-0.5 ${tab === "inventory" ? "bg-keep-bg" : "bg-keep-banner/40 hover:bg-keep-banner"}`}
        >
          Inventory ({inventory.length})
        </button>
        <button
          type="button"
          onClick={() => setTab("shop")}
          className={`rounded border px-3 py-1 font-semibold shadow-sm transition ${
            tab === "shop"
              ? "border-keep-action bg-keep-action/30 text-keep-action"
              : "border-keep-action bg-keep-action/10 text-keep-action hover:bg-keep-action/20"
          }`}
          title="Browse the shop"
        >
          🛒 Shop ({shopItems.length})
        </button>
        <button
          type="button"
          onClick={() => setTab("collection")}
          className={`rounded border border-keep-rule px-2 py-0.5 ${tab === "collection" ? "bg-keep-bg" : "bg-keep-banner/40 hover:bg-keep-banner"}`}
        >
          Collection ({collection.length}/10)
        </button>
        <button
          type="button"
          onClick={() => setTab("pets")}
          className={`rounded border border-keep-rule px-2 py-0.5 ${tab === "pets" ? "bg-keep-bg" : "bg-keep-banner/40 hover:bg-keep-banner"}`}
        >
          Pets ({petCollection.length}/5)
        </button>
        <span className="ml-auto self-center text-keep-muted">
          Wallet: <CoinAmount amount={activeIdentity.currency} className="text-xs" />
        </span>
      </div>

      {err ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-sm text-keep-accent">{err}</div>
      ) : null}

      {tab === "inventory" ? (
        <div className="space-y-2">
          {inventory.length === 0 ? (
            <p className="text-sm text-keep-muted">
              {activeIdentity.label} doesn't hold any items yet. Switch to "Shop" to browse or wait for someone to /give you one.
            </p>
          ) : (() => {
            // Inventory filter row, category select + free-text
            // search, mirroring the admin Items panel's lighter
            // single-row pattern (no chip strip). Inventories
            // typically run 5-30 items so we don't need the shop's
            // dense filter UI; one row is enough.
            //
            // Categories listed in the dropdown are only the ones
            // present in THIS inventory, empty buckets are hidden
            // so the picker doesn't list categories the user has
            // nothing in.
            const presentCategories = new Set<ItemCategory>();
            for (const e of inventory) {
              const r = catalogByKey.get(e.itemKey);
              if (r) presentCategories.add(r.category);
            }
            const orderedPresent = ITEM_CATEGORIES.filter((c) => presentCategories.has(c));
            const q = inventoryQuery.trim().toLowerCase();
            const filtered = inventory.filter((entry) => {
              const row = catalogByKey.get(entry.itemKey);
              if (!row) return q.length === 0 && inventoryCategory === "all"; // unknown items only show under "all" + empty search
              if (inventoryCategory !== "all" && row.category !== inventoryCategory) return false;
              if (q.length > 0) {
                const haystack = `${row.name} ${row.namePlural ?? ""} ${row.description}`.toLowerCase();
                if (!haystack.includes(q)) return false;
              }
              return true;
            });
            return (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={inventoryCategory}
                    onChange={(e) => setInventoryCategory(e.target.value as ItemCategory | "all")}
                    aria-label="Filter inventory by category"
                    className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
                  >
                    <option value="all">All categories ({inventory.length})</option>
                    {orderedPresent.map((c) => {
                      const count = inventory.filter((e) => catalogByKey.get(e.itemKey)?.category === c).length;
                      return (
                        <option key={c} value={c}>
                          {ITEM_CATEGORY_LABELS[c]} ({count})
                        </option>
                      );
                    })}
                  </select>
                  <input
                    type="search"
                    value={inventoryQuery}
                    onChange={(e) => setInventoryQuery(e.target.value)}
                    placeholder="Search inventory…"
                    className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
                  />
                  <span className="text-xs text-keep-muted">
                    Showing {filtered.length} of {inventory.length}
                  </span>
                </div>
                {filtered.length === 0 ? (
                  <p className="text-sm text-keep-muted">
                    {q.length > 0
                      ? `No items match "${inventoryQuery.trim()}" in this category.`
                      : "No items in this category."}
                  </p>
                ) : (
                  // Same grid scaffold the Shop tab uses so identity-
                  // owned inventory reads as the column/row companion
                  // to the catalog above. `auto-rows-fr` keeps cards in
                  // the same row height-aligned regardless of which
                  // ones have a 3-line description vs a one-liner.
                  <div className="grid auto-rows-fr gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {filtered.map((entry) => {
                      const row = catalogByKey.get(entry.itemKey);
                      if (!row) {
                        // Catalog row vanished, shouldn't happen given
                        // the FK on identity_inventory, but render a
                        // defensive fallback rather than crashing the tab.
                        return (
                          <article
                            key={entry.itemKey}
                            className="rounded border border-keep-rule bg-keep-bg/40 p-2 text-xs text-keep-muted"
                          >
                            Unknown item <code>{entry.itemKey}</code> × {entry.quantity.toLocaleString()}
                          </article>
                        );
                      }
                      return <InventoryRow key={entry.itemKey} item={row} quantity={entry.quantity} />;
                    })}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      ) : null}

      {tab === "shop" ? (
        <div className="space-y-2">
          {/* Category filter. "All" first, then every category that
              actually has at least one shop item, empty buckets get
              hidden so the affordance doesn't carry dead options.
              Mobile collapses the chip strip to a single <select>
              dropdown; desktop renders the full chip row. */}
          {(() => {
            const cats = (["all", ...ITEM_CATEGORIES] as const)
              .filter((c) => c === "all" || shopItems.some((it) => it.category === c));
            const countFor = (c: ItemCategory | "all") => c === "all"
              ? shopItems.length
              : shopItems.filter((it) => it.category === c).length;
            const labelFor = (c: ItemCategory | "all") => c === "all" ? "All" : ITEM_CATEGORY_LABELS[c];
            return (
              <>
                {/* Mobile dropdown */}
                <div className="md:hidden">
                  <select
                    value={shopCategory}
                    onChange={(e) => setShopCategory(e.target.value as ItemCategory | "all")}
                    aria-label="Shop category"
                    className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
                  >
                    {cats.map((c) => (
                      <option key={c} value={c}>
                        {labelFor(c)} ({countFor(c)})
                      </option>
                    ))}
                  </select>
                </div>
                {/* Desktop chips */}
                <div className="hidden flex-wrap gap-1 border-b border-keep-rule/40 pb-2 text-[10px] uppercase tracking-widest md:flex">
                  {cats.map((c) => {
                    const active = shopCategory === c;
                    return (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setShopCategory(c as ItemCategory | "all")}
                        className={`rounded border px-2 py-0.5 ${
                          active
                            ? "border-keep-action bg-keep-action/15 text-keep-action"
                            : "border-keep-rule bg-keep-banner/30 text-keep-muted hover:bg-keep-banner/60"
                        }`}
                      >
                        {labelFor(c)} <span className="ml-0.5 opacity-70">({countFor(c)})</span>
                      </button>
                    );
                  })}
                </div>
              </>
            );
          })()}
          {/* Free-text search. Sits below the category row so the
              two filters compose visually, pick a bucket, then
              refine by name. Matches against name + plural +
              description (the public catalog doesn't expose aliases,
              so the admin's "knife" → dagger trick from the admin
              panel only works there; we match what users see on
              the cards). */}
          <input
            type="search"
            value={shopQuery}
            onChange={(e) => setShopQuery(e.target.value)}
            placeholder="Search the shop…"
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
          />
          {(() => {
            const q = shopQuery.trim().toLowerCase();
            const filtered = shopItems.filter((it) => {
              if (shopCategory !== "all" && it.category !== shopCategory) return false;
              if (q.length > 0) {
                const haystack = `${it.name} ${it.namePlural ?? ""} ${it.description}`.toLowerCase();
                if (!haystack.includes(q)) return false;
              }
              return true;
            });
            if (filtered.length === 0) {
              return (
                <p className="text-sm text-keep-muted">
                  {q.length > 0
                    ? `No items match "${shopQuery.trim()}" in this category.`
                    : "No items in this category right now."}
                </p>
              );
            }
            // Grid layout, better use of horizontal space than the
            // previous full-width stacked rows. 1 col mobile, 2 col
            // tablet, 3 col desktop. `auto-rows-fr` keeps the per-row
            // card heights aligned even when one card has a longer
            // description than its neighbor.
            return (
              <div className="grid auto-rows-fr gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((item) => {
                  const owned = inventoryByKey.get(item.key)?.quantity ?? 0;
                  return (
                    <div key={item.key} data-shop-row={item.key} className="rounded">
                      <ShopRow
                        item={item}
                        owned={owned}
                        wallet={activeIdentity.currency}
                        busy={busyKey === item.key}
                        onBuy={(qty) => void doBuy(item.key, qty)}
                        flashSale={flashSale}
                      />
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      ) : null}

      {tab === "collection" ? (
        <CollectionEditor
          identityLabel={activeIdentity.label}
          characterId={activeCharacterId}
          inventory={inventory}
          catalogByKey={catalogByKey}
          collection={collection}
          maxSlots={10}
          pickerFilter={(row) => row.category !== "pet"}
          commitFn={setCollectionSlots}
          copy={{
            header: (
              <>
                Pin up to 10 items from <span className="font-semibold text-keep-text">{activeIdentity.label}</span>'s inventory to feature on their profile. Pets pin to the separate Pet Collection (5 slots), switch to the Pets tab to manage those.
              </>
            ),
            emptyInventory: "No items in this identity's inventory to pin. Visit the Shop tab or wait for someone to /give you one.",
            pickerEmpty: "No non-pet items in this inventory. Pets pin to the Pets tab instead.",
          }}
          onError={setErr}
          onSaved={() => void refresh()}
        />
      ) : null}

      {tab === "pets" ? (
        <CollectionEditor
          identityLabel={activeIdentity.label}
          characterId={activeCharacterId}
          inventory={inventory}
          catalogByKey={catalogByKey}
          collection={petCollection}
          maxSlots={5}
          pickerFilter={(row) => row.category === "pet"}
          commitFn={setPetCollectionSlots}
          renameFn={setPetNickname}
          copy={{
            header: (
              <>
                Pin up to 5 pets from <span className="font-semibold text-keep-text">{activeIdentity.label}</span>'s inventory to feature on their profile. Non-pet items live in the Collection tab. Give each pet a nickname after pinning to show "Whiskers (Maine Coon)" on the profile.
              </>
            ),
            emptyInventory: "No items in this identity's inventory yet. Visit the Shop tab and look for the Pets category.",
            pickerEmpty: "No pets in this inventory. Buy one from the Shop's Pets category to pin it here.",
          }}
          onError={setErr}
          onSaved={() => void refresh()}
        />
      ) : null}

      {!me ? null : (
        <p className="text-[10px] text-keep-muted">
          Tip: items move between identities only via the <code>/give</code> command. <code>/throw</code> and <code>/drop</code> consume the item for flavor, nothing transfers.
        </p>
      )}
    </div>
  );
}

/** Collection slots editor. Parameterized over `maxSlots` + item
 *  filter + commit fn so the same component drives both the 10-slot
 *  Item Collection and the 5-slot Pet Collection. Each slot is
 *  either empty (with a "+ Pin" button) or filled (icon + name +
 *  small clear control). Picking a slot opens an inline picker
 *  below the grid that lists the current identity's inventory,
 *  filtered to whichever item kind this editor accepts. */
function CollectionEditor({
  identityLabel,
  characterId,
  inventory,
  catalogByKey,
  collection,
  maxSlots,
  pickerFilter,
  commitFn,
  renameFn,
  copy,
  onError,
  onSaved,
}: {
  identityLabel: string;
  characterId: string | null;
  inventory: InventoryEntry[];
  catalogByKey: Map<string, ItemCatalogRow>;
  collection: CollectionEntry[];
  /** Number of slots in the grid (10 for items, 5 for pets). */
  maxSlots: number;
  /** Predicate selecting which catalog rows are pickable. Items
   *  collection passes `row.category !== 'pet'`; pet collection
   *  passes `row.category === 'pet'`. */
  pickerFilter: (row: ItemCatalogRow) => boolean;
  /** Save callback. Same wire shape (slots[] + characterId) for both
   *  collection kinds; differs only in which server endpoint is hit. */
  commitFn: (slots: { slot: number; itemKey: string | null }[], characterId: string | null) => Promise<void>;
  /** Optional rename callback, when set, the editor surfaces the
   *  current nickname under each pinned slot's catalog name and adds
   *  an inline "Pet name" input in the slot's edit panel. Only the
   *  pet collection wires this; the item collection has no per-item
   *  nicknames so omits it. */
  renameFn?: (slot: number, nickname: string | null, characterId: string | null) => Promise<{ slot: number; nickname: string | null }>;
  /** Per-kind UI copy, header sentence + empty-picker message.
   *  `header` is a ReactNode so callers can interpolate the identity
   *  label inline; the other two are plain strings for the empty
   *  states. */
  copy: {
    header: React.ReactNode;
    emptyInventory: string;
    pickerEmpty: string;
  };
  onError: (msg: string) => void;
  onSaved: () => void;
}) {
  const [editingSlot, setEditingSlot] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  // Picker filter state. Lives at the editor level (not the picker
  // panel) so flipping between slots preserves the admin's filter
  // selection, they're typically pinning a series of related items
  // and reapplying the same filter each time would be friction.
  const [pickerCategory, setPickerCategory] = useState<ItemCategory | "all">("all");
  const [pickerQuery, setPickerQuery] = useState("");

  // Slot index → catalog row of the pinned item (when pinned).
  const slotMap = useMemo(() => {
    const m = new Map<number, ItemCatalogRow>();
    for (const c of collection) {
      const row = catalogByKey.get(c.itemKey);
      if (row) m.set(c.slot, row);
    }
    return m;
  }, [collection, catalogByKey]);

  // Slot index → owner-assigned nickname (pet collection only; the
  // item-collection entries don't carry a nickname so the map stays
  // sparse-empty for them). Lookup keyed off the same `collection`
  // array the slotMap walks so nickname renders stay in sync with the
  // pinned-itemKey state.
  const slotNicknames = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of collection) {
      if (c.nickname && c.nickname.trim().length > 0) m.set(c.slot, c.nickname);
    }
    return m;
  }, [collection]);

  // Local rename state for the inline "Pet name" input shown in the
  // edit panel. Re-seeded from the current nickname whenever the
  // editing slot changes so reopening the panel doesn't show a stale
  // draft from a previous session.
  const [renameDraft, setRenameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  useEffect(() => {
    if (editingSlot === null) {
      setRenameDraft("");
      return;
    }
    setRenameDraft(slotNicknames.get(editingSlot) ?? "");
  }, [editingSlot, slotNicknames]);

  async function commitRename(override?: string | null) {
    if (renameFn == null || editingSlot == null || renaming) return;
    // Accept an explicit override (e.g. from the Clear button) so the
    // call doesn't have to wait for a state-update round trip. When no
    // override is provided we use the live draft.
    const source = override === undefined ? renameDraft : (override ?? "");
    const trimmed = source.replace(/\s+/g, " ").trim();
    const next = trimmed.length > 0 ? trimmed : null;
    // No-op when the draft matches the current value, skip the
    // round trip rather than churning the ledger.
    const current = slotNicknames.get(editingSlot) ?? null;
    if (next === current) return;
    setRenaming(true);
    try {
      await renameFn(editingSlot, next, characterId);
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Rename failed");
    } finally {
      setRenaming(false);
    }
  }

  // Don't suggest the SAME item twice, the showcase reads as
  // disorganized when slots 0/3/7 all show the same cookie tile.
  // Filter the picker against the slots that ALREADY pin this key
  // (except the slot being edited, where re-picking the current key
  // is a no-op rather than a duplicate).
  const pinnedKeysExceptEditing = useMemo(() => {
    if (editingSlot === null) return new Set<string>();
    const s = new Set<string>();
    for (const c of collection) if (c.slot !== editingSlot) s.add(c.itemKey);
    return s;
  }, [collection, editingSlot]);

  // Picker source, the active identity's inventory, filtered by the
  // editor's kind predicate (items vs pets). Lazy-resolved so an
  // empty inventory short-circuits before we hit the catalog.
  const pickerCandidates = useMemo(() => {
    return inventory
      .map((entry) => {
        const row = catalogByKey.get(entry.itemKey);
        return row ? { entry, row } : null;
      })
      .filter((x): x is { entry: InventoryEntry; row: ItemCatalogRow } => x !== null && pickerFilter(x.row));
  }, [inventory, catalogByKey, pickerFilter]);

  async function commit(slot: number, itemKey: string | null) {
    setSaving(true);
    try {
      await commitFn([{ slot, itemKey }], characterId);
      setEditingSlot(null);
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // Grid column count, fits 5-wide for items (10 slots → 2 rows of 5)
  // and 5-wide for pets (5 slots → 1 row of 5).
  const gridCols = "grid-cols-5";

  return (
    <div className="space-y-3">
      <p className="text-xs text-keep-muted">{copy.header}</p>
      <div className={`grid ${gridCols} gap-2`}>
        {Array.from({ length: maxSlots }, (_, slot) => {
          const pinned = slotMap.get(slot);
          const isEditing = editingSlot === slot;
          return (
            <button
              key={slot}
              type="button"
              onClick={() => setEditingSlot(isEditing ? null : slot)}
              className={`flex aspect-square flex-col items-center justify-center gap-1 rounded border p-2 text-center text-[11px] ${
                isEditing
                  ? "border-keep-action bg-keep-action/10"
                  : pinned
                    ? "border-keep-rule bg-keep-bg/40 hover:bg-keep-banner"
                    : "border-keep-rule/60 bg-keep-banner/20 hover:bg-keep-banner/40 text-keep-muted"
              }`}
              title={pinned ? `${pinned.name}, click to change` : `Slot ${slot + 1} (empty)`}
            >
              {pinned ? (
                <>
                  {/* Filled-slot icon fills the tile (which is
                      aspect-square in a 5-col grid, so it can run
                      hundreds of pixels wide on desktop). Capped at
                      256px so a single tile can't dwarf the dashboard
                      on ultrawide. min-h-0 lets the flex parent shrink
                      the image to leave room for the label. */}
                  {pinned.iconUrl ? (
                    <img
                      src={pinned.iconUrl}
                      alt=""
                      loading="lazy"
                      className="min-h-0 w-full max-w-[256px] flex-1 rounded border border-keep-rule/60 bg-keep-bg object-contain"
                    />
                  ) : (
                    <div
                      className="grid min-h-0 w-full max-w-[256px] flex-1 place-items-center rounded border border-keep-rule/60 bg-keep-banner/40 text-keep-muted"
                      aria-hidden="true"
                    >
                      <span className="text-2xl font-semibold sm:text-3xl md:text-4xl lg:text-5xl">
                        {pinned.name.slice(0, 1).toUpperCase()}
                      </span>
                    </div>
                  )}
                  {/* When a nickname is set, the nickname becomes the
                      primary label and the catalog name (breed/species)
                      reads as a subtitle. Mirrors the ProfileModal pin
                      so the owner sees the same shape they're showing
                      to visitors. */}
                  {slotNicknames.has(slot) ? (
                    <>
                      <span className="line-clamp-1 break-all font-semibold">{slotNicknames.get(slot)}</span>
                      <span className="line-clamp-1 break-all text-[9px] italic text-keep-muted">{pinned.name}</span>
                    </>
                  ) : (
                    <span className="line-clamp-1 break-all font-semibold">{pinned.name}</span>
                  )}
                </>
              ) : (
                <>
                  <span className="text-2xl text-keep-muted">+</span>
                  <span>Slot {slot + 1}</span>
                </>
              )}
            </button>
          );
        })}
      </div>

      {editingSlot !== null ? (
        <div className="rounded border border-keep-action/40 bg-keep-action/5 p-3 space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-xs uppercase tracking-widest text-keep-muted">
              Pinning slot {editingSlot + 1}
            </span>
            <div className="flex gap-2">
              {slotMap.has(editingSlot) ? (
                <button
                  type="button"
                  onClick={() => void commit(editingSlot, null)}
                  disabled={saving}
                  className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs text-keep-muted hover:text-keep-accent disabled:opacity-50"
                >
                  Clear slot
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setEditingSlot(null)}
                className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs text-keep-muted hover:bg-keep-banner"
              >
                Cancel
              </button>
            </div>
          </div>
          {/* Rename row, only when a pet is pinned in this slot AND
              the parent provided a renameFn (pet collection only).
              Empty input clears the nickname; the server normalizes
              whitespace and treats empty as null. */}
          {renameFn && slotMap.has(editingSlot) ? (
            <div className="flex flex-wrap items-end gap-2 rounded border border-keep-rule bg-keep-bg/30 p-2">
              <label className="min-w-0 flex-1 text-[10px] uppercase tracking-widest text-keep-muted">
                Pet name (optional)
                <input
                  type="text"
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); void commitRename(); }
                  }}
                  maxLength={40}
                  placeholder={slotMap.get(editingSlot)?.name ?? "Name your pet"}
                  className="mt-1 block w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm normal-case tracking-normal text-keep-text"
                />
              </label>
              <button
                type="button"
                onClick={() => void commitRename()}
                disabled={renaming || renameDraft.replace(/\s+/g, " ").trim() === (slotNicknames.get(editingSlot) ?? "")}
                className="rounded border border-keep-action bg-keep-action/15 px-2 py-1 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
              >
                {renaming ? "…" : "Save name"}
              </button>
              {slotNicknames.has(editingSlot) ? (
                <button
                  type="button"
                  onClick={() => { setRenameDraft(""); void commitRename(null); }}
                  disabled={renaming}
                  className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs text-keep-muted hover:text-keep-accent disabled:opacity-50"
                >
                  Clear
                </button>
              ) : null}
            </div>
          ) : null}
          {inventory.length === 0 ? (
            <p className="text-xs text-keep-muted">{copy.emptyInventory}</p>
          ) : pickerCandidates.length === 0 ? (
            <p className="text-xs text-keep-muted">{copy.pickerEmpty}</p>
          ) : (() => {
            // Apply category + search on top of the kind-filtered
            // candidate list. The kind filter (item vs pet) is
            // applied upstream in `pickerCandidates`; category and
            // search narrow within that pool. Only categories
            // ACTUALLY present in the candidates are surfaced,
            // for the pet collection that usually means just one
            // bucket, but the dropdown stays functional regardless.
            const presentCategories = new Set<ItemCategory>();
            for (const { row } of pickerCandidates) presentCategories.add(row.category);
            const orderedPresent = ITEM_CATEGORIES.filter((c) => presentCategories.has(c));
            const q = pickerQuery.trim().toLowerCase();
            const filtered = pickerCandidates.filter(({ row }) => {
              if (pickerCategory !== "all" && row.category !== pickerCategory) return false;
              if (q.length > 0) {
                const haystack = `${row.name} ${row.namePlural ?? ""} ${row.description}`.toLowerCase();
                if (!haystack.includes(q)) return false;
              }
              return true;
            });
            return (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {/* Only render the category select if there's more
                      than one bucket to choose between, the pet
                      collection picker degenerates to just "pet", so
                      a single-option dropdown would be dead UI. */}
                  {orderedPresent.length > 1 ? (
                    <select
                      value={pickerCategory}
                      onChange={(e) => setPickerCategory(e.target.value as ItemCategory | "all")}
                      aria-label="Filter pinnable items by category"
                      className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs"
                    >
                      <option value="all">All ({pickerCandidates.length})</option>
                      {orderedPresent.map((c) => {
                        const count = pickerCandidates.filter((x) => x.row.category === c).length;
                        return (
                          <option key={c} value={c}>
                            {ITEM_CATEGORY_LABELS[c]} ({count})
                          </option>
                        );
                      })}
                    </select>
                  ) : null}
                  <input
                    type="search"
                    value={pickerQuery}
                    onChange={(e) => setPickerQuery(e.target.value)}
                    placeholder="Search…"
                    className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs"
                  />
                </div>
                {filtered.length === 0 ? (
                  <p className="text-xs text-keep-muted">
                    {q.length > 0
                      ? `No items match "${pickerQuery.trim()}".`
                      : "No items in this category."}
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                    {filtered.map(({ entry, row }) => {
                      const alreadyPinnedElsewhere = pinnedKeysExceptEditing.has(entry.itemKey);
                      return (
                        <button
                          key={entry.itemKey}
                          type="button"
                          onClick={() => void commit(editingSlot, entry.itemKey)}
                          disabled={saving || alreadyPinnedElsewhere}
                          title={alreadyPinnedElsewhere ? "Already pinned to another slot." : `Pin ${row.name} here.`}
                          className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg/40 px-2 py-1 text-left hover:bg-keep-banner disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <ItemIcon iconUrl={row.iconUrl} name={row.name} size="sm" />
                          <span className="min-w-0 flex-1 truncate text-sm">{row.name}</span>
                          <span className="shrink-0 text-[10px] uppercase tracking-widest text-keep-muted">
                            × {entry.quantity}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      ) : null}
    </div>
  );
}

/** One inventory row, icon, name × quantity, description, and a
 *  hint listing which commands (give/throw/drop) the item supports.
 *  Disabled items render with a "no longer available" chip so the
 *  user knows why /buy is gone but they still hold the stack. */
function InventoryRow({ item, quantity }: { item: ItemCatalogRow; quantity: number }) {
  const commandList = [
    item.availableCommands.give ? "/give" : null,
    item.availableCommands.throw ? "/throw" : null,
    item.availableCommands.drop ? "/drop" : null,
  ].filter(Boolean);
  return (
    <article className="flex flex-col gap-2 rounded border border-keep-rule bg-keep-bg/40 p-3">
      {/* Icon centered at the top of the card, sized to match the
          Shop tab's grid card so an item in inventory visually
          rhymes with its shop-tab counterpart. Quantity chip
          overlays the icon's bottom-right corner so the "× N" count
          stays attached to the visual without stealing a row of
          vertical space. The relative wrapper sits on the ICON,
          not the centering container, so `absolute` anchors to the
          icon's actual edges regardless of viewport size. */}
      <div className="flex justify-center">
        <div className="relative">
          {item.iconUrl ? (
            <img
              src={item.iconUrl}
              alt=""
              loading="lazy"
              className="h-20 w-20 rounded border border-keep-rule/60 bg-keep-bg object-contain sm:h-24 sm:w-24 lg:h-28 lg:w-28"
            />
          ) : (
            <div
              aria-hidden="true"
              className="grid h-20 w-20 place-items-center rounded border border-keep-rule/60 bg-keep-banner/40 text-keep-muted sm:h-24 sm:w-24 lg:h-28 lg:w-28"
            >
              <span className="text-3xl font-semibold sm:text-4xl">{item.name.slice(0, 1).toUpperCase()}</span>
            </div>
          )}
          <span
            className="absolute -bottom-1 -right-1 rounded-full border border-keep-rule bg-keep-bg px-1.5 py-0.5 text-[11px] font-semibold tabular-nums shadow"
            title={`You have ${quantity.toLocaleString()}`}
          >
            ×{quantity.toLocaleString()}
          </span>
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-1.5">
          <span className="truncate font-semibold">{formatItemName(item, quantity)}</span>
          {!item.enabled ? (
            <span className="rounded border border-keep-accent/40 bg-keep-accent/10 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent">
              no longer available
            </span>
          ) : null}
        </div>
        <p className="line-clamp-2 text-xs text-keep-muted" title={item.description}>{item.description}</p>
        {commandList.length > 0 && item.enabled ? (
          <p className="mt-auto pt-1 text-[10px] uppercase tracking-widest text-keep-muted">
            {commandList.join(" · ")}
          </p>
        ) : null}
      </div>
    </article>
  );
}

/** Shop card, vertical layout for grid display. Icon on top, name +
 *  description in the middle, price + qty + Buy at the bottom.
 *
 *  Buy disables when the price exceeds the active identity's wallet
 *  or the stack would overflow. The sale window's "opens in / ends in"
 *  reason renders inline when `purchasable=false` so the user knows
 *  why an item they can see isn't buyable yet. When the row is today's
 *  flash-sale pick, `<SalePip />` appears next to the name and the
 *  base price is struck through with the discounted price in accent.
 *  Server applies the same discount on the actual purchase, the UI
 *  display is faithful to what the user will be charged. */
function ShopRow({
  item,
  owned,
  wallet,
  busy,
  onBuy,
  flashSale,
}: {
  item: ItemCatalogRow;
  owned: number;
  wallet: number;
  busy: boolean;
  onBuy: (quantity: number) => void;
  flashSale: FlashSaleResponse | null;
}) {
  const sale = flashSalePriceFor(flashSale, "item", item.key, item.price);
  const effectiveUnitPrice = sale.effectivePrice;
  const [qty, setQty] = useState(1);
  // No per-item stack cap on the buyable quantity, players
  // accumulate without ceiling, by design. `maxBuyable` is now
  // wallet-bound only. (The catalog row still carries a
  // `stackLimit` value the admin tool exposes, but no runtime gate
  // reads it on the shop / give / raffle paths.)
  const maxBuyable = Math.floor(wallet / Math.max(1, effectiveUnitPrice)) || 0;
  const clampedQty = Math.min(Math.max(1, qty), Math.max(1, maxBuyable));
  const total = effectiveUnitPrice * clampedQty;
  const blockedReason = useMemo(() => {
    if (!item.enabled) return "Not available.";
    if (!item.forSale) return "Not currently for sale.";
    const now = Date.now();
    if (item.saleStartsAt && now < item.saleStartsAt) {
      return `Sale opens ${new Date(item.saleStartsAt).toLocaleString()}.`;
    }
    if (item.saleEndsAt && now >= item.saleEndsAt) return "Sale ended.";
    if (wallet < effectiveUnitPrice) return "Not enough Currency.";
    return null;
  }, [item, wallet, effectiveUnitPrice]);

  return (
    <article className="flex flex-col gap-2 rounded border border-keep-rule bg-keep-bg/40 p-3">
      {/* Icon centered at top of the card. Sized down from the
          previous full-width row variant so the card fits 3-up at
          desktop widths without dominating the available space. */}
      <div className="flex justify-center">
        {item.iconUrl ? (
          <img
            src={item.iconUrl}
            alt=""
            loading="lazy"
            className="h-20 w-20 rounded border border-keep-rule/60 bg-keep-bg object-contain sm:h-24 sm:w-24 lg:h-28 lg:w-28"
          />
        ) : (
          <div
            aria-hidden="true"
            className="grid h-20 w-20 place-items-center rounded border border-keep-rule/60 bg-keep-banner/40 text-keep-muted sm:h-24 sm:w-24 lg:h-28 lg:w-28"
          >
            <span className="text-3xl font-semibold sm:text-4xl">{item.name.slice(0, 1).toUpperCase()}</span>
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate font-semibold">{item.name}</span>
          <SalePip discountPct={sale.discountPct} />
        </div>
        <p className="line-clamp-2 text-xs text-keep-muted" title={item.description}>{item.description}</p>
        <div className="mt-1 flex flex-wrap items-baseline gap-2">
          <PriceBlock basePrice={item.price} effectivePrice={effectiveUnitPrice} onSale={sale.discountPct != null} />
          {owned > 0 ? (
            <span className="text-[10px] uppercase tracking-widest text-keep-muted">
              you own {owned.toLocaleString()}
            </span>
          ) : null}
        </div>
        {item.saleEndsAt && item.purchasable ? (
          <p className="text-[10px] uppercase tracking-widest text-keep-action">
            on sale until {new Date(item.saleEndsAt).toLocaleString()}
          </p>
        ) : null}
      </div>
      {/* Bottom action row pinned via mt-auto so cards of different
          description lengths line their Buy buttons up. */}
      <div className="mt-auto flex items-center justify-end gap-2">
        <input
          type="number"
          min={1}
          max={Math.max(1, maxBuyable)}
          value={clampedQty}
          onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
          disabled={!item.purchasable || maxBuyable < 1 || busy}
          className="w-16 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-right text-sm disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => onBuy(clampedQty)}
          disabled={!item.purchasable || maxBuyable < 1 || busy || blockedReason !== null}
          title={blockedReason ?? `Buy ${clampedQty} for ${total.toLocaleString()} Currency`}
          className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
        >
          {busy ? "Working…" : `Buy${clampedQty > 1 ? ` × ${clampedQty}` : ""}`}
        </button>
      </div>
      {blockedReason && !busy ? (
        <p className="text-[11px] text-keep-muted">{blockedReason}</p>
      ) : null}
    </article>
  );
}

/** Item icon tile. Renders the uploaded image when present; otherwise
 *  a placeholder square showing the item's first letter so the layout
 *  doesn't collapse for items the admin hasn't iconed yet. */
function ItemIcon({
  iconUrl,
  name,
  size,
}: {
  iconUrl: string | null;
  name: string;
  size: "sm" | "md";
}) {
  const px = size === "md" ? 48 : 32;
  if (iconUrl) {
    return (
      <img
        src={iconUrl}
        alt=""
        width={px}
        height={px}
        className="shrink-0 rounded border border-keep-rule/60 bg-keep-bg object-contain"
      />
    );
  }
  return (
    <div
      className="shrink-0 rounded border border-keep-rule/60 bg-keep-banner/40 grid place-items-center text-keep-muted"
      style={{ width: px, height: px }}
      aria-hidden="true"
    >
      <span className="text-base font-semibold">{name.slice(0, 1).toUpperCase()}</span>
    </div>
  );
}
