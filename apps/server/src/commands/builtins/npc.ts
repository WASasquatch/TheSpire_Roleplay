import { and, eq } from "drizzle-orm";
import { roomMembers, rooms } from "../../db/schema.js";
import { addMessage, addSystemMessage, broadcastRoomState } from "../../realtime/broadcast.js";
import type { CommandContext, CommandHandler } from "../types.js";

const NPC_NAME_RX = /^[\p{L}\p{N}_\-' ]{1,40}$/u;

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/**
 * /npc <Name> <text>     - voice an NPC; renders as <Name> "<text>"
 * /npc <Name> /me <act>  - emote-shape: renders as <Name> <act> (no quotes)
 *
 * Anyone can voice an NPC by default. The room owner / mods can disable NPCs
 * for themed games via the room editor (sets rooms.npc_disabled). Each NPC
 * line carries a "voiced by <author>" attribution so impersonation stays
 * traceable - players can't anonymously voice characters they're not speaking
 * for.
 */
export const npcCommand: CommandHandler = {
  name: "npc",
  usage: "/npc <Name> <text>",
  description:
    "Voice an NPC by name in the current room. The line shows who voiced it. Room owner can disable /npc for themed games.",
  subcommands: [
    { verb: "<Name> <text>", usage: "/npc Innkeeper Welcome, traveler.", description: "Voice an NPC saying something." },
    { verb: "<Name> /me <act>", usage: "/npc Innkeeper /me polishes a glass.", description: "Voice an NPC performing an action (no quotes)." },
  ],
  async run(ctx) {
    if (ctx.args.length < 2) {
      notice(ctx, "NPC_USAGE", "Usage: /npc <Name> <text>  (or /npc <Name> /me <action>)");
      return;
    }

    // Per-room toggle. Owners/mods set this via the room editor for themed
    // games where everyone must voice their own character only.
    const room = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
    if (room?.npcDisabled) {
      notice(ctx, "NPC_DISABLED", "/npc is disabled in this room.");
      return;
    }

    const npcName = ctx.args[0]!;
    if (!NPC_NAME_RX.test(npcName)) {
      notice(ctx, "NPC_BAD_NAME", "NPC name must be 1-40 chars: letters, numbers, spaces, _ - '");
      return;
    }

    const rest = ctx.argsText.replace(/^\S+\s*/, "");
    let body = rest;
    let kindIsAction = false;
    if (/^\/me\s+/i.test(rest)) {
      kindIsAction = true;
      body = rest.replace(/^\/me\s+/i, "").trim();
    } else {
      body = rest.trim();
    }
    if (!body) {
      notice(ctx, "NPC_EMPTY", "NPC line is empty.");
      return;
    }

    // The server-stored kind stays "npc" regardless of action vs say shape -
    // the client decides how to render based on the prefix in the body.
    // Simpler than a second kind, and all attribution rules stay uniform.
    const renderedBody = kindIsAction ? `*${body}*` : body;

    await addMessage(ctx, {
      kind: "npc",
      body: renderedBody,
      displayNameOverride: npcName,
      // Use the master username (not displayName) for the voiced-by tag so
      // players can find the actual account behind the puppet regardless of
      // which character the author is currently switched to.
      npcVoicedBy: ctx.user.username,
    });
  },
};

/**
 * /npcmode on|off
 *
 * Owner / room-mod / site-mod / site-admin only. Toggles the per-room flag
 * that lets a director run a themed game where every player must voice
 * their own character only.
 */
export const npcModeCommand: CommandHandler = {
  name: "npcmode",
  aliases: ["npcs"],
  usage: "/npcmode on|off",
  description:
    "Toggle whether /npc is allowed in the current room. Owner/mod only. Useful for themed games where everyone must voice their own character.",
  async run(ctx) {
    const arg = (ctx.args[0] ?? "").toLowerCase();
    let nextDisabled: boolean;
    if (arg === "on" || arg === "enable" || arg === "allow") {
      nextDisabled = false;
    } else if (arg === "off" || arg === "disable" || arg === "block") {
      nextDisabled = true;
    } else {
      notice(ctx, "NPCMODE_USAGE", "Usage: /npcmode on  (or)  /npcmode off");
      return;
    }

    // Owner / room mod / site mod / site admin.
    let allowed = ctx.user.role === "admin" || ctx.user.role === "mod";
    if (!allowed) {
      const member = (await ctx.db
        .select()
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, ctx.roomId), eq(roomMembers.userId, ctx.user.id)))
        .limit(1))[0];
      allowed = member?.role === "owner" || member?.role === "mod";
    }
    if (!allowed) {
      notice(ctx, "PERM", "Only the room owner or a mod can change NPC mode.");
      return;
    }

    await ctx.db.update(rooms).set({ npcDisabled: nextDisabled }).where(eq(rooms.id, ctx.roomId));
    // Refresh room state so clients pick up the new npcDisabled flag.
    await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
    await addSystemMessage(
      ctx.io,
      ctx.db,
      ctx.roomId,
      nextDisabled
        ? `${ctx.user.displayName} disabled /npc in this room.`
        : `${ctx.user.displayName} enabled /npc in this room.`,
    );
  },
};
