import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { ChatMessage } from "@thekeep/shared";
import { characters, ignores, messages, users } from "../../db/schema.js";
import { pushTriggers } from "../../realtime/broadcast.js";
import { isBlockedBetween } from "../../auth/blocks.js";
import { isAdultUser } from "../../auth/ageGate.js";
import { isIsolatedBetween } from "../../auth/ageIsolation.js";
import { maskForMinors } from "../../realtime/minorLanguageFilter.js";
import { stripFirstToken } from "../parser.js";
import { emitAmbiguousIdentityModal, resolveIdentityArg } from "../identityArg.js";
import { tFor } from "../../i18n.js";
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
      notice(ctx, "WHISPER_USAGE", tFor(ctx.user.locale, "commands:whisper.usage"));
      return;
    }
    const targetName = args[0]!;
    // body is the original argsText with the first token (and following
    // whitespace) stripped. `stripFirstToken` is NBSP-aware so a username
    // with an Alt+0160 keeps its full name as a single token.
    const body = stripFirstToken(ctx.argsText).trim();
    if (!body) {
      notice(ctx, "WHISPER_EMPTY", tFor(ctx.user.locale, "commands:whisper.empty"));
      return;
    }

    // Resolve recipient via the shared token-or-name resolver. Tokens
    // (`@id:<userId>` / `@cid:<characterId>`) pin a specific identity;
    // bare names go through NBSP-aware lookup against both tables and
    // can come back ambiguous when more than one identity shares the
    // typed name. Ambiguous goes to a system notice listing the
    // tokens so the user can re-run with the right one.
    const resolution = await resolveIdentityArg(ctx.db, targetName);
    if (resolution.kind === "none") {
      notice(ctx, "WHISPER_NO_USER", tFor(ctx.user.locale, "commands:shared.noUserNamed", { name: targetName }));
      return;
    }
    if (resolution.kind === "ambiguous") {
      emitAmbiguousIdentityModal(ctx, targetName, resolution.matches);
      return;
    }
    const targetUserId = resolution.target.userId;
    if (targetUserId === ctx.user.id) {
      notice(ctx, "WHISPER_SELF", tFor(ctx.user.locale, "commands:whisper.self"));
      return;
    }
    // A block hides the target entirely (mutual): behave as if no such user
    // exists, never reveal the block to either side.
    if (await isBlockedBetween(ctx.db, ctx.user.id, targetUserId)) {
      notice(ctx, "WHISPER_NO_USER", tFor(ctx.user.locale, "commands:shared.noUserNamed", { name: targetName }));
      return;
    }
    // Fetch the full target row for downstream needs (activeCharacterId
    // to resolve display name). One indexed lookup; cheap.
    const target = (await ctx.db
      .select()
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1))[0];
    if (!target) {
      // Resolver said unique but the row vanished between resolve and
      // fetch, exceedingly rare race (admin disable mid-command).
      notice(ctx, "WHISPER_NO_USER", tFor(ctx.user.locale, "commands:shared.noUserNamed", { name: targetName }));
      return;
    }
    // Minor isolation (age plan, Phase 5): same posture as a block — the
    // pair behave as if the other doesn't exist, so the refusal is the
    // exact "no such user" line, never a hint that isolation is on. Both
    // rows are already in hand (session + the fetch above), so the check
    // is pure in-memory.
    if (isIsolatedBetween(ctx.user, target)) {
      notice(ctx, "WHISPER_NO_USER", tFor(ctx.user.locale, "commands:shared.noUserNamed", { name: targetName }));
      return;
    }

    // Use the identity the caller actually addressed. `resolution.target.displayName`
    // is the character name when the caller passed `@cid:` (or typed a character
    // name) and the master username when they passed `@id:` (or typed a master
    // handle). Falling back to the target's *current* active character, the
    // previous behavior here, silently rewrote a click on the OOC handle as a
    // whisper to whichever character that user happened to be voicing right
    // now, which is exactly the leak the identity-token system was added to
    // prevent. The actual message delivery still routes by `target.id`
    // regardless of which identity name decorates the line.
    const targetDisplayName = resolution.target.displayName;

    // Effective sender color. When in-character, prefer the active
    // character's own chat_color so a whisper from Char A renders in
    // Char A's red even though `ctx.user.chatColor` (the master's
    // snapshot) is null or some other OOC color. Mirrors the
    // character-first/master-fallback logic addMessage uses for room
    // messages, so whisper and say lines from the same character agree
    // on color.
    let senderColor: string | null = ctx.user.chatColor;
    if (ctx.user.activeCharacterId) {
      const cc = (await ctx.db
        .select({ chatColor: characters.chatColor })
        .from(characters)
        .where(eq(characters.id, ctx.user.activeCharacterId))
        .limit(1))[0];
      senderColor = cc?.chatColor ?? ctx.user.chatColor;
    }

    const id = nanoid();
    const now = new Date();
    // Per-identity recipient pin: when the resolver matched a character
    // (either via `@cid:` token or character-name lookup), we record
    // that character id so a click on the recipient name in chat can
    // build the matching `@cid:` token on the continuation /whisper.
    // Master / OOC-addressed whispers store null here and the click
    // path uses `@id:<userId>`. See migration 0189 for the rationale.
    const targetCharacterId = resolution.target.characterId;
    await ctx.db.insert(messages).values({
      id,
      roomId: ctx.roomId,
      userId: ctx.user.id,
      characterId: ctx.user.activeCharacterId,
      displayName: ctx.user.displayName,
      kind: "whisper",
      body,
      toUserId: target.id,
      toCharacterId: targetCharacterId,
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
      ...(targetCharacterId ? { toCharacterId: targetCharacterId } : {}),
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
    // the sender OR the recipient. Each socket gets the message stamped
    // with whichever room THAT tab is currently viewing, so the line
    // lands in the chat view the user is looking at rather than a bucket
    // for the sender's room (which the recipient may not be in at all).
    // The DB row keeps the sender's room as its canonical home; this
    // per-socket rewrite is purely for live rendering. Scrollback in
    // every room overlays party-to-me whispers via sendRoomBacklogTo /
    // GET /rooms/:id/messages.
    //
    // Minor language filter (age plan Phase 7, plan_ext.md §J): a minor
    // PARTY to the whisper — recipient, or the sender's own echo — reads
    // it masked; an adult party reads the original. Both parties' rows are
    // in hand (session + target fetch), so this is decided per side with
    // ONE mask compute when any side is a minor, and zero work when both
    // are adults. The stored row keeps what the author wrote.
    const senderIsMinor = !ctx.user.isAdult;
    const targetIsMinor = !isAdultUser(target);
    const masked = senderIsMinor || targetIsMinor ? maskForMinors(body) : null;
    const sockets = await ctx.io.fetchSockets();
    for (const s of sockets) {
      const uid = (s.data as { userId?: string }).userId;
      const tabRoom = (s.data as { roomId?: string }).roomId ?? ctx.roomId;
      if (uid === ctx.user.id) {
        s.emit("message:new", {
          ...out,
          roomId: tabRoom,
          ...(masked !== null && senderIsMinor ? { body: masked } : {}),
        });
      } else if (!blocked && uid === target.id) {
        s.emit("message:new", {
          ...out,
          roomId: tabRoom,
          ...(masked !== null && targetIsMinor ? { body: masked } : {}),
        });
      }
    }
    if (blocked) return;

    // Offline-recipient push. pushTriggers internally checks userIsOnline
    // and skips when the recipient is connected, so calling unconditionally
    // is correct. Without this, whisper push notifications (Phase 4) never
    // fire, whispers don't route through addMessage, so the in-line
    // pushTriggers call there doesn't see them.
    void pushTriggers(ctx.io, ctx.db, out, ctx.user, "whisper");
  },
};
