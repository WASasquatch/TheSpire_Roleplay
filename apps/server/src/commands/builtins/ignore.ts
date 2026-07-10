import { and, eq } from "drizzle-orm";
import { ignores, users } from "../../db/schema.js";
import { emitAmbiguousIdentityModal, resolveIdentityArg, type ResolvedTarget } from "../identityArg.js";
import { tFor } from "../../i18n.js";
import type { CommandContext, CommandHandler } from "../types.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/**
 * Resolve `raw` to a target user. Tokens (`@id:` / `@cid:`) win;
 * otherwise we run the NBSP-aware name lookup and surface ambiguous
 * matches via a system notice so the caller can pick the right one.
 *
 * Returns the ResolvedTarget on success. On any failure (no match,
 * ambiguous, self-targeting) emits the appropriate notice and returns
 * null, the caller short-circuits.
 *
 * NOTE: `/ignore` is keyed on the OOC master id, so we surface
 * `target.userId` regardless of whether the caller pointed at a
 * character. That preserves the "ignoring `Kaal` silences WAS no
 * matter which face they're wearing" contract, character disambig
 * just helps you specify WHICH user when names collide.
 */
async function resolveIgnoreTarget(
  ctx: CommandContext,
  raw: string,
): Promise<ResolvedTarget | null> {
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
 * /ignore <name>          - silence a user. If they're not already
 *                           ignored, this adds them; if they ARE already
 *                           ignored, /ignore toggles them back off (same
 *                           effect as /unignore). The block persists on
 *                           your OOC master account and is global across
 *                           every character either side plays: ignoring
 *                           "Kaal" silences that user whether they're
 *                           speaking as Kaal, their OOC master, or any
 *                           other character they own, and the ignore
 *                           continues to apply when YOU swap characters
 *                           too. Persists across sessions until cleared.
 * /ignore                 - list everyone you currently ignore.
 * /ignore clear           - clear your entire ignore list.
 *
 * The block is one-way and one-sided: the ignored user has no signal that
 * you've ignored them. Admins are NOT exempt - admins who want a user gone
 * for everyone should use /kick or moderation tools, not /ignore.
 */
export const ignoreCommand: CommandHandler = {
  name: "ignore",
  // NOTE: "block"/"unblock" are NO LONGER ignore aliases. /block is now a
  // separate, MUTUAL, global invisibility feature (see builtins/block.ts);
  // /ignore stays the one-way, message-only mute it always was.
  aliases: ["mute-user"],
  usage: "/ignore [name|clear]",
  description: "Toggle ignoring a user (one-way: silences their messages for you). Runs again to undo. Persists on your account across all characters. For a stronger, mutual block use /block.",
  subcommands: [
    { verb: "<name>", usage: "/ignore <name>", description: "Ignore (or, if already ignored, unignore) this user." },
    { verb: "clear", usage: "/ignore clear", description: "Clear your entire ignore list." },
  ],
  async run(ctx) {
    const target = ctx.argsText.trim();

    // No-arg: list everyone you're ignoring.
    if (!target) {
      const rows = await ctx.db
        .select({ username: users.username })
        .from(ignores)
        .innerJoin(users, eq(users.id, ignores.ignoredUserId))
        .where(eq(ignores.userId, ctx.user.id));
      const names = rows.map((r) => r.username).sort();
      const body = names.length
        ? tFor(ctx.user.locale, "commands:ignore.list", { names: names.join(", ") })
        : tFor(ctx.user.locale, "commands:ignore.listEmpty");
      notice(ctx, "IGNORE_LIST", body);
      return;
    }

    if (target.toLowerCase() === "clear") {
      await ctx.db.delete(ignores).where(eq(ignores.userId, ctx.user.id));
      notice(ctx, "IGNORE_CLEARED", tFor(ctx.user.locale, "commands:ignore.cleared"));
      return;
    }

    const resolved = await resolveIgnoreTarget(ctx, target);
    if (!resolved) return;
    if (resolved.userId === ctx.user.id) return notice(ctx, "IGNORE_SELF", tFor(ctx.user.locale, "commands:ignore.self"));

    // Toggle semantics: /ignore on an already-ignored user removes the
    // block (matches /unignore). This lets the user re-use the same
    // command for both directions and matches the "click Ignore again
    // to undo" affordance on the profile modal. Both sides of the
    // ignores row key on the OOC master id (ctx.user.id is always the
    // master; the resolver walks character→user) so the block is
    // global across every character either side plays.
    const existing = (await ctx.db
      .select()
      .from(ignores)
      .where(and(eq(ignores.userId, ctx.user.id), eq(ignores.ignoredUserId, resolved.userId)))
      .limit(1))[0];

    if (existing) {
      await ctx.db
        .delete(ignores)
        .where(and(eq(ignores.userId, ctx.user.id), eq(ignores.ignoredUserId, resolved.userId)));
      notice(ctx, "UNIGNORED", tFor(ctx.user.locale, "commands:ignore.removed", { name: resolved.masterUsername }));
      return;
    }

    await ctx.db
      .insert(ignores)
      .values({ userId: ctx.user.id, ignoredUserId: resolved.userId })
      .onConflictDoNothing();

    notice(ctx, "IGNORED", tFor(ctx.user.locale, "commands:ignore.added", { name: resolved.masterUsername }));
  },
};

/**
 * /unignore <name> - opposite of /ignore. Resolved by master username only
 * (since we stored the userId), but accepts character names too for
 * convenience (we resolve both forms).
 */
export const unignoreCommand: CommandHandler = {
  name: "unignore",
  usage: "/unignore <name>",
  description: "Stop ignoring a user; their messages will reach you again.",
  async run(ctx) {
    const target = ctx.argsText.trim();
    if (!target) return notice(ctx, "NEED_NAME", tFor(ctx.user.locale, "commands:unignore.usage"));

    const resolved = await resolveIgnoreTarget(ctx, target);
    if (!resolved) return;

    const result = await ctx.db
      .delete(ignores)
      .where(and(eq(ignores.userId, ctx.user.id), eq(ignores.ignoredUserId, resolved.userId)));

    if (result.changes === 0) {
      notice(ctx, "NOT_IGNORED", tFor(ctx.user.locale, "commands:unignore.notIgnored", { name: resolved.masterUsername }));
    } else {
      notice(ctx, "UNIGNORED", tFor(ctx.user.locale, "commands:ignore.removed", { name: resolved.masterUsername }));
    }
  },
};
