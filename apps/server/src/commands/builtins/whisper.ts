import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { ChatMessage } from "@thekeep/shared";
import { ignores, messages, users } from "../../db/schema.js";
import { pushTriggers } from "../../realtime/broadcast.js";
import { stripFirstToken } from "../parser.js";
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
  description:
    "Send a private 1:1 message. The recipient is resolved by master username OR their currently-active character name. Whispers are persisted for sender and recipient scrollback only - they're never visible to admins or other users.",
  subcommands: [
    {
      verb: "<name> <text>",
      usage: "/whisper Alice are you free?",
      description: "Send a private message. Use a master username (always works) or a character name (only if they're currently active as that character).",
    },
  ],
  async run(ctx) {
    const args = ctx.args;
    if (args.length < 2) {
      notice(ctx, "WHISPER_USAGE", "Usage: /whisper <username> <text>");
      return;
    }
    const targetName = args[0]!;
    // body is the original argsText with the first token (and following
    // whitespace) stripped. `stripFirstToken` is NBSP-aware so a username
    // with an Alt+0160 keeps its full name as a single token.
    const body = stripFirstToken(ctx.argsText).trim();
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

    // Effective sender color. When in-character, prefer the active
    // character's own chat_color so a whisper from Char A renders in
    // Char A's red even though `ctx.user.chatColor` (the master's
    // snapshot) is null or some other OOC color. Mirrors the
    // character-first/master-fallback logic addMessage uses for room
    // messages, so whisper and say lines from the same character agree
    // on color.
    let senderColor: string | null = ctx.user.chatColor;
    if (ctx.user.activeCharacterId) {
      const { characters } = await import("../../db/schema.js");
      const cc = (await ctx.db
        .select({ chatColor: characters.chatColor })
        .from(characters)
        .where(eq(characters.id, ctx.user.activeCharacterId))
        .limit(1))[0];
      senderColor = cc?.chatColor ?? ctx.user.chatColor;
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
      color: senderColor,
    });

    const out: ChatMessage = {
      id,
      roomId: ctx.roomId,
      userId: ctx.user.id,
      characterId: ctx.user.activeCharacterId,
      displayName: ctx.user.displayName,
      kind: "whisper",
      body,
      color: senderColor,
      createdAt: +now,
      toUserId: target.id,
      toDisplayName: targetDisplayName,
    };

    // Honor /ignore: if the recipient has the sender on their ignore list,
    // silently drop the delivery to them. The sender still sees their own
    // line - we don't tell them they were ignored (that signal is the whole
    // point of one-sided ignores).
    const blocked = (await ctx.db
      .select()
      .from(ignores)
      .where(and(eq(ignores.userId, target.id), eq(ignores.ignoredUserId, ctx.user.id)))
      .limit(1))[0];

    // One pass over all sockets: emit to every socket belonging to either
    // the sender OR the recipient. Previously the sender path only hit
    // `ctx.socket` (the one tab that ran the command), so a user with
    // the chat open on their phone and a tab on their desktop would
    // miss the whisper on whichever surface didn't issue the send.
    // Whispers feel like DMs to the user — they should appear on every
    // device they're signed in on, both sides. The client dedupes by id
    // so the duplicate (when sender == recipient, which can't happen
    // here because /whisper rejects self-whisper above) wouldn't cause
    // a double-render anyway.
    const sockets = await ctx.io.fetchSockets();
    for (const s of sockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (uid === ctx.user.id) {
        s.emit("message:new", out);
      } else if (!blocked && uid === target.id) {
        s.emit("message:new", out);
      }
    }
    if (blocked) return;

    // Offline-recipient push. pushTriggers internally checks userIsOnline
    // and skips when the recipient is connected, so calling unconditionally
    // is correct. Without this, whisper push notifications (Phase 4) never
    // fire — whispers don't route through addMessage, so the in-line
    // pushTriggers call there doesn't see them.
    void pushTriggers(ctx.io, ctx.db, out, ctx.user, "whisper");
  },
};
