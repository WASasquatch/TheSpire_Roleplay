import { resolveMessageColor } from "@thekeep/shared";
import type { Gender } from "../lib/gender.js";
import { genderGlyph } from "../lib/gender.js";
import { useActiveTheme } from "../lib/theme.js";

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
  /** "★" / "♛" indicator preceding the icon (room role). */
  rolePrefix?: string;
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
  rolePrefix,
  hideIcon,
  italic,
  mood,
  ooc,
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
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-1">
      {rolePrefix ? <span className="shrink-0 text-keep-muted">{rolePrefix}</span> : null}
      {hideIcon ? null : (
        <button
          type="button"
          onClick={onIconClick}
          title={`view profile (${g.title})`}
          // px-1 py-0.5 + rounded background on hover gives a real tap
          // target on mobile without changing visual density.
          // `shrink-0` keeps the gender icon at its natural size when
          // the row scrunches — only the name button absorbs the
          // squeeze.
          className="shrink-0 rounded px-1 py-0.5 text-base leading-none hover:bg-keep-panel hover:underline md:text-sm"
          style={{ color: g.color }}
        >
          {g.icon}
        </button>
      )}
      <button
        type="button"
        onClick={onNameClick}
        title={
          (italic ? `${displayName} - admin` : `whisper ${displayName}`) +
          (away && awayMessage ? ` (away: ${awayMessage})` : "")
        }
        // `min-w-0 truncate` is what lets the displayName ellipsize
        // inside a narrow rail (e.g. after the user drags the
        // userlist resize handle to a tight width). `truncate` =
        // `overflow:hidden; text-overflow:ellipsis; white-space:nowrap`,
        // and `min-w-0` lets this flex child shrink below its
        // content-size so the ellipsis actually has room to engage.
        // Without these, long names previously broke onto a new line
        // and threw the row layout off.
        className={`min-w-0 truncate rounded px-1 py-0.5 font-semibold hover:bg-keep-panel hover:underline${italic ? " italic" : ""}`}
        style={resolvedColor ? { color: resolvedColor } : undefined}
      >
        {displayName}
      </button>
      {mood ? (
        <span
          className="ml-1 shrink-0 rounded bg-keep-action/15 px-1 text-[10px] uppercase tracking-wide text-keep-action"
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
