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
      // "Never expire" (migration 0347) outranks any stale minutes value —
      // the janitor skips exempt rooms entirely — so report it first.
      const cur = room.messageExpiryMinutes;
      const msg = room.retentionExempt
        ? tFor(ctx.user.locale, "commands:expiry.never")
        : cur && cur > 0
          ? tFor(ctx.user.locale, "commands:expiry.current", { minutes: cur })
          : tFor(ctx.user.locale, "commands:expiry.none");
      return notice(ctx, "EXPIRY", msg);
    }

    if (!(await callerCanEditRoom(ctx.db, ctx.user, ctx.roomId))) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:expiry.permission"));
    }

    if (/^(off|clear|none|0)$/i.test(arg)) {
      // Full reset to "inherit the server retention window": clears the
      // per-room minutes AND the never-expire exemption, so the reported
      // "only the global retention applies" is actually true afterwards.
      await ctx.db.update(rooms).set({ messageExpiryMinutes: null, retentionExempt: false }).where(eq(rooms.id, ctx.roomId));
      const { addMessage, broadcastRoomState } = await import("../../realtime/broadcast.js");
      await addMessage(ctx, { kind: "system", body: "Per-room message expiry cleared." });
      await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
      return;
    }

    const n = parseInt(arg, 10);
    if (!Number.isFinite(n) || n < 1 || n > 43_200) {
      return notice(ctx, "BAD_EXPIRY", tFor(ctx.user.locale, "commands:expiry.invalid"));
    }
    // An explicit lifetime supersedes "never expire" — without clearing the
    // exemption the janitor would keep skipping the room AND the immediate
    // purge below would contradict the stored policy.
    await ctx.db.update(rooms).set({ messageExpiryMinutes: n, retentionExempt: false }).where(eq(rooms.id, ctx.roomId));

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
 * /postmode [everyone|staff]
 *
 * Show or set who may post in this room (info rooms, migration 0345).
 * "staff" turns the room read-only for ordinary members: only the room
 * owner, room mods, the room's server staff, and site staff may post;
 * everyone else reads and reacts. Whispers and non-posting commands are
 * unaffected. Boards (rooms inside a forum) are refused — boards carry
 * their own permission system. Same gate as /nsfw channel
 * (callerCanEditRoom: owner / room mod / edit_any_room_metadata).
 */
export const postModeCommand: CommandHandler = {
  name: "postmode",
  aliases: ["postingmode"],
  usage: "/postmode [everyone|staff]",
  description: "Show or set who can post in this room (owner/mod only to set).",
  subcommands: [
    { verb: "(no args)", usage: "/postmode", description: "Show who can currently post in this room." },
    { verb: "staff", usage: "/postmode staff", description: "Only staff can post: room owner, room mods, server staff, and site staff. Everyone else can still read and react." },
    { verb: "everyone", usage: "/postmode everyone", description: "Anyone in the room can post (default).", aliases: ["all", "open"] },
  ],
  async run(ctx) {
    const arg = ctx.argsText.trim().toLowerCase();
    const room = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
    if (!room) return notice(ctx, "NO_ROOM", tFor(ctx.user.locale, "commands:shared.roomNotFound"));

    if (!arg) {
      // 'roles' is console-only (no subcommand sets it), but the readout
      // must still report it — falling into "everyone" would tell a mod
      // the exact opposite of the room's state.
      return notice(ctx, "POSTMODE", tFor(ctx.user.locale,
        room.postMode === "staff"
          ? "commands:postMode.currentStaff"
          : room.postMode === "roles"
            ? "commands:postMode.currentRoles"
            : "commands:postMode.currentEveryone"));
    }
    let value: "everyone" | "staff";
    if (arg === "staff") value = "staff";
    else if (arg === "everyone" || arg === "all" || arg === "open") value = "everyone";
    else return notice(ctx, "BAD_POSTMODE", tFor(ctx.user.locale, "commands:postMode.usage"));

    // Boards live in the Forums Catalog and carry their own posting
    // permissions; this room-level knob must never shadow those.
    if (room.forumId) {
      return notice(ctx, "FORUM_BOARD", tFor(ctx.user.locale, "commands:postMode.forumBoard"));
    }
    if (!(await callerCanEditRoom(ctx.db, ctx.user, ctx.roomId))) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:postMode.permission"));
    }
    if (room.postMode === value) {
      return notice(ctx, "POSTMODE", tFor(ctx.user.locale,
        value === "staff" ? "commands:postMode.alreadyStaff" : "commands:postMode.alreadyEveryone"));
    }
    await ctx.db.update(rooms).set({ postMode: value }).where(eq(rooms.id, ctx.roomId));

    const { addMessage, broadcastRoomState, emitTreeChanged } = await import("../../realtime/broadcast.js");
    await addMessage(ctx, {
      kind: "system",
      body: value === "staff"
        ? "Posting is now limited to staff - everyone else can read and react."
        : "Posting is open to everyone again.",
    });
    // postLocked is a join-time socket stamp; refresh it for every socket
    // standing in the room before the summary fan-out reads it, so the flip
    // repaints occupants' composers without a rejoin.
    const { restampPostLockedForRoom } = await import("../../lib/postMode.js");
    await restampPostLockedForRoom(ctx.io, ctx.db, { ...room, postMode: value });
    await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
    // broadcastRoomState only reaches occupants; non-occupant rails need a
    // /rooms refetch to repaint the megaphone glyph + postLocked rows.
    emitTreeChanged(ctx.io, room.serverId ?? null);
  },
};

/**
 * /public
 *
 * Convert this room from PRIVATE to PUBLIC in place. A room's visibility
 * (rooms.type) is otherwise only ever set at creation (/private <name> <pw>
 * vs /go), and there was no way to open a private room up afterward — the
 * "can't change private → public once you're done setting up a room" report.
 * Clears the room password (a public room needs none) and re-lists the room
 * in the public rail. Boards (forumId) carry their own visibility model and
 * are refused. Same gate as the other room-mode commands (callerCanEditRoom:
 * owner / room mod / edit_any_room_metadata). Distinct verb from the CREATING
 * /private command so it never shadows room creation.
 *
 * Note: visibility (type) is orthogonal to a room's access role-gate — a
 * public room that also has an access gate still stays hidden from members
 * who lack the gating role. This only flips the public/private axis.
 */
export const publicRoomCommand: CommandHandler = {
  name: "public",
  aliases: ["unlock"],
  usage: "/public",
  description: "Make this private room public so anyone can find and join it (owner/mod only).",
  subcommands: [
    { verb: "(no args)", usage: "/public", description: "Convert this private room to public and clear its password." },
  ],
  async run(ctx) {
    const room = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
    if (!room) return notice(ctx, "NO_ROOM", tFor(ctx.user.locale, "commands:shared.roomNotFound"));
    // Boards live in the Forums Catalog with their own visibility model.
    if (room.forumId) {
      return notice(ctx, "FORUM_BOARD", tFor(ctx.user.locale, "commands:public.forumBoard"));
    }
    if (!(await callerCanEditRoom(ctx.db, ctx.user, ctx.roomId))) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:public.permission"));
    }
    if (room.type === "public") {
      return notice(ctx, "PUBLIC", tFor(ctx.user.locale, "commands:public.already"));
    }
    // Clear the password: joinRoom gates the prompt on type==='private', so a
    // leftover hash is inert, but a public room should carry no secret.
    await ctx.db.update(rooms).set({ type: "public", passwordHash: null }).where(eq(rooms.id, ctx.roomId));

    const { addMessage, broadcastRoomState, emitTreeChanged } = await import("../../realtime/broadcast.js");
    await addMessage(ctx, { kind: "system", body: tFor(ctx.user.locale, "commands:public.systemLine") });
    await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
    // broadcastRoomState only reaches occupants; non-occupant rails need a
    // /rooms refetch to surface the now-public room in the listing.
    emitTreeChanged(ctx.io, room.serverId ?? null);
  },
};

/**
 * /staffroom [on|off]
 *
 * Show or set whether this room is STAFF-ONLY (migration 0363) — a NEW access
 * axis, orthogonal to /postmode (who can POST) and to visibility/role gates.
 * When on, the room is hidden from everyone outside the staff set (the room
 * owner, room mods, this server's staff, and site staff): it drops out of the
 * rail, its join refuses with the same "no such room" as a nonexistent room,
 * and its slug link 404s — so its existence never leaks. It KEEPS a normal
 * userlist and normal posting among the staff who can see it, which is what
 * separates it from an info room (/postmode staff, public-read). Boards
 * (forumId) carry their own model and are refused. Same gate as the other
 * room-mode commands (callerCanEditRoom: owner / room mod /
 * edit_any_room_metadata). Flipping it ON evicts current non-staff occupants
 * (the socket path has no per-message read check).
 */
export const staffRoomCommand: CommandHandler = {
  name: "staffroom",
  aliases: ["staffonly"],
  usage: "/staffroom [on|off]",
  description: "Show or set whether only staff can see this room (owner/mod only to set).",
  subcommands: [
    { verb: "(no args)", usage: "/staffroom", description: "Show whether this room is staff only." },
    { verb: "on", usage: "/staffroom on", description: "Hide this room from everyone but staff: the room owner, room mods, this server's staff, and site staff. It keeps a normal userlist and normal posting.", aliases: ["true", "1"] },
    { verb: "off", usage: "/staffroom off", description: "Make this room visible to everyone again.", aliases: ["false", "0"] },
  ],
  async run(ctx) {
    const arg = ctx.argsText.trim().toLowerCase();
    const room = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
    if (!room) return notice(ctx, "NO_ROOM", tFor(ctx.user.locale, "commands:shared.roomNotFound"));

    if (!arg) {
      return notice(ctx, "STAFFROOM", tFor(ctx.user.locale,
        room.staffOnly ? "commands:staffRoom.currentOn" : "commands:staffRoom.currentOff"));
    }
    let value: boolean;
    if (/^(on|true|1)$/.test(arg)) value = true;
    else if (/^(off|false|0)$/.test(arg)) value = false;
    else return notice(ctx, "BAD_STAFFROOM", tFor(ctx.user.locale, "commands:staffRoom.usage"));

    // Boards live in the Forums Catalog with their own access model.
    if (room.forumId) {
      return notice(ctx, "FORUM_BOARD", tFor(ctx.user.locale, "commands:staffRoom.forumBoard"));
    }
    if (!(await callerCanEditRoom(ctx.db, ctx.user, ctx.roomId))) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:staffRoom.permission"));
    }
    if (!!room.staffOnly === value) {
      return notice(ctx, "STAFFROOM", tFor(ctx.user.locale,
        value ? "commands:staffRoom.alreadyOn" : "commands:staffRoom.alreadyOff"));
    }
    await ctx.db.update(rooms).set({ staffOnly: value }).where(eq(rooms.id, ctx.roomId));

    const { addMessage, broadcastRoomState, emitTreeChanged } = await import("../../realtime/broadcast.js");
    await addMessage(ctx, {
      kind: "system",
      body: tFor(ctx.user.locale, value ? "commands:staffRoom.systemLineOn" : "commands:staffRoom.systemLineOff"),
    });
    // Flip ON: boot current non-staff occupants — the socket path has no
    // per-message read check, so a live flip must evict them the way an
    // access-gate PATCH does. Room mods pass (folded into the eviction gate).
    if (value) {
      const { evictRoleDeniedFromRoom } = await import("../../lib/roleGates.js");
      await evictRoleDeniedFromRoom(ctx.io, ctx.db, { ...room, staffOnly: true });
    }
    await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
    // broadcastRoomState only reaches occupants; non-occupant rails need a
    // /rooms refetch to drop (or restore) the now-hidden room + shield glyph.
    emitTreeChanged(ctx.io, room.serverId ?? null);
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
  usage: "/nsfw [on|off] | /nsfw channel [on|off]",
  description: "Show or set this room's 18+ setting, or manage its 18+ channel (owner/mod only to set; adults only).",
  subcommands: [
    { verb: "(no args)", usage: "/nsfw", description: "Show whether this room is 18+." },
    { verb: "on", usage: "/nsfw on", description: "Mark the room 18+. Members under 18 can no longer see or join it.", aliases: ["true", "1"] },
    { verb: "off", usage: "/nsfw off", description: "Clear the 18+ setting. Messages written while it was 18+ stay hidden from members under 18.", aliases: ["false", "0"] },
    { verb: "channel on", usage: "/nsfw channel on", description: "Add an 18+ channel: an adults-only side of this room with its own chat feed, behind a SFW/18+ toggle on the room's row." },
    { verb: "channel off", usage: "/nsfw channel off", description: "Turn the 18+ channel off. Its history is kept and comes back if you turn it on again." },
  ],
  async run(ctx) {
    const arg = ctx.argsText.trim().toLowerCase();
    const room = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
    if (!room) return notice(ctx, "NO_ROOM", tFor(ctx.user.locale, "commands:shared.roomNotFound"));

    // /nsfw channel [on|off] — the per-room 18+ CHANNEL (lib/adultChannel):
    // an adults-only side feed behind the rail row's SFW/18+ toggle,
    // orthogonal to the whole-room flag below.
    if (/^channel\b/.test(arg)) {
      const sub = arg.replace(/^channel\s*/, "");
      if (!(await callerCanEditRoom(ctx.db, ctx.user, ctx.roomId))) {
        return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:nsfw.permission"));
      }
      if (!ctx.user.isAdult) {
        return notice(ctx, "AGE_RESTRICTED", tFor(ctx.user.locale, "errors:server.common.nsfwSettingAdultsOnly"));
      }
      let value: boolean;
      if (/^(on|true|1)$/.test(sub)) value = true;
      else if (/^(off|false|0)$/.test(sub)) value = false;
      else return notice(ctx, "BAD_NSFW", tFor(ctx.user.locale, "commands:nsfw.channelUsage"));

      const { enableAdultChannel, disableAdultChannel } = await import("../../lib/adultChannel.js");
      const res = value
        ? await enableAdultChannel(ctx.db, room)
        : await disableAdultChannel(ctx.db, ctx.io, room);
      if (!res.ok) {
        return notice(ctx, `CHANNEL_${res.error}`, tFor(ctx.user.locale, `errors:server.rooms.adultChannel.${res.error}`));
      }
      if (!res.changed) {
        return notice(ctx, "NSFW", tFor(ctx.user.locale, value ? "commands:nsfw.channelAlreadyOn" : "commands:nsfw.channelAlreadyOff"));
      }
      const { recordAudit } = await import("../../audit.js");
      await recordAudit(ctx.db, {
        actorUserId: ctx.user.id,
        action: value ? "room_link" : "room_unlink",
        targetRoomId: room.id,
        metadata: { adultChannel: true, channelRoomId: res.channelRoomId },
      });
      const { addMessage, broadcastRoomState, emitTreeChanged } = await import("../../realtime/broadcast.js");
      await addMessage(ctx, {
        kind: "system",
        body: tFor(ctx.user.locale, value ? "commands:nsfw.channelOn" : "commands:nsfw.channelOff"),
      });
      await broadcastRoomState(ctx.io, ctx.db, room.id).catch(() => {});
      if (res.channelRoomId) await broadcastRoomState(ctx.io, ctx.db, res.channelRoomId).catch(() => {});
      emitTreeChanged(ctx.io, room.serverId ?? null);
      return;
    }

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
