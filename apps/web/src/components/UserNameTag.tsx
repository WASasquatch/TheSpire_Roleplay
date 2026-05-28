import { resolveMessageColor } from "@thekeep/shared";
import type { Gender } from "../lib/gender.js";
import { genderGlyph } from "../lib/gender.js";
import { useActiveTheme } from "../lib/theme.js";
import { BorderedAvatar } from "./BorderedAvatar.js";
import { RankSigil } from "./RankSigil.js";
import { StyledName } from "./StyledName.js";

interface Props {
  displayName: string;
  gender: Gender;
  /** If set, icon + name use this color (e.g. user's chat color or message snapshot color). */
  color?: string | null | undefined;
  away?: boolean;
  awayMessage?: string | null;
  /**
   * Click on the gender icon → view (or edit, if it's me) profile.
   * Click on the name → start a whisper to this user.
   * Both handlers receive (userId, displayName).
   */
  onIconClick: () => void;
  onNameClick: () => void;
  /**
   * Hide the gender icon entirely. Used by the chat message log so message
   * lines stay tight; the userlist still shows icons (and remains the
   * authoritative place to open someone's profile from).
   */
  hideIcon?: boolean;
  /** Render the name in italics (used to mark site admins). */
  italic?: boolean;
  /** Free-text mood/expression chip rendered after the name (e.g. "[angry]"). */
  mood?: string | null;
  /**
   * True when the speaker / occupant is on their master account (no active
   * character). Renders a small muted "(ooc)" suffix - same convention as
   * `[away]`, kept lowercase + parenthesised so it reads as a quiet aside
   * rather than a badge that competes with mood/role markers.
   */
  ooc?: boolean;
  /**
   * Earning rank/tier — drives the inline sigil rendered before the
   * name. Optional; nulls / missing values render no sigil. The
   * RankSigil component itself reads the catalog from the earning
   * store, so the caller only needs to pass the (key, tier) tuple.
   *
   * Sized `sm` by default (chat-line / forum-header use). The
   * userlist passes `md` for a slightly larger glyph.
   */
  rankKey?: string | null;
  tier?: number | null;
  rankSigilSize?: "sm" | "md" | "lg";
  /**
   * Which rank-icon set to render. `tier` (default) uses the per-tier
   * chevron from the catalog — the existing chat-line / forum-header
   * art. `gem` uses the abridged six-gem set (`gem_rank_N.png`), one
   * per top-level rank, with tier ignored. Userlist callers pass
   * `gem` because the rail has no room for the tier-distinct chevron
   * detail and the rank category alone is enough.
   */
  rankIconVariant?: "tier" | "gem";
  /**
   * Earning — equipped name style + per-user config for the
   * styled-name renderer. Both null when the user has nothing
   * equipped; the tag falls back to a plain text name button.
   * Source is the live occupant payload (broadcast.ts populates it
   * per-room from user_active_cosmetics + user_owned_name_styles).
   */
  nameStyleKey?: string | null;
  nameStyleConfig?: Record<string, unknown> | null;
  /**
   * Earning — when set AND `avatarUrl` is non-null AND the user
   * has the `inline_avatar` cosmetic active, the gender-icon click
   * target is swapped for a bordered avatar (per plan.md Phase 4
   * spec). Users without the cosmetic keep the gender icon.
   */
  avatarUrl?: string | null;
  selectedBorderRankKey?: string | null;
  /** Free-form border (migration 0149). Takes precedence over the
   *  rank-tier slot in BorderedAvatar's resolution chain. */
  selectedFreeformBorderKey?: string | null;
  /** Per-identity color customization for the equipped freeform
   *  border (migration 0158). Passed through to BorderedAvatar
   *  unchanged; null = use the catalog row's CSS fallbacks. */
  freeformBorderConfig?: Record<string, string> | null;
  inlineAvatar?: boolean;
  /**
   * Opt the inner name button into ellipsis truncation. Default off.
   *
   * Truncation requires `overflow: hidden` on the button, which clips
   * any paint extending past the layout box — italic glyph slant on
   * the last character, drop-shadow halos on name styles, ember
   * pseudo-element particles, etc. Chat lines have plenty of room
   * and don't need to truncate, so leaving this off lets all of that
   * decoration render fully. The userlist rail (RoomsTree) opts in
   * because narrow widths legitimately require ellipsis on long
   * names.
   */
  truncate?: boolean;
}

/**
 * Render a user's display tag - gender icon + name - with two click targets:
 * the icon opens the profile, the name opens a whisper. Used in the userlist
 * (icons visible) and in chat-message lines (icons hidden).
 */
export function UserNameTag({
  displayName,
  gender,
  color,
  away,
  awayMessage,
  onIconClick,
  onNameClick,
  hideIcon,
  italic,
  mood,
  ooc,
  rankKey,
  tier,
  rankSigilSize,
  rankIconVariant = "tier",
  nameStyleKey,
  nameStyleConfig,
  avatarUrl,
  selectedBorderRankKey,
  selectedFreeformBorderKey,
  freeformBorderConfig,
  inlineAvatar,
  truncate = false,
}: Props) {
  const g = genderGlyph(gender);
  // Resolve theme-slot tokens (e.g. `theme:system`) to a CSS color
  // that follows the viewer's palette. Literal hex strings are nudged
  // toward legibility against the current theme background when the
  // chosen shade wouldn't meet WCAG contrast.
  const themeBg = useActiveTheme().bg;
  const resolvedColor = resolveMessageColor(color, themeBg);
  return (
    // `inline-flex min-w-0 max-w-full` lets the tag shrink below
    // its intrinsic content width when its container (e.g. a
    // userlist row in a narrow rail) is scrunched. Without
    // `min-w-0` flex children default to their content size and
    // refuse to shrink, which is what was causing long usernames
    // to wrap onto a second line.
    //
    // `items-center` (not baseline) because the rank sigil is an
    // image with no text baseline of its own — under items-baseline
    // it sits flush with the bottom of the line while the username
    // text rides its own baseline, and the two end up visibly
    // staggered (image floats above the name). Center keeps the
    // sigil, gender glyph, and name visually aligned regardless of
    // their individual intrinsic heights.
    //
    // `align-middle` on the OUTER wrapper centers the whole tag on
    // the SURROUNDING text's middle line (timestamp + body). Without
    // it the inline-flex falls back to baseline alignment with the
    // line's text, so a taller child (the gem rank sigil at 1.6em,
    // for example) pushes the whole tag upward and the username +
    // gem end up floating above the timestamp / body. With this
    // class the tag sits centered on the line and the gem +
    // username line up with the rest of the chat row.
    // `data-display-name` carries the raw display name so the chat
    // copy handler can paste `[Username] body` regardless of how the
    // visual was rendered. Name-style templates can put the visible
    // name into CSS `content`, into a sprite-shaped span chain, or
    // into a `dangerouslySetInnerHTML` blob without ever exposing a
    // real text node — and without this attribute the clipboard
    // would receive `[] body` instead. See lib/chatCopy.ts for the
    // walker that consumes the attribute.
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1 align-middle"
      data-display-name={displayName}
    >
      {(() => {
        // Icon slot priority (only when an icon slot is shown at all —
        // chat lines pass `hideIcon` so this branch doesn't render
        // there). Order is deliberate:
        //
        //   1. Bordered avatar — opt-in cosmetic. Wins over everything
        //      else because it's the most deliberately equipped piece
        //      of identity art.
        //   2. Rank sigil — RANK ALWAYS REPLACES THE GENDER GLYPH WHEN
        //      THE USER HAS A RANK. There is no per-user toggle: a
        //      resolved rank IS the user's primary identity badge, and
        //      stacking gender + rank in the same row reads as visual
        //      clutter (the legacy behavior). Falls back to gender
        //      automatically for unranked accounts, so flipping nothing
        //      on a fresh account doesn't leave the row icon-less.
        //   3. Gender glyph — the original Unicode badge. Renders only
        //      when there's no avatar AND no resolved rank.
        if (hideIcon) return null;
        if (inlineAvatar && avatarUrl) {
          return (
            <BorderedAvatar
              avatarUrl={avatarUrl}
              name={displayName}
              borderRankKey={selectedBorderRankKey ?? null}
              freeformBorderKey={selectedFreeformBorderKey ?? null}
              freeformConfig={freeformBorderConfig ?? null}
              size="sm"
              onClick={onIconClick}
              title={`view profile (${g.title})`}
              className="shrink-0"
            />
          );
        }
        // Rank-resolution check. Gem variant only needs `rankKey` (the
        // catalog lookup happens inside RankSigil and ignores tier).
        // Tier variant requires both `rankKey` and `tier` because each
        // tier has its own art. Either way, when the rank renders in
        // the icon slot the standalone-after-icon sigil below is
        // suppressed to avoid showing the same image twice in a row.
        const hasResolvedRank =
          rankKey != null &&
          (rankIconVariant === "gem" || tier != null);
        if (hasResolvedRank) {
          return (
            <button
              type="button"
              onClick={onIconClick}
              title={`view profile (${displayName})`}
              className="shrink-0 rounded px-0.5 py-0.5 leading-none hover:bg-keep-panel"
            >
              <RankSigil rankKey={rankKey} tier={tier ?? null} size={rankSigilSize ?? "md"} variant={rankIconVariant} />
            </button>
          );
        }
        return (
          <button
            type="button"
            onClick={onIconClick}
            title={`view profile (${g.title})`}
            // px-1 py-0.5 + rounded background on hover gives a real tap
            // target on mobile without changing visual density.
            // `shrink-0` keeps the gender icon at its natural size when
            // the row scrunches — only the name button absorbs the
            // squeeze. font-size in em so the glyph scales with the
            // container's font-size (driven by the chat/rail font-step
            // setting). 1em matches the surrounding text; the Unicode
            // gender glyphs read clearly at this size.
            className="shrink-0 rounded px-1 py-0.5 leading-none hover:bg-keep-panel hover:underline"
            style={{ color: g.color, fontSize: "1em" }}
          >
            {g.icon}
          </button>
        );
      })()}
      {/* Standalone inline rank sigil. Renders in two cases:
          1. Chat lines (`hideIcon`) — no icon slot, so the rank sits
             here right before the name.
          2. Avatar in the icon slot — rank gets a small repeat slot
             after the avatar so the rank still shows even when the
             cosmetic owns the click target.
          Suppressed when the rank is ALREADY in the icon slot (icon
          slot rendered the rank because the user is ranked + has no
          avatar cosmetic), to keep the rail from showing two of the
          same image side by side. */}
      {(() => {
        const hasResolvedRank =
          rankKey != null &&
          (rankIconVariant === "gem" || tier != null);
        if (!hasResolvedRank) return null;
        const rankWasInIconSlot = !hideIcon && !(inlineAvatar && avatarUrl);
        if (rankWasInIconSlot) return null;
        return (
          <RankSigil rankKey={rankKey ?? null} tier={tier ?? null} size={rankSigilSize ?? "sm"} variant={rankIconVariant} />
        );
      })()}
      <button
        type="button"
        onClick={onNameClick}
        title={
          (italic ? `${displayName} - admin` : `whisper ${displayName}`) +
          (away && awayMessage ? ` (away: ${awayMessage})` : "")
        }
        // Two render modes, gated by the `truncate` prop:
        //
        //   truncate=true  — narrow-rail use (userlist). The button
        //                    ellipsizes with `…` when the name is
        //                    longer than the available width. Adds
        //                    `min-w-0` so the button can shrink below
        //                    its content size as a flex child.
        //                    `overflow-clip` + `overflow-clip-margin`
        //                    let italic slant and small style halos
        //                    paint outside the box even while
        //                    truncation is enabled.
        //
        //   truncate=false — chat-line / forum-header default. No
        //                    overflow rule at all so the button is
        //                    the same size as its content and italic
        //                    glyphs / name-style decorations render
        //                    fully into the ambient inline flow. The
        //                    chat line has plenty of horizontal room
        //                    and would never need to truncate the
        //                    name; `overflow: hidden` was the actual
        //                    cause of clipped italic admin names.
        //
        // `py-0.5` only — no horizontal padding here. Right-side
        // breathing room is applied INSIDE StyledName via its
        // wrapper's `padding-right` so the gradient-clip-text family
        // of name styles widens its mask to cover italic glyph
        // overflow. Padding on the button itself would leave empty
        // space outside the styled span where the gradient doesn't
        // reach, making italic styled admin names look like the last
        // letter's slant was sheared off.
        className={`rounded py-0.5 font-semibold hover:bg-keep-panel hover:underline${
          truncate ? " min-w-0 overflow-clip text-ellipsis whitespace-nowrap [overflow-clip-margin:1.75em]" : ""
        }${italic ? " italic" : ""}`}
        // Inline chatColor is preserved as a fallback for users with
        // no equipped style — StyledName below paints over it when a
        // template's CSS sets `color` directly, but when the style
        // CSS doesn't touch color (e.g. a glow-only effect), the
        // user's picked chat color still bleeds through.
        style={resolvedColor && !nameStyleKey ? { color: resolvedColor } : undefined}
      >
        <StyledName
          displayName={displayName}
          styleKey={nameStyleKey ?? null}
          config={nameStyleConfig ?? null}
          // Pass the resolved chatColor as the base color for the
          // plain-text fallback so unstyled users keep their per-
          // character color.
          baseColor={resolvedColor}
        />
      </button>
      {mood ? (
        <span
          // No `px-1` here either — same rationale as the username
          // button: punctuation around the chip ("[", ":") sits
          // adjacent enough that horizontal padding read as a gap.
          className="shrink-0 rounded bg-keep-action/15 text-[10px] uppercase tracking-wide text-keep-action"
          title={`mood: ${mood}`}
        >
          {mood}
        </span>
      ) : null}
      {ooc ? (
        <span
          className="ml-1 shrink-0 text-[10px] text-keep-muted"
          title="Speaking from their master / OOC account, not as a character"
        >
          (ooc)
        </span>
      ) : null}
      {away ? <span className="ml-1 shrink-0 text-keep-muted">[away]</span> : null}
    </span>
  );
}
