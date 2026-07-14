import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { isModeratorRole } from "@thekeep/shared";
import { messages, roomMembers, rooms } from "../../db/schema.js";
import { listArchivedOwnedRooms } from "../../lib/archivedRooms.js";
import { effectiveRoomNsfwWith, nsfwServerIds } from "../../lib/nsfwRooms.js";
import { loadRoleGates, roleAccessDeniedWith, roomModRoomIdsFor, staffServerIdsFor, usergroupIdsFor } from "../../lib/roleGates.js";
import { nsfwForumIds } from "../../forums/nsfw.js";
import { setRoomCleared } from "../../lib/roomClears.js";
import { formatDuration, parseDuration } from "../duration.js";
import { hasPermission } from "../../auth/permissions.js";
import { areServersEnabled, getSettings } from "../../settings.js";
import { tFor } from "../../i18n.js";
import type { CommandContext, CommandHandler } from "../types.js";

const CLEAR_CHUNK = 400; // keep each UPDATE under SQLite's bound-variable cap

/**
 * Drop rooms the caller can't see from a command listing — role-locked rooms
 * (room_role_gates kind='access') AND staff-only rooms (rooms.staff_only,
 * migration 0363). Their existence must not leak through /list or /find when
 * every other surface (rail, join, by-slug) hides them. Same batched shape as
 * GET /rooms: one gate read, then at most one membership, one staff, and one
 * room-mod read for the caller. Callers MUST select `staffOnly` onto the rows
 * (else a staff room reads as visible and leaks here).
 */
async function dropRoleLockedRooms<
  T extends { id: string; ownerId: string | null; serverId: string | null; staffOnly?: boolean },
>(ctx: CommandContext, rows: T[]): Promise<T[]> {
  if (rows.length === 0) return rows;
  const gates = await loadRoleGates(ctx.db, rows.map((r) => r.id));
  const hasAccess = [...gates.values()].some((g) => g.access.size > 0);
  const hasStaffOnly = rows.some((r) => r.staffOnly);
  if (!hasAccess && !hasStaffOnly) return rows;
  const isSite = isModeratorRole(ctx.user.role);
  const groupIds = hasAccess ? await usergroupIdsFor(ctx.db, ctx.user.id) : new Set<string>();
  const staffIds = isSite ? new Set<string>() : await staffServerIdsFor(ctx.db, ctx.user.id);
  // Staff-only rooms additionally admit the room's own mods.
  const roomModIds = hasStaffOnly && !isSite
    ? await roomModRoomIdsFor(ctx.db, ctx.user.id, rows.filter((r) => r.staffOnly).map((r) => r.id))
    : new Set<string>();
  return rows.filter(
    (r) => !roleAccessDeniedWith(ctx.user, r, gates.get(r.id)?.access, groupIds, staffIds, roomModIds),
  );
}

/**
 * Can the caller moderate (hide for everyone) in THIS room? Mirrors the
 * dispatcher's two-tier gate: the global `delete_others_message` permission, OR
 * — on a non-system sub-server room — the matching per-server grant.
 */
async function canModerateClear(ctx: CommandContext): Promise<boolean> {
  if (await hasPermission(ctx.user, "delete_others_message", ctx.db)) return true;
  const sid = (ctx.socket.data as { serverId?: string }).serverId;
  if (sid && areServersEnabled(await getSettings(ctx.db))) {
    const { serverAuthority, serverCan } = await import("../../servers/authority.js");
    const a = await serverAuthority(ctx.db, ctx.user, sid);
    return !!a.server && !a.server.isSystem && serverCan(a, "delete_others_message");
  }
  return false;
}

/**
 * /list - show all public rooms (name, topic, occupant count). Mirrors the
 * phpMyChat /list shorthand. Surfaced via the persistent info modal
 * (open-info-modal ui:hint) rather than the auto-dismissing toast,
 * because the list is too long to catch in passing and users
 * frequently want to scan it for the room they're looking for.
 *
 * Private rooms are intentionally omitted - listing them by name even
 * without messages would defeat the privacy contract for /list
 * specifically. Use /find for partial-match search (which DOES
 * include private + archived rooms, entry still gated by password)
 * or the admin Rooms tab for the full inventory.
 */
export const listCommand: CommandHandler = {
  name: "list",
  aliases: ["rooms"],
  usage: "/list",
  description: "Show every public room (name + topic + member count).",
  async run(ctx) {
    let allRooms = await ctx.db
      .select({
        id: rooms.id,
        name: rooms.name,
        topic: rooms.topic,
        type: rooms.type,
        isNsfw: rooms.isNsfw,
        serverId: rooms.serverId,
        ownerId: rooms.ownerId,
        forumId: rooms.forumId,
        // Needed by dropRoleLockedRooms below — without it a staff-only room
        // reads as visible and would leak into /list for non-staff.
        staffOnly: rooms.staffOnly,
      })
      .from(rooms)
      // Archived rows hold a name reservation but no users; hide them
      // from the user-facing list. They'll come back if anyone
      // recreates a room with the same name.
      .where(and(eq(rooms.type, "public"), isNull(rooms.archivedAt)))
      .orderBy(asc(rooms.name));

    // HARD age gate (age plan, Phase 2): effectively-18+ rooms are hidden
    // from minors entirely, matching the /rooms rail. Boards of an 18+
    // FORUM count too: a board room isn't individually flagged when only
    // its parent forum is, so the row-level flags alone can't see it
    // (same reasoning as the /rooms route).
    if (!ctx.user.isAdult) {
      const nsfwServers = await nsfwServerIds(ctx.db);
      const nsfwForums = await nsfwForumIds(ctx.db);
      allRooms = allRooms.filter((r) =>
        !effectiveRoomNsfwWith(r, nsfwServers)
        && !(r.forumId && nsfwForums.has(r.forumId)));
    }
    // Role-locked rooms are absent for non-holders, matching the rail.
    allRooms = await dropRoleLockedRooms(ctx, allRooms);

    if (allRooms.length === 0) {
      ctx.socket.emit("ui:hint", {
        kind: "open-info-modal",
        title: tFor(ctx.user.locale, "commands:list.title"),
        body: tFor(ctx.user.locale, "commands:list.empty"),
      });
      return;
    }

    const counts = await ctx.db
      .select({ roomId: roomMembers.roomId, n: sql<number>`count(*)` })
      .from(roomMembers)
      .groupBy(roomMembers.roomId);
    const countByRoom = new Map(counts.map((c) => [c.roomId, c.n]));

    const lines = allRooms.map((r) => {
      const n = countByRoom.get(r.id) ?? 0;
      return `  ${r.name} (${n})${r.topic ? ` - ${r.topic}` : ""}`;
    });
    ctx.socket.emit("ui:hint", {
      kind: "open-info-modal",
      title: tFor(ctx.user.locale, "commands:list.titleCount", { total: allRooms.length }),
      body: lines.join("\n"),
    });
  },
};

/**
 * /myrooms - list the rooms you own that have gone quiet (archived).
 *
 * A room you own is archived automatically once its last occupant leaves;
 * the row sticks around holding the name + settings (and, for a private
 * room, its password hash) so you can bring it back later. This command
 * surfaces those rooms so you don't have to remember what you named them.
 *
 * Output is PRIVATE to you - the list can include private room names, so we
 * emit a socket-only `my-rooms` hint (the client renders it as a local chat
 * line) instead of broadcasting it, the same privacy posture `/list` and
 * `/find` use. Each room renders as a click-to-fill link that drops
 * `/go <name>` into your composer; sending it resurrects the room exactly as
 * it was (a private room comes back private with its original password) so
 * you can tweak the line first if you'd rather change the password.
 */
export const myRoomsCommand: CommandHandler = {
  name: "myrooms",
  aliases: ["archived"],
  usage: "/myrooms",
  description:
    "List the rooms you own that have gone quiet (archived). Each one becomes a tap-to-fill /go link so you can bring it back - private rooms return private with their original password.",
  async run(ctx) {
    const owned = await listArchivedOwnedRooms(ctx.db, ctx.user.id);
    ctx.socket.emit("ui:hint", { kind: "my-rooms", rooms: owned });
  },
};

/**
 * /clear - two behaviors, by argument:
 *
 *   /clear              (anyone) hide YOUR OWN scrollback in this room from
 *                       here on. Records a per-viewer `cleared_at = now` marker
 *                       (room_clears) so it's DURABLE: every backlog source
 *                       filters to messages newer than it for this user. No
 *                       rows are deleted and other users are unaffected.
 *
 *   /clear <duration>   (mods) hide the last N of chat from EVERYONE's view —
 *                       the moderation tool for cleaning up after a harassment
 *                       incident. SOFT: rows are kept (marked removed), so they
 *                       vanish live for everyone yet stay readable to admins for
 *                       reports/bans. Use /trash to delete permanently instead.
 *                       Gated by `delete_others_message` (global OR per-server).
 */
export const clearCommand: CommandHandler = {
  name: "clear",
  aliases: ["cls"],
  usage: "/clear  (your view)  ·  /clear <duration>  (mods: hide the last N from everyone)",
  description: "No args: hide earlier messages from your OWN view. With a duration (mods): hide the last N (e.g. 30m, 2h) from EVERYONE, kept for moderators to review.",
  subcommands: [
    { verb: "(none)", usage: "/clear", description: "Hide earlier messages in this room from your own view (durable; doesn't delete)." },
    { verb: "<duration>", usage: "/clear 30m", description: "Mods: hide the last N from everyone's view (30s, 5m, 2h, 1h30m, 1d). Kept for moderators; use /trash to delete permanently." },
  ],
  async run(ctx) {
    const arg = ctx.argsText.trim();

    // No duration → the classic per-viewer clear (available to anyone).
    if (!arg) {
      await setRoomCleared(ctx.db, ctx.user.id, ctx.roomId, new Date());
      ctx.socket.emit("ui:hint", { kind: "clear-room-messages" });
      return;
    }

    // A duration → the moderation soft-clear. Gate it here (not on the handler)
    // so the no-arg personal clear stays open to everyone.
    const ms = parseDuration(arg);
    if (ms == null) {
      ctx.socket.emit("error:notice", {
        code: "BAD_DURATION",
        message: tFor(ctx.user.locale, "commands:clear.badDuration"),
      });
      return;
    }
    if (!(await canModerateClear(ctx))) {
      ctx.socket.emit("error:notice", {
        code: "NO_PERMISSION",
        message: tFor(ctx.user.locale, "commands:clear.noPermission"),
      });
      return;
    }
    const room = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
    if (!room) { ctx.socket.emit("error:notice", { code: "NO_ROOM", message: tFor(ctx.user.locale, "commands:shared.roomNotFound") }); return; }
    if (room.replyMode === "nested") {
      ctx.socket.emit("error:notice", { code: "FORUM", message: tFor(ctx.user.locale, "commands:clear.forum") });
      return;
    }

    const cutoff = new Date(Date.now() - ms);
    // Snapshot the ids first so the live removal matches what we hide. Skip
    // whispers (private) and system lines (join/leave/announcements aren't the
    // harassment we're clearing), and rows already removed.
    const doomed = await ctx.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(
        eq(messages.roomId, ctx.roomId),
        sql`${messages.kind} != 'whisper'`,
        sql`${messages.kind} != 'system'`,
        gte(messages.createdAt, cutoff),
        isNull(messages.deletedAt),
      ));
    const ids = doomed.map((r) => r.id);
    if (ids.length === 0) {
      ctx.socket.emit("error:notice", { code: "CLEAR", message: tFor(ctx.user.locale, "commands:clear.none", { duration: formatDuration(ms) }) });
      return;
    }

    // SOFT remove: keep the rows (admins keep the evidence + who/when) but blank
    // them for everyone else. We snapshot the actor's ACCOUNT name for audit
    // transparency, matching the single-message delete path.
    const now = new Date();
    for (let i = 0; i < ids.length; i += CLEAR_CHUNK) {
      await ctx.db.update(messages)
        .set({ deletedAt: now, deletedByUserId: ctx.user.id, deletedByDisplayName: ctx.user.username })
        .where(inArray(messages.id, ids.slice(i, i + CLEAR_CHUNK)));
    }

    // Live-remove from every client's buffer (reload then shows the standard
    // "[message removed]" tombstones; admins still see the originals), then a
    // system summary whose own row is newer than the cutoff, so it survives.
    ctx.io.to(`room:${ctx.roomId}`).emit("message:bulk-delete", { roomId: ctx.roomId, ids });
    // Staff pair oversight: the soft-clear also drops the rows from the
    // merged view of staff standing in the pair's other channel.
    const { emitToPairStaff } = await import("../../lib/pairStaffView.js");
    await emitToPairStaff(ctx.io, ctx.db, ctx.roomId, (s) => s.emit("message:bulk-delete", { roomId: ctx.roomId, ids }));
    const { addMessage } = await import("../../realtime/broadcast.js");
    await addMessage(ctx, {
      kind: "system",
      body: `${ctx.user.displayName} hid ${ids.length} message${ids.length === 1 ? "" : "s"} from the last ${formatDuration(ms)} from everyone's view.`,
    });
  },
};

/**
 * /find <name> - search rooms by partial name. Helpful when you only
 * remember a fragment of a room name (e.g. an archived room you made
 * months ago).
 *
 * Privacy model, archived AND private rooms are INCLUDED:
 *   - Archived rooms are listed so the user can find (and then
 *     recreate) one they made; archived rows are name reservations
 *     with no occupants, and anyone can re-establish the room by
 *     navigating to it.
 *   - Private rooms are listed because surfacing the name doesn't
 *     bypass the privacy contract, entry still requires the
 *     password and there's no transcript leak from a name match.
 *
 * Authoritative full inventory still lives in the admin Rooms tab;
 * this is just a "what did I name that thing?" recall tool.
 */
export const findCommand: CommandHandler = {
  name: "find",
  aliases: ["search"],
  usage: "/find <name>",
  description: "Search rooms by partial name (case-insensitive). Includes archived + private rooms.",
  subcommands: [
    {
      verb: "<name>",
      usage: "/find tav",
      description: "Show every room whose name contains 'tav' (case-insensitive).",
    },
  ],
  async run(ctx) {
    const needle = ctx.argsText.trim();
    if (!needle) {
      // Usage hint is a single line, transient feedback, toast fits.
      ctx.socket.emit("error:notice", {
        code: "ROOM_FIND",
        message: tFor(ctx.user.locale, "commands:find.usage"),
      });
      return;
    }
    const RESULT_CAP = 25;
    let matches = await ctx.db
      .select({
        id: rooms.id,
        name: rooms.name,
        topic: rooms.topic,
        type: rooms.type,
        archivedAt: rooms.archivedAt,
        isNsfw: rooms.isNsfw,
        serverId: rooms.serverId,
        ownerId: rooms.ownerId,
        forumId: rooms.forumId,
        // Needed by dropRoleLockedRooms below (staff-only rooms don't surface
        // by name for non-staff, same as role-locked rooms).
        staffOnly: rooms.staffOnly,
      })
      .from(rooms)
      .where(sql`lower(${rooms.name}) LIKE ${"%" + needle.toLowerCase() + "%"}`)
      .orderBy(asc(rooms.name))
      .limit(RESULT_CAP + 1);

    // HARD age gate: 18+ room names don't surface to minors even here
    // (private names are fine to list, 18+ ones are not — decision #3
    // hides the spaces entirely). Includes boards whose parent FORUM is
    // 18+, which carry no room-level flag of their own.
    if (!ctx.user.isAdult) {
      const nsfwServers = await nsfwServerIds(ctx.db);
      const nsfwForums = await nsfwForumIds(ctx.db);
      matches = matches.filter((r) =>
        !effectiveRoomNsfwWith(r, nsfwServers)
        && !(r.forumId && nsfwForums.has(r.forumId)));
    }
    // Role-locked rooms don't surface even by name — unlike private rooms
    // (whose names are safe to list), the access gate's contract is that
    // existence never leaks to non-holders.
    matches = await dropRoleLockedRooms(ctx, matches);

    if (matches.length === 0) {
      ctx.socket.emit("ui:hint", {
        kind: "open-info-modal",
        title: tFor(ctx.user.locale, "commands:find.title", { query: needle }),
        body: tFor(ctx.user.locale, "commands:find.noMatch", { query: needle }),
      });
      return;
    }

    const shown = matches.slice(0, RESULT_CAP);
    const truncated = matches.length > RESULT_CAP;

    // Occupant counts. Active rooms only, archived rooms always
    // have zero members by definition, so the join-then-filter on
    // shown ids skips them naturally.
    const counts = await ctx.db
      .select({ roomId: roomMembers.roomId, n: sql<number>`count(*)` })
      .from(roomMembers)
      .groupBy(roomMembers.roomId);
    const countByRoom = new Map(counts.map((c) => [c.roomId, c.n]));

    const lines = shown.map((r) => {
      const tags: string[] = [];
      if (r.type === "private") tags.push(tFor(ctx.user.locale, "commands:find.tagPrivate"));
      if (r.archivedAt) tags.push(tFor(ctx.user.locale, "commands:find.tagArchived"));
      const tagSuffix = tags.length > 0 ? ` · ${tags.join(" · ")}` : "";
      const topicPart = r.topic ? ` - ${r.topic}` : "";
      // Hide the "(0)" occupant count on archived rooms since it's
      // tautological and just adds visual noise.
      const occupantPart = r.archivedAt ? "" : ` (${countByRoom.get(r.id) ?? 0})`;
      return `  ${r.name}${occupantPart}${topicPart}${tagSuffix}`;
    });

    const title = truncated
      ? tFor(ctx.user.locale, "commands:find.titleTruncated", { query: needle, cap: RESULT_CAP, total: matches.length })
      : tFor(ctx.user.locale, "commands:find.titleCount", { query: needle, total: shown.length });
    ctx.socket.emit("ui:hint", {
      kind: "open-info-modal",
      title,
      body: lines.join("\n"),
    });
  },
};
