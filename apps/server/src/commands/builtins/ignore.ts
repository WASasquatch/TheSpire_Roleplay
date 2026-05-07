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
 * /ignore <name>          - silence a user; their say/me/ooc/roll/whisper
 *                           lines stop reaching you in real time and are
 *                           filtered out of room backlog you fetch.
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
  description: "Hide messages from a specific user. Use /unignore to undo, or /ignore (no args) to list.",
  subcommands: [
    { verb: "<name>", usage: "/ignore <name>", description: "Stop seeing messages from this user." },
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

    await ctx.db
      .insert(ignores)
      .values({ userId: ctx.user.id, ignoredUserId: u.id })
      .onConflictDoNothing();

    notice(ctx, "IGNORED", `Now ignoring ${u.username}. Use /unignore ${u.username} to undo.`);
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
