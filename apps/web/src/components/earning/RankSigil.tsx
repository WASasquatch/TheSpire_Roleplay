/**
 * Inline rank/tier sigil, the small badge image rendered next to a
 * display name in chat lines, userlist rows, forum headers, and
 * profile cards.
 *
 * Two render variants:
 *
 *   `tier` (default), the per-tier chevron pulled from the catalog's
 *      `rankTiers.sigilImageUrl`. Requires both `rankKey` AND `tier`
 *      because each tier has its own art (I/II/III/IV). Used by chat
 *      lines, forum headers, the dashboard hero, etc., anywhere the
 *      tier distinction matters.
 *
 *   `gem`, the six abridged gem icons (`gem_rank_1.png` …
 *      `gem_rank_6.png`), one per top-level rank. Tier is ignored:
 *      a user at Active I and another at Active IV both render gem
 *      #2. Used in the userlist where horizontal real estate is
 *      scarce and the rank category alone is enough.
 *
 * Both variants resolve via the cached earning catalog (loaded once
 * at sign-in into useEarning). Self-hide when the catalog hasn't
 * loaded yet OR the rank doesn't resolve (unranked author / rank
 * admin-deleted after the message was sent).
 *
 * Sized via a fixed `sm | md | lg` enum rather than free CSS so the
 * sigil stays visually consistent across every surface and we can
 * coordinate a sitewide resize from one place if needed.
 */

import { useEarning } from "../../state/earning.js";

type Size = "sm" | "md" | "lg" | "xl" | "hero";
type Variant = "tier" | "gem";

/** Number of gem assets shipped in /assets/ranks/gem_rank_*.png. */
const GEM_MAX = 6;

/**
 * Sigil sizing. `sm` / `md` use em so they scale with the
 * surrounding container's font-size, the Tools-menu font-step
 * setting flips the chat and rail's font-size in em, and these
 * sigils ride that change instead of staying pinned at 14/18px.
 * Larger fixed-size variants (`lg`, `xl`, `hero`) stay in px because
 * they live in surfaces with their own typography scale (dashboard
 * sub-headers, profile hero) and shouldn't reflow with the chat
 * setting.
 */
const SIZES: Record<Size, { size: string }> = {
  sm: { size: "1.25em" }, // inline next to a chat-line name (legacy callers)
  md: { size: "1.6em" },  // chat-line + userlist row gem icon, large
                          // enough to read the gem color at a glance,
                          // still scales with the Tools font cycle
                          // (em, not px) so a user on font-step 3 gets
                          // a proportionally bigger sigil. Bumped from
                          // 1.25em when the chat feed switched to the
                          // gem variant, the gems benefit from more
                          // real estate than the older chevrons did.
  lg: { size: "28px" },   // dashboard sub-headers
  xl: { size: "64px" },   // profile hero, the rank reads as the primary identity tag
  hero: { size: "11rem" }, // earning dashboard hero rank, left-aligned chevron lockup
};

interface Props {
  rankKey: string | null | undefined;
  /** Tier within the rank (1..N). Ignored when `variant === "gem"`. */
  tier: number | null | undefined;
  size?: Size;
  /** Optional className for fine-tuning margins at the call site. */
  className?: string;
  /**
   * Which icon set to render. Defaults to `tier` (the per-tier
   * chevron from the catalog) for backwards compatibility. Pass
   * `gem` to render the abridged gem icons used in the userlist.
   */
  variant?: Variant;
}

export function RankSigil({ rankKey, tier, size = "sm", className, variant = "tier" }: Props) {
  // Read the catalog once. Selecting a primitive ref keeps the
  // selector stable across renders so we don't trip the same
  // useSyncExternalStore loop the ribbon hit earlier.
  const snapshot = useEarning((s) => s.snapshot);
  if (!rankKey || !snapshot) return null;
  const rank = snapshot.catalog.ranks.find((r) => r.key === rankKey);
  const { size: dim } = SIZES[size];

  if (variant === "gem") {
    // Gem icons: one per top-level rank, indexed by the catalog's
    // `order` field (1..6 in the default seed). Clamped to GEM_MAX so
    // an installation that adds a 7th rank without shipping a 7th gem
    // falls back to the top-tier icon instead of breaking with a 404.
    // No tier required: gem #N covers every tier of rank #N.
    if (!rank) return null;
    const idx = Math.min(Math.max(rank.order, 1), GEM_MAX);
    const tierRow = tier != null
      ? snapshot.catalog.rankTiers.find((t) => t.rankKey === rankKey && t.tier === tier) ?? null
      : null;
    const title = tierRow ? `${rank.name} ${tierRow.label}` : rank.name;
    return (
      <img
        src={`/assets/ranks/gem_rank_${idx}.png`}
        alt=""
        title={title}
        className={`inline-block shrink-0 align-middle select-none ${className ?? ""}`}
        style={{ width: dim, height: dim }}
        draggable={false}
        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
      />
    );
  }

  // Default: per-tier chevron from the catalog.
  if (tier == null) return null;
  const tierRow = snapshot.catalog.rankTiers.find((t) => t.rankKey === rankKey && t.tier === tier);
  if (!tierRow?.sigilImageUrl) return null;
  const title = rank ? `${rank.name} ${tierRow.label}` : tierRow.label;
  return (
    <img
      src={tierRow.sigilImageUrl}
      alt=""
      title={title}
      // `align-middle` centers the sigil on the text's middle line,
      // `align-text-bottom` left it riding visually high because the
      // chevron PNGs are top-heavy artwork (no real descender to
      // anchor to). Middle alignment lines the chevron's vertical
      // center up with the username's x-height, which reads as
      // "next to the name" instead of "floating above it."
      className={`inline-block shrink-0 align-middle select-none ${className ?? ""}`}
      style={{ width: dim, height: dim }}
      draggable={false}
      // Bad URL (admin deleted the asset between writes) shouldn't
      // leave a broken-image icon next to every line, onError hides
      // the element outright.
      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
    />
  );
}
