/**
 * BorderedAvatar — round avatar with an optional rank-border frame
 * overlaid on top.
 *
 * Architecture (per user's prescription):
 *   1. **Outer container** — the layout slot. Sized to fit the ornate
 *      frame design, NOT just the avatar. Establishes the positioning
 *      context for both layers.
 *   2. **Avatar layer** — centered inside the container at the
 *      avatar's intrinsic visual size (smaller than the container so
 *      the surrounding frame has room).
 *   3. **Frame overlay** — fills the container, painted on TOP of the
 *      avatar. The PNG has transparency in the middle so the avatar
 *      shows through the frame's inner cutout.
 *
 * Why the container is larger than the avatar:
 *   The shipped frame PNGs (rank*_tier4_border.png) are ornate ovals
 *   ~440-480px square where the central "avatar slot" cutout occupies
 *   only the inner ~50%. If we sized the container to the avatar and
 *   let the frame overflow, the frame band ended up clipping into the
 *   portrait and reading as a tight ring rather than a frame. Sizing
 *   the container to the frame and centering the avatar inside gives
 *   the frame the breathing room its design assumes.
 *
 * Two layout modes (chosen automatically by size):
 *   - **xs/sm/md (inline)** — frame design isn't a fit for tight
 *     chat-line / userlist rows, so we keep the container at the
 *     avatar size and skip the frame entirely if one is requested.
 *     The chat-line was never the place to show off an ornate ring.
 *   - **lg/xl (showcase)** — container expands to ~2× the avatar so
 *     the frame design renders at intended scale (used in the
 *     borders catalog + profile hero).
 *
 * Fallback: when no avatar URL is provided, renders a circular
 * initials chip in the keep-banner color. When the avatar URL is
 * broken (404 / deleted), an onError handler swaps to the initials
 * fallback inline so the row doesn't show a broken-image glyph.
 */

import { useState } from "react";
import { useEarning } from "../state/earning.js";

export type BorderedAvatarSize = "xs" | "sm" | "md" | "lg" | "xl";
type Size = BorderedAvatarSize;

/** Avatar (portrait) diameter per size. CSS length values, not raw
 *  numbers, so the inline tiers can `clamp()` against the document
 *  font-size: chat-line + userlist scale between a 30px floor and a
 *  ~40px ceiling (≈ Discord chat avatars) as the user steps through
 *  the font-scale preferences. At medium / large font scales the
 *  inline avatar lands near the 40px cap; small / xl get clamped to
 *  the bounds. The showcase tiers stay fixed pixels — those slots
 *  (forum body, earning catalog, profile hero) have layouts tuned
 *  to specific avatar diameters and shouldn't drift with font-size. */
const AVATAR_SIZE: Record<Size, string> = {
  xs: "clamp(31px, 2.125rem, 41px)", // chat-line inline — Discord-like prominence;
                                     //   small font →31, medium →34, large →38, xl →41
  sm: "clamp(32px, 2.2rem, 40px)", // userlist row — one notch tighter than the
                                   //   chat-line but in the same visual class
  md: "32px", // forum post avatar
  lg: "64px", // earning modal mid-size preview
  xl: "124px", // borders catalog showcase — sized to fill the frame's
               // inner ring (frame container at 1.5× = 186px, avatar at
               // 124px ≈ 67% of container so its edge tucks under the
               // ring instead of leaving a gap or its own border line
               // visible inside the frame's cutout).
};

/** Container scale: how much bigger the frame container is than the
 *  avatar. The avatar sits centered inside; the frame PNG fills the
 *  container. Tuned so the avatar's edge tucks JUST under the
 *  frame's inner ring (hides the avatar's own border line). `xs` is
 *  pinned at 1 so the chat-line inline avatar never carries the
 *  frame — the ornate ring throws off message-line spacing and
 *  reads as visual noise next to the timestamp; that slot stays
 *  plain regardless of which border the user equipped. Larger tiers
 *  use the 1.5× ratio so the frame's decorative ring nests around
 *  the avatar the same way at userlist, forum body, and profile
 *  hero. */
const CONTAINER_SCALE: Record<Size, number> = {
  xs: 1,
  sm: 1.5,
  md: 1.5,
  lg: 1.5,
  xl: 1.5,
};

interface Props {
  avatarUrl: string | null | undefined;
  /** Display name — used to derive the initials fallback. */
  name: string;
  /** Rank whose tier-IV border PNG should frame the avatar. */
  borderRankKey?: string | null;
  size?: Size;
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  className?: string;
}

export function BorderedAvatar({
  avatarUrl,
  name,
  borderRankKey,
  size = "sm",
  onClick,
  title,
  className,
}: Props) {
  const snapshot = useEarning((s) => s.snapshot);
  const avatarSize = AVATAR_SIZE[size];
  const containerScale = CONTAINER_SCALE[size];
  const borderUrl = borderRankKey && snapshot
    ? snapshot.catalog.rankTiers.find((t) => t.rankKey === borderRankKey && t.tier === 4)?.borderImageUrl ?? null
    : null;
  // Only enlarge the container when there's actually a border to show
  // AND the size is a showcase tier. Inline sizes never enlarge — the
  // chat-line layout can't accommodate a 2× footprint.
  const useFrameContainer = !!borderUrl && containerScale > 1;
  // `calc()` here so the scale-up survives the inline tiers' clamp()
  // — multiplying a numeric px would have dropped the responsive
  // sizing. Showcase tiers are static pixel strings so calc() just
  // multiplies them straight.
  const containerSize = useFrameContainer ? `calc(${avatarSize} * ${containerScale})` : avatarSize;
  // Userlist row alignment: reserve the same horizontal footprint
  // for `sm` (userlist) whether or not the user has a border, so
  // names line up cleanly when the list mixes border owners with
  // borderless members. Height stays at the avatar size so
  // borderless rows don't gain vertical air they didn't ask for.
  const containerWidth = (size === "sm" && !useFrameContainer)
    ? `calc(${avatarSize} * ${CONTAINER_SCALE.sm})`
    : containerSize;
  const [errored, setErrored] = useState(false);
  const showAvatar = !!avatarUrl && !errored;

  const wrapper = (
    <span
      className={`relative inline-block shrink-0 ${className ?? ""}`}
      style={{ width: containerWidth, height: containerSize }}
    >
      {/* Avatar layer — always centered in the container. When the
          container is sized to the frame (useFrameContainer), the
          avatar lives in the central cutout area; when not, it just
          fills the container. */}
      <span
        className="absolute"
        style={{
          left: "50%",
          top: "50%",
          width: avatarSize,
          height: avatarSize,
          transform: "translate(-50%, -50%)",
        }}
      >
        {showAvatar ? (
          <img
            src={avatarUrl!}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setErrored(true)}
            className="h-full w-full rounded-full border border-keep-rule object-cover"
          />
        ) : (
          <span
            aria-hidden
            className="flex h-full w-full items-center justify-center rounded-full border border-keep-rule bg-keep-banner text-[10px] font-semibold uppercase tracking-wide text-keep-muted"
          >
            {initialsFor(name)}
          </span>
        )}
      </span>
      {/* Frame overlay — paints on TOP of the avatar. PNG transparency
          in the center lets the portrait show through; the opaque
          decorative band frames the visible avatar. `pointer-events:
          none` so the frame can't intercept clicks on the avatar.
          Skipped when the container is at 1× scale (xs / chat-line
          inline) — without the extra container room the frame band
          would crush onto the portrait and read as a tight ring. */}
      {borderUrl && useFrameContainer ? (
        <img
          src={borderUrl}
          alt=""
          aria-hidden
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full select-none"
        />
      ) : null}
    </span>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={(e) => onClick(e)}
        title={title}
        // Strip the default button chrome so the avatar reads as the
        // affordance, not a chip. `focus-visible:` keeps keyboard nav
        // accessible without painting a ring after a mouse click —
        // the browser only fires focus-visible when focus arrives via
        // keyboard, never via pointer.
        className="inline-block rounded-full bg-transparent p-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-keep-action"
      >
        {wrapper}
      </button>
    );
  }
  return wrapper;
}

function initialsFor(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}
