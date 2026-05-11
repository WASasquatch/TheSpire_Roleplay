import { and, asc, eq, sql } from "drizzle-orm";
import { bans, mutes, roomMembers, rooms, users } from "../../db/schema.js";
import {
  addMessage,
  broadcastPresence,
  broadcastRoomState,
  findCanonicalLanding,
  sendRoomBacklogTo,
} from "../../realtime/broadcast.js";
import { formatDuration, parseDuration } from "../duration.js";
import { recordAudit } from "../../audit.js";
import type { CommandContext, CommandHandler } from "../types.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/** Look up a user by master username (the canonical mod-target identifier). */
async function findUserByName(ctx: CommandContext, name: string) {
  const lower = name.toLowerCase();
  return (await ctx.db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = ${lower}`)
    .limit(1))[0];
}

async function getRoomMember(ctx: CommandContext, roomId: string, userId: string) {
  return (await ctx.db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    .limit(1))[0];
}

/**
 * The keymaster - the longest-tenured admin. Untouchable: cannot be demoted,
 * cannot be kicked or muted by other admins. They're the keys to the keep.
 */
async function isKeymaster(ctx: CommandContext, userId: string): Promise<boolean> {
  const earliestAdmin = (await ctx.db
    .select()
    .from(users)
    .where(eq(users.role, "admin"))
    .orderBy(asc(users.createdAt))
    .limit(1))[0];
  return earliestAdmin?.id === userId;
}

/**
 * Caller has *some* moderation authority over the current room: site admin,
 * room owner (by row OR by membership row), or room mod.
 */
async function callerCanModerateRoom(ctx: CommandContext): Promise<boolean> {
  if (ctx.user.role === "admin") return true;
  const room = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
  if (!room) return false;
  if (room.ownerId === ctx.user.id) return true;
  const m = await getRoomMember(ctx, ctx.roomId, ctx.user.id);
  return m?.role === "owner" || m?.role === "mod";
}

/**
 * Stricter - only the room owner (or a site admin) can manage room roles.
 * A room mod can /kick or /mute but can't promote others to mod.
 */
async function callerOwnsRoom(ctx: CommandContext): Promise<boolean> {
  if (ctx.user.role === "admin") return true;
  const room = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
  if (!room) return false;
  if (room.ownerId === ctx.user.id) return true;
  const m = await getRoomMember(ctx, ctx.roomId, ctx.user.id);
  return m?.role === "owner";
}

/* ---------------------- /kick ---------------------- */

export const kickCommand: CommandHandler = {
  name: "kick",
  aliases: ["boot"],
  usage: "/kick <username> [reason]",
  description: "Boot a user from the current room (back to the landing room). Mod/owner/admin only.",
  subcommands: [
    {
      verb: "<username>",
      usage: "/kick Bob",
      description: "Kick with no reason. The kicked user can rejoin immediately - use /ban to keep them out.",
    },
    {
      verb: "[reason]",
      usage: "/kick Bob being rude",
      description: "Optional reason shown to the kicked user and posted as a system notice.",
    },
  ],
  async run(ctx) {
    if (!(await callerCanModerateRoom(ctx))) {
      return notice(ctx, "PERM", "Only room owner/mod or a site admin can /kick.");
    }
    const [name, ...reasonParts] = ctx.args;
    const reason = reasonParts.join(" ").trim();
    if (!name) return notice(ctx, "EMPTY", "Usage: /kick <username> [reason]");

    const target = await findUserByName(ctx, name);
    if (!target) return notice(ctx, "NO_USER", `No user named "${name}".`);
    if (target.id === ctx.user.id) return notice(ctx, "SELF", "Kicking yourself isn't useful.");
    if (target.role === "admin" && ctx.user.role !== "admin") {
      return notice(ctx, "PERM", "Site admins can't be kicked by non-admins.");
    }
    if (await isKeymaster(ctx, target.id)) {
      return notice(ctx, "PERM", "The keymaster can't be kicked.");
    }

    // Boot every socket of the target out of this room and into the
    // canonical landing. After s.join we also push a fresh room:state and
    // backlog to the booted socket — without those it's stuck on the old
    // room's UI even though it's now joined the landing channel.
    const landing = await findCanonicalLanding(ctx.db);
    const socks = await ctx.io.fetchSockets();
    let booted = 0;
    for (const s of socks) {
      const data = s.data as { userId?: string };
      if (data.userId !== target.id) continue;
      if (!s.rooms.has(`room:${ctx.roomId}`)) continue;
      s.leave(`room:${ctx.roomId}`);
      s.emit("error:notice", {
        code: "KICKED",
        message: reason
          ? `You were kicked from this room by ${ctx.user.displayName}: ${reason}`
          : `You were kicked from this room by ${ctx.user.displayName}.`,
      });
      if (landing) {
        s.join(`room:${landing.id}`);
        (s.data as { roomId?: string }).roomId = landing.id;
        await sendRoomBacklogTo(s, ctx.db, landing.id, target.id);
      }
      booted++;
    }

    await addMessage(ctx, {
      kind: "system",
      body: reason
        ? `${ctx.user.displayName} kicked ${target.username}: ${reason}`
        : `${ctx.user.displayName} kicked ${target.username}.`,
    });
    await recordAudit(ctx.db, {
      actorUserId: ctx.user.id,
      action: "kick",
      targetUserId: target.id,
      targetRoomId: ctx.roomId,
      reason: reason || null,
    });
    await broadcastPresence(ctx.io, ctx.db, ctx.roomId);
    // Landing destination needs full room state (membership + occupants),
    // not just presence, so the booted socket's UI shows the right room
    // metadata. broadcastRoomState fans out room:state to all in the
    // channel — the booted socket included.
    if (landing && booted > 0) await broadcastRoomState(ctx.io, ctx.db, landing.id);
  },
};

/* ---------------------- /mute /unmute ---------------------- */

export const muteCommand: CommandHandler = {
  name: "mute",
  aliases: ["silence"],
  usage: "/mute <username> <duration> [reason]   (e.g. /mute Alice 5m spam)",
  description: "Silence a user in the current room for a duration. Mod/owner/admin only.",
  subcommands: [
    {
      verb: "<duration>",
      usage: "/mute Alice 10m",
      description: "Duration formats: s/m/h/d. Combine for compound (e.g. 1h20m). Examples: 30s, 5m, 2h, 1h20m, 7d.",
    },
    {
      verb: "[reason]",
      usage: "/mute Bob 1h spamming",
      description: "Optional reason - shown in the system notice posted when the mute is issued.",
    },
  ],
  async run(ctx) {
    if (!(await callerCanModerateRoom(ctx))) {
      return notice(ctx, "PERM", "Only room owner/mod or a site admin can /mute.");
    }
    const [name, durationStr, ...reasonParts] = ctx.args;
    const reason = reasonParts.join(" ").trim();
    if (!name || !durationStr) {
      return notice(ctx, "EMPTY", "Usage: /mute <username> <duration> [reason]. Examples: /mute Alice 10m, /mute Bob 1h20m spam");
    }
    const ms = parseDuration(durationStr);
    if (ms == null) {
      return notice(ctx, "BAD_DURATION", "Bad duration. Use forms like 5m, 30m, 1h, 1h20m, 7d.");
    }
    const target = await findUserByName(ctx, name);
    if (!target) return notice(ctx, "NO_USER", `No user named "${name}".`);
    if (target.id === ctx.user.id) return notice(ctx, "SELF", "Muting yourself isn't useful.");
    if (target.role === "admin" && ctx.user.role !== "admin") {
      return notice(ctx, "PERM", "Site admins can't be muted by non-admins.");
    }
    if (await isKeymaster(ctx, target.id)) {
      return notice(ctx, "PERM", "The keymaster can't be muted.");
    }

    const until = new Date(Date.now() + ms);
    await ctx.db
      .insert(mutes)
      .values({
        roomId: ctx.roomId,
        userId: target.id,
        until,
        reason: reason || null,
        issuedById: ctx.user.id,
      })
      .onConflictDoUpdate({
        target: [mutes.roomId, mutes.userId],
        set: { until, reason: reason || null, issuedById: ctx.user.id },
      });

    await addMessage(ctx, {
      kind: "system",
      body: reason
        ? `${ctx.user.displayName} muted ${target.username} for ${formatDuration(ms)}: ${reason}`
        : `${ctx.user.displayName} muted ${target.username} for ${formatDuration(ms)}.`,
    });
    await recordAudit(ctx.db, {
      actorUserId: ctx.user.id,
      action: "mute",
      targetUserId: target.id,
      targetRoomId: ctx.roomId,
      reason: reason || null,
      metadata: { durationMs: ms },
    });
  },
};

export const unmuteCommand: CommandHandler = {
  name: "unmute",
  usage: "/unmute <username>",
  description: "Lift a /mute on a user in the current room.",
  async run(ctx) {
    if (!(await callerCanModerateRoom(ctx))) {
      return notice(ctx, "PERM", "Only room owner/mod or a site admin can /unmute.");
    }
    const name = ctx.argsText.trim();
    if (!name) return notice(ctx, "EMPTY", "Usage: /unmute <username>");
    const target = await findUserByName(ctx, name);
    if (!target) return notice(ctx, "NO_USER", `No user named "${name}".`);
    const r = await ctx.db
      .delete(mutes)
      .where(and(eq(mutes.roomId, ctx.roomId), eq(mutes.userId, target.id)));
    if (r.changes === 0) {
      return notice(ctx, "NOT_MUTED", `${target.username} isn't muted in this room.`);
    }
    await addMessage(ctx, {
      kind: "system",
      body: `${ctx.user.displayName} lifted the mute on ${target.username}.`,
    });
    await recordAudit(ctx.db, {
      actorUserId: ctx.user.id,
      action: "unmute",
      targetUserId: target.id,
      targetRoomId: ctx.roomId,
    });
  },
};

/* ---------------------- /promote /demote (room) ---------------------- */

export const promoteCommand: CommandHandler = {
  name: "promote",
  usage: "/promote <username>",
  description: "Promote a user to room mod (room owner only).",
  async run(ctx) {
    if (!(await callerOwnsRoom(ctx))) {
      return notice(ctx, "PERM", "Only the room owner (or a site admin) can promote room mods.");
    }
    const name = ctx.argsText.trim();
    if (!name) return notice(ctx, "EMPTY", "Usage: /promote <username>");
    const target = await findUserByName(ctx, name);
    if (!target) return notice(ctx, "NO_USER", `No user named "${name}".`);
    if (target.id === ctx.user.id) return notice(ctx, "SELF", "You're already at the top of this room.");

    // Ensure they have a row, then upgrade to mod.
    await ctx.db
      .insert(roomMembers)
      .values({ roomId: ctx.roomId, userId: target.id, role: "mod" })
      .onConflictDoUpdate({
        target: [roomMembers.roomId, roomMembers.userId],
        set: { role: "mod" },
      });
    await addMessage(ctx, {
      kind: "system",
      body: `${ctx.user.displayName} promoted ${target.username} to room mod.`,
    });
    await recordAudit(ctx.db, {
      actorUserId: ctx.user.id,
      action: "promote_mod",
      targetUserId: target.id,
      targetRoomId: ctx.roomId,
    });
    await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
  },
};

export const demoteCommand: CommandHandler = {
  name: "demote",
  usage: "/demote <username>",
  description: "Demote a room mod back to member (room owner only).",
  async run(ctx) {
    if (!(await callerOwnsRoom(ctx))) {
      return notice(ctx, "PERM", "Only the room owner (or a site admin) can demote room mods.");
    }
    const name = ctx.argsText.trim();
    if (!name) return notice(ctx, "EMPTY", "Usage: /demote <username>");
    const target = await findUserByName(ctx, name);
    if (!target) return notice(ctx, "NO_USER", `No user named "${name}".`);
    const m = await getRoomMember(ctx, ctx.roomId, target.id);
    if (!m) return notice(ctx, "NO_MEMBER", `${target.username} isn't in this room's member list.`);
    if (m.role === "owner") return notice(ctx, "PERM", "Use /demote on mods only - owners can't be demoted from their own room.");
    if (m.role === "member") return notice(ctx, "NO_MOD", `${target.username} isn't a mod.`);

    await ctx.db
      .update(roomMembers)
      .set({ role: "member" })
      .where(and(eq(roomMembers.roomId, ctx.roomId), eq(roomMembers.userId, target.id)));
    await addMessage(ctx, {
      kind: "system",
      body: `${ctx.user.displayName} demoted ${target.username} to member.`,
    });
    await recordAudit(ctx.db, {
      actorUserId: ctx.user.id,
      action: "demote_mod",
      targetUserId: target.id,
      targetRoomId: ctx.roomId,
    });
    await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
  },
};

/* ---------------------- /promoteadmin /demoteadmin (site) ---------------------- */

export const promoteAdminCommand: CommandHandler = {
  name: "promoteadmin",
  aliases: ["sysop"],
  usage: "/promoteadmin <username>",
  description: "Promote a user to site admin (admin only).",
  permission: "admin",
  async run(ctx) {
    const name = ctx.argsText.trim();
    if (!name) return notice(ctx, "EMPTY", "Usage: /promoteadmin <username>");
    const target = await findUserByName(ctx, name);
    if (!target) return notice(ctx, "NO_USER", `No user named "${name}".`);
    if (target.role === "admin") return notice(ctx, "ALREADY", `${target.username} is already a site admin.`);

    const priorRole = target.role;
    await ctx.db.update(users).set({ role: "admin" }).where(eq(users.id, target.id));
    await addMessage(ctx, {
      kind: "system",
      body: `${ctx.user.displayName} promoted ${target.username} to site admin.`,
    });
    await recordAudit(ctx.db, {
      actorUserId: ctx.user.id,
      action: "promote_admin",
      targetUserId: target.id,
      metadata: { priorRole, nextRole: "admin" },
    });
  },
};

export const demoteAdminCommand: CommandHandler = {
  name: "demoteadmin",
  aliases: ["unsysop"],
  usage: "/demoteadmin <username>",
  description: "Demote a site admin to user (admin only). The keymaster cannot be demoted.",
  permission: "admin",
  async run(ctx) {
    const name = ctx.argsText.trim();
    if (!name) return notice(ctx, "EMPTY", "Usage: /demoteadmin <username>");
    const target = await findUserByName(ctx, name);
    if (!target) return notice(ctx, "NO_USER", `No user named "${name}".`);
    if (target.role !== "admin") return notice(ctx, "NOT_ADMIN", `${target.username} isn't a site admin.`);
    if (await isKeymaster(ctx, target.id)) {
      return notice(ctx, "KEYMASTER", "The keymaster (first admin) cannot be demoted.");
    }
    if (target.id === ctx.user.id) {
      return notice(ctx, "SELF", "Demote yourself by asking another admin - keeps the chain of custody honest.");
    }

    await ctx.db.update(users).set({ role: "user" }).where(eq(users.id, target.id));
    await addMessage(ctx, {
      kind: "system",
      body: `${ctx.user.displayName} demoted ${target.username} from site admin.`,
    });
    await recordAudit(ctx.db, {
      actorUserId: ctx.user.id,
      action: "demote_admin",
      targetUserId: target.id,
      metadata: { priorRole: "admin", nextRole: "user" },
    });
  },
};

/* ---------------------- /ban /unban (room) ----------------------
 *
 * Bans persist in the `bans` table, which `joinRoom` already consults
 * (broadcast.ts) - so a banned user can't re-enter even if they reconnect.
 * The ban also boots them on issue. Optional duration (e.g. /ban Bob 1d
 * spam) is stored on `bans.until`; permanent if omitted.
 */

export const banCommand: CommandHandler = {
  name: "ban",
  aliases: ["banish"],
  usage: "/ban <username> [duration] [reason]",
  description: "Ban a user from the current room. Mod/owner/admin only.",
  subcommands: [
    {
      verb: "<username>",
      usage: "/ban Bob",
      description: "Permanent ban with no reason note. Boots their sockets to the landing room and refuses re-entry.",
    },
    {
      verb: "<duration>",
      usage: "/ban Bob 1h",
      description: "Time-limited ban. Duration formats: s/m/h/d, combinable (e.g. 30m, 1h20m, 7d). Omit for permanent.",
    },
    {
      verb: "[reason]",
      usage: "/ban Bob 1d spam",
      description: "Optional reason. The booted user sees it; everyone else sees a system notice.",
    },
  ],
  async run(ctx) {
    if (!(await callerCanModerateRoom(ctx))) {
      return notice(ctx, "PERM", "Only room owner/mod or a site admin can /ban.");
    }
    const [name, maybeDur, ...rest] = ctx.args;
    if (!name) return notice(ctx, "EMPTY", "Usage: /ban <username> [duration] [reason]");

    // Second token is a duration ONLY if it parses cleanly; otherwise it's
    // part of the reason. This keeps `/ban Bob spam` working without a
    // user-specified duration.
    let durationMs: number | null = null;
    let reasonStart = 1;
    if (maybeDur) {
      const parsed = parseDuration(maybeDur);
      if (parsed != null) {
        durationMs = parsed;
        reasonStart = 2;
      }
    }
    const reason = [maybeDur, ...rest].slice(reasonStart - 1).filter(Boolean).join(" ").trim();

    const target = await findUserByName(ctx, name);
    if (!target) return notice(ctx, "NO_USER", `No user named "${name}".`);
    if (target.id === ctx.user.id) return notice(ctx, "SELF", "Banning yourself isn't useful.");
    if (target.role === "admin" && ctx.user.role !== "admin") {
      return notice(ctx, "PERM", "Site admins can't be banned by non-admins.");
    }
    if (await isKeymaster(ctx, target.id)) {
      return notice(ctx, "PERM", "The keymaster can't be banned.");
    }

    const until = durationMs ? new Date(Date.now() + durationMs) : null;
    await ctx.db
      .insert(bans)
      .values({
        roomId: ctx.roomId,
        userId: target.id,
        until,
        reason: reason || null,
        issuedById: ctx.user.id,
      })
      .onConflictDoUpdate({
        target: [bans.roomId, bans.userId],
        set: { until, reason: reason || null, issuedById: ctx.user.id },
      });

    // Boot every live socket of the target out of this room. They go to
    // the canonical landing — same flow as /kick but without the auto-
    // rejoin loop, since the ban row refuses the next /go back. Each
    // booted socket also gets a fresh backlog so its message list
    // matches the new room.
    const landing = await findCanonicalLanding(ctx.db);
    const socks = await ctx.io.fetchSockets();
    let booted = 0;
    for (const s of socks) {
      const data = s.data as { userId?: string };
      if (data.userId !== target.id) continue;
      if (!s.rooms.has(`room:${ctx.roomId}`)) continue;
      s.leave(`room:${ctx.roomId}`);
      s.emit("error:notice", {
        code: "BANNED",
        message: until
          ? `You were banned from this room for ${formatDuration(until.getTime() - Date.now())} by ${ctx.user.displayName}${reason ? `: ${reason}` : "."}`
          : `You were banned from this room by ${ctx.user.displayName}${reason ? `: ${reason}` : "."}`,
      });
      if (landing) {
        s.join(`room:${landing.id}`);
        (s.data as { roomId?: string }).roomId = landing.id;
        await sendRoomBacklogTo(s, ctx.db, landing.id, target.id);
      }
      booted++;
    }

    const durStr = until ? ` for ${formatDuration(until.getTime() - Date.now())}` : " (permanent)";
    await addMessage(ctx, {
      kind: "system",
      body: reason
        ? `${ctx.user.displayName} banned ${target.username}${durStr}: ${reason}`
        : `${ctx.user.displayName} banned ${target.username}${durStr}.`,
    });
    await recordAudit(ctx.db, {
      actorUserId: ctx.user.id,
      action: "ban",
      targetUserId: target.id,
      targetRoomId: ctx.roomId,
      reason: reason || null,
      metadata: durationMs ? { durationMs } : { permanent: true },
    });
    await broadcastPresence(ctx.io, ctx.db, ctx.roomId);
    if (landing && booted > 0) await broadcastRoomState(ctx.io, ctx.db, landing.id);
  },
};

export const unbanCommand: CommandHandler = {
  name: "unban",
  aliases: ["pardon"],
  usage: "/unban <username>",
  description: "Lift a /ban from the current room.",
  async run(ctx) {
    if (!(await callerCanModerateRoom(ctx))) {
      return notice(ctx, "PERM", "Only room owner/mod or a site admin can /unban.");
    }
    const name = ctx.argsText.trim();
    if (!name) return notice(ctx, "EMPTY", "Usage: /unban <username>");
    const target = await findUserByName(ctx, name);
    if (!target) return notice(ctx, "NO_USER", `No user named "${name}".`);

    const r = await ctx.db
      .delete(bans)
      .where(and(eq(bans.roomId, ctx.roomId), eq(bans.userId, target.id)));
    if (r.changes === 0) {
      return notice(ctx, "NOT_BANNED", `${target.username} isn't banned from this room.`);
    }
    await addMessage(ctx, {
      kind: "system",
      body: `${ctx.user.displayName} lifted the ban on ${target.username}.`,
    });
    await recordAudit(ctx.db, {
      actorUserId: ctx.user.id,
      action: "unban",
      targetUserId: target.id,
      targetRoomId: ctx.roomId,
    });
  },
};

/* ---------------------- /announce ----------------------
 *
 * Admin-authored "megaphone" message - renders distinctly in MessageList
 * (the kind="announce" branch) and triggers desktop notifications even
 * for users on `notifyPref="mentions"`.
 *
 * Two scopes:
 *   /announce <text>      - current room only (room owners/mods + admins)
 *   /announce all <text>  - every room sitewide (site admins only)
 */
export const announceCommand: CommandHandler = {
  name: "announce",
  aliases: ["broadcast", "shout"],
  usage: "/announce [all] <text>",
  description: "Send a high-visibility announcement. 'all' = every room (admin only); otherwise current room (owner/mod/admin).",
  subcommands: [
    { verb: "<text>", usage: "/announce <text>", description: "Announce in the current room (owner/mod/admin)." },
    { verb: "all", usage: "/announce all <text>", description: "Announce sitewide to every room (site admin only)." },
  ],
  async run(ctx) {
    const argsText = ctx.argsText.trim();
    if (!argsText) return notice(ctx, "EMPTY", "Usage: /announce [all] <text>");

    // Sitewide variant - recognised by leading "all " (case-insensitive).
    const allMatch = /^all\s+(.+)/i.exec(argsText);
    if (allMatch) {
      if (ctx.user.role !== "admin") {
        return notice(ctx, "PERM", "/announce all is admin-only. Drop 'all' to announce in the current room.");
      }
      const body = allMatch[1]!.trim();
      if (!body) return notice(ctx, "EMPTY", "Usage: /announce all <text>");

      const allRooms = await ctx.db.select({ id: rooms.id }).from(rooms);
      // Re-use addMessage per room so each room gets its own persisted row,
      // its own ignore-filtered fan-out, and its own /history visible later.
      for (const r of allRooms) {
        const roomCtx = { ...ctx, roomId: r.id };
        await addMessage(roomCtx, { kind: "announce", body });
      }
      await recordAudit(ctx.db, {
        actorUserId: ctx.user.id,
        action: "announce",
        metadata: { scope: "all", body },
      });
      return;
    }

    // Current-room variant - owner/mod/admin only.
    if (!(await callerCanModerateRoom(ctx))) {
      return notice(ctx, "PERM", "Only room owner/mod or a site admin can /announce.");
    }
    await addMessage(ctx, { kind: "announce", body: argsText });
    await recordAudit(ctx.db, {
      actorUserId: ctx.user.id,
      action: "announce",
      targetRoomId: ctx.roomId,
      metadata: { scope: "room", body: argsText },
    });
  },
};
