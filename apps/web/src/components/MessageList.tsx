import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatMessage, RoomOccupant } from "@thekeep/shared";
import { UserNameTag } from "./UserNameTag.js";
import type { Gender } from "../lib/gender.js";
import { parseInline } from "../lib/markdown.js";
import { splitMentions } from "../lib/mentions.js";

interface Props {
  messages: ChatMessage[];
  /** Used to look up gender for each message author. */
  occupants: RoomOccupant[];
  /** Current viewer's user id - so the renderer can decide which messages get edit/delete grace controls. Null when not yet authenticated. */
  selfUserId: string | null;
  /** Current room's type. Reporting is a public-room-only feature. */
  roomType?: "public" | "private" | null;
  onIconClick: (userId: string, displayName: string) => void;
  onNameClick: (userId: string, displayName: string) => void;
  /** Click handler for @mentions parsed out of the message body. */
  onMentionClick: (name: string) => void;
  /** Click on the timestamp - pre-fill the composer with /reply <msgid>. Only enabled for chat kinds (say/me/ooc). */
  onTimeClick: (msgId: string) => void;
  fontStep: 0 | 1 | 2 | 3;
}

/** Kinds eligible for /reports - mirrors the server's privacy gate. */
const REPORTABLE_KINDS = new Set(["say", "me", "ooc", "announce", "npc"]);

/** Author can edit or delete their own message inside this window after sending. Mirrors the server-side cap in routes/messages.ts. */
const GRACE_MS = 60_000;

const REPLYABLE_KINDS = new Set(["say", "me", "ooc"]);

const FONT_PX = ["12px", "14px", "16px", "18px"] as const;

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function MessageList({ messages, occupants, selfUserId, roomType, onIconClick, onNameClick, onMentionClick, onTimeClick, fontStep }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const genderByUser = new Map<string, Gender>();
  // Account-level role lookup so the renderer can italicize site admins'
  // names. Only populated for users currently in the room - history from
  // someone who's left renders without italics, which is fine (italics is
  // decorative, not load-bearing identification).
  const adminUserIds = new Set<string>();
  for (const o of occupants) {
    genderByUser.set(o.userId, o.gender);
    if (o.accountRole === "admin") adminUserIds.add(o.userId);
  }

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
          isSenderAdmin={adminUserIds.has(m.userId)}
          isRecipientAdmin={!!m.toUserId && adminUserIds.has(m.toUserId)}
          isOwn={!!selfUserId && m.userId === selfUserId}
          canReport={roomType === "public"}
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
  isSenderAdmin,
  isRecipientAdmin,
  isOwn,
  canReport,
  onIconClick,
  onNameClick,
  onMentionClick,
  onTimeClick,
}: {
  msg: ChatMessage;
  gender: Gender;
  isSenderAdmin: boolean;
  isRecipientAdmin: boolean;
  isOwn: boolean;
  canReport: boolean;
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
      italic={isSenderAdmin}
      mood={msg.moodSnapshot ?? null}
      onIconClick={() => onIconClick(msg.userId, msg.displayName)}
      onNameClick={() => onNameClick(msg.userId, msg.displayName)}
      // Chat lines stay compact - viewers open profiles from the userlist.
      hideIcon
    />
  );
  // Soft-deleted messages collapse to a placeholder regardless of kind.
  // Server strips the body server-side already; this just paints the gap so
  // the timeline doesn't shift when an in-grace delete fires.
  if (msg.deletedAt) {
    return (
      <div className="text-keep-muted/70">
        <span className="mr-2 select-none text-xs tabular-nums">{timeText}</span>
        <span className="italic">[message removed]</span>
      </div>
    );
  }

  // Memoize the parsed parts on body so the splitMentions regex doesn't
  // re-run on every parent render (only when the body changes).
  const bodyParts = useMemo(() => splitMentions(msg.body), [msg.body]);
  const renderedBody = renderParts(bodyParts, onMentionClick);

  // Edit/delete controls only apply to the author's own chat-shaped lines
  // and only inside the grace window. The server re-validates both rules,
  // so the UI is just an affordance hint.
  const ageMs = Date.now() - msg.createdAt;
  const showOwnControls = isOwn && ageMs < GRACE_MS && REPLYABLE_KINDS.has(msg.kind);
  const editedBadge = msg.editedAt ? (
    <span
      className="ml-1 text-[10px] italic text-keep-muted"
      title={`edited ${new Date(msg.editedAt).toLocaleTimeString()}`}
    >
      (edited)
    </span>
  ) : null;

  let lineEl: ReactNode;
  switch (msg.kind) {
    case "me":
      lineEl = (
        <div className="font-action" style={msg.color ? { color: msg.color } : { color: "#0b3a8c" }}>
          {time}{tag} <span className="whitespace-pre-wrap">{renderedBody}</span>{editedBadge}
        </div>
      );
      break;
    case "roll":
      lineEl = (
        <div className="text-keep-system">
          {time}{tag} <span className="whitespace-pre-wrap">🎲 {renderedBody}</span>{editedBadge}
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
          {time}<span className="whitespace-pre-wrap">📣 {renderedBody}</span>
        </div>
      );
      break;
    case "scene":
      lineEl = (
        // Tinted banner that visually breaks the timeline. Distinct from
        // announce (red, sitewide) and system (muted, joins/parts).
        <div className="my-1 rounded border-y border-keep-action/40 bg-keep-action/10 px-3 py-1 text-center font-action italic text-keep-action">
          <span className="whitespace-pre-wrap">🎭 {renderedBody}</span>
        </div>
      );
      break;
    case "npc":
      // Renders the NPC name (msg.displayName has been overridden by the
      // /npc handler) followed by the body. The "voiced by" tag is small,
      // muted, and clickable - it routes to the voicing user's master profile
      // so the audience can verify who's puppeting. Body shape: a leading
      // `*...*` (italic) means /npc <Name> /me <act> ; otherwise quoted say.
      lineEl = (
        <div className="text-keep-text">
          {time}
          <span className="font-semibold italic">{msg.displayName}</span>
          {msg.npcVoicedBy ? (
            <button
              type="button"
              onClick={() => onMentionClick(msg.npcVoicedBy!)}
              className="ml-1 rounded text-[10px] uppercase tracking-wide text-keep-muted hover:text-keep-action hover:underline"
              title={`voiced by ${msg.npcVoicedBy} — click to view profile`}
            >
              (voiced by {msg.npcVoicedBy})
            </button>
          ) : null}
          <span className="ml-1 whitespace-pre-wrap">{renderedBody}</span>
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
            italic={isRecipientAdmin}
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
          <span className="text-keep-muted">:</span> <span className="whitespace-pre-wrap">{renderedBody}</span>{editedBadge}
        </div>
      );
      break;
    }
    case "ooc":
      lineEl = (
        <div className="text-keep-muted">
          {time}[{tag}] <span className="whitespace-pre-wrap">{renderedBody}</span>{editedBadge}
        </div>
      );
      break;
    case "say":
    default:
      lineEl = (
        <div>
          {time}[{tag}] <span className="whitespace-pre-wrap" style={msg.color ? { color: msg.color } : undefined}>{renderedBody}</span>{editedBadge}
        </div>
      );
      break;
  }

  // Wrap the line in a `group` so author edit/delete controls and the
  // report button can be hover-revealed (they'd be too noisy in your own
  // history otherwise). Controls are absolutely positioned so they don't
  // disturb existing layout for any kind.
  const showReport = canReport && !isOwn && REPORTABLE_KINDS.has(msg.kind);
  const wrapped = (
    <div className="group relative">
      {lineEl}
      {showOwnControls ? <OwnControls msg={msg} /> : null}
      {showReport && !showOwnControls ? <ReportButton msg={msg} /> : null}
    </div>
  );

  // Replies wrap the quote + the line in a single container with a continuous
  // accent-tinted left border, so the two read as one coupled block instead
  // of as two stray lines next to each other in the timeline.
  if (isReply) {
    return (
      <div className="my-0.5 border-l-2 border-keep-action/50 pl-2">
        {quote}
        {wrapped}
      </div>
    );
  }
  return wrapped;
}

/**
 * Hover-revealed 🚩 button on public-room messages from other users. Opens
 * a window.prompt for an optional reason and POSTs the report. The server
 * is authoritative on eligibility (whisper/private gates, dup-report cap);
 * any 4xx surfaces verbatim via window.alert.
 */
function ReportButton({ msg }: { msg: ChatMessage }) {
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function file() {
    if (done || busy) return;
    const reason = window.prompt(
      `Report this message from ${msg.displayName}? Optional reason (admins see it):`,
      "",
    );
    // window.prompt returns null on cancel, "" on empty submit. Treat null
    // as "abandoned" and "" as "no reason" so cancelling doesn't fire.
    if (reason === null) return;
    setBusy(true);
    try {
      const res = await fetch("/reports", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: msg.id, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        window.alert(j.error ?? `Couldn't file report (HTTP ${res.status}).`);
        return;
      }
      setDone(true);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "report failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="absolute right-0 top-0 invisible group-hover:visible">
      <button
        type="button"
        onClick={file}
        disabled={busy || done}
        title={done ? "Reported - admins will review." : "Report this message to admins"}
        className="rounded border border-keep-rule bg-keep-bg/80 px-1.5 py-0 text-[10px] text-keep-muted hover:bg-keep-accent/10 hover:text-keep-accent disabled:opacity-50"
      >
        {done ? "reported" : "🚩 report"}
      </button>
    </span>
  );
}

/**
 * Author-only inline controls for editing/deleting a message inside the
 * grace window. Hover-revealed to keep the timeline tidy. The server is
 * authoritative on the grace cap; clicks that land just past the window
 * surface the server's error verbatim rather than failing silently.
 */
function OwnControls({ msg }: { msg: ChatMessage }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.body);
  const [error, setError] = useState<string | null>(null);

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (trimmed === msg.body) { setEditing(false); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/messages/${msg.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: trimmed }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      // Server emits message:update; the store action picks it up and the
      // line re-renders. We just close the inline editor.
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "edit failed");
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    if (!window.confirm("Delete this message? You can only do this within 60 seconds of sending.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/messages/${msg.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <form
        onSubmit={submitEdit}
        className="mt-1 flex items-center gap-1"
        onKeyDown={(e) => {
          if (e.key === "Escape") { setEditing(false); setDraft(msg.body); }
        }}
      >
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="flex-1 rounded border border-keep-action bg-keep-bg px-2 py-0.5 text-sm outline-none"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded border border-keep-action bg-keep-action/10 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/20 disabled:opacity-50"
        >
          {busy ? "..." : "Save"}
        </button>
        <button
          type="button"
          onClick={() => { setEditing(false); setDraft(msg.body); setError(null); }}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs hover:bg-keep-banner"
        >
          Cancel
        </button>
        {error ? <span className="text-[10px] text-keep-accent">{error}</span> : null}
      </form>
    );
  }

  return (
    <span className="absolute right-0 top-0 invisible flex gap-1 group-hover:visible">
      <button
        type="button"
        onClick={() => { setDraft(msg.body); setEditing(true); }}
        title="Edit (within 60s of sending)"
        className="rounded border border-keep-rule bg-keep-bg/80 px-1.5 py-0 text-[10px] text-keep-muted hover:bg-keep-banner hover:text-keep-text"
      >
        edit
      </button>
      <button
        type="button"
        onClick={doDelete}
        title="Delete (within 60s of sending)"
        disabled={busy}
        className="rounded border border-keep-accent/50 bg-keep-bg/80 px-1.5 py-0 text-[10px] text-keep-accent hover:bg-keep-accent/10 disabled:opacity-50"
      >
        delete
      </button>
      {error ? <span className="text-[10px] text-keep-accent">{error}</span> : null}
    </span>
  );
}
