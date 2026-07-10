import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { isAdminRole, roleRank, type PermissionKey, type ServerModPermission, type ServerPermission } from "@thekeep/shared";
import { accountMutes, bans, mutes, roomMembers, roomMods, rooms, users } from "../../db/schema.js";
import { hasPermission } from "../../auth/permissions.js";
import { areServersEnabled, getSettings } from "../../settings.js";
import {
  addMessage,
  broadcastPresence,
  broadcastRoomState,
  findCanonicalLanding,
  sendRoomBacklogTo,
} from "../../realtime/broadcast.js";
import { formatDuration, parseDuration } from "../duration.js";
import { auditServerAction, recordAudit } from "../../audit.js";
import { emitAmbiguousIdentityModal, resolveIdentityArg } from "../identityArg.js";
import { tFor } from "../../i18n.js";
import type { CommandContext, CommandHandler } from "../types.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/**
 * Look up a moderation target through the shared resolver. Accepts
 * `@id:` / `@cid:` tokens AND bare names, and emits the appropriate
 * notice on miss / ambiguous before returning null. Callers just
 * check `if (!target) return;`.
 *
 * Mod commands operate on the USER account (kick/ban/mute kick the
 * whole session, not a single character), so we follow the resolved
 * target's `userId` back to the full users row, that's the shape
 * the existing call sites consume for permissions + display.
 *
 * Stashes the RESOLVED display name on the returned row's
 * `__resolvedDisplayName` so the caller can broadcast `${target.name}
 * promoted to room mod` using the IDENTITY the caller typed (the
 * character name when they targeted a character, the master username
 * otherwise) instead of always leaking the master username.
 */
async function findUserByName(ctx: CommandContext, name: string) {
  const resolution = await resolveIdentityArg(ctx.db, name);
  if (resolution.kind === "none") {
    notice(ctx, "NO_USER", tFor(ctx.user.locale, "commands:shared.noUserNamed", { name }));
    return undefined;
  }
  if (resolution.kind === "ambiguous") {
    emitAmbiguousIdentityModal(ctx, name, resolution.matches);
    return undefined;
  }
  const row = (await ctx.db
    .select()
    .from(users)
    .where(eq(users.id, resolution.target.userId))
    .limit(1))[0];
  if (!row) return undefined;
  return Object.assign(row, {
    __resolvedDisplayName: resolution.target.displayName,
    // The IDENTITY the caller targeted: a character id when they typed
    // `@cid:` / a character name, or null for the master/OOC handle.
    // /promote uses this to attribute the room-mod crown to that exact
    // identity (room_mods); the underlying authority stays per-account.
    __resolvedCharacterId: resolution.target.characterId,
  });
}

async function getRoomMember(ctx: CommandContext, roomId: string, userId: string) {
  return (await ctx.db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    .limit(1))[0];
}

/**
 * The keymaster - the longest-tenured admin-tier account (admin or
 * masteradmin). Untouchable: cannot be demoted, cannot be kicked or muted
 * by other admins. They're the keys to the keep.
 *
 * Why include both tiers: the original bootstrap admin became `masteradmin`
 * in migration 0058. Filtering only on `"admin"` would silently strip the
 * keymaster protection from them. Keymaster status is about tenure across
 * the admin-tier as a whole, not about which tier a person currently sits in.
 */
async function isKeymaster(ctx: CommandContext, userId: string): Promise<boolean> {
  const earliestAdmin = (await ctx.db
    .select()
    .from(users)
    .where(inArray(users.role, ["admin", "masteradmin"]))
    .orderBy(asc(users.createdAt))
    .limit(1))[0];
  return earliestAdmin?.id === userId;
}

/**
 * Caller has moderation authority for the current room.
 *
 * Three paths grant authority (any one suffices):
 *   1. Site-level permission `siteKey`, admin tier (and anyone the
 *      matrix has granted that specific moderation permission) skips
 *      the per-room ownership check.
 *   2. Room owner, `rooms.ownerId = caller` OR `room_members.role =
 *      "owner"`. Local privilege; not site-wide.
 *   3. Room mod, `room_members.role = "mod"`. Local privilege; the
 *      room owner promoted them via /promote.
 *
 * `siteKey` is the specific permission the command needs (e.g.
 * `kick_user`, `ban_user`). Threading it through means a user with
 * just `kick_user` can boot people but not ban them, granular
 * matrix grants pass straight through.
 */
/**
 * The caller's per-server moderation tier for THIS room's server, or null when
 * servers are off or this isn't a real sub-server (the default/system server
 * keeps the GLOBAL moderation gates, plan §9.8). Mirrors routes/messages.ts
 * `serverModTier` so chat commands honor server roles exactly like the HTTP
 * path does. serverAuthority is imported dynamically to keep mod.ts off the
 * servers module's static graph.
 */
async function serverModTier(
  ctx: CommandContext,
): Promise<{ isOwner: boolean; permissions: ServerPermission[]; serverOwnerUserId: string; serverId: string } | null> {
  if (!areServersEnabled(await getSettings(ctx.db))) return null;
  const room = (await ctx.db.select({ serverId: rooms.serverId }).from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
  if (!room?.serverId) return null;
  const { serverAuthority } = await import("../../servers/authority.js");
  const a = await serverAuthority(ctx.db, ctx.user, room.serverId);
  if (!a.server || a.server.isSystem) return null;
  return { isOwner: a.isOwner, permissions: a.permissions, serverOwnerUserId: a.server.ownerUserId, serverId: room.serverId };
}

/** Owner-implies-all check for a server moderation tier (mirrors serverCan). */
function serverTierCan(
  tier: { isOwner: boolean; permissions: ServerPermission[] } | null,
  key: ServerModPermission,
): boolean {
  return !!tier && (tier.isOwner || tier.permissions.includes(key));
}

async function callerCanModerateRoom(
  ctx: CommandContext,
  siteKey: PermissionKey,
  serverKey?: ServerModPermission,
): Promise<boolean> {
  if (await hasPermission(ctx.user, siteKey, ctx.db)) return true;
  // Per-server staff: a sub-server's owner/admin/mod holding the matching
  // server grant can moderate that server's rooms via chat (default server
  // stays on the global gates above).
  if (serverKey && serverTierCan(await serverModTier(ctx), serverKey)) return true;
  const room = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
  if (!room) return false;
  if (room.ownerId === ctx.user.id) return true;
  const m = await getRoomMember(ctx, ctx.roomId, ctx.user.id);
  return m?.role === "owner" || m?.role === "mod";
}

/**
 * Stricter - only the room owner (or someone with the site-level
 * permission) can manage room roles. A room mod can /kick or /mute
 * but can't promote others to mod (that requires room ownership or
 * the matrix-granted equivalent).
 */
async function callerOwnsRoom(
  ctx: CommandContext,
  siteKey: PermissionKey,
  serverKey?: ServerModPermission,
): Promise<boolean> {
  if (await hasPermission(ctx.user, siteKey, ctx.db)) return true;
  // Per-server staff with the matching server grant (e.g. ban_member) count as
  // "owner-equivalent" for this gate in their own server's rooms.
  if (serverKey && serverTierCan(await serverModTier(ctx), serverKey)) return true;
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
  description: "Room owner/mod: boot a user from the current room (back to the landing room). Site admin: log the user out of the Spire entirely.",
  subcommands: [
    {
      verb: "<username>",
      usage: "/kick Bob",
      description: "Kick with no reason. Owners/mods boot from the room (they can rejoin - use /ban to keep them out); admins log them out of the site.",
    },
    {
      verb: "[reason]",
      usage: "/kick Bob being rude",
      description: "Optional reason shown to the kicked user (on the login screen for admin kicks) and posted as a system notice.",
    },
  ],
  async run(ctx) {
    if (!(await callerCanModerateRoom(ctx, "kick_user", "kick_member"))) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:kick.permission"));
    }
    const [name, ...reasonParts] = ctx.args;
    const reason = reasonParts.join(" ").trim();
    if (!name) return notice(ctx, "EMPTY", tFor(ctx.user.locale, "commands:kick.usage"));

    const target = await findUserByName(ctx, name);
    if (!target) return;  // findUserByName emitted the appropriate notice.
    if (target.id === ctx.user.id) return notice(ctx, "SELF", tFor(ctx.user.locale, "commands:kick.self"));
    if (roleRank(target.role) > roleRank(ctx.user.role)) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:kick.adminProtected"));
    }
    if (await isKeymaster(ctx, target.id)) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:kick.keymaster"));
    }

    // SITE kick (admin tier): /kick from an admin logs the target out of
    // the Spire entirely — sessions revoked, sockets dropped, the reason
    // shown on the login splash. Room owners and mods (site mods
    // included) keep the room-level boot below.
    if (isAdminRole(ctx.user.role)) {
      const { forceLogoutUser } = await import("../../auth/session.js");
      // Recipient-locale message: this line lands on the TARGET's login
      // splash, so it resolves through their users.locale, not the issuer's.
      await forceLogoutUser(ctx.io, ctx.db, target.id, reason
        ? tFor(target.locale, "commands:kick.loggedOutReason", { name: ctx.user.displayName, reason })
        : tFor(target.locale, "commands:kick.loggedOut", { name: ctx.user.displayName }));
      await addMessage(ctx, {
        kind: "system",
        body: reason
          ? `${ctx.user.displayName} logged ${target.username} out: ${reason}`
          : `${ctx.user.displayName} logged ${target.username} out.`,
      });
      await recordAudit(ctx.db, {
        actorUserId: ctx.user.id,
        action: "kick",
        targetUserId: target.id,
        targetRoomId: ctx.roomId,
        reason: reason || null,
        metadata: { site: true },
      });
      // No manual presence work: each socket's disconnect handler runs
      // the full per-room cleanup (ghosting, presence, room expiry).
      return;
    }

    // Boot every socket of the target out of this room and into the
    // canonical landing. After s.join we also push a fresh room:state and
    // backlog to the booted socket, without those it's stuck on the old
    // room's UI even though it's now joined the landing channel.
    const landing = await findCanonicalLanding(ctx.db);
    const socks = await ctx.io.fetchSockets();
    let booted = 0;
    for (const s of socks) {
      const data = s.data as { userId?: string };
      if (data.userId !== target.id) continue;
      if (!s.rooms.has(`room:${ctx.roomId}`)) continue;
      s.leave(`room:${ctx.roomId}`);
      // Recipient-locale notice: goes to the KICKED user's sockets.
      s.emit("error:notice", {
        code: "KICKED",
        message: reason
          ? tFor(target.locale, "commands:kick.kickedReason", { name: ctx.user.displayName, reason })
          : tFor(target.locale, "commands:kick.kicked", { name: ctx.user.displayName }),
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
    // channel, the booted socket included.
    if (landing && booted > 0) await broadcastRoomState(ctx.io, ctx.db, landing.id);
  },
};

/* ---------------------- /mute /unmute ---------------------- */

/**
 * The REACH of a /mute or /unmute, following the ISSUER's authority — the
 * widest tier they hold wins. Site staff act site-wide, server staff act across
 * their whole server, everyone else (room owner/mod) acts on just this room.
 * `serverId` is set only for "server" reach. Precedence mirrors
 * callerCanModerateRoom; the caller passes the same site/server permission keys
 * that gated the command so mute and unmute resolve the tier identically.
 */
async function muteReach(
  ctx: CommandContext,
  siteKey: PermissionKey,
  serverKey: ServerModPermission,
): Promise<{ scope: "site" | "server" | "room"; serverId: string | null }> {
  if (await hasPermission(ctx.user, siteKey, ctx.db)) return { scope: "site", serverId: null };
  const tier = await serverModTier(ctx);
  if (tier && serverTierCan(tier, serverKey)) return { scope: "server", serverId: tier.serverId };
  return { scope: "room", serverId: null };
}

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
    if (!(await callerCanModerateRoom(ctx, "mute_user", "mute_member"))) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:mute.permission"));
    }
    const [name, durationStr, ...reasonParts] = ctx.args;
    const reason = reasonParts.join(" ").trim();
    if (!name || !durationStr) {
      return notice(ctx, "EMPTY", tFor(ctx.user.locale, "commands:mute.usage"));
    }
    const ms = parseDuration(durationStr);
    if (ms == null) {
      return notice(ctx, "BAD_DURATION", tFor(ctx.user.locale, "commands:mute.badDuration"));
    }
    const target = await findUserByName(ctx, name);
    if (!target) return;  // findUserByName emitted the appropriate notice.
    if (target.id === ctx.user.id) return notice(ctx, "SELF", tFor(ctx.user.locale, "commands:mute.self"));
    if (roleRank(target.role) > roleRank(ctx.user.role)) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:mute.adminProtected"));
    }
    if (await isKeymaster(ctx, target.id)) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:mute.keymaster"));
    }

    const until = new Date(Date.now() + ms);
    // Reach follows the issuer's authority (site > server > room). A site/server
    // admin muting silences the target account across that whole scope; a room
    // owner/mod's mute stays room-local. Every scope hits all the target's tabs.
    const reach = await muteReach(ctx, "mute_user", "mute_member");
    if (reach.scope === "room") {
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
    } else {
      // Wider mute. Replace any existing same-scope row for this target so a
      // re-mute just resets the timer (the partial UNIQUE indexes also allow
      // only one row per scope). Site scope keeps serverId NULL; server scope
      // pins it to this room's server.
      await ctx.db.delete(accountMutes).where(
        and(
          eq(accountMutes.userId, target.id),
          eq(accountMutes.scope, reach.scope),
          reach.scope === "server" && reach.serverId
            ? eq(accountMutes.serverId, reach.serverId)
            : isNull(accountMutes.serverId),
        ),
      );
      await ctx.db.insert(accountMutes).values({
        id: nanoid(),
        userId: target.id,
        scope: reach.scope,
        serverId: reach.scope === "server" ? reach.serverId : null,
        until,
        reason: reason || null,
        issuedById: ctx.user.id,
      });
    }

    const scopeLabel =
      reach.scope === "site" ? " across the site" : reach.scope === "server" ? " across this server" : "";
    await addMessage(ctx, {
      kind: "system",
      body: reason
        ? `${ctx.user.displayName} muted ${target.username} for ${formatDuration(ms)}${scopeLabel}: ${reason}`
        : `${ctx.user.displayName} muted ${target.username} for ${formatDuration(ms)}${scopeLabel}.`,
    });
    await recordAudit(ctx.db, {
      actorUserId: ctx.user.id,
      action: "mute",
      targetUserId: target.id,
      targetRoomId: ctx.roomId,
      reason: reason || null,
      metadata: { durationMs: ms, scope: reach.scope, ...(reach.serverId ? { serverId: reach.serverId } : {}) },
    });
  },
};

export const unmuteCommand: CommandHandler = {
  name: "unmute",
  usage: "/unmute <username>",
  description: "Lift a /mute on a user in the current room.",
  async run(ctx) {
    if (!(await callerCanModerateRoom(ctx, "unmute_user", "unmute_member"))) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:unmute.permission"));
    }
    const name = ctx.argsText.trim();
    if (!name) return notice(ctx, "EMPTY", tFor(ctx.user.locale, "commands:unmute.usage"));
    const target = await findUserByName(ctx, name);
    if (!target) return;  // findUserByName emitted the appropriate notice.
    // Lift every mute affecting this room that the issuer's authority permits:
    // the room mute always (they passed the room gate); the server-wide mute if
    // they're server/site staff; the site-wide mute if they're site staff. A
    // room mod can't clear a wider mute they lack the authority to have set.
    const reach = await muteReach(ctx, "unmute_user", "unmute_member");
    let lifted = 0;
    lifted += (await ctx.db
      .delete(mutes)
      .where(and(eq(mutes.roomId, ctx.roomId), eq(mutes.userId, target.id)))).changes;
    if (reach.scope === "server" || reach.scope === "site") {
      const serverId = reach.serverId ?? (await ctx.db
        .select({ serverId: rooms.serverId })
        .from(rooms)
        .where(eq(rooms.id, ctx.roomId))
        .limit(1))[0]?.serverId ?? null;
      if (serverId) {
        lifted += (await ctx.db.delete(accountMutes).where(
          and(
            eq(accountMutes.userId, target.id),
            eq(accountMutes.scope, "server"),
            eq(accountMutes.serverId, serverId),
          ),
        )).changes;
      }
    }
    if (reach.scope === "site") {
      lifted += (await ctx.db.delete(accountMutes).where(
        and(eq(accountMutes.userId, target.id), eq(accountMutes.scope, "site")),
      )).changes;
    }
    if (lifted === 0) {
      return notice(ctx, "NOT_MUTED", tFor(ctx.user.locale, "commands:unmute.notMuted", { name: target.username }));
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
    // Site-key `edit_any_room_metadata` covers admins managing any
    // room's roster, the legacy admin shortcut in `callerOwnsRoom`
    // routes through it. Room-owner check stays local (hardcoded).
    if (!(await callerOwnsRoom(ctx, "edit_any_room_metadata"))) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:promote.permission"));
    }
    const name = ctx.argsText.trim();
    if (!name) return notice(ctx, "EMPTY", tFor(ctx.user.locale, "commands:promote.usage"));
    const target = await findUserByName(ctx, name);
    if (!target) return;  // findUserByName emitted the appropriate notice.
    if (target.id === ctx.user.id) return notice(ctx, "SELF", tFor(ctx.user.locale, "commands:promote.self"));

    // Authority is per-ACCOUNT: set room_members.role so the caller keeps
    // moderation power in this room across every identity they voice (none
    // of the room-authority checks change, and switching characters never
    // drops their mod power).
    await ctx.db
      .insert(roomMembers)
      .values({ roomId: ctx.roomId, userId: target.id, role: "mod" })
      .onConflictDoUpdate({
        target: [roomMembers.roomId, roomMembers.userId],
        set: { role: "mod" },
      });
    // Crown display is per-IDENTITY: record WHICH identity this /promote
    // targeted so the mod crown shows on that identity alone, not on every
    // character the account voices. `''` = OOC/master. A second /promote
    // on another of the same user's identities just adds another row (the
    // "list of ID/CID"); /demote clears them all.
    await ctx.db
      .insert(roomMods)
      .values({
        roomId: ctx.roomId,
        userId: target.id,
        characterId: target.__resolvedCharacterId ?? "",
      })
      .onConflictDoNothing();
    const displayed = target.__resolvedDisplayName;
    await addMessage(ctx, {
      kind: "system",
      body: `${ctx.user.displayName} promoted ${displayed} to room mod.`,
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
    if (!(await callerOwnsRoom(ctx, "edit_any_room_metadata"))) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:demote.permission"));
    }
    const name = ctx.argsText.trim();
    if (!name) return notice(ctx, "EMPTY", tFor(ctx.user.locale, "commands:demote.usage"));
    const target = await findUserByName(ctx, name);
    if (!target) return;  // findUserByName emitted the appropriate notice.
    const displayed = target.__resolvedDisplayName;
    const m = await getRoomMember(ctx, ctx.roomId, target.id);
    if (!m) return notice(ctx, "NO_MEMBER", tFor(ctx.user.locale, "commands:demote.notMember", { name: displayed }));
    if (m.role === "owner") return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:demote.owner"));
    if (m.role === "member") return notice(ctx, "NO_MOD", tFor(ctx.user.locale, "commands:demote.notMod", { name: displayed }));

    await ctx.db
      .update(roomMembers)
      .set({ role: "member" })
      .where(and(eq(roomMembers.roomId, ctx.roomId), eq(roomMembers.userId, target.id)));
    // Clear every per-identity crown row for this user in this room (demote
    // is per-account, mirroring the authority above).
    await ctx.db
      .delete(roomMods)
      .where(and(eq(roomMods.roomId, ctx.roomId), eq(roomMods.userId, target.id)));
    await addMessage(ctx, {
      kind: "system",
      body: `${ctx.user.displayName} demoted ${displayed} to member.`,
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
  permission: "grant_admin_role",
  async run(ctx) {
    const name = ctx.argsText.trim();
    if (!name) return notice(ctx, "EMPTY", tFor(ctx.user.locale, "commands:promoteAdmin.usage"));
    // Role-hierarchy gate. The granular `grant_admin_role` permission
    // makes the command callable, but the matrix-bypass-the-hierarchy
    // attack ("a user-tier account with grant_admin_role promotes
    // itself to admin via an alt") is blocked by requiring the actor
    // to already hold at least the role they're granting. Mirrors
    // plan.md's hardcoded role-hierarchy exception applied to the
    // grant side.
    if (roleRank(ctx.user.role) < roleRank("admin")) {
      return notice(ctx, "RANK", tFor(ctx.user.locale, "commands:promoteAdmin.rank"));
    }
    const target = await findUserByName(ctx, name);
    if (!target) return;  // findUserByName emitted the appropriate notice.
    if (isAdminRole(target.role)) return notice(ctx, "ALREADY", tFor(ctx.user.locale, "commands:promoteAdmin.already", { name: target.username }));

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
  permission: "revoke_admin_role",
  async run(ctx) {
    const name = ctx.argsText.trim();
    if (!name) return notice(ctx, "EMPTY", tFor(ctx.user.locale, "commands:demoteAdmin.usage"));
    // Role-hierarchy gate. Same reasoning as /promoteadmin's: the
    // granular permission key makes the command callable, but the
    // hardcoded hierarchy refuses an actor below the target's tier
    // from demoting them. Means a user-tier account with
    // revoke_admin_role can't demote actual admins.
    if (roleRank(ctx.user.role) < roleRank("admin")) {
      return notice(ctx, "RANK", tFor(ctx.user.locale, "commands:demoteAdmin.rank"));
    }
    const target = await findUserByName(ctx, name);
    if (!target) return;  // findUserByName emitted the appropriate notice.
    // /demoteadmin only handles plain admins. Master admins must be
    // demoted via the admin panel by another master, since /demoteadmin
    // has no way to ask "demote to admin" vs "demote to user" anyway.
    if (target.role === "masteradmin") {
      return notice(ctx, "NOT_ADMIN", tFor(ctx.user.locale, "commands:demoteAdmin.isOwner", { name: target.username }));
    }
    if (target.role !== "admin") return notice(ctx, "NOT_ADMIN", tFor(ctx.user.locale, "commands:demoteAdmin.notAdmin", { name: target.username }));
    if (await isKeymaster(ctx, target.id)) {
      return notice(ctx, "KEYMASTER", tFor(ctx.user.locale, "commands:demoteAdmin.keymaster"));
    }
    if (target.id === ctx.user.id) {
      return notice(ctx, "SELF", tFor(ctx.user.locale, "commands:demoteAdmin.self"));
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
  description: "Banish a user from the current room. Owner/admin only, room mods can /kick or /mute, but only the room owner can permanently bar someone.",
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
    // Owner-or-sitewide-only. Room mods are intentionally NOT allowed
    // to ban, banishment is a permanent escalation that revokes the
    // user's ability to even enter the room, and the room owner should
    // be the only local authority who gets to make that call. Room
    // mods can /kick (temporary ejection) and /mute (silenced but
    // still present), those cover the day-to-day moderation surface
    // without handing out the "you can never come back" lever.
    if (!(await callerOwnsRoom(ctx, "ban_user", "ban_member"))) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:ban.permission"));
    }
    const [name, maybeDur, ...rest] = ctx.args;
    if (!name) return notice(ctx, "EMPTY", tFor(ctx.user.locale, "commands:ban.usage"));

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
    if (!target) return;  // findUserByName emitted the appropriate notice.
    if (target.id === ctx.user.id) return notice(ctx, "SELF", tFor(ctx.user.locale, "commands:ban.self"));
    if (roleRank(target.role) > roleRank(ctx.user.role)) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:ban.adminProtected"));
    }
    if (await isKeymaster(ctx, target.id)) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:ban.keymaster"));
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
    // the canonical landing, same flow as /kick but without the auto-
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
      // Recipient-locale notice: goes to the BANNED user's sockets.
      s.emit("error:notice", {
        code: "BANNED",
        message: until
          ? (reason
              ? tFor(target.locale, "commands:ban.bannedTimedReason", { duration: formatDuration(until.getTime() - Date.now()), name: ctx.user.displayName, reason })
              : tFor(target.locale, "commands:ban.bannedTimed", { duration: formatDuration(until.getTime() - Date.now()), name: ctx.user.displayName }))
          : (reason
              ? tFor(target.locale, "commands:ban.bannedReason", { name: ctx.user.displayName, reason })
              : tFor(target.locale, "commands:ban.banned", { name: ctx.user.displayName })),
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
  description: "Lift a /ban from the current room. Owner/admin only, pairs with /ban, which room mods can't issue.",
  async run(ctx) {
    // Symmetric to /ban, only the room owner (or a site-perm holder)
    // can lift a ban. A room mod who could /unban but not /ban would
    // be able to override an owner's permanent ban decision, which
    // defeats the purpose of restricting /ban to the owner.
    if (!(await callerOwnsRoom(ctx, "unban_user", "unban_member"))) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:unban.permission"));
    }
    const name = ctx.argsText.trim();
    if (!name) return notice(ctx, "EMPTY", tFor(ctx.user.locale, "commands:unban.usage"));
    const target = await findUserByName(ctx, name);
    if (!target) return;  // findUserByName emitted the appropriate notice.

    const r = await ctx.db
      .delete(bans)
      .where(and(eq(bans.roomId, ctx.roomId), eq(bans.userId, target.id)));
    if (r.changes === 0) {
      return notice(ctx, "NOT_BANNED", tFor(ctx.user.locale, "commands:unban.notBanned", { name: target.username }));
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
    if (!argsText) return notice(ctx, "EMPTY", tFor(ctx.user.locale, "commands:announce.usage"));

    // Sitewide variant - recognised by leading "all " (case-insensitive).
    const allMatch = /^all\s+(.+)/i.exec(argsText);
    if (allMatch) {
      if (!(await hasPermission(ctx.user, "announce_sitewide", ctx.db))) {
        return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:announce.allPermission"));
      }
      const body = allMatch[1]!.trim();
      if (!body) return notice(ctx, "EMPTY", tFor(ctx.user.locale, "commands:announce.allUsage"));

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
    if (!(await callerCanModerateRoom(ctx, "announce_room", "manage_announcements"))) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:announce.permission"));
    }

    // Servers ON: a room-scoped announce fans across the ISSUING server's
    // rooms, not just the one the command was typed in. We derive the
    // server from the issuing room (`rooms.server_id`) and target only that
    // server's rooms — a sub-server's owner/mod can't reach into a sibling
    // server's chats, and the system/default server stays the "everyone who
    // isn't on a sub-server" bucket. Rooms whose `server_id` is NULL belong
    // to the system/default server, so a NULL-server issuer fans across the
    // other NULL-server rooms (matched with isNull, not eq-on-null).
    //
    // FLAG-OFF: when servers are disabled this whole branch is skipped and
    // we fall through to the single-room `addMessage(ctx, ...)` below —
    // byte-identical to today.
    if (areServersEnabled(await getSettings(ctx.db))) {
      const issuing = (await ctx.db
        .select({ serverId: rooms.serverId })
        .from(rooms)
        .where(eq(rooms.id, ctx.roomId))
        .limit(1))[0];
      const serverId = issuing?.serverId ?? null;
      const scopedRooms = await ctx.db
        .select({ id: rooms.id })
        .from(rooms)
        .where(serverId === null ? isNull(rooms.serverId) : eq(rooms.serverId, serverId));
      // Re-use addMessage per room so each room gets its own persisted row,
      // its own ignore-filtered fan-out, and its own /history visible later
      // — mirroring the `/announce all` loop above.
      for (const r of scopedRooms) {
        const roomCtx = { ...ctx, roomId: r.id };
        await addMessage(roomCtx, { kind: "announce", body: argsText });
      }
      // Audit scoping mirrors §9.8: a REAL sub-server's room-scoped announce
      // is a server moderation action, so it stamps `server_id` and lands in
      // that server's Mod Log (auditServerAction). A NULL-server issuer is the
      // system/default server, which keeps today's GLOBAL Audit feed
      // (recordAudit) — never a server-scoped row.
      if (serverId !== null) {
        await auditServerAction(ctx.db, {
          serverId,
          actorUserId: ctx.user.id,
          action: "announce",
          targetRoomId: ctx.roomId,
          metadata: { scope: "server", rooms: scopedRooms.length, body: argsText },
        });
      } else {
        await recordAudit(ctx.db, {
          actorUserId: ctx.user.id,
          action: "announce",
          targetRoomId: ctx.roomId,
          metadata: { scope: "room", rooms: scopedRooms.length, body: argsText },
        });
      }
      return;
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
