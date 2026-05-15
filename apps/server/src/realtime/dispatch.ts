import { and, eq } from "drizzle-orm";
import type { Server as IoServer, Socket } from "socket.io";
import { isAdminRole } from "@thekeep/shared";
import type {
  ClientToServerEvents,
  Role,
  ServerToClientEvents,
} from "@thekeep/shared";
import { parseInput } from "../commands/parser.js";
import type { CommandRegistry } from "../commands/registry.js";
import type { CommandContext, SessionUser } from "../commands/types.js";
import type { Db } from "../db/index.js";
import { messages, mutes, rooms } from "../db/schema.js";
import { formatDuration } from "../commands/duration.js";
import { getSettings } from "../settings.js";
import { addMessage } from "./broadcast.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;
type Sock = Socket<ClientToServerEvents, ServerToClientEvents>;

/**
 * Per-user chat rate limiter. Uses a sliding window of timestamps in a Map
 * keyed by userId. A user can send up to RATE_MAX messages within
 * RATE_WINDOW_MS; the (RATE_MAX + 1)th lands them in a brief cooldown.
 *
 * Admins are exempted (they shouldn't be locked out of their own moderation).
 * Map entries are pruned on each check so the table doesn't leak memory for
 * users who disconnect and never come back.
 */
const RATE_MAX = 12;
/** Trusted accounts get 2× the headroom - earned via the auto-promotion sweep. */
const RATE_MAX_TRUSTED = 24;
const RATE_WINDOW_MS = 10_000;
const COOLDOWN_MS = 5_000;
const recentByUser = new Map<string, number[]>();
const cooldownUntil = new Map<string, number>();

function checkChatRate(userId: string, now: number, max: number): { ok: true } | { ok: false; retryMs: number } {
  const cooldown = cooldownUntil.get(userId) ?? 0;
  if (cooldown > now) return { ok: false, retryMs: cooldown - now };

  const window = recentByUser.get(userId) ?? [];
  // Drop timestamps outside the window before counting.
  const cutoff = now - RATE_WINDOW_MS;
  let i = 0;
  while (i < window.length && window[i]! < cutoff) i++;
  const fresh = i > 0 ? window.slice(i) : window;

  if (fresh.length >= max) {
    cooldownUntil.set(userId, now + COOLDOWN_MS);
    return { ok: false, retryMs: COOLDOWN_MS };
  }
  fresh.push(now);
  recentByUser.set(userId, fresh);
  return { ok: true };
}

export async function dispatchChatInput(args: {
  io: Io;
  socket: Sock;
  db: Db;
  registry: CommandRegistry;
  user: SessionUser;
  roomId: string;
  text: string;
  /**
   * Optional thread-category bucket for new top-level topics in
   * nested-mode rooms. Validated by the caller (`socket.on("chat:input")`)
   * to belong to the target room; an invalid id is silently dropped to
   * null here rather than rejecting the send, so a racing admin delete
   * of the chosen category never costs the user their message.
   */
  threadCategoryId?: string | null;
  /**
   * Non-empty when the user is starting a new forum topic. Carried
   * straight through to the persisted message row as `title`. Caller
   * has already trimmed; we just verify it's not blank when present.
   */
  threadTitle?: string;
  /**
   * When set, this send is a reply under that topic. The dispatcher
   * also accepts inline `/reply <id>` syntax for the same effect; this
   * explicit field is what the forum composer uses since it doesn't
   * require encoding the parent id inside the body text.
   */
  replyToId?: string;
}): Promise<void> {
  const { io, socket, db, registry, user, roomId, text, threadCategoryId, threadTitle, replyToId } = args;

  const trimmed = text.trim();
  if (!trimmed) return;
  // Admin-configurable cap; the cached settings read is essentially free
  // after the first hit.
  const { maxMessageLength } = await getSettings(db);
  if (trimmed.length > maxMessageLength) {
    socket.emit("error:notice", { code: "TOO_LONG", message: `Messages capped at ${maxMessageLength} chars.` });
    return;
  }

  // Per-user rate limit. Site mods and admins are exempt entirely
  // (moderation flurries shouldn't get throttled). Trusted users (auto-
  // promoted by the janitor after the trust thresholds are met) get a 2×
  // budget; everyone else uses the default cap. The limiter applies to ALL
  // chat:input - slash commands included - because a flood of /me or /roll
  // is just as disruptive as a flood of plain text.
  // Both admin tiers + mods bypass the rate limit — moderation
  // flurries (rapid kicks, mutes, /announce sequences) shouldn't get
  // throttled. Adding masteradmin via isAdminRole keeps both admin
  // tiers exempt without enumerating them here.
  if (!isAdminRole(user.role) && user.role !== "mod") {
    const max = user.role === "trusted" ? RATE_MAX_TRUSTED : RATE_MAX;
    const rate = checkChatRate(user.id, Date.now(), max);
    if (!rate.ok) {
      socket.emit("error:notice", {
        code: "RATE_LIMIT",
        message: `Slow down - try again in ${Math.ceil(rate.retryMs / 1000)}s.`,
      });
      return;
    }
  }

  // Reject sends targeted at a room the socket isn't joined to. Without this
  // a stale client (or a hostile one) could chat into rooms it never joined,
  // bypassing private/password gates. We use socket.rooms because it's the
  // ground truth for "what rooms this socket actually broadcasts into."
  if (!socket.rooms.has(`room:${roomId}`)) {
    socket.emit("error:notice", {
      code: "WRONG_ROOM",
      message: "You aren't in that room. Try /go <room> to switch.",
    });
    return;
  }

  const parsed = parseInput(text);

  // Mute check - applies to plain chat, /me-style emotes, /whisper, and most
  // other speech-producing commands. We deliberately allow some non-speech
  // commands to pass (e.g. /char list, /profile, /help, /refresh, /go) so a
  // muted user isn't completely paralyzed in the room. Anything that emits a
  // visible message routes through addMessage which also checks the mute.
  const muteRow = (await db
    .select()
    .from(mutes)
    .where(and(eq(mutes.roomId, roomId), eq(mutes.userId, user.id)))
    .limit(1))[0];
  let mutedFor: number | null = null;
  if (muteRow) {
    const remaining = +muteRow.until - Date.now();
    if (remaining > 0) mutedFor = remaining;
    else {
      // Auto-clean expired mutes so the row doesn't keep tripping checks.
      await db.delete(mutes).where(and(eq(mutes.roomId, roomId), eq(mutes.userId, user.id)));
    }
  }
  const isSpeechCommand = (cmd: string | null): boolean => {
    if (cmd === null) return true; // plain say
    return [
      "me", "he", "she", "they", "it", "em", "action", "pose", "emote",
      "whisper", "wh", "w", "to", "msg", "message", "pm",
      "reply", "re",
      "roll", "dice",
      "topic",
      "scene", "npc",
    ].includes(cmd);
  };
  if (mutedFor !== null && isSpeechCommand(parsed.command)) {
    socket.emit("error:notice", {
      code: "MUTED",
      message: `You're muted in this room for another ${formatDuration(mutedFor)}.`,
    });
    return;
  }

  // Plain chat. Behavior splits based on the room's replyMode:
  //   - flat rooms: standard chronological chat (the historic behavior).
  //   - nested rooms: forum-style. Plain sends MUST be either a new
  //     topic (threadTitle set) or a reply under an existing topic
  //     (replyToId set). Bare chat-style sends are rejected — the
  //     composer enforces this client-side, but the server is
  //     authoritative.
  if (parsed.command === null) {
    const roomRow = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
    const isForum = roomRow?.replyMode === "nested";
    const ctx: CommandContext = {
      io, socket, db, registry, user, roomId,
      argsText: parsed.argsText,
      args: [],
      invokedAs: "say",
    };
    if (isForum) {
      // New topic path. Title is required to start one; the client
      // should never send an empty topic title with no replyToId, but
      // we reject defensively.
      if (threadTitle && !replyToId) {
        const cappedTitle = threadTitle.trim().slice(0, 120);
        if (!cappedTitle) {
          socket.emit("error:notice", {
            code: "EMPTY_TITLE",
            message: "Topic title can't be empty.",
          });
          return;
        }
        await addMessage(ctx, {
          kind: "say",
          body: parsed.argsText.trimEnd(),
          title: cappedTitle,
          ...(threadCategoryId ? { threadCategoryId } : {}),
        });
        return;
      }
      // Reply path. The parent must exist, be in the same room, and
      // itself be a top-level topic (not a reply to a reply — forum
      // structure is two-level: topic + flat reply chain). We
      // snapshot the parent author's name + a body excerpt for the
      // inline quote preview, same as the /reply slash command does.
      if (replyToId && !threadTitle) {
        const parent = (await db.select().from(messages).where(eq(messages.id, replyToId)).limit(1))[0];
        if (!parent || parent.roomId !== roomId) {
          socket.emit("error:notice", {
            code: "BAD_TOPIC",
            message: "That topic isn't in this room (or has been removed).",
          });
          return;
        }
        if (parent.replyToId) {
          socket.emit("error:notice", {
            code: "NOT_A_TOPIC",
            message: "Replies attach to topics, not to other replies.",
          });
          return;
        }
        // Deleted topics are hidden from end-user views — but a stale
        // client (or a determined one) could still submit a reply to a
        // remembered id. Reject with the same code the client uses for
        // missing-topics so the user sees a graceful message.
        if (parent.deletedAt) {
          socket.emit("error:notice", {
            code: "BAD_TOPIC",
            message: "That topic isn't in this room (or has been removed).",
          });
          return;
        }
        // Locked topics reject new replies for users — but moderators
        // (role mod or admin/masteradmin) bypass the gate so they can post
        // locks/verdicts/notices in the same thread the lock applies to.
        // Mirrors the slash-command path in commands/builtins/reply.ts.
        if (parent.lockedAt && user.role !== "mod" && !isAdminRole(user.role)) {
          socket.emit("error:notice", {
            code: "TOPIC_LOCKED",
            message: "This topic is locked and isn't accepting new replies.",
          });
          return;
        }
        const snippet = parent.body.length > 120 ? `${parent.body.slice(0, 120)}…` : parent.body;
        await addMessage(ctx, {
          kind: "say",
          body: parsed.argsText.trimEnd(),
          replyToId: parent.id,
          replyToDisplayName: parent.displayName,
          replyToBodySnippet: snippet,
        });
        return;
      }
      // Neither a topic nor a reply — forum rooms don't accept loose
      // chat. The composer is supposed to disable in this state; this
      // is the server's belt-and-suspenders.
      socket.emit("error:notice", {
        code: "FORUM_NEEDS_TOPIC",
        message: "This room is a forum. Pick a topic to reply to, or start a new one.",
      });
      return;
    }
    // Flat-room path (historic). threadCategoryId is still honored for
    // installs that flipped a categorized room back to flat: the field
    // is harmless if present, ignored by the flat renderer.
    await addMessage(ctx, {
      kind: "say",
      body: parsed.argsText.trim(),
      ...(threadCategoryId ? { threadCategoryId } : {}),
    });
    return;
  }

  const handler = registry.resolve(parsed.command);
  if (!handler) {
    const suggestions = registry.suggest(parsed.command);
    const tail = suggestions.length ? ` Did you mean ${suggestions.map((s) => `/${s}`).join(", ")}?` : "";
    socket.emit("error:notice", {
      code: "UNKNOWN_CMD",
      message: `Unknown command /${parsed.command}.${tail}`,
    });
    return;
  }

  if (handler.permission && !hasPermission(user, handler.permission)) {
    socket.emit("error:notice", { code: "PERM", message: "You don't have permission to use that command." });
    return;
  }

  const ctx: CommandContext = {
    io, socket, db, registry, user, roomId,
    argsText: parsed.argsText,
    args: parsed.args,
    invokedAs: parsed.command,
  };

  try {
    await handler.run(ctx);
  } catch (err) {
    socket.emit("error:notice", {
      code: "CMD_ERROR",
      message: err instanceof Error ? err.message : "Command failed.",
    });
  }
}

function hasPermission(user: SessionUser, required: Role): boolean {
  // `trusted` sits between `user` and `mod` - elevated rate limits / extra
  // privileges, but no moderation authority. `masteradmin` is strictly
  // above `admin`, so an `admin`-required command also accepts a
  // masteradmin without enumerating the tier explicitly.
  const order = { user: 0, trusted: 1, mod: 2, admin: 3, masteradmin: 4 } as const;
  return order[user.role] >= order[required];
}
