import type { Gender } from "../lib/gender.js";
import { genderGlyph } from "../lib/gender.js";

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
  return (
    <span className="inline-flex items-baseline gap-1">
      {rolePrefix ? <span className="text-keep-muted">{rolePrefix}</span> : null}
      {hideIcon ? null : (
        <button
          type="button"
          onClick={onIconClick}
          title={`view profile (${g.title})`}
          // px-1 py-0.5 + rounded background on hover gives a real tap
          // target on mobile without changing visual density.
          className="rounded px-1 py-0.5 text-base leading-none hover:bg-keep-panel hover:underline md:text-sm"
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
        className={`rounded px-1 py-0.5 font-semibold hover:bg-keep-panel hover:underline${italic ? " italic" : ""}`}
        style={color ? { color } : undefined}
      >
        {displayName}
      </button>
      {mood ? (
        <span
          className="ml-1 rounded bg-keep-action/15 px-1 text-[10px] uppercase tracking-wide text-keep-action"
          title={`mood: ${mood}`}
        >
          {mood}
        </span>
      ) : null}
      {ooc ? (
        <span
          className="ml-1 text-[10px] text-keep-muted"
          title="Speaking from their master / OOC account, not as a character"
        >
          (ooc)
        </span>
      ) : null}
      {away ? <span className="ml-1 text-keep-muted">[away]</span> : null}
    </span>
  );
}
