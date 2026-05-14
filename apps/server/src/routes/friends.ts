import type { FastifyInstance } from "fastify";
import type { Server as IoServer } from "socket.io";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import { characters, friends, users } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "./auth.js";
import { characterIdFromQuery, eqIdentity, ownsCharacter, type Identity } from "../auth/identity.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

export interface FriendListEntry {
  userId: string;
  username: string;
  /** Active character name if the friend is currently in-character, else master username. */
  displayName: string;
  avatarUrl: string | null;
  online: boolean;
}

export interface FriendRequestEntry {
  /** The user who SENT the request — the one whose pending row points at me. */
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  createdAt: number;
}

/**
 * `/me/friends` and `/me/friend-requests` — the data backing the
 * unified Messages modal's left pane.
 *
 * Symmetric friendship semantics (since migration 0051):
 *   - A row exists in `friends` for each directed edge ever created.
 *   - `status='accepted'` rows are MUTUAL — both parties see the other
 *     in their friends list regardless of which side originated.
 *   - `status='pending'` rows are one-way pending requests; they
 *     surface only in the FRIENDED user's `/me/friend-requests`
 *     inbox until the friended user runs `/accept` (or `/decline`).
 *
 * Implementation notes:
 *   - `/me/friends` returns the OTHER user for every accepted edge
 *     touching me, in either direction. We `CASE WHEN` the columns
 *     so the join target depends on which side I'm on.
 *   - `/me/friend-requests` is one-direction-only: rows where I'm the
 *     friended party and status is pending. The friender's side gets
 *     no inbox entry — they're the one who sent it.
 *   - Online state is computed once per request via a single socket-
 *     list scan + Set lookup, so the per-row cost is constant.
 */
export async function registerFriendsRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  app.get<{ Querystring: { characterId?: string } }>("/me/friends", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    // Friends are keyed per-identity. The client passes `?characterId=`
    // when the active tab is in-character; missing/empty means OOC.
    // We verify ownership server-side so a user can't read another
    // player's character inbox by guessing the id.
    const charId = characterIdFromQuery(req.query.characterId);
    if (charId && !(await ownsCharacter(db, me.id, charId))) {
      reply.code(403); return { error: "not your character" };
    }
    const meIdentity: Identity = { userId: me.id, characterId: charId };

    // Symmetric pull: every accepted edge where I (this identity) am
    // on either side, plus the OTHER side's identity (so we can
    // resolve their display name as the character that initiated the
    // friendship, not whatever they're currently playing).
    const rows = await db
      .select({
        frienderUserId: friends.frienderUserId,
        frienderCharacterId: friends.frienderCharacterId,
        friendedUserId: friends.friendedUserId,
        friendedCharacterId: friends.friendedCharacterId,
      })
      .from(friends)
      .where(and(
        or(
          eqIdentity(friends.frienderUserId, friends.frienderCharacterId, meIdentity),
          eqIdentity(friends.friendedUserId, friends.friendedCharacterId, meIdentity),
        ),
        eq(friends.status, "accepted"),
      ));

    // Resolve each other-side identity to a display name + avatar.
    // We need both the user row (for username + master avatar) and
    // optionally the specific character row (for character name +
    // avatar when the friendship was tagged to a character).
    const otherIdentities = rows.map((r) => {
      const iAmFriender = r.frienderUserId === me.id
        && (r.frienderCharacterId ?? null) === charId;
      return iAmFriender
        ? { userId: r.friendedUserId, characterId: r.friendedCharacterId ?? null }
        : { userId: r.frienderUserId, characterId: r.frienderCharacterId ?? null };
    });

    const otherUserIds = [...new Set(otherIdentities.map((o) => o.userId))];
    const userRows = otherUserIds.length
      ? await db.select().from(users).where(sql`${users.id} IN (${sql.join(otherUserIds.map((u) => sql`${u}`), sql`, `)})`)
      : [];
    const userById = new Map(userRows.map((u) => [u.id, u]));

    const otherCharIds = otherIdentities.map((o) => o.characterId).filter((c): c is string => !!c);
    const charRows = otherCharIds.length
      ? await db.select().from(characters).where(sql`${characters.id} IN (${sql.join(otherCharIds.map((c) => sql`${c}`), sql`, `)})`)
      : [];
    const charById = new Map(charRows.map((c) => [c.id, c]));

    const allSockets = await io.fetchSockets();
    const online = new Set<string>();
    for (const s of allSockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (uid) online.add(uid);
    }

    const entries: FriendListEntry[] = otherIdentities.map((o) => {
      const u = userById.get(o.userId);
      const c = o.characterId ? charById.get(o.characterId) : null;
      const displayName = c?.name ?? u?.username ?? "(unknown)";
      const avatarUrl = c?.avatarUrl ?? u?.avatarUrl ?? null;
      return {
        userId: o.userId,
        username: u?.username ?? "(unknown)",
        displayName,
        avatarUrl,
        online: online.has(o.userId),
      };
    });

    entries.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });

    return { friends: entries };
  });

  /**
   * Send a friend request (or auto-accept if the target had already
   * asked you). Mirrors the `/friend <name>` slash-command logic in
   * commands/builtins/friends.ts but returns a structured success /
   * error response so the Messages modal can show inline confirmation
   * — the slash-command path emits its results as room system
   * messages, which the modal can't easily surface.
   *
   * Response shape:
   *   201 { ok: true, status: "sent" | "accepted" | "already_friends" | "already_pending" }
   *   404 { error: "no_user" }            — username doesn't exist or disabled
   *   400 { error: "self" }               — friending yourself is silly
   *   400 { error: "username required" }  — body empty
   */
  app.post<{ Body: { username?: string; characterId?: string } }>("/me/friend-requests", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const username = (req.body?.username ?? "").trim();
    if (!username) { reply.code(400); return { error: "username required" }; }
    // Friender identity: my active character (or master if absent).
    const myCharId = characterIdFromQuery(req.body?.characterId);
    if (myCharId && !(await ownsCharacter(db, me.id, myCharId))) {
      reply.code(403); return { error: "not your character" };
    }
    const meIdentity: Identity = { userId: me.id, characterId: myCharId };

    // Target identity: try master username first, then character name.
    // Either resolution gives us a (userId, characterId|null) pair to
    // pin the friendship to.
    let targetIdentity: Identity | null = null;
    let targetDisplay: string = username;
    const masterRow = (await db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = ${username.toLowerCase()}`)
      .limit(1))[0];
    if (masterRow && !masterRow.disabledAt) {
      targetIdentity = { userId: masterRow.id, characterId: null };
      targetDisplay = masterRow.username;
    } else {
      const charRow = (await db
        .select()
        .from(characters)
        .where(sql`lower(${characters.name}) = ${username.toLowerCase()}`)
        .limit(1))[0];
      if (charRow && !charRow.deletedAt) {
        targetIdentity = { userId: charRow.userId, characterId: charRow.id };
        targetDisplay = charRow.name;
      }
    }
    if (!targetIdentity) { reply.code(404); return { error: "no_user" }; }
    if (targetIdentity.userId === me.id && targetIdentity.characterId === myCharId) {
      reply.code(400); return { error: "self" };
    }

    // Idempotency over the identity pair, in either direction.
    const existing = (await db
      .select()
      .from(friends)
      .where(or(
        and(
          eqIdentity(friends.frienderUserId, friends.frienderCharacterId, meIdentity),
          eqIdentity(friends.friendedUserId, friends.friendedCharacterId, targetIdentity),
        ),
        and(
          eqIdentity(friends.frienderUserId, friends.frienderCharacterId, targetIdentity),
          eqIdentity(friends.friendedUserId, friends.friendedCharacterId, meIdentity),
        ),
      ))
      .limit(1))[0];

    const targetUserId = targetIdentity.userId;
    const meId = me.id;
    const meUsername = me.username;
    async function notifyTarget() {
      const sockets = await io.fetchSockets();
      for (const s of sockets) {
        const uid = (s.data as { userId?: string }).userId;
        if (uid !== targetUserId) continue;
        s.emit("friend:request", {
          frienderUserId: meId,
          frienderUsername: meUsername,
          frienderDisplayName: meUsername,
        });
      }
    }

    if (existing) {
      if (existing.status === "accepted") {
        reply.code(200);
        return { ok: true, status: "already_friends" as const, username: targetDisplay };
      }
      const meIsFriender = existing.frienderUserId === me.id
        && (existing.frienderCharacterId ?? null) === myCharId;
      if (meIsFriender) {
        reply.code(200);
        return { ok: true, status: "already_pending" as const, username: targetDisplay };
      }
      // Their pending request to ME flips to accepted (mutual intent).
      await db
        .update(friends)
        .set({ status: "accepted" })
        .where(and(
          eqIdentity(friends.frienderUserId, friends.frienderCharacterId, targetIdentity),
          eqIdentity(friends.friendedUserId, friends.friendedCharacterId, meIdentity),
        ));
      await notifyTarget();
      reply.code(200);
      return { ok: true, status: "accepted" as const, username: targetDisplay };
    }

    await db
      .insert(friends)
      .values({
        frienderUserId: meIdentity.userId,
        frienderCharacterId: meIdentity.characterId,
        friendedUserId: targetIdentity.userId,
        friendedCharacterId: targetIdentity.characterId,
        status: "pending",
      });
    await notifyTarget();
    reply.code(201);
    return { ok: true, status: "sent" as const, username: targetDisplay };
  });

  app.get<{ Querystring: { characterId?: string } }>("/me/friend-requests", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    // Friend requests are per-identity too. The active tab's character
    // id determines which inbox we're reading; missing = OOC.
    const charId = characterIdFromQuery(req.query.characterId);
    if (charId && !(await ownsCharacter(db, me.id, charId))) {
      reply.code(403); return { error: "not your character" };
    }
    const meIdentity: Identity = { userId: me.id, characterId: charId };

    // Pending rows where I (this identity) am the friended side.
    // Surface the FRIENDER's identity — the user only ever sees the
    // character that sent the request, not the master handle behind it.
    const rows = await db
      .select({
        frienderUserId: friends.frienderUserId,
        frienderCharacterId: friends.frienderCharacterId,
        createdAt: friends.createdAt,
      })
      .from(friends)
      .where(and(
        eqIdentity(friends.friendedUserId, friends.friendedCharacterId, meIdentity),
        eq(friends.status, "pending"),
      ));

    const otherUserIds = [...new Set(rows.map((r) => r.frienderUserId))];
    const userRows = otherUserIds.length
      ? await db.select().from(users).where(sql`${users.id} IN (${sql.join(otherUserIds.map((u) => sql`${u}`), sql`, `)})`)
      : [];
    const userById = new Map(userRows.map((u) => [u.id, u]));
    const otherCharIds = rows.map((r) => r.frienderCharacterId).filter((c): c is string => !!c);
    const charRows = otherCharIds.length
      ? await db.select().from(characters).where(sql`${characters.id} IN (${sql.join(otherCharIds.map((c) => sql`${c}`), sql`, `)})`)
      : [];
    const charById = new Map(charRows.map((c) => [c.id, c]));

    const entries: FriendRequestEntry[] = rows.map((r) => {
      const u = userById.get(r.frienderUserId);
      const c = r.frienderCharacterId ? charById.get(r.frienderCharacterId) : null;
      return {
        userId: r.frienderUserId,
        username: u?.username ?? "(unknown)",
        displayName: c?.name ?? u?.username ?? "(unknown)",
        avatarUrl: c?.avatarUrl ?? u?.avatarUrl ?? null,
        createdAt: +r.createdAt,
      };
    });
    // Newest first.
    entries.sort((a, b) => b.createdAt - a.createdAt);
    return { requests: entries };
  });
}
