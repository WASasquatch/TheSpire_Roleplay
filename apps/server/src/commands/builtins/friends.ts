import { and, eq, or, sql } from "drizzle-orm";
import { addSystemMessage } from "../../realtime/broadcast.js";
import { resolveDisplayName } from "../../auth/session.js";
import { friends, users } from "../../db/schema.js";
import type { CommandContext, CommandHandler } from "../types.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/** Emit a one-shot system message visible only to the caller (not broadcast). */
async function whisperToSelf(ctx: CommandContext, body: string): Promise<void> {
  // Re-uses the message:new event channel; not persisted to DB. addSystemMessage
  // is room-wide, which is the wrong scope here — friend-list output is
  // private to the caller.
  ctx.socket.emit("message:new", {
    id: `friend-${Date.now()}`,
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
 * Notify a target user's live sockets that they've received a new
 * friend request. The actual `friend:request` socket event is wired
 * via dynamic import to dodge a circular dependency with broadcast.ts.
 */
async function emitFriendRequestTo(
  ctx: CommandContext,
  targetUserId: string,
): Promise<void> {
  const sockets = await ctx.io.fetchSockets();
  for (const s of sockets) {
    const uid = (s.data as { userId?: string }).userId;
    if (uid === targetUserId) {
      s.emit("friend:request", {
        frienderUserId: ctx.user.id,
        frienderUsername: ctx.user.username,
        frienderDisplayName: ctx.user.displayName,
      });
    }
  }
}

/**
 * Symmetric friendship. `/friend` now sends a friend REQUEST — the
 * row is created with `status='pending'`, the target gets a `friend:
 * request` socket event, and the friendship becomes effective only
 * after the target runs `/accept <username>`. `/decline <username>`
 * deletes a pending request from a given sender; `/unfriend` removes
 * an accepted friendship from either side.
 *
 *   /friend alice            → pending request, alice notified
 *   alice runs /accept WAS   → row flips to accepted; both lists update
 *   alice runs /decline WAS  → row deleted; WAS never re-notified
 *   /unfriend alice          → removes accepted friendship (either side)
 *
 * Aliases: `/watch`, `/unwatch`, `/watching` still resolve to /friend,
 * /unfriend, /friends respectively, so existing tutorials + muscle
 * memory keep working. The asymmetric-watch semantics are gone — a
 * pre-existing /watch row was grandfathered to `status='accepted'` by
 * the 0051 migration.
 */
export const friendCommand: CommandHandler = {
  name: "friend",
  aliases: ["watch", "follow"],
  usage: "/friend <username>",
  description:
    "Send a friend request. They'll see it in their inbox and can /accept or /decline. Once accepted you'll both appear on each other's friends lists.",
  async run(ctx) {
    const targetName = ctx.argsText.trim();
    if (!targetName) return notice(ctx, "FRIEND_USAGE", "Usage: /friend <username>");

    const target = (await ctx.db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = ${targetName.toLowerCase()}`)
      .limit(1))[0];
    if (!target || target.disabledAt) return notice(ctx, "NO_USER", `No user named "${targetName}".`);
    if (target.id === ctx.user.id) return notice(ctx, "SELF", "Friending yourself isn't useful.");

    // Idempotency: if there's already an accepted friendship in either
    // direction, just confirm. If there's a pending request from THIS
    // user to the target, also a no-op. If the target previously sent
    // US a request that we never accepted, calling /friend on them
    // counts as accepting (mutual intent — same shape as Facebook).
    const existing = (await ctx.db
      .select()
      .from(friends)
      .where(or(
        and(eq(friends.frienderUserId, ctx.user.id), eq(friends.friendedUserId, target.id)),
        and(eq(friends.frienderUserId, target.id), eq(friends.friendedUserId, ctx.user.id)),
      ))
      .limit(1))[0];
    if (existing) {
      if (existing.status === "accepted") {
        return whisperToSelf(ctx, `You and ${target.username} are already friends.`);
      }
      if (existing.frienderUserId === ctx.user.id) {
        return whisperToSelf(ctx, `Friend request to ${target.username} is still pending — wait for them to /accept.`);
      }
      // Existing pending request from THEM to us; calling /friend on
      // them is the natural way to accept.
      await ctx.db
        .update(friends)
        .set({ status: "accepted" })
        .where(and(eq(friends.frienderUserId, target.id), eq(friends.friendedUserId, ctx.user.id)));
      await whisperToSelf(ctx, `Accepted ${target.username}'s friend request.`);
      await emitFriendRequestTo(ctx, target.id);
      return;
    }

    await ctx.db
      .insert(friends)
      .values({ frienderUserId: ctx.user.id, friendedUserId: target.id, status: "pending" });
    await whisperToSelf(ctx, `Friend request sent to ${target.username}.`);
    await emitFriendRequestTo(ctx, target.id);
  },
};

export const acceptFriendCommand: CommandHandler = {
  name: "accept",
  aliases: ["acceptfriend"],
  usage: "/accept <username>",
  description: "Accept a pending friend request from this user.",
  async run(ctx) {
    const targetName = ctx.argsText.trim();
    if (!targetName) return notice(ctx, "ACCEPT_USAGE", "Usage: /accept <username>");

    const target = (await ctx.db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = ${targetName.toLowerCase()}`)
      .limit(1))[0];
    if (!target) return notice(ctx, "NO_USER", `No user named "${targetName}".`);

    const r = await ctx.db
      .update(friends)
      .set({ status: "accepted" })
      .where(and(
        eq(friends.frienderUserId, target.id),
        eq(friends.friendedUserId, ctx.user.id),
        eq(friends.status, "pending"),
      ));
    if (r.changes === 0) {
      return notice(ctx, "NO_REQUEST", `No pending friend request from ${target.username}.`);
    }
    await whisperToSelf(ctx, `You and ${target.username} are now friends.`);
    // Tell the original sender so their inbox + friends-rail refresh.
    await emitFriendRequestTo(ctx, target.id);
  },
};

export const declineFriendCommand: CommandHandler = {
  name: "decline",
  aliases: ["declinefriend", "rejectfriend"],
  usage: "/decline <username>",
  description: "Decline a pending friend request. The sender isn't notified.",
  async run(ctx) {
    const targetName = ctx.argsText.trim();
    if (!targetName) return notice(ctx, "DECLINE_USAGE", "Usage: /decline <username>");

    const target = (await ctx.db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = ${targetName.toLowerCase()}`)
      .limit(1))[0];
    if (!target) return notice(ctx, "NO_USER", `No user named "${targetName}".`);

    const r = await ctx.db
      .delete(friends)
      .where(and(
        eq(friends.frienderUserId, target.id),
        eq(friends.friendedUserId, ctx.user.id),
        eq(friends.status, "pending"),
      ));
    if (r.changes === 0) {
      return notice(ctx, "NO_REQUEST", `No pending friend request from ${target.username}.`);
    }
    await whisperToSelf(ctx, `Declined ${target.username}'s friend request.`);
  },
};

export const unfriendCommand: CommandHandler = {
  name: "unfriend",
  aliases: ["unwatch", "unfollow"],
  usage: "/unfriend <username>",
  description: "End a friendship OR cancel a pending request, in either direction.",
  async run(ctx) {
    const targetName = ctx.argsText.trim();
    if (!targetName) return notice(ctx, "UNFRIEND_USAGE", "Usage: /unfriend <username>");

    const target = (await ctx.db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = ${targetName.toLowerCase()}`)
      .limit(1))[0];
    if (!target) return notice(ctx, "NO_USER", `No user named "${targetName}".`);

    // Delete any row in either direction. Covers all three states:
    //   - accepted friendship: row(me→them) or row(them→me)
    //   - pending request I sent: row(me→them, pending)
    //   - pending request they sent: row(them→me, pending) — same as decline
    const r = await ctx.db
      .delete(friends)
      .where(or(
        and(eq(friends.frienderUserId, ctx.user.id), eq(friends.friendedUserId, target.id)),
        and(eq(friends.frienderUserId, target.id), eq(friends.friendedUserId, ctx.user.id)),
      ));
    if (r.changes === 0) {
      return notice(ctx, "NOT_FRIENDED", `${target.username} isn't on your friends list or in your inbox.`);
    }
    await whisperToSelf(ctx, `Removed ${target.username} from your friends list.`);
    // Refresh the other party's inbox / list — same event, different cause.
    await emitFriendRequestTo(ctx, target.id);
  },
};

export const friendsCommand: CommandHandler = {
  name: "friends",
  aliases: ["watching", "watchlist", "watches"],
  usage: "/friends",
  description: "List your accepted friendships (mutual).",
  async run(ctx) {
    // Symmetric: list anyone with an accepted edge to me, regardless
    // of which side originated the request.
    const rows = await ctx.db
      .select({
        otherUserId: sql<string>`CASE WHEN ${friends.frienderUserId} = ${ctx.user.id} THEN ${friends.friendedUserId} ELSE ${friends.frienderUserId} END`,
        username: users.username,
      })
      .from(friends)
      .innerJoin(
        users,
        sql`${users.id} = CASE WHEN ${friends.frienderUserId} = ${ctx.user.id} THEN ${friends.friendedUserId} ELSE ${friends.frienderUserId} END`,
      )
      .where(and(
        or(eq(friends.frienderUserId, ctx.user.id), eq(friends.friendedUserId, ctx.user.id)),
        eq(friends.status, "accepted"),
      ));
    if (rows.length === 0) {
      return whisperToSelf(ctx, "Friends list is empty. Use /friend <username> to send a request.");
    }
    const names = await Promise.all(rows.map(async (r) => {
      const display = await resolveDisplayName(ctx.db, r.otherUserId);
      return display === r.username ? r.username : `${r.username} (${display})`;
    }));
    return whisperToSelf(ctx, `Friends: ${names.join(", ")}`);
  },
};

// Keep `addSystemMessage` import alive — it's part of the broadcast
// toolkit and harmless to retain even if unused locally; matches the
// posture of the previous watch.ts.
void addSystemMessage;
