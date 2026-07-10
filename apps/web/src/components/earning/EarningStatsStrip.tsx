/**
 * EarningStatsStrip, small, glanceable Earning read-out for the
 * chat composer area.
 *
 * Shows three at-a-glance facts: current rank (text), coin pouch +
 * Currency total, and a thin XP progress bar to the next tier. Lives
 * in two places per the spec:
 *   - Desktop (md+): inline with the formatting toolbar, pushed to
 *     the right via `ml-auto` so it sits opposite the formatting
 *     buttons.
 *   - Mobile (< md): a standalone row ABOVE the formatting toolbar,
 *     same content, full-width.
 *
 * Always renders (even before the snapshot loads, or for accounts with
 * no Earning row yet) so the system is discoverable from a fresh
 * login, zero-state reads "Unranked · 0 · 0 XP" with the icons.
 *
 * Live deltas: when `earning:earned` fires, the store updates the
 * matching pool (master or per-character). The strip selects the
 * pool for the currently-active identity (master when OOC, the
 * character's own pool when in character) and diffs against the
 * previous render's totals, popping a floating `+N XP` / `+N coin`
 * chip that bounces up and fades out (~3.2s). Lighter than toasts,
 * in-context next to the totals they belong to, matches the project
 * ethos of "no video-game toasts." Clicking the strip opens the
 * dashboard. Switching characters resets the diff baseline so a
 * cross-pool delta doesn't pop a spurious burst.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useEarning, lookupRankTier, progressToNextTier } from "../../state/earning.js";
import { useChat } from "../../state/store.js";
import { formatNumber } from "../../lib/intlFormat.js";

interface Props {
  /**
   * Click handler that opens the Earning dashboard. When OMITTED the strip
   * renders as a plain, non-interactive read-out (a `<div>`, no hover, no
   * tap target). The mobile placement omits it on purpose so the full-width
   * read-out isn't one giant accidental-tap button.
   */
  onOpenEarning?: () => void;
  /** Optional className for the wrapper, used to control md+/mobile visibility. */
  className?: string;
}

interface Burst {
  id: string;
  xpDelta: number;
  coinDelta: number;
}

export function EarningStatsStrip({ onOpenEarning, className }: Props) {
  const { t } = useTranslation("earning");
  const snapshot = useEarning((s) => s.snapshot);
  const loading = useEarning((s) => s.loading);
  const error = useEarning((s) => s.error);
  // Active identity drives which pool the strip displays. Switching
  // characters flips the readout (xp/currency/rank) to that character's
  // pool; OOC / master falls back to snapshot.master. Without this the
  // strip stayed pinned to master and never reflected per-character
  // progression, and the burst chip never popped on character-scope
  // earnings because it was diffing the wrong totals.
  const activeCharacterId = useChat((s) => s.activeCharacterId);
  const pool = useMemo(() => {
    if (!snapshot) return null;
    if (activeCharacterId) {
      const charPool = snapshot.characters.find((c) => c.ownerId === activeCharacterId);
      // Defensive fallback: a character that just got created might not
      // be in the snapshot yet (the next /earning/me refresh fills it
      // in). Show the master totals in the meantime rather than zeros.
      if (charPool) return charPool;
    }
    return snapshot.master;
  }, [snapshot, activeCharacterId]);

  // Live-delta bursts. We diff the active pool's xp/currency vs the
  // previous render; positive deltas push a transient "burst" that the
  // markup renders as a floating +N chip with a CSS bounce animation.
  // Negative or zero deltas don't pop anything (spends shouldn't feel
  // like an "earn"). Auto-expires after the animation finishes so the
  // chip doesn't pile up off-screen.
  //
  // Identity-switch handling: prevRef is keyed on the pool's ownerId so
  // switching characters resets the comparison baseline cleanly, the
  // first render under the new identity is treated as a fresh settle
  // (no spurious "+1000 XP" burst from the cross-pool delta), then
  // subsequent earned events bump from there.
  const prevRef = useRef<{ ownerId: string; xp: number; currency: number } | null>(null);
  const [bursts, setBursts] = useState<Burst[]>([]);
  useEffect(() => {
    if (!pool) {
      prevRef.current = null;
      return;
    }
    const prev = prevRef.current;
    prevRef.current = { ownerId: pool.ownerId, xp: pool.xp, currency: pool.currency };
    // First settle for THIS identity (either initial mount, or just
    // switched characters): no burst, we don't want a "+N" pop on
    // load or on /char switch.
    if (!prev || prev.ownerId !== pool.ownerId) return;
    const xpDelta = pool.xp - prev.xp;
    const coinDelta = pool.currency - prev.currency;
    if (xpDelta <= 0 && coinDelta <= 0) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setBursts((bs) => [...bs, { id, xpDelta: Math.max(0, xpDelta), coinDelta: Math.max(0, coinDelta) }]);
    // Linger time must match the `earn-burst` CSS keyframe duration in
    // styles.css (currently 3.2s). Mismatched values either chop the
    // tail off the fade or leave a stale node mounted in the DOM.
    const t = window.setTimeout(() => {
      setBursts((bs) => bs.filter((b) => b.id !== id));
    }, 3200);
    return () => window.clearTimeout(t);
  }, [pool?.ownerId, pool?.xp, pool?.currency]);

  const { rank, tierRow } = lookupRankTier(snapshot, pool?.rankKey ?? null, pool?.tier ?? null);
  const progress = progressToNextTier(snapshot, pool ?? {
    scope: "user",
    ownerId: "",
    displayName: "",
    xp: 0,
    currency: 0,
    rankKey: null,
    tier: null,
    rankName: null,
    tierLabel: null,
    sigilImageUrl: null,
    maxRankKeyEverHeld: null,
    maxTierEverHeld: null,
    selectedBorderRankKey: null,
    selectedFreeformBorderKey: null,
    hideCurrencyCount: false,
    hideXpCount: false,
  });
  const pct = progress ? Math.round(progress.pct * 100) : 0;
  const rankLabel = rank
    ? `${rank.name}${tierRow ? ` ${tierRow.label}` : ""}`
    : t("unranked");
  const xp = pool?.xp ?? 0;
  const currency = pool?.currency ?? 0;

  // Resolved title for the wrapper. Surfacing a clear loading/error
  // hint here makes it easy to debug a stuck "zero" state, a fetch
  // 401 or 500 used to silently render the same all-zeros UI as a
  // genuinely fresh account, with no signal which case you were in.
  const title = error
    ? t("strip.fetchFailedTitle", { error })
    : loading && !snapshot
      ? t("strip.loadingTitle")
      : t("strip.openTitle");

  // Interactive only when a handler is supplied (desktop). Mobile renders a
  // plain read-out so the bar isn't a giant link.
  const interactive = typeof onOpenEarning === "function";
  // `relative` anchors the floating burst chips to the strip. `bg-black/10` +
  // `px-[15px]` give the rank / coin / XP triad a grouped dark panel. The
  // hover affordance only applies when the strip is actually clickable.
  const wrapperClassName =
    `relative flex items-center gap-2 rounded bg-black/10 px-[15px] py-0.5 text-[11px] leading-tight text-keep-muted ${interactive ? "hover:bg-keep-banner/40 hover:text-keep-text" : ""} ${className ?? ""}`;
  const content = (
    <>
      {/* Rank text, uppercase tracked, matches other meta chips. */}
      <span className="hidden font-action uppercase tracking-widest text-keep-text sm:inline">
        {rankLabel}
      </span>
      {/* Faint vertical divider between rank and currency. The
          `aria-hidden` keeps screen readers from announcing pipe
          characters between adjacent groups. */}
      <span aria-hidden className="hidden h-4 w-px shrink-0 bg-keep-rule/60 sm:block" />
      {/* Currency: coin pouch icon + total. Pouch sized at 1.5rem to
          read clearly at the bottom-of-toolbar context (h-4 / 1rem
          earlier looked like a tiny chip and disappeared into the
          row). */}
      <span className="flex shrink-0 items-center gap-1">
        {/* Pouch wrapper is its own positioning context so the +N
            burst can anchor directly over the icon. The wrapper is
            sized to match the pouch image so `left-1/2 -translate-x-1/2`
            centers the chip horizontally on the pouch itself, not on
            the wider pouch-plus-number group. */}
        <span className="relative inline-flex" style={{ width: "1.75rem", height: "1.75rem" }}>
          <img
            src="/assets/earning/cache_pouch.png"
            alt=""
            aria-hidden
            className="select-none"
            style={{ width: "1.75rem", height: "1.75rem" }}
            draggable={false}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
          {bursts
            .filter((b) => b.coinDelta > 0)
            .map((b) => (
              <span
                key={b.id}
                className="earn-burst pointer-events-none absolute left-1/2 -top-5 -translate-x-1/2 whitespace-nowrap font-semibold text-keep-action"
              >
                +{formatNumber(b.coinDelta)}
              </span>
            ))}
        </span>
        <span className="font-semibold tabular-nums text-keep-text">
          {formatNumber(currency)}
        </span>
      </span>
      {/* Faint vertical divider between currency and XP bar. */}
      <span aria-hidden className="h-4 w-px shrink-0 bg-keep-rule/60" />
      {/* XP bar, thin, fills the available width on mobile,
          fixed-ish width on desktop. */}
      <span className="flex min-w-[80px] flex-1 items-center gap-1.5 sm:min-w-[120px] sm:max-w-[180px]">
        <span className="h-1.5 flex-1 overflow-hidden rounded bg-keep-rule/40">
          <span
            className="block h-full bg-keep-action transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        </span>
        {/* XP label is its own positioning context so the +N XP
            burst can anchor directly over it, matching the
            coin-pouch placement on the left side. */}
        <span className="relative shrink-0 text-[10px] tabular-nums">
          {t("xpAmount", { amount: formatNumber(xp) })}
          {bursts
            .filter((b) => b.xpDelta > 0)
            .map((b) => (
              <span
                key={b.id}
                className="earn-burst pointer-events-none absolute left-1/2 -top-5 -translate-x-1/2 whitespace-nowrap font-semibold text-keep-accent"
              >
                {t("xpAmount", { amount: `+${formatNumber(b.xpDelta)}` })}
              </span>
            ))}
        </span>
      </span>
      {/* Error dot, visible when /earning/me failed so the all-zeros
          read-out doesn't masquerade as a fresh account. Hover the
          strip to see the underlying error message in the title. */}
      {error ? (
        <span
          aria-label={t("strip.errorDot")}
          className="ml-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-keep-accent"
        />
      ) : null}
    </>
  );
  return interactive ? (
    <button type="button" onClick={onOpenEarning} title={title} className={wrapperClassName}>
      {content}
    </button>
  ) : (
    <div title={title} className={wrapperClassName}>
      {content}
    </div>
  );
}
