import { and, eq } from "drizzle-orm";
import { messages } from "../../db/schema.js";
import { addMessage } from "../../realtime/broadcast.js";
import { hasPermission } from "../../auth/permissions.js";
import { tFor } from "../../i18n.js";
import type { CommandContext, CommandHandler } from "../types.js";

const SNIPPET_LEN = 80;
const REPLYABLE_KINDS = new Set(["say", "me", "ooc"]);

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

function snippet(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SNIPPET_LEN) return collapsed;
  return collapsed.slice(0, SNIPPET_LEN - 1).trimEnd() + "…";
}

/**
 * /reply <msgid> <text>
 *
 * Posts a normal "say" line that references a prior message. The client UI
 * pre-fills this command when the user clicks a message's timestamp; users
 * can also type it by hand.
 *
 * Server validates that the parent exists in the same room and is a kind
 * that's safe to reply to publicly (say/me/ooc). Whispers are intentionally
 * excluded - replying to a private message in public would leak the content
 * (or at least its existence) to a third party.
 */
export const replyCommand: CommandHandler = {
  name: "reply",
  aliases: ["re"],
  usage: "/reply <message-id> <text>",
  description:
    "Reply to a specific message. The reply renders with a small quote of the original above it. Click a message's timestamp to pre-fill this command.",
  async run(ctx) {
    if (ctx.args.length < 2) {
      notice(ctx, "REPLY_USAGE", tFor(ctx.user.locale, "commands:reply.usage"));
      return;
    }
    const targetId = ctx.args[0]!;
    const body = ctx.argsText.replace(/^\S+\s*/, "").trim();
    if (!body) {
      notice(ctx, "REPLY_EMPTY", tFor(ctx.user.locale, "commands:reply.empty"));
      return;
    }

    const parent = (await ctx.db
      .select()
      .from(messages)
      .where(and(eq(messages.id, targetId), eq(messages.roomId, ctx.roomId)))
      .limit(1))[0];
    if (!parent) {
      notice(ctx, "REPLY_NO_MSG", tFor(ctx.user.locale, "commands:reply.notAvailable"));
      return;
    }
    if (!REPLYABLE_KINDS.has(parent.kind)) {
      notice(ctx, "REPLY_BAD_KIND", tFor(ctx.user.locale, "commands:reply.badKind"));
      return;
    }
    // Soft-deleted parents (forum topics or chat lines) are not reply
    // targets, the parent's body is gone from public view and the
    // reply would look like an orphan quoting nothing. Mirrors the
    // plain-say reply gate in `dispatch.ts`.
    if (parent.deletedAt) {
      notice(ctx, "REPLY_NO_MSG", tFor(ctx.user.locale, "commands:reply.notAvailable"));
      return;
    }
    // Locked forum topics reject new replies, except holders of
    // `bypass_topic_lock` (mod + admin by seed default), who can still
    // post in the thread to leave a notice / verdict. Mirrors the
    // plain-say path in dispatch.ts.
    if (parent.lockedAt && !(await hasPermission(ctx.user, "bypass_topic_lock", ctx.db))) {
      notice(ctx, "TOPIC_LOCKED", tFor(ctx.user.locale, "commands:reply.topicLocked"));
      return;
    }

    await addMessage(ctx, {
      kind: "say",
      body,
      replyToId: parent.id,
      replyToDisplayName: parent.displayName,
      // Rich-format parents (migration 0352) snapshot their VISIBLE
      // text, never raw markup.
      replyToBodySnippet: snippet(parent.format === "html" ? (parent.bodyText ?? "") : parent.body),
    });
  },
};
