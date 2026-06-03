import { and, eq, or, sql } from "drizzle-orm";
import { addSystemMessage } from "../../realtime/broadcast.js";
import { resolveDisplayName } from "../../auth/session.js";
import { characters, friends, users } from "../../db/schema.js";
import { eqIdentity, type Identity } from "../../auth/identity.js";
import { emitAmbiguousIdentityModal, resolveIdentityArg } from "../identityArg.js";
import type { CommandContext, CommandHandler } from "../types.js";

/**
 * Resolve a typed-in target (name or `@id:` / `@cid:` token) to an
 * Identity, surfacing ambiguous-name notices to the caller. Returns
 * null on miss or ambiguous (after emitting the appropriate notice),
 * so the command body can short-circuit with a bare `return`.
 *
 * Friend commands key on `Identity` (per-identity friendships), so
 * this wrapper drops the richer ResolvedTarget down to that pair —
 * the displayName/masterUsername are looked up later through
 * resolveDisplayName for the success copy.
 */
async function resolveIdentityByName(
  ctx: CommandContext,
  raw: string,
): Promise<Identity | null> {
  const resolution = await resolveIdentityArg(ctx.db, raw);
  if (resolution.kind === "none") {
    notice(ctx, "NO_USER", `No user or character named "${raw}".`);
    return null;
  }
  if (resolution.kind === "ambiguous") {
    emitAmbiguousIdentityModal(ctx, raw, resolution.matches);
    return null;
  }
  return {
    userId: resolution.target.userId,
    characterId: resolution.target.characterId,
  };
}


function meIdentity(ctx: CommandContext): Identity {
  return { userId: ctx.user.id, characterId: ctx.user.activeCharacterId };
}

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
  usage: "/friend <name>",
  description:
    "Send a friend request. The friendship is tied to whoever's active right now — if you're in-character, the request comes from that character; the other party never sees your OOC handle through this request.",
  async run(ctx) {
    const targetName = ctx.argsText.trim();
    if (!targetName) return notice(ctx, "FRIEND_USAGE", "Usage: /friend <name>");

    const target = await resolveIdentityByName(ctx, targetName);
    if (!target) return;  // resolver emitted the appropriate notice.

    const me = meIdentity(ctx);
    if (target.userId === me.userId && target.characterId === me.characterId) {
      return notice(ctx, "SELF", "Friending yourself isn't useful.");
    }

    // Idempotency over the IDENTITY PAIR. Two characters of mine can
    // each have their own friendship with the same target — only the
    // exact same identity pair (either direction) collides.
    const existing = (await ctx.db
      .select()
      .from(friends)
      .where(or(
        and(eqIdentity(friends.frienderUserId, friends.frienderCharacterId, me),
            eqIdentity(friends.friendedUserId, friends.friendedCharacterId, target)),
        and(eqIdentity(friends.frienderUserId, friends.frienderCharacterId, target),
            eqIdentity(friends.friendedUserId, friends.friendedCharacterId, me)),
      ))
      .limit(1))[0];
    if (existing) {
      if (existing.status === "accepted") {
        return whisperToSelf(ctx, `You and ${targetName} are already friends.`);
      }
      if (existing.frienderUserId === me.userId
          && (existing.frienderCharacterId ?? null) === me.characterId) {
        return whisperToSelf(ctx, `Friend request to ${targetName} is still pending — wait for them to /accept.`);
      }
      // Existing pending request from THEM to us; calling /friend on
      // them is the natural way to accept.
      await ctx.db
        .update(friends)
        .set({ status: "accepted" })
        .where(and(
          eqIdentity(friends.frienderUserId, friends.frienderCharacterId, target),
          eqIdentity(friends.friendedUserId, friends.friendedCharacterId, me),
        ));
      await whisperToSelf(ctx, `Accepted ${targetName}'s friend request.`);
      await emitFriendRequestTo(ctx, target.userId);
      return;
    }

    await ctx.db
      .insert(friends)
      .values({
        frienderUserId: me.userId,
        frienderCharacterId: me.characterId,
        friendedUserId: target.userId,
        friendedCharacterId: target.characterId,
        status: "pending",
      });
    await whisperToSelf(ctx, `Friend request sent to ${targetName}.`);
    await emitFriendRequestTo(ctx, target.userId);
  },
};

export const acceptFriendCommand: CommandHandler = {
  name: "accept",
  aliases: ["acceptfriend"],
  usage: "/accept <name>",
  description: "Accept a pending friend request from this user or character.",
  async run(ctx) {
    const targetName = ctx.argsText.trim();
    if (!targetName) return notice(ctx, "ACCEPT_USAGE", "Usage: /accept <name>");

    const target = await resolveIdentityByName(ctx, targetName);
    if (!target) return;  // resolver emitted the appropriate notice.

    const me = meIdentity(ctx);
    const r = await ctx.db
      .update(friends)
      .set({ status: "accepted" })
      .where(and(
        eqIdentity(friends.frienderUserId, friends.frienderCharacterId, target),
        eqIdentity(friends.friendedUserId, friends.friendedCharacterId, me),
        eq(friends.status, "pending"),
      ));
    if (r.changes === 0) {
      return notice(ctx, "NO_REQUEST", `No pending friend request from ${targetName}.`);
    }
    await whisperToSelf(ctx, `You and ${targetName} are now friends.`);
    // Tell the original sender so their inbox + friends-rail refresh.
    await emitFriendRequestTo(ctx, target.userId);
  },
};

export const declineFriendCommand: CommandHandler = {
  name: "decline",
  aliases: ["declinefriend", "rejectfriend"],
  usage: "/decline <name>",
  description: "Decline a pending friend request. The sender isn't notified.",
  async run(ctx) {
    const targetName = ctx.argsText.trim();
    if (!targetName) return notice(ctx, "DECLINE_USAGE", "Usage: /decline <name>");

    const target = await resolveIdentityByName(ctx, targetName);
    if (!target) return;  // resolver emitted the appropriate notice.

    const me = meIdentity(ctx);
    const r = await ctx.db
      .delete(friends)
      .where(and(
        eqIdentity(friends.frienderUserId, friends.frienderCharacterId, target),
        eqIdentity(friends.friendedUserId, friends.friendedCharacterId, me),
        eq(friends.status, "pending"),
      ));
    if (r.changes === 0) {
      return notice(ctx, "NO_REQUEST", `No pending friend request from ${targetName}.`);
    }
    await whisperToSelf(ctx, `Declined ${targetName}'s friend request.`);
  },
};

export const unfriendCommand: CommandHandler = {
  name: "unfriend",
  aliases: ["unwatch", "unfollow"],
  usage: "/unfriend <name>",
  description: "End a friendship OR cancel a pending request, in either direction. Operates on your active identity only.",
  async run(ctx) {
    const targetName = ctx.argsText.trim();
    if (!targetName) return notice(ctx, "UNFRIEND_USAGE", "Usage: /unfriend <name>");

    const target = await resolveIdentityByName(ctx, targetName);
    if (!target) return;  // resolver emitted the appropriate notice.

    const me = meIdentity(ctx);
    // Delete the row for THIS identity pair in either direction. Other
    // characters of the same user keep their own friendships with the
    // same target — only this active identity unfriends.
    const r = await ctx.db
      .delete(friends)
      .where(or(
        and(eqIdentity(friends.frienderUserId, friends.frienderCharacterId, me),
            eqIdentity(friends.friendedUserId, friends.friendedCharacterId, target)),
        and(eqIdentity(friends.frienderUserId, friends.frienderCharacterId, target),
            eqIdentity(friends.friendedUserId, friends.friendedCharacterId, me)),
      ));
    if (r.changes === 0) {
      return notice(ctx, "NOT_FRIENDED", `${targetName} isn't on your friends list or in your inbox.`);
    }
    await whisperToSelf(ctx, `Removed ${targetName} from your friends list.`);
    await emitFriendRequestTo(ctx, target.userId);
  },
};

export const friendsCommand: CommandHandler = {
  name: "friends",
  aliases: ["watching", "watchlist", "watches"],
  usage: "/friends",
  description: "List your accepted friendships for the active identity. Switch character to see that character's list.",
  async run(ctx) {
    const me = meIdentity(ctx);
    // Symmetric: list anyone with an accepted edge to MY active
    // identity (master or specific character), regardless of which
    // side originated the request.
    const rows = await ctx.db
      .select({
        otherUserId: sql<string>`CASE WHEN ${friends.frienderUserId} = ${ctx.user.id} AND ${friends.frienderCharacterId} IS ${me.characterId === null ? sql`NULL` : sql`${me.characterId}`} THEN ${friends.friendedUserId} ELSE ${friends.frienderUserId} END`,
        otherCharacterId: sql<string | null>`CASE WHEN ${friends.frienderUserId} = ${ctx.user.id} AND ${friends.frienderCharacterId} IS ${me.characterId === null ? sql`NULL` : sql`${me.characterId}`} THEN ${friends.friendedCharacterId} ELSE ${friends.frienderCharacterId} END`,
      })
      .from(friends)
      .where(and(
        or(
          eqIdentity(friends.frienderUserId, friends.frienderCharacterId, me),
          eqIdentity(friends.friendedUserId, friends.friendedCharacterId, me),
        ),
        eq(friends.status, "accepted"),
      ));
    if (rows.length === 0) {
      return whisperToSelf(ctx, "Friends list is empty for this identity. Use /friend <name> to send a request.");
    }
    // Resolve each other-side identity to a human-readable name —
    // character name if the friendship was tagged to a character,
    // master username otherwise.
    const names = await Promise.all(rows.map(async (r) => {
      if (r.otherCharacterId) {
        const c = (await ctx.db.select({ name: characters.name }).from(characters).where(eq(characters.id, r.otherCharacterId)).limit(1))[0];
        if (c) return c.name;
      }
      const u = (await ctx.db.select({ username: users.username }).from(users).where(eq(users.id, r.otherUserId)).limit(1))[0];
      return u?.username ?? "(unknown)";
    }));
    return whisperToSelf(ctx, `Friends: ${names.join(", ")}`);
  },
};

// Keep `addSystemMessage` import alive — it's part of the broadcast
// toolkit and harmless to retain even if unused locally; matches the
// posture of the previous watch.ts.
void addSystemMessage;
