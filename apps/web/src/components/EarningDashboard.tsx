/**
 * Earning dashboard modal — the user-facing surface for the
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

import { useEffect, useMemo, useState } from "react";
import { Modal, MODAL_CARD_CONTENT } from "./Modal.js";
import { DisplayPrivacyRow } from "./DisplayPrivacyRow.js";
import { useEarning, lookupRankTier, progressToNextTier } from "../state/earning.js";
import { useChat } from "../state/store.js";
import {
  equipCosmetic,
  fetchEarningCatalog,
  fetchEarningLedger,
  formatLedgerReason,
  patchNameStyleConfig,
  patchEarningSettings,
  purchaseBorder,
  purchaseCosmetic,
  purchaseNameStyle,
  setActiveNameStyle,
  type CatalogResponse,
  type LedgerEntry,
  type NameStyleCatalogRow,
  type OwnedStyle,
  type PoolView,
  type RankTierRow,
} from "../lib/earning.js";
import { BorderedAvatar } from "./BorderedAvatar.js";
import { CoinAmount } from "./CoinAmount.js";
import { StyledName } from "./StyledName.js";
import { CloseButton } from "./CloseButton.js";

interface Props {
  onClose: () => void;
}

type DashboardTab = "overview" | "ledger" | "settings" | "styles" | "borders" | "cosmetics";

export function EarningDashboard({ onClose }: Props) {
  const snapshot = useEarning((s) => s.snapshot);
  const loading = useEarning((s) => s.loading);
  const error = useEarning((s) => s.error);
  const refresh = useEarning((s) => s.refresh);
  const me = useChat((s) => s.me);
  const [tab, setTab] = useState<DashboardTab>("overview");

  // Re-fetch on mount so a freshly-opened dashboard reflects any
  // earnings that landed while the modal was closed (rank-up events
  // already updated the unack list live; this catches wallet drift if
  // a credit somehow missed the live event).
  useEffect(() => {
    void refresh();
  }, [refresh]);

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
              tab strip was hard to scan at <lg widths — even the
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
            <option value="styles">Name Styles</option>
            <option value="borders">Borders</option>
            <option value="cosmetics">Cosmetics</option>
            <option value="settings">Settings</option>
          </select>
          {/* Desktop: the horizontal tab strip stays as the primary
              affordance. Hidden on mobile (lg:flex pairs with the
              `lg:hidden` on the select above). */}
          <nav className="keep-scroll-strip hidden min-w-0 flex-1 gap-1 overflow-x-auto text-xs uppercase tracking-widest lg:flex">
            <TabBtn active={tab === "overview"} onClick={() => setTab("overview")}>Overview</TabBtn>
            <TabBtn active={tab === "ledger"} onClick={() => setTab("ledger")}>Activity</TabBtn>
            <TabBtn active={tab === "styles"} onClick={() => setTab("styles")}>Name Styles</TabBtn>
            <TabBtn active={tab === "borders"} onClick={() => setTab("borders")}>Borders</TabBtn>
            <TabBtn active={tab === "cosmetics"} onClick={() => setTab("cosmetics")}>Cosmetics</TabBtn>
            <TabBtn active={tab === "settings"} onClick={() => setTab("settings")}>Settings</TabBtn>
          </nav>
          <CloseButton onClick={onClose} />
        </div>

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
            <p className="text-sm text-keep-muted">No earning record yet — earn XP from chat or forums to start.</p>
          ) : null}

          {snapshot && tab === "overview" ? <OverviewTab snapshot={snapshot} /> : null}
          {snapshot && tab === "ledger" ? <LedgerTab characters={snapshot.characters.map((c) => ({ id: c.ownerId, name: c.displayName }))} /> : null}
          {snapshot && tab === "settings" ? <SettingsTab snapshot={snapshot} myId={me?.id ?? null} /> : null}
          {snapshot && tab === "styles" ? <NameStylesTab snapshot={snapshot} /> : null}
          {snapshot && tab === "borders" ? <BordersTab snapshot={snapshot} /> : null}
          {snapshot && tab === "cosmetics" ? <CosmeticsTab snapshot={snapshot} /> : null}
        </div>
      </div>
    </Modal>
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

/* =========================================================
 *  Section 1 (header) + Section 2 (wallets)
 * ========================================================= */

function OverviewTab({ snapshot }: { snapshot: ReturnType<typeof useEarning.getState>["snapshot"] & {} }) {
  const masterRank = lookupRankTier(snapshot, snapshot.master.rankKey, snapshot.master.tier);
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
      {/* Hero band — sigil renders LEFT at 11rem so the chevron art
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
 * Welcome / explainer card shown when a fresh account opens the
 * dashboard for the first time and everything is zero. Fades out
 * naturally once any pool earns its first XP.
 *
 * Drops the user onto the "what does this even do" footing without
 * forcing them to leave the modal — the longer-form Earning guide
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
        <li><b>XP</b> grows your <b>rank</b> — the sigil shown next to your name in chat and the userlist.</li>
        <li><b>Currency</b> goes into your wallet, ready to spend on name styles, avatar borders, and other cosmetics here in the dashboard.</li>
      </ul>
      <p className="mt-2 text-keep-text">You earn both at the same time from:</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12px] text-keep-text">
        <li>Chat messages (long enough to be meaningful — a single "ok" doesn't count)</li>
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
   * rank lockup at the top of the modal — sized large enough that
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
        // letting the sibling render — done inline via a CSS handle.
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
 *  Section 3 — Activity ledger
 * ========================================================= */

function LedgerTab({ characters }: { characters: Array<{ id: string; name: string }> }) {
  const [scope, setScope] = useState<{ kind: "user" } | { kind: "character"; id: string; name: string }>({ kind: "user" });
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Re-fetch from scratch whenever scope changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setEntries([]);
    setCursor(null);
    setDone(false);
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
  }, [scope]);

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
              <div>{formatLedgerReason(e.reason)}</div>
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
 *  Section 7 — Settings (privacy toggle)
 * ========================================================= */

function SettingsTab({ snapshot, myId }: { snapshot: ReturnType<typeof useEarning.getState>["snapshot"] & {}; myId: string | null }) {
  // Both privacy flags share one save handler — patchEarningSettings
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
          Rank, tier, and sigil are always visible — rank is a public identity tag. XP and Currency
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
          Editor's Privacy tab — the component is shared from
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
            <li><code>/currency</code> — show your wallets</li>
            <li><code>/currency [user]</code> — look up another user's Currency (honors their privacy)</li>
            <li><code>/currency send [target] [amount]</code> — transfer Currency to a user or character</li>
            <li><code>/exp</code> — show your XP, rank, and any borders you can buy</li>
            <li><code>/exp [user]</code> — look up another user's rank</li>
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
      <p className="mt-1">Coming in {phase}. The data plumbing is already in place — only the buy / equip UI is pending.</p>
    </div>
  );
}

/* =========================================================
 *  Section 4 — Name Styles
 *
 *  Three tabs by ownership state:
 *    Owned     — the user owns these. Equip / unequip + per-style
 *                color picker. Live preview against the user's
 *                own display name.
 *    Available — enabled catalog styles the user doesn't own yet.
 *                Shows the buy button + cost.
 *    Locked    — placeholder for future "earn-only" gating. Empty
 *                in Phase 3 (every style is buyable).
 * ========================================================= */

function NameStylesTab({ snapshot }: { snapshot: ReturnType<typeof useEarning.getState>["snapshot"] & {} }) {
  const me = useChat((s) => s.me);
  const refresh = useEarning((s) => s.refresh);
  const [tab, setTab] = useState<"owned" | "available">("owned");
  const [err, setErr] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const styles = snapshot.catalog.nameStyles;
  const ownedKeys = useMemo(
    () => new Set(snapshot.ownedStyles.map((o) => o.styleKey)),
    [snapshot.ownedStyles],
  );
  const owned = styles.filter((s) => ownedKeys.has(s.key));
  const available = styles.filter((s) => !ownedKeys.has(s.key));
  const activeKey = snapshot.activeCosmetics.activeNameStyleKey;
  const ownedConfigByKey = useMemo(() => {
    const out = new Map<string, Record<string, unknown> | null>();
    for (const o of snapshot.ownedStyles) {
      let cfg: Record<string, unknown> | null = null;
      if (o.configJson) {
        try { cfg = JSON.parse(o.configJson) as Record<string, unknown>; }
        catch { cfg = null; }
      }
      out.set(o.styleKey, cfg);
    }
    return out;
  }, [snapshot.ownedStyles]);

  async function buy(key: string, cost: number) {
    if (!window.confirm(`Buy this style for ${cost} Currency?`)) return;
    setBusyKey(key);
    setErr(null);
    try {
      await purchaseNameStyle(key);
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
      await setActiveNameStyle(key);
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
      await patchNameStyleConfig(key, config);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusyKey(null);
    }
  }

  const previewName = me?.username ?? "Username";

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
        <div className="space-y-2">
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
            owned.map((s) => (
              <OwnedStyleCard
                key={s.key}
                style={s}
                config={ownedConfigByKey.get(s.key) ?? null}
                previewName={previewName}
                isActive={s.key === activeKey}
                busy={busyKey === s.key}
                onEquip={() => void equip(s.key === activeKey ? null : s.key)}
                onSaveConfig={(cfg) => void saveConfig(s.key, cfg)}
              />
            ))
          )}
        </div>
      ) : null}

      {tab === "available" ? (
        <div className="space-y-2">
          {available.length === 0 ? (
            <p className="text-sm text-keep-muted">You own every available style. Nice.</p>
          ) : (
            available.map((s) => (
              <AvailableStyleCard
                key={s.key}
                style={s}
                previewName={previewName}
                busy={busyKey === s.key}
                affordable={snapshot.master.currency >= s.cost}
                onBuy={() => void buy(s.key, s.cost)}
              />
            ))
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
}: {
  style: NameStyleCatalogRow;
  config: Record<string, unknown> | null;
  previewName: string;
  isActive: boolean;
  busy: boolean;
  onEquip: () => void;
  onSaveConfig: (config: Record<string, unknown> | null) => void;
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

  return (
    <div className={`rounded border ${isActive ? "border-keep-action" : "border-keep-rule"} bg-keep-bg/40 p-3`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{style.name}</div>
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

      <div className="mt-3 rounded border border-keep-rule/60 bg-keep-bg/60 px-3 py-2 text-2xl font-bold">
        <StyledName displayName={previewName} styleKey={style.key} config={draft} />
      </div>

      <div className="mt-3 flex flex-wrap gap-3">
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
}: {
  style: NameStyleCatalogRow;
  previewName: string;
  busy: boolean;
  affordable: boolean;
  onBuy: () => void;
}) {
  return (
    <div className="rounded border border-keep-rule bg-keep-bg/40 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{style.name}</div>
          {style.description ? <div className="text-xs text-keep-muted">{style.description}</div> : null}
        </div>
        <CoinAmount amount={style.cost} className="text-xs uppercase tracking-widest text-keep-muted" />
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
      <div className="mt-3 rounded border border-keep-rule/60 bg-keep-bg/60 px-3 py-2 text-2xl font-bold">
        <StyledName displayName={previewName} styleKey={style.key} config={{ color1: "#ff7a45", color2: "#ffb47a", glow: "rgba(255,170,80,0.6)" }} />
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
 *  Section 5 — Rank Borders (Phase 4)
 *
 *  Three buckets:
 *    Eligible to buy — Tier IV of this rank reached at some
 *                      point but the user hasn't purchased the
 *                      border yet.
 *    Owned          — borders the user already bought. Equip one
 *                      via /earning/me/settings { selectedBorderRankKey }
 *                      (handled by the existing patchEarningSettings).
 *    Locked         — borders the user isn't eligible for yet
 *                      (haven't crossed Tier IV). Shown muted with
 *                      a "Reach <rank> IV" hint.
 *
 *  Eligibility check mirrors the server: peak >= this rank's order
 *  AND at least Tier IV on the peak (or the peak is higher than
 *  this rank, in which case every lower rank's capstone was
 *  necessarily traversed).
 * ========================================================= */

function BordersTab({ snapshot }: { snapshot: ReturnType<typeof useEarning.getState>["snapshot"] & {} }) {
  const refresh = useEarning((s) => s.refresh);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Pull the viewer's own avatar from the room-occupant cosmetics
  // cache (same source that drives the chat-line inline avatars).
  // Lets every preview show the user's actual portrait inside the
  // frame — not an initials chip stand-in. Falls back to null when
  // the user has no occupant row in any open room yet, in which
  // case the BorderedAvatar shows initials.
  const me = useChat((s) => s.me);
  const viewerAvatarUrl = useChat((s) => {
    if (!me) return null;
    for (const list of Object.values(s.occupants)) {
      const row = list.find((o) => o.userId === me.id);
      if (row?.avatarUrl) return row.avatarUrl;
    }
    return null;
  });

  const ownedKeys = useMemo(
    () => new Set(snapshot.ownedBorders.map((b) => b.rankKey)),
    [snapshot.ownedBorders],
  );
  const selectedKey = snapshot.master.selectedBorderRankKey;

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

  // Eligibility map. We pre-compute it once rather than per-card
  // because the calculation walks the rank order list.
  const eligibleKeys = useMemo(() => {
    const peakKey = snapshot.master.maxRankKeyEverHeld;
    const peakTier = snapshot.master.maxTierEverHeld ?? 0;
    if (!peakKey) return new Set<string>();
    const peakRank = snapshot.catalog.ranks.find((r) => r.key === peakKey);
    if (!peakRank) return new Set<string>();
    const out = new Set<string>();
    for (const r of snapshot.catalog.ranks) {
      if (r.order < peakRank.order) out.add(r.key);
      else if (r.order === peakRank.order && peakTier >= 4) out.add(r.key);
    }
    return out;
  }, [snapshot.master.maxRankKeyEverHeld, snapshot.master.maxTierEverHeld, snapshot.catalog.ranks]);

  async function buy(rankKey: string) {
    if (!window.confirm("Buy this rank's border?")) return;
    setBusyKey(rankKey);
    setErr(null);
    try {
      await purchaseBorder(rankKey);
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
      await patchEarningSettings({ selectedBorderRankKey: rankKey });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Equip failed");
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
          <div className="flex flex-col gap-3">
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
          <div className="flex flex-col gap-3">
            {available.map(({ tier, rank }) => (
              <BorderCard
                key={tier.rankKey}
                tier={tier}
                rankName={rank!.name}
                state="available"
                busy={busyKey === tier.rankKey}
                affordable={snapshot.master.currency >= (tier.borderCost ?? 0)}
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
          <div className="flex flex-col gap-3">
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
          container — the avatar fills the frame's inner ring so the
          preview shows the border on the user's actual portrait.
          The frame is intentionally NOT muted on locked tiles —
          earlier we wrapped the whole card in `opacity-60`, which
          washed out the gold/silver detailing of the frames the
          user is trying to evaluate. Only the text (rank name +
          unlock copy) dims to signal locked state. */}
      <BorderedAvatar
        avatarUrl={userAvatarUrl ?? null}
        name={userDisplayName}
        borderRankKey={tier.rankKey}
        size="xl"
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
 *  Section 6 — Cosmetics (Phase 4)
 *
 *  Currently a single row: `inline_avatar`. Buy + on/off toggle.
 *  Purchase is one-time; the toggle is free to flip after.
 * ========================================================= */

function CosmeticsTab({ snapshot }: { snapshot: ReturnType<typeof useEarning.getState>["snapshot"] & {} }) {
  const refresh = useEarning((s) => s.refresh);
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

  if (loading) return <p className="text-sm text-keep-muted">Loading cosmetics…</p>;
  const inlineAvatarRow = catalog?.cosmetics.find((c) => c.key === "inline_avatar");
  if (!inlineAvatarRow) return <p className="text-sm text-keep-muted">No cosmetics available right now.</p>;

  // The user "owns" inline_avatar when they've ever toggled it on or
  // we see the cosmetic active. We surface that here by checking
  // active state; a more rigorous check would look at the ledger,
  // but the server-side purchase endpoint sets enabled=true so the
  // flag suffices for the UI's buy vs equip gate.
  const owns = snapshot.activeCosmetics.inlineAvatarEnabled;
  const equipped = snapshot.activeCosmetics.inlineAvatarEnabled;

  async function doBuy() {
    if (!window.confirm(`Buy "${inlineAvatarRow!.name}" for ${inlineAvatarRow!.cost} Currency?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await purchaseCosmetic("inline_avatar");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Purchase failed");
    } finally {
      setBusy(false);
    }
  }
  async function doToggle(next: boolean) {
    setBusy(true);
    setErr(null);
    try {
      await equipCosmetic("inline_avatar", next);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {err ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-sm text-keep-accent">{err}</div>
      ) : null}
      <section className="rounded border border-keep-rule bg-keep-bg/40 p-3">
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{inlineAvatarRow.name}</div>
            {inlineAvatarRow.description ? (
              <p className="text-xs text-keep-muted">{inlineAvatarRow.description}</p>
            ) : null}
          </div>
          {!owns ? (
            <>
              <CoinAmount amount={inlineAvatarRow.cost} className="text-xs uppercase tracking-widest text-keep-muted" />
              <button
                type="button"
                onClick={() => void doBuy()}
                disabled={busy || snapshot.master.currency < inlineAvatarRow.cost}
                title={snapshot.master.currency >= inlineAvatarRow.cost ? "Buy + auto-equip" : "Not enough Currency"}
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
    </div>
  );
}
