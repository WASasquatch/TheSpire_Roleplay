import { and, eq, lt } from "drizzle-orm";
import { messages, rooms } from "../../db/schema.js";
import { callerCanEditRoom } from "../../auth/roomPermissions.js";
import { archiveDoomedBookmarks } from "../../retention/archiveBookmarks.js";
import { effectiveRoomNsfw, setRoomNsfw } from "../../lib/nsfwRooms.js";
import { tFor } from "../../i18n.js";
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
    if (!room) return notice(ctx, "NO_ROOM", tFor(ctx.user.locale, "commands:shared.roomNotFound"));

    if (!arg) {
      const cur = room.messageExpiryMinutes;
      const msg = cur && cur > 0
        ? tFor(ctx.user.locale, "commands:expiry.current", { minutes: cur })
        : tFor(ctx.user.locale, "commands:expiry.none");
      return notice(ctx, "EXPIRY", msg);
    }

    if (!(await callerCanEditRoom(ctx.db, ctx.user, ctx.roomId))) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:expiry.permission"));
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
      return notice(ctx, "BAD_EXPIRY", tFor(ctx.user.locale, "commands:expiry.invalid"));
    }
    await ctx.db.update(rooms).set({ messageExpiryMinutes: n }).where(eq(rooms.id, ctx.roomId));

    // Fire the sweep immediately for THIS room so visible old messages don't
    // hang around until the next janitor tick. Bounded by the new cutoff.
    const cutoff = new Date(Date.now() - n * 60 * 1000);
    const doomed = and(eq(messages.roomId, ctx.roomId), lt(messages.createdAt, cutoff));
    // Snapshot-archive bookmarks BEFORE the hard delete drops the rows.
    await archiveDoomedBookmarks(ctx.db, doomed);
    await ctx.db.delete(messages).where(doomed);

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
    if (!room) return notice(ctx, "NO_ROOM", tFor(ctx.user.locale, "commands:shared.roomNotFound"));

    if (!arg) {
      return notice(ctx, "REPLYMODE", tFor(ctx.user.locale, "commands:replyMode.current", { mode: room.replyMode }));
    }
    if (arg !== "flat" && arg !== "nested") {
      return notice(ctx, "BAD_REPLYMODE", tFor(ctx.user.locale, "commands:replyMode.invalid"));
    }
    // Boards (rooms inside a forum) are nested BY DEFINITION — the Forums
    // Catalog renders their topics, and flipping one to flat would orphan
    // every topic from that UI. Board structure is managed from the forum
    // owner's settings, not this command.
    if (room.forumId) {
      return notice(ctx, "FORUM_BOARD", tFor(ctx.user.locale, "commands:replyMode.forumBoard"));
    }
    if (!(await callerCanEditRoom(ctx.db, ctx.user, ctx.roomId))) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:replyMode.permission"));
    }
    if (room.replyMode === arg) {
      return notice(ctx, "REPLYMODE", tFor(ctx.user.locale, "commands:replyMode.already", { mode: arg }));
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

/**
 * /nsfw [on|off]
 *
 * Show or set this room's 18+ flag (age-restriction plan, Phase 2). While a
 * room is 18+, members under 18 can't see it in the rail, join it, read or
 * export its history, or get notified from it — and messages written while
 * it's on are stamped so that era stays hidden from minors even after a
 * flip back.
 *
 * Writes require room-edit rights (owner / room mod / `edit_any_room_metadata`,
 * the same gate as /expiry) AND an adult account: there is deliberately no
 * staff bypass for minor accounts. The shared toggle core (`setRoomNsfw`)
 * enforces the landing-room rule, evicts minor occupants on flip-ON (their
 * membership rows are kept), writes the audit row, and posts the system line.
 */
export const nsfwCommand: CommandHandler = {
  name: "nsfw",
  aliases: ["adult", "18plus"],
  usage: "/nsfw [on|off]",
  description: "Show or set this room's 18+ setting (owner/mod only to set; adults only).",
  subcommands: [
    { verb: "(no args)", usage: "/nsfw", description: "Show whether this room is 18+." },
    { verb: "on", usage: "/nsfw on", description: "Mark the room 18+. Members under 18 can no longer see or join it.", aliases: ["true", "1"] },
    { verb: "off", usage: "/nsfw off", description: "Clear the 18+ setting. Messages written while it was 18+ stay hidden from members under 18.", aliases: ["false", "0"] },
  ],
  async run(ctx) {
    const arg = ctx.argsText.trim().toLowerCase();
    const room = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
    if (!room) return notice(ctx, "NO_ROOM", tFor(ctx.user.locale, "commands:shared.roomNotFound"));

    if (!arg) {
      // Bare /nsfw reports the EFFECTIVE state. Inside an 18+ community the
      // room is 18+ whatever its own flag says, and the report says so.
      const effective = await effectiveRoomNsfw(ctx.db, room);
      const msg = room.isNsfw
        ? tFor(ctx.user.locale, "commands:nsfw.on18")
        : effective
          ? tFor(ctx.user.locale, "commands:nsfw.effectiveCommunity")
          : tFor(ctx.user.locale, "commands:nsfw.off18");
      return notice(ctx, "NSFW", msg);
    }

    let value: boolean;
    if (/^(on|true|1)$/.test(arg)) value = true;
    else if (/^(off|false|0)$/.test(arg)) value = false;
    else {
      return notice(ctx, "BAD_NSFW", tFor(ctx.user.locale, "commands:nsfw.usage"));
    }

    if (!(await callerCanEditRoom(ctx.db, ctx.user, ctx.roomId))) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:nsfw.permission"));
    }
    if (room.isNsfw === value) {
      return notice(ctx, "NSFW", value
        ? tFor(ctx.user.locale, "commands:nsfw.already18")
        : tFor(ctx.user.locale, "commands:nsfw.alreadyNot18"));
    }

    // The shared core owns the adult-only write, the landing-room rule, the
    // minor eviction, the audit row, the system line, and the broadcasts.
    const result = await setRoomNsfw({ db: ctx.db, io: ctx.io, room, value, actor: ctx.user });
    if (!result.ok) return notice(ctx, result.code, result.message);
  },
};
