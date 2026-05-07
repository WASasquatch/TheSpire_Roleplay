import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { ChatMessage } from "@thekeep/shared";
import { ignores, messages, users } from "../../db/schema.js";
import type { CommandContext, CommandHandler } from "../types.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/**
 * /whisper <name> <text>      - send a private 1:1 message
 * Aliases: /wh /to /msg /message /pm /w
 *
 * The message is persisted (so users can scroll back through their own
 * whispers) but only emitted to the sender and recipient sockets - never to
 * the room. Recipient is resolved by master username OR by their currently
 * active character name.
 */
export const whisperCommand: CommandHandler = {
  name: "whisper",
  aliases: ["wh", "w", "to", "msg", "message", "pm"],
  usage: "/whisper <name> <text>",
  description: "Send a private message to one user.",
  async run(ctx) {
    const args = ctx.args;
    if (args.length < 2) {
      notice(ctx, "WHISPER_USAGE", "Usage: /whisper <username> <text>");
      return;
    }
    const targetName = args[0]!;
    // body is the original argsText with the first token (and following whitespace) stripped
    const body = ctx.argsText.replace(/^\S+\s*/, "").trim();
    if (!body) {
      notice(ctx, "WHISPER_EMPTY", "Whisper body is empty.");
      return;
    }

    // Resolve recipient - master username first, then active character name.
    const targetLower = targetName.toLowerCase();
    let target = (await ctx.db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = ${targetLower}`)
      .limit(1))[0];

    if (!target) {
      // Try character name → owning user (only if that char is currently active).
      const { characters } = await import("../../db/schema.js");
      const c = (await ctx.db
        .select()
        .from(characters)
        .where(sql`lower(${characters.name}) = ${targetLower}`)
        .limit(1))[0];
      if (c && !c.deletedAt) {
        const owner = (await ctx.db
          .select()
          .from(users)
          .where(eq(users.id, c.userId))
          .limit(1))[0];
        if (owner && owner.activeCharacterId === c.id) target = owner;
      }
    }

    if (!target) {
      notice(ctx, "WHISPER_NO_USER", `No user named "${targetName}".`);
      return;
    }
    if (target.id === ctx.user.id) {
      notice(ctx, "WHISPER_SELF", "Whispering yourself isn't useful.");
      return;
    }

    // Resolve target's display name - prefer their active character name.
    let targetDisplayName = target.username;
    if (target.activeCharacterId) {
      const { characters } = await import("../../db/schema.js");
      const c = (await ctx.db
        .select()
        .from(characters)
        .where(eq(characters.id, target.activeCharacterId))
        .limit(1))[0];
      if (c && !c.deletedAt) targetDisplayName = c.name;
    }

    const id = nanoid();
    const now = new Date();
    await ctx.db.insert(messages).values({
      id,
      roomId: ctx.roomId,
      userId: ctx.user.id,
      characterId: ctx.user.activeCharacterId,
      displayName: ctx.user.displayName,
      kind: "whisper",
      body,
      toUserId: target.id,
      toDisplayName: targetDisplayName,
      color: ctx.user.chatColor,
    });

    const out: ChatMessage = {
      id,
      roomId: ctx.roomId,
      userId: ctx.user.id,
      characterId: ctx.user.activeCharacterId,
      displayName: ctx.user.displayName,
      kind: "whisper",
      body,
      color: ctx.user.chatColor,
      createdAt: +now,
      toUserId: target.id,
      toDisplayName: targetDisplayName,
    };

    // Emit to sender (so they see what they sent) and to every socket of the
    // recipient (they may have multiple tabs open). NOT to the room at large.
    ctx.socket.emit("message:new", out);

    // Honor /ignore: if the recipient has the sender on their ignore list,
    // silently drop the delivery to them. The sender still sees their own
    // line - we don't tell them they were ignored (that signal is the whole
    // point of one-sided ignores).
    const blocked = (await ctx.db
      .select()
      .from(ignores)
      .where(and(eq(ignores.userId, target.id), eq(ignores.ignoredUserId, ctx.user.id)))
      .limit(1))[0];
    if (blocked) return;

    const sockets = await ctx.io.fetchSockets();
    for (const s of sockets) {
      if ((s.data as { userId?: string }).userId === target.id) {
        s.emit("message:new", out);
      }
    }
  },
};
