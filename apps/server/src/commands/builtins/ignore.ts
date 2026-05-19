import { and, eq, sql } from "drizzle-orm";
import { characters, ignores, users } from "../../db/schema.js";
import type { CommandContext, CommandHandler } from "../types.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/**
 * Resolve a target name (master username OR active character name) to a
 * user row. Mirrors /whisper's lookup so users can ignore by whichever name
 * they see in chat. Returns null if the name doesn't resolve to anyone.
 */
async function resolveTarget(ctx: CommandContext, name: string) {
  const lower = name.toLowerCase();
  const u = (await ctx.db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = ${lower}`)
    .limit(1))[0];
  if (u) return u;

  // Character name resolves to its owning user - regardless of whether that
  // character is currently active. Ignoring "Kaal" silences WAS no matter
  // which face they're wearing, which is the intuitive behavior.
  const c = (await ctx.db
    .select()
    .from(characters)
    .where(sql`lower(${characters.name}) = ${lower}`)
    .limit(1))[0];
  if (c && !c.deletedAt) {
    const owner = (await ctx.db
      .select()
      .from(users)
      .where(eq(users.id, c.userId))
      .limit(1))[0];
    if (owner) return owner;
  }
  return null;
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
  aliases: ["block", "mute-user"],
  usage: "/ignore [name|clear]",
  description: "Toggle ignoring a user — runs again to undo. Persists on your account across all characters.",
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
        ? `You are ignoring: ${names.join(", ")}`
        : "Your ignore list is empty. Use /ignore <name> to add someone.";
      notice(ctx, "IGNORE_LIST", body);
      return;
    }

    if (target.toLowerCase() === "clear") {
      await ctx.db.delete(ignores).where(eq(ignores.userId, ctx.user.id));
      notice(ctx, "IGNORE_CLEARED", "Ignore list cleared.");
      return;
    }

    const u = await resolveTarget(ctx, target);
    if (!u) return notice(ctx, "NO_USER", `No user named "${target}".`);
    if (u.id === ctx.user.id) return notice(ctx, "IGNORE_SELF", "You can't ignore yourself.");

    // Toggle semantics: /ignore on an already-ignored user removes the
    // block (matches /unignore). This lets the user re-use the same
    // command for both directions and matches the "click Ignore again
    // to undo" affordance on the profile modal. Both sides of the
    // ignores row key on the OOC master id (ctx.user.id is always the
    // master; resolveTarget walks character→user) so the block is
    // global across every character either side plays.
    const existing = (await ctx.db
      .select()
      .from(ignores)
      .where(and(eq(ignores.userId, ctx.user.id), eq(ignores.ignoredUserId, u.id)))
      .limit(1))[0];

    if (existing) {
      await ctx.db
        .delete(ignores)
        .where(and(eq(ignores.userId, ctx.user.id), eq(ignores.ignoredUserId, u.id)));
      notice(ctx, "UNIGNORED", `No longer ignoring ${u.username}.`);
      return;
    }

    await ctx.db
      .insert(ignores)
      .values({ userId: ctx.user.id, ignoredUserId: u.id })
      .onConflictDoNothing();

    notice(ctx, "IGNORED", `Now ignoring ${u.username}. Use /unignore ${u.username} (or /ignore ${u.username} again) to undo.`);
  },
};

/**
 * /unignore <name> - opposite of /ignore. Resolved by master username only
 * (since we stored the userId), but accepts character names too for
 * convenience (we resolve both forms).
 */
export const unignoreCommand: CommandHandler = {
  name: "unignore",
  aliases: ["unblock"],
  usage: "/unignore <name>",
  description: "Stop ignoring a user; their messages will reach you again.",
  async run(ctx) {
    const target = ctx.argsText.trim();
    if (!target) return notice(ctx, "NEED_NAME", "Usage: /unignore <username>");

    const u = await resolveTarget(ctx, target);
    if (!u) return notice(ctx, "NO_USER", `No user named "${target}".`);

    const result = await ctx.db
      .delete(ignores)
      .where(and(eq(ignores.userId, ctx.user.id), eq(ignores.ignoredUserId, u.id)));

    if (result.changes === 0) {
      notice(ctx, "NOT_IGNORED", `You weren't ignoring ${u.username}.`);
    } else {
      notice(ctx, "UNIGNORED", `No longer ignoring ${u.username}.`);
    }
  },
};
