import type { FastifyInstance } from "fastify";
import type { Server as IoServer } from "socket.io";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import { characters, friends, users } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "./auth.js";
import { characterIdFromQuery, eqIdentity, ownsCharacter, type Identity } from "../auth/identity.js";
import { eqNameInsensitive } from "../lib/nameLookup.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/**
 * Result of `/me/friend-resolve?name=X` — every identity (master and
 * character) that the name could refer to. Lets the friend-add UI
 * disambiguate before sending an actual request. Empty array when
 * nothing matches.
 *
 * Multiple character matches are possible: two players can each name
 * a character "Jagger." The UI shows each with the owner's master
 * username as a disambiguator (e.g. "Jagger (E D Erin)").
 */
export interface FriendResolveMatch {
  kind: "master" | "character";
  userId: string;
  /** Character id when kind === 'character'; null for master matches. */
  characterId: string | null;
  /** What to display in the picker — character name or master username. */
  displayName: string;
  /** The master username — used as the disambiguator tag on character
   *  rows ("Jagger (E D Erin)") and as the primary text for master rows. */
  masterUsername: string;
  avatarUrl: string | null;
}

export interface FriendListEntry {
  userId: string;
  username: string;
  /**
   * The friend's character id pinned to THIS friendship row, or null
   * when they're friended via their master/OOC handle. Per-identity
   * partition contract: if you friended @Aphelios (a character), this
   * row carries Aphelios's character id and the DM thread it opens
   * stays bound to that character forever — no OOC crossover. The
   * client uses this as `targetCharacterId` when seeding a fresh DM
   * conversation so the first message lands in the right pinned
   * thread.
   */
  characterId: string | null;
  /** Character name when characterId is set, else the master username. */
  displayName: string;
  /**
   * Handle the UI shows under the displayName — character name when
   * the friendship is pinned to a character, master username
   * otherwise. Distinct from `username` so the per-character privacy
   * contract holds: a character-pinned friend NEVER leaks the
   * master account's username through the @handle.
   */
  handle: string;
  avatarUrl: string | null;
  online: boolean;
}

export interface FriendRequestEntry {
  /** The user who SENT the request — the one whose pending row points at me. */
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  /**
   * The sender's character id pinned to THIS request, or null when
   * they sent it as their master/OOC handle. The client passes this
   * back when accepting/declining so the server can identify the
   * exact row by identity instead of by name (name-based lookup is
   * ambiguous when a character shares a username with a master).
   */
  frienderCharacterId: string | null;
  /**
   * The RECEIVER's (caller's) character id this request was sent to —
   * mirrors the `?characterId` the inbox was queried with. Echoed
   * back per entry so a later accept/decline click doesn't have to
   * thread the per-fetch identity through the UI state.
   */
  friendedCharacterId: string | null;
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
  /* ---------- /me/friend-resolve — disambiguation -----------
   *
   * Given a free-text `name`, return every identity it could refer
   * to: at most one master (usernames are unique) plus zero-or-more
   * characters (multiple players can name a character the same
   * thing). The friend-add UI consumes this BEFORE firing a request
   * so the user can pick exactly which identity they meant.
   *
   * Self-matches are excluded so the picker never offers "friend
   * yourself" rows. Disabled / soft-deleted rows are excluded.
   *
   * The existing POST /me/friend-requests still accepts a bare
   * `username` for backward compatibility (the slash-command path
   * uses that), but now ALSO accepts an explicit
   * `targetCharacterId` to pin the request to a specific character
   * without going through the name-resolution lookup that
   * master-prefers-over-character.
   */
  app.get<{ Querystring: { name?: string } }>("/me/friend-resolve", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const name = (req.query.name ?? "").trim();
    if (!name) return { matches: [] as FriendResolveMatch[] };

    const matches: FriendResolveMatch[] = [];

    // Master match. Username uniqueness means at most one. Comparison
    // is space-insensitive: a caller typing `John Doe` matches a master
    // stored as `John Doe` (NBSP, the master-username canonical) so
    // the disambiguator surfaces them in the picker even when the user
    // doesn't know to type Alt+0160.
    const masterRow = (await db
      .select()
      .from(users)
      .where(and(
        eqNameInsensitive(users.username, name),
        isNull(users.disabledAt),
      ))
      .limit(1))[0];
    if (masterRow && masterRow.id !== me.id) {
      matches.push({
        kind: "master",
        userId: masterRow.id,
        characterId: null,
        displayName: masterRow.username,
        masterUsername: masterRow.username,
        avatarUrl: masterRow.avatarUrl ?? null,
      });
    }

    // Character matches. Pull all live characters with this name,
    // joined to their owners for the disambiguator label. Caller's
    // own characters are excluded — friending yourself is silly.
    const charRows = await db
      .select({
        id: characters.id,
        name: characters.name,
        avatarUrl: characters.avatarUrl,
        userId: characters.userId,
        ownerUsername: users.username,
      })
      .from(characters)
      .innerJoin(users, eq(users.id, characters.userId))
      .where(and(
        eqNameInsensitive(characters.name, name),
        isNull(characters.deletedAt),
        isNull(users.disabledAt),
      ));
    for (const c of charRows) {
      if (c.userId === me.id) continue;
      matches.push({
        kind: "character",
        userId: c.userId,
        characterId: c.id,
        displayName: c.name,
        masterUsername: c.ownerUsername,
        avatarUrl: c.avatarUrl ?? null,
      });
    }

    return { matches };
  });

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
      const usingChar = !!(c && !c.deletedAt);
      const displayName = usingChar ? c!.name : (u?.username ?? "(unknown)");
      // Character-pinned rows must NOT fall back to the master's
      // avatar — that fallback leaks the OOC owner's portrait into
      // the friends rail for any character whose own avatar slot is
      // empty. Null falls through to the initials placeholder
      // client-side, which is the privacy-correct rendering.
      const avatarUrl = usingChar ? (c!.avatarUrl ?? null) : (u?.avatarUrl ?? null);
      return {
        userId: o.userId,
        username: u?.username ?? "(unknown)",
        // Pinned character id for this friendship row. Null when
        // they're friended OOC. The client uses this to seed
        // `targetCharacterId` on a brand-new DM so the conversation
        // is created against the right identity, not the master.
        characterId: usingChar ? o.characterId : null,
        displayName,
        // Handle = character name when pinned to a character, else
        // master username. Keeps the master handle out of the UI
        // entirely for character-friendship rows.
        handle: usingChar ? c!.name : (u?.username ?? "(unknown)"),
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
  app.post<{ Body: { username?: string; characterId?: string; targetUserId?: string; targetCharacterId?: string | null } }>("/me/friend-requests", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    // Friender identity: my active character (or master if absent).
    const myCharId = characterIdFromQuery(req.body?.characterId);
    if (myCharId && !(await ownsCharacter(db, me.id, myCharId))) {
      reply.code(403); return { error: "not your character" };
    }
    const meIdentity: Identity = { userId: me.id, characterId: myCharId };

    // Target identity resolution. Two paths:
    //
    //   1. EXPLICIT: caller passed `targetUserId` (and optionally
    //      `targetCharacterId`). Used by the disambiguation picker
    //      that calls /me/friend-resolve first and then commits to
    //      a specific identity. Validates the target exists +
    //      character (if any) belongs to that user.
    //   2. NAME-BASED: caller passed `username`. Backward-compatible
    //      path for the slash command and legacy clients. Tries
    //      master-first, then character-by-name. Ambiguous (same
    //      name as both a master and a character) silently picks
    //      the master — the new disambiguation flow exists precisely
    //      because this resolution order isn't always what the user
    //      meant.
    let targetIdentity: Identity | null = null;
    let targetDisplay: string = "";
    if (typeof req.body?.targetUserId === "string" && req.body.targetUserId.trim()) {
      const targetUserId = req.body.targetUserId.trim();
      const targetCharacterId = req.body.targetCharacterId ?? null;
      const userRow = (await db.select().from(users).where(eq(users.id, targetUserId)).limit(1))[0];
      if (!userRow || userRow.disabledAt) { reply.code(404); return { error: "no_user" }; }
      if (targetCharacterId) {
        const charRow = (await db.select().from(characters).where(eq(characters.id, targetCharacterId)).limit(1))[0];
        if (!charRow || charRow.userId !== userRow.id || charRow.deletedAt) {
          reply.code(404); return { error: "no_target_character" };
        }
        targetIdentity = { userId: userRow.id, characterId: charRow.id };
        targetDisplay = charRow.name;
      } else {
        targetIdentity = { userId: userRow.id, characterId: null };
        targetDisplay = userRow.username;
      }
    } else {
      const username = (req.body?.username ?? "").trim();
      if (!username) { reply.code(400); return { error: "username required" }; }
      // Space-insensitive match so a slash-command `/friend John Doe`
      // resolves a master stored as `John Doe` (NBSP) — same fold the
      // /me/friend-resolve picker uses above.
      const masterRow = (await db
        .select()
        .from(users)
        .where(eqNameInsensitive(users.username, username))
        .limit(1))[0];
      if (masterRow && !masterRow.disabledAt) {
        targetIdentity = { userId: masterRow.id, characterId: null };
        targetDisplay = masterRow.username;
      } else {
        const charRow = (await db
          .select()
          .from(characters)
          .where(eqNameInsensitive(characters.name, username))
          .limit(1))[0];
        if (charRow && !charRow.deletedAt) {
          targetIdentity = { userId: charRow.userId, characterId: charRow.id };
          targetDisplay = charRow.name;
        }
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
      const usingChar = !!(c && !c.deletedAt);
      return {
        userId: r.frienderUserId,
        username: u?.username ?? "(unknown)",
        displayName: usingChar ? c!.name : (u?.username ?? "(unknown)"),
        // Same privacy contract as /me/friends: never fall back to the
        // master's avatar when the request was sent FROM a character.
        avatarUrl: usingChar ? (c!.avatarUrl ?? null) : (u?.avatarUrl ?? null),
        // Surface the exact friender identity so accept/decline can
        // identify the row unambiguously — a master and a character
        // can share a name, and `resolveIdentityByName` resolves
        // master-first, so name-only matching strands rows whose
        // friender_character_id is set.
        frienderCharacterId: r.frienderCharacterId ?? null,
        // Friended (receiver) side identity that this request was
        // sent TO. Always equal to the inbox's characterId since
        // the query filters on it — but echoed back per-row so the
        // client doesn't have to remember which inbox the entry
        // came from when it later fires accept/decline.
        friendedCharacterId: charId,
        createdAt: +r.createdAt,
      };
    });
    // Newest first.
    entries.sort((a, b) => b.createdAt - a.createdAt);
    return { requests: entries };
  });

  /**
   * Accept (`/accept`) and decline (`/decline`) — but routed by EXACT
   * identity instead of by name. The Messages-modal Accept/Decline
   * buttons and the FriendRequestPrompts banner both call these so
   * they can clear the canonical pending row even when:
   *
   *   - the sender's name collides with a master account (a
   *     character named "Aphelios" sent the request, but
   *     `resolveIdentityByName("Aphelios")` resolves master-first and
   *     never matches the row whose friender_character_id is set);
   *   - the receiver's tab has since switched identities (the slash-
   *     command path uses ctx.user.activeCharacterId for `me`, which
   *     drifts as the user moves between characters);
   *   - the row was written with a friender_character_id we can only
   *     read off the inbox payload, not derive from a name.
   *
   * Both endpoints require the FULL friender identity in the URL +
   * body, and the friended-side identity (this caller's `?characterId`).
   * Mirroring /me/friend-requests' query-string contract keeps the
   * "this inbox is this identity" rule consistent across the API.
   */
  const acceptDeclineBody = z.object({
    /** The friender's character id on the row, or null for their master OOC. */
    frienderCharacterId: z.string().nullable().optional(),
    /** My own character id for this request, or null for my master OOC inbox. */
    characterId: z.string().nullable().optional(),
  }).strict();

  app.post<{ Params: { frienderUserId: string }; Body: unknown }>(
    "/me/friend-requests/:frienderUserId/accept",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      let body: z.infer<typeof acceptDeclineBody>;
      try { body = acceptDeclineBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }
      const myCharId = body.characterId ?? null;
      if (myCharId && !(await ownsCharacter(db, me.id, myCharId))) {
        reply.code(403); return { error: "not your character" };
      }
      const frienderIdentity: Identity = {
        userId: req.params.frienderUserId,
        characterId: body.frienderCharacterId ?? null,
      };
      const meIdentity: Identity = { userId: me.id, characterId: myCharId };

      // Flip status pending → accepted on the exact pair. r.changes ===
      // 0 means the row's already been resolved (other tab accepted,
      // sender canceled, etc.) — we treat that as success so the client
      // can still clear its local optimistic state instead of looping
      // on a stuck banner. The /me/friend-requests refetch the client
      // does next will reflect the actual current state.
      await db
        .update(friends)
        .set({ status: "accepted" })
        .where(and(
          eqIdentity(friends.frienderUserId, friends.frienderCharacterId, frienderIdentity),
          eqIdentity(friends.friendedUserId, friends.friendedCharacterId, meIdentity),
          eq(friends.status, "pending"),
        ));
      // Notify the sender's sockets so their friends rail refreshes.
      const sockets = await io.fetchSockets();
      for (const s of sockets) {
        const uid = (s.data as { userId?: string }).userId;
        if (uid !== frienderIdentity.userId) continue;
        s.emit("friend:request", {
          frienderUserId: me.id,
          frienderUsername: me.username,
          frienderDisplayName: me.username,
        });
      }
      // Echo to the acceptor's own sockets too. The client's listener
      // bumps `friendsVersion` on every `friend:request` event, which
      // is what triggers MessagesModal to refetch its friends list.
      // Without this echo, accepting via the in-chat
      // FriendRequestPrompts banner (or while the inbox modal is on
      // another viewer's tab) left the acceptor's friends list stale
      // — the only refresh path was the local `refreshKey` bump
      // inside MessagesModal's own `acceptRequest`, which doesn't fire
      // for the banner path or for sibling tabs. Payload identifies
      // the original SENDER (now a friend) so the soft notice reads
      // sensibly.
      const frienderRow = (
        await db.select().from(users).where(eq(users.id, frienderIdentity.userId)).limit(1)
      )[0];
      if (frienderRow) {
        for (const s of sockets) {
          const uid = (s.data as { userId?: string }).userId;
          if (uid !== me.id) continue;
          s.emit("friend:request", {
            frienderUserId: frienderIdentity.userId,
            frienderUsername: frienderRow.username,
            frienderDisplayName: frienderRow.username,
          });
        }
      }
      return { ok: true };
    },
  );

  app.post<{ Params: { frienderUserId: string }; Body: unknown }>(
    "/me/friend-requests/:frienderUserId/decline",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      let body: z.infer<typeof acceptDeclineBody>;
      try { body = acceptDeclineBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }
      const myCharId = body.characterId ?? null;
      if (myCharId && !(await ownsCharacter(db, me.id, myCharId))) {
        reply.code(403); return { error: "not your character" };
      }
      const frienderIdentity: Identity = {
        userId: req.params.frienderUserId,
        characterId: body.frienderCharacterId ?? null,
      };
      const meIdentity: Identity = { userId: me.id, characterId: myCharId };

      // Delete the pending row outright. Same "already-resolved is
      // success" posture as accept above so the UI never gets stuck
      // looping.
      await db
        .delete(friends)
        .where(and(
          eqIdentity(friends.frienderUserId, friends.frienderCharacterId, frienderIdentity),
          eqIdentity(friends.friendedUserId, friends.friendedCharacterId, meIdentity),
          eq(friends.status, "pending"),
        ));
      // Sender stays unnotified per the existing decline contract —
      // mirrors the slash-command behavior and avoids a passive-
      // aggressive "they declined you" signal.
      return { ok: true };
    },
  );
}
