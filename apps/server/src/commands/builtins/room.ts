import argon2 from "argon2";
import { and, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { bans, roomInvites, roomMembers, rooms } from "../../db/schema.js";
import { joinRoom } from "../../realtime/broadcast.js";
import { getSettings } from "../../settings.js";
import { hasPermission } from "../../auth/permissions.js";
import type { CommandContext, CommandHandler } from "../types.js";

/**
 * Returns true if the caller can create another room. Admins are always
 * allowed. Counts only non-system rooms the user currently owns; deleted /
 * auto-expired rooms cascade away so they don't count.
 */
async function checkRoomCap(ctx: CommandContext): Promise<boolean> {
  if (await hasPermission(ctx.user, "bypass_room_cap", ctx.db)) return true;
  const { maxRoomsPerOwner } = await getSettings(ctx.db);
  if (maxRoomsPerOwner === 0) {
    ctx.socket.emit("error:notice", {
      code: "ROOM_DISABLED",
      message: "User-created rooms are disabled by an administrator.",
    });
    return false;
  }
  // Archived rooms don't count against the per-user cap, they hold a
  // name reservation but have no users and add no load. Without this
  // exclusion, a user who created N rooms that all auto-archived would
  // permanently lose the ability to create more even though all of
  // their visible rooms are gone.
  const countRow = (await ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(rooms)
    .where(and(
      eq(rooms.ownerId, ctx.user.id),
      eq(rooms.isSystem, false),
      isNull(rooms.archivedAt),
    )))[0];
  const count = countRow?.n ?? 0;
  if (count >= maxRoomsPerOwner) {
    ctx.socket.emit("error:notice", {
      code: "ROOM_LIMIT",
      message: `You already own ${count} rooms - the per-user limit is ${maxRoomsPerOwner}.`,
    });
    return false;
  }
  return true;
}

const NAME_RX = /^[\p{L}\p{N}_\-' ]{1,40}$/u;

async function findRoomByName(ctx: CommandContext, name: string) {
  // Returns ARCHIVED rooms too, callers branch on `row.archivedAt` to
  // decide between "join existing", "resurrect", and "name conflict".
  // Filtering archived rows here would break the resurrect path
  // because the room_name unique index still holds, so the matching
  // create would 409 on the live row anyway.
  const rows = await ctx.db
    .select()
    .from(rooms)
    .where(sql`lower(${rooms.name}) = ${name.toLowerCase()}`)
    .limit(1);
  return rows[0];
}

/**
 * Bring an archived row back to life with a new caller as owner.
 * Mirrors the design choice from the spec: settings (topic,
 * description, replyMode, theme link, messageExpiryMinutes,
 * npcDisabled, plus type + passwordHash by default) all carry over
 * so the new owner inherits the prior incarnation's setup; the
 * membership / invites / bans tables reset to a clean slate so the
 * new owner doesn't inherit someone else's moderation history.
 *
 * `overrides` is the escape hatch for resurrection paths where the
 * caller explicitly redeclared the room's mode, `/private` / `/go
 * <name> <password>` clearly want a private room with a known
 * password regardless of how the previous incarnation was set up. A
 * plain `/go <name>` leaves both fields alone and the preserved
 * type/password carry through; the owner bypasses the password
 * gate in `joinExistingWithPassword` so re-entry works.
 */
async function resurrectArchivedRoom(
  ctx: CommandContext,
  roomId: string,
  overrides?: { type?: "public" | "private"; passwordHash?: string | null },
): Promise<void> {
  await ctx.db
    .update(rooms)
    .set({
      archivedAt: null,
      ownerId: ctx.user.id,
      ...(overrides?.type !== undefined ? { type: overrides.type } : {}),
      ...(overrides?.passwordHash !== undefined ? { passwordHash: overrides.passwordHash } : {}),
    })
    .where(eq(rooms.id, roomId));
  // Wipe any stale per-user state from the previous incarnation. FK
  // cascades did this on hard-delete; we replicate it explicitly now
  // that the row sticks around.
  await ctx.db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
  await ctx.db.delete(bans).where(eq(bans.roomId, roomId));
  await ctx.db.delete(roomInvites).where(eq(roomInvites.roomId, roomId));
  // Re-seat the new caller as the owner-role member so /topic + other
  // owner-gated commands recognize them immediately.
  await ctx.db.insert(roomMembers).values({
    roomId,
    userId: ctx.user.id,
    role: "owner",
  });
}

async function joinOrCreatePublic(ctx: CommandContext, name: string) {
  if (!NAME_RX.test(name)) {
    ctx.socket.emit("error:notice", {
      code: "BAD_ROOM_NAME",
      message: "Room name must be 1-40 chars: letters, numbers, spaces, _ - '",
    });
    return;
  }
  let room = await findRoomByName(ctx, name);
  if (room?.archivedAt) {
    // Resurrection path: the row's been parked since its last
    // occupant left. Bring it back with the current caller as owner;
    // settings carry over, member/ban/invite tables reset.
    if (!(await checkRoomCap(ctx))) return;
    await resurrectArchivedRoom(ctx, room.id);
    room = (await findRoomByName(ctx, name))!;
  } else if (!room) {
    if (!(await checkRoomCap(ctx))) return;
    const id = nanoid();
    await ctx.db.insert(rooms).values({
      id,
      name,
      type: "public",
      ownerId: ctx.user.id,
    });
    // Mirror /private: the creator is also a member with role=owner.
    // Otherwise /topic and other owner-gated commands won't recognize them
    // until something else upgrades the row.
    await ctx.db.insert(roomMembers).values({
      roomId: id,
      userId: ctx.user.id,
      role: "owner",
    }).onConflictDoNothing();
    room = (await findRoomByName(ctx, name))!;
  }
  // Private rooms: joinRoom will prompt for password if no invite/membership.
  await joinRoom(ctx.io, ctx.db, ctx.socket, ctx.user, room.id);
}

/**
 * Create a brand-new private room owned by the caller and immediately join it.
 * Shared by /private and the /go-with-password sugar form below. Caller has
 * already verified there's no LIVE room with this name; an archived row with
 * this name still gets resurrected here with the caller's password as the
 * new override (the previous incarnation's password is replaced because the
 * caller clearly intended a fresh private setup with their own credential).
 */
async function createPrivateRoom(ctx: CommandContext, name: string, password: string) {
  if (!NAME_RX.test(name)) {
    ctx.socket.emit("error:notice", { code: "BAD_ROOM_NAME", message: "Bad room name." });
    return;
  }
  if (!(await checkRoomCap(ctx))) return;
  const passwordHash = await argon2.hash(password);
  // Same-name resurrection: an archived row keeps the unique index
  // alive, so a fresh INSERT would 23505. Detect + resurrect with the
  // caller's chosen password as the override.
  const archived = await findRoomByName(ctx, name);
  if (archived?.archivedAt) {
    await resurrectArchivedRoom(ctx, archived.id, { type: "private", passwordHash });
    await joinRoom(ctx.io, ctx.db, ctx.socket, ctx.user, archived.id);
    return;
  }
  const id = nanoid();
  await ctx.db.insert(rooms).values({
    id,
    name,
    type: "private",
    passwordHash,
    ownerId: ctx.user.id,
  });
  await ctx.db.insert(roomMembers).values({
    roomId: id,
    userId: ctx.user.id,
    role: "owner",
  });
  await joinRoom(ctx.io, ctx.db, ctx.socket, ctx.user, id);
}

/**
 * Verify a supplied password against an existing private room, then join.
 * Used by /go's inline-password sugar so users don't have to click through
 * the prompt-room-password modal. Public rooms ignore the password (with a
 * gentle notice so users know it was a no-op rather than silently accepted).
 */
async function joinExistingWithPassword(
  ctx: CommandContext,
  room: typeof rooms.$inferSelect,
  password: string,
) {
  if (room.type === "public") {
    ctx.socket.emit("error:notice", {
      code: "PASSWORD_IGNORED",
      message: `${room.name} is a public room - the password you supplied was ignored.`,
    });
    await joinRoom(ctx.io, ctx.db, ctx.socket, ctx.user, room.id);
    return;
  }
  // Private. Owner gets a free pass; otherwise verify the password upfront.
  if (room.ownerId === ctx.user.id || !room.passwordHash) {
    await joinRoom(ctx.io, ctx.db, ctx.socket, ctx.user, room.id);
    return;
  }
  const ok = await argon2.verify(room.passwordHash, password).catch(() => false);
  if (!ok) {
    ctx.socket.emit("error:notice", { code: "BAD_PASSWORD", message: "Incorrect password." });
    return;
  }
  await joinRoom(ctx.io, ctx.db, ctx.socket, ctx.user, room.id, { passwordOk: true });
}

/**
 * /go <room> [password]
 *
 * Unified entry into a room:
 *   - /go The_Spire          join existing public room
 *   - /go MyRoom              create a public room (and join) if it doesn't exist
 *   - /go SecretRoom hunter2  same as /private: create a private room with this
 *                             password if it doesn't exist, OR join an existing
 *                             private room using this password (skips the modal)
 *   - /go My Cool Room        multi-word public name still works as long as it
 *                             matches an existing room or you don't pass a password
 *
 * Disambiguation: when the argsText has multiple whitespace-separated tokens
 * AND the entire argsText doesn't match an existing room name, the first
 * token is treated as the room name and the rest is the password (mirroring
 * /private's convention). Multi-word room names with inline passwords aren't
 * supported via this sugar form, use /private with quoting (or just /go
 * <name> first, then enter the password in the modal) for that.
 */
export const goCommand: CommandHandler = {
  name: "go",
  aliases: ["join"],
  usage: "/go <room> [password]",
  description:
    "Join a room (creating it if needed). With a password, behaves like /private: creates a password-protected room or joins an existing private room without a separate prompt.",
  subcommands: [
    {
      verb: "<room>",
      usage: "/go The_Spire",
      description: "Join an existing room, or create a new PUBLIC room with this name. Multi-word names allowed.",
    },
    {
      verb: "<room> <password>",
      usage: "/go SecretRoom hunter2",
      description:
        "Create a private room with this password if it doesn't exist, or join an existing private room with it. Same effect as /private. First whitespace-separated token is the name; everything after is the password.",
    },
  ],
  async run(ctx) {
    const argsText = ctx.argsText.trim();
    if (!argsText) {
      ctx.socket.emit("error:notice", { code: "EMPTY", message: "Usage: /go <room> [password]" });
      return;
    }

    // Always try the full argsText as a room name first - this preserves the
    // pre-existing /go behavior for multi-word room names like "Common Room".
    // joinRoom itself surfaces the password prompt UI for private rooms when
    // the user didn't supply one inline.
    //
    // Archived rooms surface here too, `joinOrCreatePublic` handles the
    // resurrection branch when there's no password component. A
    // matched-but-archived row with a password supplied later in the flow
    // (the multi-token branch below) routes through `createPrivateRoom`
    // which also handles resurrection.
    const fullMatch = await findRoomByName(ctx, argsText);
    if (fullMatch && !fullMatch.archivedAt) {
      await joinRoom(ctx.io, ctx.db, ctx.socket, ctx.user, fullMatch.id);
      return;
    }

    // No full-text room match (or matched row is archived). If the user
    // provided multiple tokens, treat the first as the name and the rest
    // as a password (the /private form). Single token → public.
    const tokens = argsText.split(/\s+/);
    if (tokens.length === 1) {
      await joinOrCreatePublic(ctx, tokens[0]!);
      return;
    }

    const name = tokens[0]!;
    const password = tokens.slice(1).join(" ");
    const existingByFirst = await findRoomByName(ctx, name);
    if (existingByFirst && !existingByFirst.archivedAt) {
      // The first-token name matches a LIVE room. Treat the trailing
      // text as a password and let joinExistingWithPassword sort out
      // public-vs-private (public will emit a "password ignored" notice).
      await joinExistingWithPassword(ctx, existingByFirst, password);
      return;
    }
    // No live room by first token. createPrivateRoom resurrects an
    // archived row with the new password if there is one, otherwise
    // inserts a fresh row.
    await createPrivateRoom(ctx, name, password);
  },
};

export const privateRoomCommand: CommandHandler = {
  name: "private",
  aliases: ["pvt", "lock"],
  usage: "/private <name> <password>",
  description:
    "Create a password-protected room. Equivalent to /go <name> <password> when no room with that name exists. First whitespace-separated token is the name; everything after is the password.",
  async run(ctx) {
    const [name, ...pwParts] = ctx.args;
    const password = pwParts.join(" ").trim();
    if (!name || !password) {
      ctx.socket.emit("error:notice", {
        code: "EMPTY",
        message: "Usage: /private <name> <password>",
      });
      return;
    }
    const existing = await findRoomByName(ctx, name);
    if (existing && !existing.archivedAt) {
      // LIVE room, name's still in active use, reject. Archived
      // rooms fall through to createPrivateRoom which resurrects.
      ctx.socket.emit("error:notice", {
        code: "DUP_ROOM",
        message: `A room named "${name}" already exists.`,
      });
      return;
    }
    await createPrivateRoom(ctx, name, password);
  },
};

export const inviteCommand: CommandHandler = {
  name: "invite",
  usage: "/invite <username>",
  description:
    "Invite a user to this room. For private rooms they can join without the password. For public rooms it sends them a heads-up notification.",
  async run(ctx) {
    const username = ctx.argsText.trim();
    if (!username) {
      ctx.socket.emit("error:notice", { code: "EMPTY", message: "Usage: /invite <username>" });
      return;
    }
    const { invite } = await import("../../realtime/invites.js");
    await invite(ctx, username);
  },
};

/**
 * Helper - does the caller have authority to edit room metadata (topic,
 * description)? Site admins always; otherwise the row's ownerId, the
 * roomMembers role of "owner", or "mod".
 */
async function callerCanEditRoom(ctx: CommandContext): Promise<boolean> {
  if (await hasPermission(ctx.user, "edit_any_room_metadata", ctx.db)) return true;
  const room = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
  if (!room) return false;
  if (room.ownerId === ctx.user.id) return true;
  const m = (await ctx.db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, ctx.roomId), eq(roomMembers.userId, ctx.user.id)))
    .limit(1))[0];
  return m?.role === "owner" || m?.role === "mod";
}

export const topicCommand: CommandHandler = {
  name: "topic",
  usage: "/topic [<text>]",
  description: "Show or set the current room's topic (owner/mod only to set).",
  subcommands: [
    {
      verb: "(no args)",
      usage: "/topic",
      description: "Show the current room's topic.",
    },
    {
      verb: "<text>",
      usage: "/topic <text>",
      description: "Set the room's topic (owner/mod/admin only). Topic is the short headline above the chat.",
    },
  ],
  async run(ctx) {
    const txt = ctx.argsText.trim();
    if (!txt) {
      const r = await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1);
      const topic = r[0]?.topic ?? "(no topic set)";
      ctx.socket.emit("error:notice", { code: "TOPIC", message: `Topic: ${topic}` });
      return;
    }
    if (!(await callerCanEditRoom(ctx))) {
      ctx.socket.emit("error:notice", {
        code: "PERM",
        message: "Only the room owner or a mod can change the topic.",
      });
      return;
    }
    await ctx.db.update(rooms).set({ topic: txt }).where(eq(rooms.id, ctx.roomId));

    const { addMessage, broadcastRoomState } = await import("../../realtime/broadcast.js");
    await addMessage(ctx, { kind: "system", body: `Topic set: ${txt}` });
    await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
  },
};

const DESCRIPTION_MAX = 5000;

/**
 * /describe [text|clear]
 *
 * Long-form world/setting description for the current room. Shown to a
 * user ONCE when they enter the room (as a system message), so it sets
 * the scene without polluting ongoing chat. Distinct from /topic, which
 * is a short headline always visible above the chat.
 *
 *   /describe                - show the current description (caller only)
 *   /describe <text>         - set or replace the description (owner/mod/admin)
 *   /describe clear          - remove the description (owner/mod/admin)
 *
 * Plain text, newlines preserved. Capped at 5000 chars.
 */
export const describeCommand: CommandHandler = {
  name: "describe",
  aliases: ["description"],
  usage: "/describe [<text>|clear]",
  description: "Show or set the room's long-form description (shown to users on join). Owner/mod only to edit.",
  subcommands: [
    { verb: "(no args)", usage: "/describe", description: "Show the current description." },
    { verb: "<text>", usage: "/describe <text>", description: "Set or replace the description (owner/mod/admin)." },
    { verb: "clear", usage: "/describe clear", description: "Remove the description (owner/mod/admin)." },
  ],
  async run(ctx) {
    const txt = ctx.argsText.trim();

    // No args → show the current description to the caller only.
    // Up to 5000 chars of long-form prose, surfaced via the
    // persistent info modal so the user can read at leisure
    // (the auto-dismissing toast can't display 5000 chars).
    if (!txt) {
      const r = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
      const desc = r?.description ?? null;
      ctx.socket.emit("ui:hint", {
        kind: "open-info-modal",
        title: `Room description - ${r?.name ?? "this room"}`,
        body: desc ?? "(no description set)",
      });
      return;
    }

    // Edit paths require owner/mod/admin.
    if (!(await callerCanEditRoom(ctx))) {
      ctx.socket.emit("error:notice", {
        code: "PERM",
        message: "Only the room owner or a mod can change the description.",
      });
      return;
    }

    if (/^clear$/i.test(txt)) {
      await ctx.db.update(rooms).set({ description: null }).where(eq(rooms.id, ctx.roomId));
      const { addMessage } = await import("../../realtime/broadcast.js");
      await addMessage(ctx, { kind: "system", body: `${ctx.user.displayName} cleared the room description.` });
      return;
    }

    if (txt.length > DESCRIPTION_MAX) {
      ctx.socket.emit("error:notice", {
        code: "TOO_LONG",
        message: `Description is capped at ${DESCRIPTION_MAX} chars.`,
      });
      return;
    }

    await ctx.db.update(rooms).set({ description: txt }).where(eq(rooms.id, ctx.roomId));
    const { addMessage } = await import("../../realtime/broadcast.js");
    await addMessage(ctx, {
      kind: "system",
      body: `${ctx.user.displayName} updated the room description. New visitors will see it on join.`,
    });
  },
};
