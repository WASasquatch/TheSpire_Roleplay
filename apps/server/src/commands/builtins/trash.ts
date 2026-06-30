import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { messages, rooms } from "../../db/schema.js";
import { formatDuration, parseDuration } from "../duration.js";
import type { CommandContext, CommandHandler } from "../types.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

const CHUNK = 400; // keep each DELETE under SQLite's bound-variable cap

/**
 * /trash <duration> - hard-delete the most recent messages in this room.
 *
 * The moderation counterpart to /clear (which only hides scrollback for
 * the caller). `/trash 30m` permanently removes every message posted in
 * the last 30 minutes and makes them vanish live for everyone via the
 * `message:bulk-delete` event. Irreversible.
 *
 *   /trash 30m     delete the last 30 minutes
 *   /trash 2h      delete the last 2 hours
 *   /trash 1h30m   compound durations work
 *
 * Gated by the `delete_others_message` permission (mods + admins by
 * default; an admin can redistribute it via the Roles & Permissions
 * matrix). The dispatcher enforces this before run() and hides the
 * command from /help for anyone without it, so plain room owners can't
 * mass-delete - this is a moderation hammer, not a room-config knob.
 *
 * Whispers are left alone (private, cross-room). Forum rooms are
 * excluded - their posts are long-lived by design; delete topics
 * individually there instead.
 */
export const trashCommand: CommandHandler = {
  name: "trash",
  aliases: ["purge"],
  usage: "/trash <duration>   (e.g. /trash 30m - delete the last 30 minutes of messages)",
  description: "Delete this room's most recent messages by age (mod/admin only). Irreversible.",
  permission: "delete_others_message",
  // Server staff with the per-server delete grant can /trash in their own
  // server's rooms (the default/system server stays on the global key).
  serverPermission: "delete_others_message",
  subcommands: [
    {
      verb: "<duration>",
      usage: "/trash 30m",
      description: "Hard-delete every message from the last N. Formats: 30s, 5m, 2h, 1h30m, 1d.",
    },
  ],
  async run(ctx) {
    const arg = ctx.argsText.trim();
    if (!arg) {
      return notice(ctx, "USAGE", "Usage: /trash <duration> - e.g. /trash 30m to delete the last 30 minutes.");
    }
    // Permission is enforced by the dispatcher via `permission` above
    // (delete_others_message). No inline role check needed here.
    const room = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
    if (!room) return notice(ctx, "NO_ROOM", "Room not found.");
    if (room.replyMode === "nested") {
      return notice(ctx, "FORUM", "/trash isn't available in forum rooms - delete topics individually instead.");
    }

    const ms = parseDuration(arg);
    if (ms == null) {
      return notice(ctx, "BAD_DURATION", "Bad duration. Use forms like 5m, 30m, 1h, 1h30m, 1d.");
    }
    const cutoff = new Date(Date.now() - ms);

    // Snapshot the exact ids to remove BEFORE deleting, so the live
    // removal broadcast matches what we delete (a message arriving
    // mid-command simply isn't trashed). Whispers are excluded.
    const doomed = await ctx.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(
        eq(messages.roomId, ctx.roomId),
        sql`${messages.kind} != 'whisper'`,
        gte(messages.createdAt, cutoff),
      ));
    const ids = doomed.map((r) => r.id);
    if (ids.length === 0) {
      return notice(ctx, "TRASH", `No messages in the last ${formatDuration(ms)} to delete.`);
    }

    for (let i = 0; i < ids.length; i += CHUNK) {
      await ctx.db.delete(messages).where(inArray(messages.id, ids.slice(i, i + CHUNK)));
    }

    // Live-remove from every client's buffer, then post a system summary
    // (the summary's own row is newer than the cutoff, so it survives).
    ctx.io.to(`room:${ctx.roomId}`).emit("message:bulk-delete", { roomId: ctx.roomId, ids });
    const { addMessage } = await import("../../realtime/broadcast.js");
    await addMessage(ctx, {
      kind: "system",
      body: `${ctx.user.displayName} cleared ${ids.length} message${ids.length === 1 ? "" : "s"} from the last ${formatDuration(ms)}.`,
    });
  },
};
