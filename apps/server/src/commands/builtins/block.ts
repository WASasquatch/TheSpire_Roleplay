import { eq } from "drizzle-orm";
import { blocks, users } from "../../db/schema.js";
import { createBlock, deleteBlock, isBlockedBetween, isBlockProtected } from "../../auth/blocks.js";
import { notifyBlockChange } from "../../realtime/broadcast.js";
import { emitAmbiguousIdentityModal, resolveIdentityArg, type ResolvedTarget } from "../identityArg.js";
import { tFor } from "../../i18n.js";
import type { CommandContext, CommandHandler } from "../types.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/**
 * Resolve `raw` to a target user for block/unblock. Tokens win; bare names go
 * through the NBSP-aware lookup and surface ambiguous matches. Block is keyed
 * on the master id (like /ignore), so we return `target.userId` regardless of
 * whether the caller pointed at a character. Emits the appropriate notice and
 * returns null on failure.
 */
async function resolveBlockTarget(ctx: CommandContext, raw: string): Promise<ResolvedTarget | null> {
  const resolution = await resolveIdentityArg(ctx.db, raw);
  if (resolution.kind === "none") {
    notice(ctx, "NO_USER", tFor(ctx.user.locale, "commands:shared.noUserNamed", { name: raw }));
    return null;
  }
  if (resolution.kind === "ambiguous") {
    emitAmbiguousIdentityModal(ctx, raw, resolution.matches);
    return null;
  }
  return resolution.target;
}

/**
 * /block <name>  - GLOBAL, MUTUAL block. Stronger than /ignore: once set, you
 *                  and the target (and every character either of you plays)
 *                  become invisible to each other everywhere, chat, userlist,
 *                  whispers, DMs, friends, profiles, search. The target gets
 *                  no signal. Unlike /ignore this is NOT a toggle: use
 *                  /unblock (or Profile -> Privacy) to lift it.
 * /block         - list everyone you've blocked.
 *
 * Blocks persist on your master account across all characters and sessions.
 */
export const blockCommand: CommandHandler = {
  name: "block",
  usage: "/block [name]",
  description: "Globally + mutually block a user: you and they (and all your characters) can't see each other anywhere. Stronger than /ignore. Lift with /unblock or Profile -> Privacy.",
  subcommands: [
    { verb: "<name>", usage: "/block <name>", description: "Block this user globally and mutually." },
  ],
  async run(ctx) {
    const target = ctx.argsText.trim();

    // No-arg: list everyone you've blocked.
    if (!target) {
      const rows = await ctx.db
        .select({ username: users.username })
        .from(blocks)
        .innerJoin(users, eq(users.id, blocks.blockedUserId))
        .where(eq(blocks.blockerUserId, ctx.user.id));
      const names = rows.map((r) => r.username).sort();
      const body = names.length
        ? tFor(ctx.user.locale, "commands:block.list", { names: names.join(", ") })
        : tFor(ctx.user.locale, "commands:block.listEmpty");
      notice(ctx, "BLOCK_LIST", body);
      return;
    }

    const resolved = await resolveBlockTarget(ctx, target);
    if (!resolved) return;
    if (resolved.userId === ctx.user.id) return notice(ctx, "BLOCK_SELF", tFor(ctx.user.locale, "commands:block.self"));
    // Moderators and admins can't be blocked (by anyone, including other
    // staff), they need to stay visible for moderation.
    if (await isBlockProtected(ctx.db, resolved.userId)) {
      return notice(ctx, "BLOCK_STAFF", tFor(ctx.user.locale, "commands:block.staff", { name: resolved.masterUsername }));
    }

    const created = await createBlock(ctx.db, ctx.user.id, resolved.userId);
    if (created) await notifyBlockChange(ctx.io, ctx.db, ctx.user.id, resolved.userId, true);
    notice(
      ctx,
      created ? "BLOCKED" : "ALREADY_BLOCKED",
      created
        ? tFor(ctx.user.locale, "commands:block.blocked", { name: resolved.masterUsername })
        : tFor(ctx.user.locale, "commands:block.already", { name: resolved.masterUsername }),
    );
  },
};

/**
 * /unblock <name> - lift a block YOU created. Only the initiator's side is
 * removed; if the other party also blocked you, you stay mutually invisible
 * until they lift theirs.
 */
export const unblockCommand: CommandHandler = {
  name: "unblock",
  usage: "/unblock <name>",
  description: "Lift a block you created. Their account and characters become visible to you again (unless they've also blocked you).",
  async run(ctx) {
    const target = ctx.argsText.trim();
    if (!target) return notice(ctx, "NEED_NAME", tFor(ctx.user.locale, "commands:unblock.usage"));

    const resolved = await resolveBlockTarget(ctx, target);
    if (!resolved) return;

    const removed = await deleteBlock(ctx.db, ctx.user.id, resolved.userId);
    if (!removed) {
      notice(ctx, "NOT_BLOCKED", tFor(ctx.user.locale, "commands:unblock.notBlocked", { name: resolved.masterUsername }));
      return;
    }
    // Only repaint/notify when the pair is now fully unblocked (the other
    // direction could still be holding the block).
    const stillBlocked = await isBlockedBetween(ctx.db, ctx.user.id, resolved.userId);
    if (!stillBlocked) await notifyBlockChange(ctx.io, ctx.db, ctx.user.id, resolved.userId, false);
    notice(
      ctx,
      "UNBLOCKED",
      stillBlocked
        ? tFor(ctx.user.locale, "commands:unblock.stillBlocked", { name: resolved.masterUsername })
        : tFor(ctx.user.locale, "commands:unblock.done", { name: resolved.masterUsername }),
    );
  },
};
