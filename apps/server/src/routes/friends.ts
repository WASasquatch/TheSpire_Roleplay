import type { FastifyInstance } from "fastify";
import type { Server as IoServer } from "socket.io";
import { and, eq, or, sql } from "drizzle-orm";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import { characters, friends, users } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "./auth.js";

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
  app.get("/me/friends", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    // Symmetric pull: every accepted edge where I'm on either side.
    // The SQL `CASE` collapses the two directions into a single
    // `otherUserId` column so the inner join only needs to walk once.
    const rows = await db
      .select({
        otherUserId: sql<string>`CASE WHEN ${friends.frienderUserId} = ${me.id} THEN ${friends.friendedUserId} ELSE ${friends.frienderUserId} END`,
        username: users.username,
        avatarUrl: users.avatarUrl,
        activeCharacterId: users.activeCharacterId,
        charName: characters.name,
        charAvatarUrl: characters.avatarUrl,
        charDeletedAt: characters.deletedAt,
      })
      .from(friends)
      .innerJoin(
        users,
        sql`${users.id} = CASE WHEN ${friends.frienderUserId} = ${me.id} THEN ${friends.friendedUserId} ELSE ${friends.frienderUserId} END`,
      )
      .leftJoin(characters, eq(characters.id, users.activeCharacterId))
      .where(and(
        or(eq(friends.frienderUserId, me.id), eq(friends.friendedUserId, me.id)),
        eq(friends.status, "accepted"),
      ));

    const allSockets = await io.fetchSockets();
    const online = new Set<string>();
    for (const s of allSockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (uid) online.add(uid);
    }

    const entries: FriendListEntry[] = rows.map((r) => {
      const usingChar = r.activeCharacterId && r.charName && !r.charDeletedAt;
      return {
        userId: r.otherUserId,
        username: r.username,
        displayName: usingChar ? r.charName! : r.username,
        avatarUrl: usingChar ? (r.charAvatarUrl ?? r.avatarUrl ?? null) : (r.avatarUrl ?? null),
        online: online.has(r.otherUserId),
      };
    });

    // Stable display ordering: online first, then alphabetical.
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
  app.post<{ Body: { username?: string } }>("/me/friend-requests", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const username = (req.body?.username ?? "").trim();
    if (!username) { reply.code(400); return { error: "username required" }; }

    const target = (await db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = ${username.toLowerCase()}`)
      .limit(1))[0];
    if (!target || target.disabledAt) { reply.code(404); return { error: "no_user" }; }
    if (target.id === me.id) { reply.code(400); return { error: "self" }; }

    // Same idempotency tree as the slash command: existing accepted edge
    // is a no-op, existing pending-from-me is also a no-op, existing
    // pending-from-them auto-accepts (mutual intent).
    const existing = (await db
      .select()
      .from(friends)
      .where(or(
        and(eq(friends.frienderUserId, me.id), eq(friends.friendedUserId, target.id)),
        and(eq(friends.frienderUserId, target.id), eq(friends.friendedUserId, me.id)),
      ))
      .limit(1))[0];

    // Capture the narrowed locals into closure-stable consts. TS doesn't
    // carry the outer null/undefined narrowing into the inner function,
    // so referencing `me.id` / `target.id` inside a nested function would
    // re-widen them. These aliases keep the closure type-clean.
    const meId = me.id;
    const meUsername = me.username;
    const targetId = target.id;
    async function notifyTarget() {
      // Fan a friend:request event to every live socket of the target so
      // their inbox/badge refreshes without polling. The payload is
      // intentionally minimal — the client pulls /me/friend-requests for
      // canonical state.
      const sockets = await io.fetchSockets();
      for (const s of sockets) {
        const uid = (s.data as { userId?: string }).userId;
        if (uid !== targetId) continue;
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
        return { ok: true, status: "already_friends" as const, username: target.username };
      }
      if (existing.frienderUserId === me.id) {
        reply.code(200);
        return { ok: true, status: "already_pending" as const, username: target.username };
      }
      // Their pending request flips to accepted.
      await db
        .update(friends)
        .set({ status: "accepted" })
        .where(and(eq(friends.frienderUserId, target.id), eq(friends.friendedUserId, me.id)));
      await notifyTarget();
      reply.code(200);
      return { ok: true, status: "accepted" as const, username: target.username };
    }

    await db
      .insert(friends)
      .values({ frienderUserId: me.id, friendedUserId: target.id, status: "pending" });
    await notifyTarget();
    reply.code(201);
    return { ok: true, status: "sent" as const, username: target.username };
  });

  app.get("/me/friend-requests", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    const rows = await db
      .select({
        frienderUserId: friends.frienderUserId,
        createdAt: friends.createdAt,
        username: users.username,
        avatarUrl: users.avatarUrl,
        activeCharacterId: users.activeCharacterId,
        charName: characters.name,
        charAvatarUrl: characters.avatarUrl,
        charDeletedAt: characters.deletedAt,
      })
      .from(friends)
      .innerJoin(users, eq(users.id, friends.frienderUserId))
      .leftJoin(characters, eq(characters.id, users.activeCharacterId))
      .where(and(
        eq(friends.friendedUserId, me.id),
        eq(friends.status, "pending"),
      ));

    const entries: FriendRequestEntry[] = rows.map((r) => {
      const usingChar = r.activeCharacterId && r.charName && !r.charDeletedAt;
      return {
        userId: r.frienderUserId,
        username: r.username,
        displayName: usingChar ? r.charName! : r.username,
        avatarUrl: usingChar ? (r.charAvatarUrl ?? r.avatarUrl ?? null) : (r.avatarUrl ?? null),
        createdAt: +r.createdAt,
      };
    });
    // Newest first.
    entries.sort((a, b) => b.createdAt - a.createdAt);
    return { requests: entries };
  });
}
