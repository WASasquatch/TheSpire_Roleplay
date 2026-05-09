import { and, eq, sql } from "drizzle-orm";
import { addSystemMessage } from "../../realtime/broadcast.js";
import { resolveDisplayName } from "../../auth/session.js";
import { users, watches } from "../../db/schema.js";
import type { CommandContext, CommandHandler } from "../types.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/** Emit a one-shot system message visible only to the caller (not broadcast). */
async function whisperToSelf(ctx: CommandContext, body: string): Promise<void> {
  // Re-uses addSystemMessage's room emit to avoid a separate channel; but we
  // want this private to the caller. Cleanest: emit directly to the caller's
  // socket as a synthetic system message, no DB write.
  ctx.socket.emit("message:new", {
    id: `watch-${Date.now()}`,
    roomId: ctx.roomId,
    userId: "system",
    characterId: null,
    displayName: "system",
    kind: "system",
    body,
    color: null,
    createdAt: Date.now(),
  });
}

/**
 * Asymmetric watch list - tell me when this user comes online. The watched
 * user can't enumerate their watchers; mutual confirmation (proper friends)
 * is a possible v2.
 *
 *   /watch <name>     - add to your list
 *   /unwatch <name>   - remove
 *   /watching         - list (delivered as system messages to just you)
 */
export const watchCommand: CommandHandler = {
  name: "watch",
  aliases: ["follow"],
  usage: "/watch <username>",
  description:
    "Get a desktop ping when this user comes online (asymmetric - they're not told you're watching).",
  async run(ctx) {
    const targetName = ctx.argsText.trim();
    if (!targetName) return notice(ctx, "WATCH_USAGE", "Usage: /watch <username>");

    const target = (await ctx.db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = ${targetName.toLowerCase()}`)
      .limit(1))[0];
    if (!target || target.disabledAt) return notice(ctx, "NO_USER", `No user named "${targetName}".`);
    if (target.id === ctx.user.id) return notice(ctx, "SELF", "Watching yourself isn't useful.");

    await ctx.db
      .insert(watches)
      .values({ watcherUserId: ctx.user.id, watchedUserId: target.id })
      .onConflictDoNothing();
    await whisperToSelf(ctx, `Watching ${target.username}. You'll be pinged when they connect.`);
  },
};

export const unwatchCommand: CommandHandler = {
  name: "unwatch",
  aliases: ["unfollow"],
  usage: "/unwatch <username>",
  description: "Remove a user from your watch list.",
  async run(ctx) {
    const targetName = ctx.argsText.trim();
    if (!targetName) return notice(ctx, "UNWATCH_USAGE", "Usage: /unwatch <username>");

    const target = (await ctx.db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = ${targetName.toLowerCase()}`)
      .limit(1))[0];
    if (!target) return notice(ctx, "NO_USER", `No user named "${targetName}".`);

    const r = await ctx.db
      .delete(watches)
      .where(and(eq(watches.watcherUserId, ctx.user.id), eq(watches.watchedUserId, target.id)));
    if (r.changes === 0) {
      return notice(ctx, "NOT_WATCHED", `${target.username} isn't on your watch list.`);
    }
    await whisperToSelf(ctx, `No longer watching ${target.username}.`);
  },
};

export const watchingCommand: CommandHandler = {
  name: "watching",
  aliases: ["watchlist", "watches"],
  usage: "/watching",
  description: "List the users on your watch list.",
  async run(ctx) {
    const rows = await ctx.db
      .select({
        watchedUserId: watches.watchedUserId,
        username: users.username,
      })
      .from(watches)
      .innerJoin(users, eq(users.id, watches.watchedUserId))
      .where(eq(watches.watcherUserId, ctx.user.id));
    if (rows.length === 0) {
      return whisperToSelf(ctx, "Watch list is empty. Use /watch <username> to add someone.");
    }
    // Resolve display names so the listing shows live identities (e.g. an
    // active character name) rather than just the master username.
    const names = await Promise.all(rows.map(async (r) => {
      const display = await resolveDisplayName(ctx.db, r.watchedUserId);
      return display === r.username ? r.username : `${r.username} (${display})`;
    }));
    return whisperToSelf(ctx, `Watching: ${names.join(", ")}`);
  },
};

// Use addSystemMessage just once to satisfy "imported but unused" in case
// another linter complains; it's part of the watch-related toolkit.
void addSystemMessage;
