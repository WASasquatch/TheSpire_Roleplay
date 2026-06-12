import { and, eq, lt } from "drizzle-orm";
import { messages, rooms } from "../../db/schema.js";
import { callerCanEditRoom } from "../../auth/roomPermissions.js";
import type { CommandContext, CommandHandler } from "../types.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/**
 * /expiry [N|off]
 *
 * Read or set the per-room message expiry window (in MINUTES). When set, the
 * janitor's hourly sweep deletes any message in this room older than the
 * configured window, regardless of the global retention setting.
 *
 *   /expiry          - report the current setting
 *   /expiry 60       - delete messages older than 60 minutes
 *   /expiry 1440     - one day
 *   /expiry off      - clear; honor only the global retention setting
 *
 * Owner/mod/admin only to change. We also fire an immediate sweep on the
 * affected room so the new policy takes effect right away (the next janitor
 * tick is up to an hour out, which would feel laggy from the operator's
 * perspective).
 */
export const expiryCommand: CommandHandler = {
  name: "expiry",
  aliases: ["expire", "ttl"],
  usage: "/expiry [N|off]   (N is minutes, e.g. 60 = 1 hour)",
  description: "Show or set per-room message auto-expiry (owner/mod only).",
  subcommands: [
    { verb: "(no args)", usage: "/expiry", description: "Show this room's current expiry setting." },
    { verb: "<minutes>", usage: "/expiry 60", description: "Delete messages older than N minutes (1-43200 = 30 days)." },
    { verb: "off", usage: "/expiry off", description: "Clear the per-room expiry; only the global retention applies.", aliases: ["clear", "none"] },
  ],
  async run(ctx) {
    const arg = ctx.argsText.trim();
    const room = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
    if (!room) return notice(ctx, "NO_ROOM", "Room not found.");

    if (!arg) {
      const cur = room.messageExpiryMinutes;
      const msg = cur && cur > 0
        ? `Messages in this room auto-expire after ${cur} minutes.`
        : "No per-room expiry set; only the global retention setting applies.";
      return notice(ctx, "EXPIRY", msg);
    }

    if (!(await callerCanEditRoom(ctx.db, ctx.user, ctx.roomId))) {
      return notice(ctx, "PERM", "Only the room owner / mod / admin can change the expiry.");
    }

    if (/^(off|clear|none|0)$/i.test(arg)) {
      await ctx.db.update(rooms).set({ messageExpiryMinutes: null }).where(eq(rooms.id, ctx.roomId));
      const { addMessage, broadcastRoomState } = await import("../../realtime/broadcast.js");
      await addMessage(ctx, { kind: "system", body: "Per-room message expiry cleared." });
      await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
      return;
    }

    const n = parseInt(arg, 10);
    if (!Number.isFinite(n) || n < 1 || n > 43_200) {
      return notice(ctx, "BAD_EXPIRY", "Expiry must be a whole number of minutes between 1 and 43200 (30 days). Use /expiry off to clear.");
    }
    await ctx.db.update(rooms).set({ messageExpiryMinutes: n }).where(eq(rooms.id, ctx.roomId));

    // Fire the sweep immediately for THIS room so visible old messages don't
    // hang around until the next janitor tick. Bounded by the new cutoff.
    const cutoff = new Date(Date.now() - n * 60 * 1000);
    await ctx.db.delete(messages).where(and(eq(messages.roomId, ctx.roomId), lt(messages.createdAt, cutoff)));

    const { addMessage, broadcastRoomState } = await import("../../realtime/broadcast.js");
    await addMessage(ctx, { kind: "system", body: `Per-room message expiry set to ${n} minutes. Older messages just purged.` });
    await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
  },
};

/**
 * /replymode [flat|nested]
 *
 * Toggle the chat rendering mode for this room. "flat" is the default
 * timeline; "nested" groups replies under their parent into thread
 * containers with a "View More" past the latest 5 replies.
 */
export const replyModeCommand: CommandHandler = {
  name: "replymode",
  aliases: ["replies", "threadmode"],
  usage: "/replymode [flat|nested]",
  description: "Show or set how replies render in this room (owner/mod only to set).",
  subcommands: [
    { verb: "(no args)", usage: "/replymode", description: "Show the current reply mode." },
    { verb: "flat", usage: "/replymode flat", description: "Replies appear at the end of chat in chronological order (default)." },
    { verb: "nested", usage: "/replymode nested", description: "Replies group under their parent in a thread container; latest 5 visible by default." },
  ],
  async run(ctx) {
    const arg = ctx.argsText.trim().toLowerCase();
    const room = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
    if (!room) return notice(ctx, "NO_ROOM", "Room not found.");

    if (!arg) {
      return notice(ctx, "REPLYMODE", `This room's reply mode: ${room.replyMode}.`);
    }
    if (arg !== "flat" && arg !== "nested") {
      return notice(ctx, "BAD_REPLYMODE", "Reply mode must be 'flat' or 'nested'.");
    }
    // Boards (rooms inside a forum) are nested BY DEFINITION — the Forums
    // Catalog renders their topics, and flipping one to flat would orphan
    // every topic from that UI. Board structure is managed from the forum
    // owner's settings, not this command.
    if (room.forumId) {
      return notice(ctx, "FORUM_BOARD", "This room is a forum board - boards always use nested replies.");
    }
    if (!(await callerCanEditRoom(ctx.db, ctx.user, ctx.roomId))) {
      return notice(ctx, "PERM", "Only the room owner / mod / admin can change the reply mode.");
    }
    if (room.replyMode === arg) {
      return notice(ctx, "REPLYMODE", `Reply mode is already ${arg}.`);
    }
    await ctx.db.update(rooms).set({ replyMode: arg }).where(eq(rooms.id, ctx.roomId));

    const { addMessage, broadcastRoomState } = await import("../../realtime/broadcast.js");
    await addMessage(ctx, {
      kind: "system",
      body: arg === "nested"
        ? "Reply mode set to nested - replies will group under their parent."
        : "Reply mode set to flat - replies will appear in chronological order.",
    });
    await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
  },
};
