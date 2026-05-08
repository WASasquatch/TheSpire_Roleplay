import { Fragment, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { ChatMessage, RoomOccupant } from "@thekeep/shared";
import { UserNameTag } from "./UserNameTag.js";
import type { Gender } from "../lib/gender.js";
import { parseInline } from "../lib/markdown.js";
import { splitMentions } from "../lib/mentions.js";

interface Props {
  messages: ChatMessage[];
  /** Used to look up gender for each message author. */
  occupants: RoomOccupant[];
  onIconClick: (userId: string, displayName: string) => void;
  onNameClick: (userId: string, displayName: string) => void;
  /** Click handler for @mentions parsed out of the message body. */
  onMentionClick: (name: string) => void;
  /** Click on the timestamp - pre-fill the composer with /reply <msgid>. Only enabled for chat kinds (say/me/ooc). */
  onTimeClick: (msgId: string) => void;
  fontStep: 0 | 1 | 2 | 3;
}

const REPLYABLE_KINDS = new Set(["say", "me", "ooc"]);

const FONT_PX = ["12px", "14px", "16px", "18px"] as const;

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function MessageList({ messages, occupants, onIconClick, onNameClick, onMentionClick, onTimeClick, fontStep }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const genderByUser = new Map<string, Gender>();
  for (const o of occupants) genderByUser.set(o.userId, o.gender);

  return (
    <div
      ref={ref}
      className="flex-1 overflow-y-auto px-4 py-2 leading-relaxed"
      style={{ fontSize: FONT_PX[fontStep] }}
    >
      {messages.map((m) => (
        <Line
          key={m.id}
          msg={m}
          gender={genderByUser.get(m.userId) ?? "undisclosed"}
          onIconClick={onIconClick}
          onNameClick={onNameClick}
          onMentionClick={onMentionClick}
          onTimeClick={onTimeClick}
        />
      ))}
    </div>
  );
}

/**
 * Render pre-split body parts with `@username` substrings turned into
 * clickable profile-open buttons. Text segments are run through the inline
 * markdown parser (lib/markdown.tsx) so `**bold**`, `*italic*`, `` `code` ``,
 * and bare http(s) URLs / image links render with structure - but always as
 * React elements, never via `dangerouslySetInnerHTML`, so message bodies
 * remain XSS-safe.
 */
function renderParts(
  parts: ReturnType<typeof splitMentions>,
  onMentionClick: (name: string) => void,
): ReactNode[] {
  const out: ReactNode[] = [];
  parts.forEach((p, i) => {
    if (p.kind === "text") {
      out.push(<Fragment key={i}>{parseInline(p.text)}</Fragment>);
    } else {
      out.push(
        <button
          key={i}
          type="button"
          onClick={() => onMentionClick(p.name)}
          className="rounded px-0.5 font-semibold text-keep-action hover:underline focus:outline-none focus:ring-1 focus:ring-keep-action"
          title={`View ${p.raw}'s profile`}
        >
          @{p.raw}
        </button>,
      );
    }
  });
  return out;
}

function Line({
  msg,
  gender,
  onIconClick,
  onNameClick,
  onMentionClick,
  onTimeClick,
}: {
  msg: ChatMessage;
  gender: Gender;
  /** Unbound - Line binds with the relevant userId/displayName for sender vs recipient. */
  onIconClick: (userId: string, displayName: string) => void;
  onNameClick: (userId: string, displayName: string) => void;
  onMentionClick: (name: string) => void;
  onTimeClick: (msgId: string) => void;
}) {
  const canReply = REPLYABLE_KINDS.has(msg.kind);
  const timeText = fmtTime(msg.createdAt);
  // Timestamp is the click target for "reply to this message" - turning the
  // whole line into a button is too aggressive (steals selection, conflicts
  // with name/mention buttons). The timestamp is a stable, decorative spot
  // that's already visually separate from the body.
  const time = canReply ? (
    <button
      type="button"
      onClick={() => onTimeClick(msg.id)}
      title="Reply to this message"
      className="mr-2 select-none rounded text-xs text-keep-muted tabular-nums hover:text-keep-action hover:underline focus:outline-none focus:ring-1 focus:ring-keep-action"
    >
      {timeText}
    </button>
  ) : (
    <span className="mr-2 select-none text-xs text-keep-muted tabular-nums">
      {timeText}
    </span>
  );
  const isReply = !!(msg.replyToId && msg.replyToDisplayName);
  const quote = isReply ? (
    <div className="flex items-baseline gap-1 text-xs leading-tight text-keep-muted">
      <span aria-hidden="true">↪</span>
      <span className="font-semibold">{msg.replyToDisplayName}:</span>
      <span className="truncate italic">{msg.replyToBodySnippet ?? ""}</span>
    </div>
  ) : null;
  const tag = (
    <UserNameTag
      displayName={msg.displayName}
      gender={gender}
      color={msg.color}
      onIconClick={() => onIconClick(msg.userId, msg.displayName)}
      onNameClick={() => onNameClick(msg.userId, msg.displayName)}
      // Chat lines stay compact - viewers open profiles from the userlist.
      hideIcon
    />
  );
  // Memoize the parsed parts on body so the splitMentions regex doesn't
  // re-run on every parent render (only when the body changes).
  const bodyParts = useMemo(() => splitMentions(msg.body), [msg.body]);
  const renderedBody = renderParts(bodyParts, onMentionClick);

  let lineEl: ReactNode;
  switch (msg.kind) {
    case "me":
      lineEl = (
        <div className="font-action" style={msg.color ? { color: msg.color } : { color: "#0b3a8c" }}>
          {time}{tag} <span>{renderedBody}</span>
        </div>
      );
      break;
    case "roll":
      lineEl = (
        <div className="text-keep-system">
          {time}{tag} <span>🎲 {renderedBody}</span>
        </div>
      );
      break;
    case "system":
      lineEl = (
        // whitespace-pre-wrap preserves the newlines that /describe authors
        // use to format multi-paragraph world descriptions; ordinary system
        // messages are single-line so this is a no-op for them. No leading
        // `* ` decoration - the italic + system color already distinguish
        // these from chat lines, and descriptions carry their own
        // `[Description]:` prefix when delivered on join.
        <div className="italic text-keep-system">
          {time}<span className="whitespace-pre-wrap">{renderedBody}</span>
        </div>
      );
      break;
    case "announce":
      lineEl = (
        <div className="font-bold text-keep-accent">
          {time}<span>📣 {renderedBody}</span>
        </div>
      );
      break;
    case "whisper": {
      // Render "<Sender> whispers <Receiver>: <msg>" so both ends of the
      // conversation are visible. Both names are click-targets:
      //   - icon → view that user's profile
      //   - name → pre-fill composer with /whisper <name> (continue/reply)
      const toUserId = msg.toUserId;
      const toName = msg.toDisplayName;
      const recipientTag =
        toUserId && toName ? (
          <UserNameTag
            displayName={toName}
            gender="undisclosed"
            color={null}
            onIconClick={() => onIconClick(toUserId, toName)}
            onNameClick={() => onNameClick(toUserId, toName)}
            hideIcon
          />
        ) : (
          <span className="text-keep-muted">someone</span>
        );
      // Whisper line uses the theme's "action" slot - distinct from say/me
      // (white-ish text) and from system (muted), and themes cleanly: forest
      // green on Parchment, purple on Twilight, etc.
      lineEl = (
        <div className="text-keep-action">
          {time}{tag} <span className="text-keep-muted">whispers</span> {recipientTag}
          <span className="text-keep-muted">:</span> {renderedBody}
        </div>
      );
      break;
    }
    case "ooc":
      lineEl = (
        <div className="text-keep-muted">
          {time}[{tag}] {renderedBody}
        </div>
      );
      break;
    case "say":
    default:
      lineEl = (
        <div>
          {time}[{tag}] <span style={msg.color ? { color: msg.color } : undefined}>{renderedBody}</span>
        </div>
      );
      break;
  }

  // Replies wrap the quote + the line in a single container with a continuous
  // accent-tinted left border, so the two read as one coupled block instead
  // of as two stray lines next to each other in the timeline.
  if (isReply) {
    return (
      <div className="my-0.5 border-l-2 border-keep-action/50 pl-2">
        {quote}
        {lineEl}
      </div>
    );
  }
  return lineEl;
}
