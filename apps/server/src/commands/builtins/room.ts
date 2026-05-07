import argon2 from "argon2";
import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { roomMembers, rooms } from "../../db/schema.js";
import { joinRoom } from "../../realtime/broadcast.js";
import { getSettings } from "../../settings.js";
import type { CommandContext, CommandHandler } from "../types.js";

/**
 * Returns true if the caller can create another room. Admins are always
 * allowed. Counts only non-system rooms the user currently owns; deleted /
 * auto-expired rooms cascade away so they don't count.
 */
async function checkRoomCap(ctx: CommandContext): Promise<boolean> {
  if (ctx.user.role === "admin") return true;
  const { maxRoomsPerOwner } = await getSettings(ctx.db);
  if (maxRoomsPerOwner === 0) {
    ctx.socket.emit("error:notice", {
      code: "ROOM_DISABLED",
      message: "User-created rooms are disabled by an administrator.",
    });
    return false;
  }
  const countRow = (await ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(rooms)
    .where(and(eq(rooms.ownerId, ctx.user.id), eq(rooms.isSystem, false))))[0];
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
  const rows = await ctx.db
    .select()
    .from(rooms)
    .where(sql`lower(${rooms.name}) = ${name.toLowerCase()}`)
    .limit(1);
  return rows[0];
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
  if (!room) {
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

export const goCommand: CommandHandler = {
  name: "go",
  aliases: ["join"],
  usage: "/go <room>",
  description: "Join a public room (or create one if it doesn't exist).",
  async run(ctx) {
    const name = ctx.argsText.trim();
    if (!name) {
      ctx.socket.emit("error:notice", { code: "EMPTY", message: "Usage: /go <room>" });
      return;
    }
    await joinOrCreatePublic(ctx, name);
  },
};

export const privateRoomCommand: CommandHandler = {
  name: "private",
  aliases: ["pvt", "lock"],
  usage: "/private <name> <password>",
  description: "Create a password-protected room.",
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
    if (!NAME_RX.test(name)) {
      ctx.socket.emit("error:notice", { code: "BAD_ROOM_NAME", message: "Bad room name." });
      return;
    }
    const existing = await findRoomByName(ctx, name);
    if (existing) {
      ctx.socket.emit("error:notice", {
        code: "DUP_ROOM",
        message: `A room named "${name}" already exists.`,
      });
      return;
    }
    if (!(await checkRoomCap(ctx))) return;
    const id = nanoid();
    await ctx.db.insert(rooms).values({
      id,
      name,
      type: "private",
      passwordHash: await argon2.hash(password),
      ownerId: ctx.user.id,
    });
    await ctx.db.insert(roomMembers).values({
      roomId: id,
      userId: ctx.user.id,
      role: "owner",
    });
    await joinRoom(ctx.io, ctx.db, ctx.socket, ctx.user, id);
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
  if (ctx.user.role === "admin") return true;
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
  description: "Show or set the current room's topic (owner/mod only).",
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
  aliases: ["description", "world"],
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
    if (!txt) {
      const r = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
      const desc = r?.description ?? null;
      ctx.socket.emit("error:notice", {
        code: "DESCRIBE",
        message: desc ? `Description:\n${desc}` : "(no description set)",
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
