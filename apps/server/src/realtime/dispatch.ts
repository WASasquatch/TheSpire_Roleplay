import { and, eq } from "drizzle-orm";
import type { Server as IoServer, Socket } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@thekeep/shared";
import { parseInput } from "../commands/parser.js";
import type { CommandRegistry } from "../commands/registry.js";
import type { CommandContext, SessionUser } from "../commands/types.js";
import type { Db } from "../db/index.js";
import { mutes } from "../db/schema.js";
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
const RATE_WINDOW_MS = 10_000;
const COOLDOWN_MS = 5_000;
const recentByUser = new Map<string, number[]>();
const cooldownUntil = new Map<string, number>();

function checkChatRate(userId: string, now: number): { ok: true } | { ok: false; retryMs: number } {
  const cooldown = cooldownUntil.get(userId) ?? 0;
  if (cooldown > now) return { ok: false, retryMs: cooldown - now };

  const window = recentByUser.get(userId) ?? [];
  // Drop timestamps outside the window before counting.
  const cutoff = now - RATE_WINDOW_MS;
  let i = 0;
  while (i < window.length && window[i]! < cutoff) i++;
  const fresh = i > 0 ? window.slice(i) : window;

  if (fresh.length >= RATE_MAX) {
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
}): Promise<void> {
  const { io, socket, db, registry, user, roomId, text } = args;

  const trimmed = text.trim();
  if (!trimmed) return;
  // Admin-configurable cap; the cached settings read is essentially free
  // after the first hit.
  const { maxMessageLength } = await getSettings(db);
  if (trimmed.length > maxMessageLength) {
    socket.emit("error:notice", { code: "TOO_LONG", message: `Messages capped at ${maxMessageLength} chars.` });
    return;
  }

  // Per-user rate limit (admins exempt - moderation flurries shouldn't get
  // throttled). The limiter applies to ALL chat:input - slash commands
  // included - because a flood of /me or /roll is just as disruptive as
  // a flood of plain text.
  if (user.role !== "admin") {
    const rate = checkChatRate(user.id, Date.now());
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
    ].includes(cmd);
  };
  if (mutedFor !== null && isSpeechCommand(parsed.command)) {
    socket.emit("error:notice", {
      code: "MUTED",
      message: `You're muted in this room for another ${formatDuration(mutedFor)}.`,
    });
    return;
  }

  // Plain chat
  if (parsed.command === null) {
    const ctx: CommandContext = {
      io, socket, db, user, roomId,
      argsText: parsed.argsText,
      args: [],
      invokedAs: "say",
    };
    await addMessage(ctx, { kind: "say", body: parsed.argsText.trim() });
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
    io, socket, db, user, roomId,
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

function hasPermission(user: SessionUser, required: "user" | "mod" | "admin"): boolean {
  const order = { user: 0, mod: 1, admin: 2 } as const;
  return order[user.role] >= order[required];
}
