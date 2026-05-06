import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { ChatMessage, RoomOccupant } from "@thekeep/shared";
import { UserNameTag } from "./UserNameTag.js";
import type { Gender } from "../lib/gender.js";
import { splitMentions } from "../lib/mentions.js";

interface Props {
  messages: ChatMessage[];
  /** Used to look up gender for each message author. */
  occupants: RoomOccupant[];
  onIconClick: (userId: string, displayName: string) => void;
  onNameClick: (userId: string, displayName: string) => void;
  /** Click handler for @mentions parsed out of the message body. */
  onMentionClick: (name: string) => void;
  fontStep: 0 | 1 | 2 | 3;
}

const FONT_PX = ["12px", "14px", "16px", "18px"] as const;

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function MessageList({ messages, occupants, onIconClick, onNameClick, onMentionClick, fontStep }: Props) {
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
        />
      ))}
    </div>
  );
}

/**
 * Render pre-split body parts with `@username` substrings turned into
 * clickable profile-open buttons. Plain text is returned as-is so it
 * composes with the surrounding line styles (inline color overrides,
 * italics, etc.).
 */
function renderParts(
  parts: ReturnType<typeof splitMentions>,
  onMentionClick: (name: string) => void,
): ReactNode[] {
  const out: ReactNode[] = [];
  parts.forEach((p, i) => {
    if (p.kind === "text") {
      out.push(<span key={i}>{p.text}</span>);
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
}: {
  msg: ChatMessage;
  gender: Gender;
  /** Unbound — Line binds with the relevant userId/displayName for sender vs recipient. */
  onIconClick: (userId: string, displayName: string) => void;
  onNameClick: (userId: string, displayName: string) => void;
  onMentionClick: (name: string) => void;
}) {
  const time = (
    <span className="mr-2 select-none text-xs text-keep-muted tabular-nums">
      {fmtTime(msg.createdAt)}
    </span>
  );
  const tag = (
    <UserNameTag
      displayName={msg.displayName}
      gender={gender}
      color={msg.color}
      onIconClick={() => onIconClick(msg.userId, msg.displayName)}
      onNameClick={() => onNameClick(msg.userId, msg.displayName)}
      // Chat lines stay compact — viewers open profiles from the userlist.
      hideIcon
    />
  );
  // Memoize the parsed parts on body so the splitMentions regex doesn't
  // re-run on every parent render (only when the body changes).
  const bodyParts = useMemo(() => splitMentions(msg.body), [msg.body]);
  const renderedBody = renderParts(bodyParts, onMentionClick);

  switch (msg.kind) {
    case "me":
      return (
        <div className="font-action" style={msg.color ? { color: msg.color } : { color: "#0b3a8c" }}>
          {time}{tag} <span>{renderedBody}</span>
        </div>
      );
    case "roll":
      return (
        <div className="text-keep-system">
          {time}{tag} <span>🎲 {renderedBody}</span>
        </div>
      );
    case "system":
      return (
        // whitespace-pre-wrap preserves the newlines that /describe authors
        // use to format multi-paragraph world descriptions; ordinary system
        // messages are single-line so this is a no-op for them. No leading
        // `* ` decoration — the italic + system color already distinguish
        // these from chat lines, and descriptions carry their own
        // `[Description]:` prefix when delivered on join.
        <div className="italic text-keep-system">
          {time}<span className="whitespace-pre-wrap">{renderedBody}</span>
        </div>
      );
    case "announce":
      return (
        <div className="font-bold text-keep-accent">
          {time}<span>📣 {renderedBody}</span>
        </div>
      );
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
      // Whisper line uses the theme's "action" slot — distinct from say/me
      // (white-ish text) and from system (muted), and themes cleanly: forest
      // green on Parchment, purple on Twilight, etc.
      return (
        <div className="text-keep-action">
          {time}{tag} <span className="text-keep-muted">whispers</span> {recipientTag}
          <span className="text-keep-muted">:</span> {renderedBody}
        </div>
      );
    }
    case "ooc":
      return (
        <div className="text-keep-muted">
          {time}[{tag}] {renderedBody}
        </div>
      );
    case "say":
    default:
      return (
        <div>
          {time}[{tag}] <span style={msg.color ? { color: msg.color } : undefined}>{renderedBody}</span>
        </div>
      );
  }
}
