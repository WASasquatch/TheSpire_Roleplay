import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, gt, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import { nanoid } from "nanoid";
import { z } from "zod";
import type {
  ChatMessage,
  ClientToServerEvents,
  MessageSearchHit,
  RoomOccupant,
  RoomInfo,
  RoomSummary,
  ServerToClientEvents,
  ThreadCategory,
  ExportManifest,
  ExportPayload,
} from "@thekeep/shared";
import {
  clampExportMs,
  DEFAULT_EXPORT_MS,
  EXPORT_MANIFEST_VERSION,
  EXPORT_MAX_MESSAGES,
  EXPORT_SIGN_ALGO,
  isModeratorRole,
  mentionsField,
  parseNpcStats,
} from "@thekeep/shared";
import { escapeLike } from "../lib/nameLookup.js";
import { getClearedAt } from "../lib/roomClears.js";
import { hasPermission } from "../auth/permissions.js";
import { exportReceipts, forums, ignores, messages, roomMembers, roomThreadCategories, rooms, users } from "../db/schema.js";
import { parseNpcList } from "../lib/roomStats.js";
import { forumBoardReadGate } from "../forums/authority.js";
import { loadPollState } from "../polls.js";
import { linkPreviewFromRow } from "../unfurl.js";
import type { Db } from "../db/index.js";
import { getServerSettings, getSettings, areServersEnabled } from "../settings.js";
import { DEFAULT_SERVER_ID } from "../earning/pool.js";
import { serverAuthority } from "../servers/authority.js";
import { isServerModerationActive } from "../servers/moderation.js";
import { buildRoomSummary, currentOccupants } from "../realtime/broadcast.js";
import { listArchivedOwnedRooms } from "../lib/archivedRooms.js";
import { roomVisibilityWhere } from "../realtime/targetedMessages.js";
import { blockedUserIdsFor } from "../auth/blocks.js";
import { buildChatLogHtml, type ExportMessageRow } from "../export/chatLog.js";
import { signExportPayload } from "../export/sign.js";
import { getSessionUser } from "./auth.js";
import { resolveTopicAuthorFlair } from "./forums.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

interface RoomWithOccupants extends RoomSummary {
  occupants: RoomOccupant[];
}

/**
 * Returns the navigable room tree for the right-rail sidebar:
 *   - every public room (always visible, even empty), each with its
 *     currently-connected occupants
 *   - the caller's current room if it happens to be private (so they can see
 *     the people they're whispering with)
 *
 * Private rooms NEVER appear in this list for callers who aren't in them.
 */
export async function registerRoomsRoutes(
  app: FastifyInstance,
  db: Db,
  io: Io,
): Promise<void> {
  app.get<{ Querystring: { serverId?: string } }>(
    "/rooms",
    // Per-IP DoS backstop. This endpoint rebuilds the whole room tree (a
    // per-room occupant fan-out) and was previously unrate-limited, so a
    // client stuck in a refetch/reconnect loop could hammer it at ~100 req/s
    // and take the synchronous-SQLite event loop down for everyone. Legit use
    // is a 20s poll plus presence-debounced bumps. Headroom note: the client's
    // presence-storm refetch is 400ms-debounced (~150/min worst case from ONE
    // tab), and the counter is shared per-IP across tabs + NAT/CGNAT peers, so
    // 240/min leaves room for a busy shared IP during a mass-reconnect storm; a
    // runaway is still capped at 4/s and its fetch just returns the last-good
    // tree client-side.
    { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } },
    async (req) => {
    const me = await getSessionUser(req, db);

    // Optional per-server scoping (multi-server lift). The web rail and the
    // ServerSettings → Rooms tab request `/rooms?serverId=<id>` to see only a
    // single server's rooms. We honor it ONLY when servers are enabled; with
    // the flag off (or no param) this predicate is `undefined`, so the query
    // below is byte-identical to today's unfiltered list.
    const wantServerId =
      typeof req.query.serverId === "string" && req.query.serverId.trim()
        ? req.query.serverId.trim()
        : undefined;
    // The DEFAULT (is_system) server ADOPTS orphan rooms: a room whose
    // `server_id` is NULL is, by the lift's documented contract (migration
    // 0277 + serverAuthority), owned by the default server until the next
    // boot-time sweep (seed.ts) backfills it. So when the rail asks for the
    // default server's rooms we must include NULL rows too — otherwise a
    // freshly-created room (the /room command stamps server_id, but a legacy
    // path or a mid-deletion SET NULL might not) silently vanishes from the
    // rail until a restart. Any OTHER (sub-)server gets a strict match: NULL
    // rooms belong to the default, never to a sub-server. Mirrors the
    // `or(eq, isNull)` adoption pattern already used for emoticon sheets,
    // reports, and mod cases.
    const serverScope =
      wantServerId && areServersEnabled(await getSettings(db))
        ? wantServerId === DEFAULT_SERVER_ID
          ? or(eq(rooms.serverId, wantServerId), isNull(rooms.serverId))
          : eq(rooms.serverId, wantServerId)
        : undefined;

    // 1. Pull every public room. Archived rows (auto-parked after the
    //    last occupant left) are excluded so the name appears
    //    available for resurrection on the next create. They still
    //    show up via `findRoomByName` on the create path so a same-
    //    name create reactivates the row instead of erroring on the
    //    unique-name index.
    const publicRows = await db
      .select()
      .from(rooms)
      .where(and(eq(rooms.type, "public"), isNull(rooms.archivedAt), serverScope))
      .orderBy(asc(rooms.name));

    // 2. If the caller is logged in, find any private room they're currently
    //    socketed into and include it too. We use the socket-room membership
    //    (not just the DB roomMembers row) so users only see their *active*
    //    private room, not every one they've ever joined.
    let extraPrivate: typeof publicRows = [];
    if (me) {
      const sockets = await io.fetchSockets();
      const privateRoomIds = new Set<string>();
      for (const s of sockets) {
        if ((s.data as { userId?: string }).userId !== me.id) continue;
        for (const r of s.rooms) {
          if (r.startsWith("room:")) privateRoomIds.add(r.slice(5));
        }
      }
      // Subtract public rooms we already have.
      for (const r of publicRows) privateRoomIds.delete(r.id);
      if (privateRoomIds.size) {
        extraPrivate = await db
          .select()
          .from(rooms)
          .where(
            and(eq(rooms.type, "private"), inArray(rooms.id, [...privateRoomIds])),
          );
      }
    }

    const allRooms = [...publicRows, ...extraPrivate];
    if (allRooms.length === 0) return { rooms: [] };

    // Hide occupants this viewer is mutually blocked with — the same
    // per-viewer filter the websocket `presence:update` path applies
    // (occupantsForViewer). Without it, /rooms leaked blocked accounts
    // (and ALL their characters, since a block is per-master-userId) back
    // into the rail: the client refetches /rooms on every
    // `rooms:tree-changed`, so a blocked user the socket path had hidden
    // reappeared a beat later — visible in the userlist yet 404-ing on a
    // profile click (the report this fixes).
    const blocked = me ? await blockedUserIdsFor(db, me.id) : new Set<string>();
    // Delegate summary + occupant assembly to the shared builders so this
    // route returns the same shape as the websocket `room:state`/
    // `presence:update` events. Without unification, fields like
    // `linkedWorld`/`primaryWorld`/`accountRole`/`mood` were silently
    // missing from /rooms and the rail UI lost half its features.
    const result: RoomWithOccupants[] = await Promise.all(
      allRooms.map(async (r): Promise<RoomWithOccupants> => {
        const summary = await buildRoomSummary(db, r);
        const occupants = (await currentOccupants(io, db, r.id))
          .filter((o) => !blocked.has(o.userId))
          .slice()
          .sort((a, b) => a.displayName.localeCompare(b.displayName));
        return { ...summary, occupants };
      }),
    );

    return { rooms: result };
  });

  /**
   * GET /rooms/by-slug/:slug
   *
   * Lightweight {id, name} lookup for a room by its slug. Powers the
   * `{room:<slug>}` UI-route chip: the renderer hydrates the chip label
   * from `name`, and the click handler joins via `id`. Visibility-gated
   * so a chip can't reveal or navigate into a room the viewer shouldn't
   * see — public, non-members-only rooms resolve for anyone; private (or
   * forum members-only) rooms resolve ONLY for a member, the owner, or
   * staff. Everything else 404s, and the chip degrades to literal text.
   */
  app.get<{ Params: { slug: string } }>("/rooms/by-slug/:slug", async (req, reply) => {
    const me = await getSessionUser(req, db);
    const slug = req.params.slug.trim().toLowerCase();
    if (!slug) { reply.code(404); return { error: "not found" }; }
    const room = (await db
      .select()
      .from(rooms)
      .where(and(sql`lower(${rooms.slug}) = ${slug}`, isNull(rooms.archivedAt)))
      .limit(1))[0];
    if (!room) { reply.code(404); return { error: "not found" }; }
    // Rooms inside a moderated (suspended/banned) server are hidden from anyone
    // who isn't that server's staff — the same "users can't see it" contract the
    // rail/discovery + /servers/by-slug + /servers/:id enforce. Without this a
    // {room:slug} chip would resolve a frozen server's public room to a live
    // link instead of degrading to plain text. Default-server / server-less
    // rooms and non-moderated servers are unaffected (expired bans read as
    // inactive), so this is a no-op off the moderated path.
    if (room.serverId && room.serverId !== DEFAULT_SERVER_ID) {
      const sa = await serverAuthority(db, me, room.serverId);
      if (sa.server && isServerModerationActive(sa.server) && !sa.isMod) {
        reply.code(404); return { error: "not found" };
      }
    }
    const openToAll = room.type === "public" && !room.forumMembersOnly;
    if (!openToAll) {
      // Gated room: require a logged-in viewer who is staff, the owner,
      // or a member. A 404 (not 403) keeps a gated room's existence from
      // leaking via the status code.
      if (!me) { reply.code(404); return { error: "not found" }; }
      const isStaff = isModeratorRole(me.role);
      let allowed = isStaff || room.ownerId === me.id;
      if (!allowed) {
        const m = (await db
          .select({ role: roomMembers.role })
          .from(roomMembers)
          .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, me.id)))
          .limit(1))[0];
        allowed = !!m;
      }
      if (!allowed) { reply.code(404); return { error: "not found" }; }
    }
    return { room: { id: room.id, name: room.name } };
  });

  /**
   * GET /rooms/mine/archived
   *
   * The caller's own archived rooms (rooms they owned that auto-parked once
   * the last occupant left). Feeds the Tools-menu "My Rooms" section, whose
   * Recreate buttons fire `/go <name>` to resurrect each one. Auth-gated and
   * scoped to the caller, an archived private room's name shouldn't leak to
   * anyone but its owner.
   */
  app.get("/rooms/mine/archived", async (req: FastifyRequest, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const archived = await listArchivedOwnedRooms(db, me.id);
    return { rooms: archived };
  });

  /**
   * POST /rooms/:id/hide-archived
   *
   * Hide one of the caller's ARCHIVED rooms from their "My Rooms" list /
   * `/myrooms` (e.g. a typo room they never meant to make). Owner-only, and
   * only for archived rooms (active rooms aren't in the list). NON-destructive:
   * it just stamps `archive_hidden_at`; the archived row stays put and the
   * room can be brought back any time with `/go <name>` (which clears it).
   */
  app.post<{ Params: { id: string } }>("/rooms/:id/hide-archived", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.id)).limit(1))[0];
    if (!room) { reply.code(404); return { error: "no room" }; }
    if (room.ownerId !== me.id) { reply.code(403); return { error: "not your room" }; }
    if (!room.archivedAt) { reply.code(409); return { error: "room is active" }; }
    await db.update(rooms).set({ archiveHiddenAt: new Date() }).where(eq(rooms.id, room.id));
    return { ok: true };
  });

  /**
   * GET /rooms/:id/info
   *
   * Full room dossier behind the Room Info bar's expandable pullout. Lazy-
   * loaded only when a viewer expands the bar, so the heavier fields
   * (description, NPC roster) stay off the hot-path room broadcast. Auth-gated;
   * for private rooms the caller must be a member (same gate as the messages
   * route). The password is NEVER returned.
   */
  app.get<{ Params: { id: string } }>("/rooms/:id/info", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.id)).limit(1))[0];
    if (!room || room.archivedAt) { reply.code(404); return { error: "no room" }; }
    if (room.type === "private") {
      const member = (await db
        .select()
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, me.id)))
        .limit(1))[0];
      if (!member) { reply.code(403); return { error: "not a member" }; }
    }
    // Reuse buildRoomSummary for the linkedWorld lookup (and to keep the shared
    // fields in lockstep with the broadcast); layer the dossier-only fields on top.
    const summary = await buildRoomSummary(db, room);
    let ownerName: string | null = null;
    if (room.ownerId) {
      const owner = (await db
        .select({ username: users.username })
        .from(users)
        .where(eq(users.id, room.ownerId))
        .limit(1))[0];
      ownerName = owner?.username ?? null;
    }
    const info: RoomInfo = {
      id: room.id,
      name: room.name,
      type: room.type,
      slug: room.slug ?? null,
      icon: room.icon ?? null,
      description: room.description ?? null,
      topic: room.topic ?? null,
      ownerName,
      createdAt: +room.createdAt,
      messageCount: room.messageCount ?? 0,
      npcs: parseNpcList(room.npcList),
      currentScene: room.currentSceneTitle
        ? { title: room.currentSceneTitle, imageUrl: room.currentSceneImageUrl ?? null }
        : null,
      replyMode: room.replyMode,
      messageExpiryMinutes: room.messageExpiryMinutes,
      difficultyClass: room.difficultyClass ?? null,
      theaterMode: room.theaterMode,
      linkedWorld: summary.linkedWorld,
    };
    return { info };
  });

  /**
   * GET /rooms/:id/messages/search?q=<term>&limit=20
   *
   * Live message search scoped to a single room. Used by the in-rail
   * SearchBar to surface old discussions, especially in nested-mode
   * (forum-style) rooms where conversations persist for days.
   *
   * Privacy gates, in order, fail-closed:
   *   1. Caller must be authenticated.
   *   2. For private rooms: caller must be a member (or owner / site
   *      admin). Non-members get 403, even seeing whether their query
   *      matches something would be a privacy leak.
   *   3. Whispers are filtered to ones the caller is party to.
   *   4. Soft-deleted messages (`deletedAt` set) are excluded, the
   *      author asked them gone; search shouldn't resurrect.
   *   5. System messages are excluded, they're noise (joins/parts,
   *      "X kicked Y", description blasts) and confuse the result list.
   *
   * Ranking: LIKE-based with a simple frequency score (count of matches
   * in the body) + recency tiebreaker. SQLite FTS5 is a future upgrade
   * once a room outgrows what LIKE handles.
   */
  app.get<{ Params: { id: string }; Querystring: { q?: string; limit?: string } }>(
    "/rooms/:id/messages/search",
    // Per-IP cap. Search is user-typed (the SearchBar), even fast debounced
    // type-search won't sustain more than one query per few hundred ms; 30/min
    // = one search every 2s sustained, ample for interactive search while it
    // blocks a LIKE-scan hammer. Matches the earning-rankings cap (comparably heavy).
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const q = (req.query.q ?? "").trim();
      if (!q) return { hits: [] as MessageSearchHit[] };
      // Cap limit so an over-aggressive client can't drag back the whole
      // table. 20 is what the UI surfaces; anything more would scroll off
      // the popup anyway.
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit ?? "20", 10) || 20));

      const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.id)).limit(1))[0];
      if (!room) { reply.code(404); return { error: "no room" }; }

      // Private-room membership gate. Site admins are NOT bypassed here
      //, the privacy contract is that admins can't read private room
      // content even via search.
      if (room.type === "private") {
        const member = (await db
          .select()
          .from(roomMembers)
          .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, me.id)))
          .limit(1))[0];
        if (!member) { reply.code(403); return { error: "not a member" }; }
      }

      // Build the privacy-filtered candidate set, then rank. The whisper
      // filter is parameterized on the caller's userId so even members
      // of a public room only see their own whisper exchanges.
      const like = `%${escapeLike(q)}%`;
      const rows = await db
        .select()
        .from(messages)
        .where(and(
          eq(messages.roomId, room.id),
          isNull(messages.deletedAt),
          sql`${messages.kind} != 'system'`,
          sql`${messages.body} LIKE ${like} ESCAPE '\\'`,
          // Whisper privacy: visible only to sender or recipient.
          or(
            sql`${messages.kind} != 'whisper'`,
            eq(messages.userId, me.id),
            eq(messages.toUserId, me.id),
          ),
        ))
        .orderBy(desc(messages.createdAt))
        .limit(limit * 4); // overfetch so the in-memory rank has options

      // Frequency-based relevance: count occurrences of the query in the
      // body (case-insensitive). Ties broken by recency. The UI displays
      // results in ascending relevance so the most-relevant hit sits
      // closest to the search input, see the SearchBar component.
      const needle = q.toLowerCase();
      const hits = rows.map((m): MessageSearchHit & { _ts: number } => {
        const lc = m.body.toLowerCase();
        let count = 0;
        let idx = 0;
        while ((idx = lc.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
        return {
          id: m.id,
          roomId: m.roomId,
          userId: m.userId,
          displayName: m.displayName,
          kind: m.kind,
          snippet: m.body,
          createdAt: +m.createdAt,
          relevance: count,
          ...(m.replyToId ? { replyToId: m.replyToId } : {}),
          _ts: +m.createdAt,
        };
      });
      hits.sort((a, b) => b.relevance - a.relevance || b._ts - a._ts);
      const trimmed = hits.slice(0, limit).map(({ _ts, ...rest }) => rest);
      return { hits: trimmed };
    },
  );

  /**
   * GET /rooms/:id/messages/around?messageId=<id>&before=20&after=20
   *
   * Returns a window of messages centered on a target so the client can
   * jump from a search hit / bookmark / mention into the middle of room
   * history. Same privacy rules as the search endpoint: room membership,
   * whisper-party filtering, no soft-deleted bodies, no system noise
   * exposed.
   *
   * The shape mirrors `joinRoom`'s `message:bulk` payload so the client
   * can swap its `messagesByRoom[roomId]` buffer wholesale. A "viewing
   * history" indicator is applied client-side based on the request
   * itself, not anything in the response.
   */
  app.get<{
    Params: { id: string };
    Querystring: { messageId?: string; before?: string; after?: string };
  }>("/rooms/:id/messages/around", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const messageId = req.query.messageId;
    if (!messageId) { reply.code(400); return { error: "messageId required" }; }
    const before = Math.min(50, Math.max(0, parseInt(req.query.before ?? "20", 10) || 20));
    const after = Math.min(50, Math.max(0, parseInt(req.query.after ?? "20", 10) || 20));

    const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.id)).limit(1))[0];
    if (!room) { reply.code(404); return { error: "no room" }; }
    if (room.type === "private") {
      const member = (await db
        .select()
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, me.id)))
        .limit(1))[0];
      if (!member) { reply.code(403); return { error: "not a member" }; }
    }

    const target = (await db.select().from(messages).where(eq(messages.id, messageId)).limit(1))[0];
    if (!target || target.roomId !== room.id) {
      reply.code(404);
      return { error: "message not in this room" };
    }
    // If the target itself is whisper-private and the caller isn't a
    // party, we don't surface it (or its context), same rule the live
    // backlog applies.
    if (target.kind === "whisper" && target.userId !== me.id && target.toUserId !== me.id) {
      reply.code(403);
      return { error: "not your whisper" };
    }

    // Cross-room whisper overlay, see the union in
    // sendRoomBacklogTo / GET /rooms/:id/messages for the rationale.
    const roomOrPartyWhisper = roomVisibilityWhere(room.id, me.id, room.serverId ?? DEFAULT_SERVER_ID);

    // Pull `before` rows with createdAt <= target (inclusive of target via
    // <= + de-dup below), and `after` rows strictly newer.
    const olderOrEq = await db
      .select()
      .from(messages)
      .where(and(
        roomOrPartyWhisper,
        sql`${messages.createdAt} <= ${target.createdAt}`,
      ))
      .orderBy(desc(messages.createdAt))
      .limit(before + 1); // +1 to include the target itself
    const newer = await db
      .select()
      .from(messages)
      .where(and(
        roomOrPartyWhisper,
        gt(messages.createdAt, target.createdAt),
      ))
      .orderBy(asc(messages.createdAt))
      .limit(after);

    const window = [...olderOrEq.reverse(), ...newer];

    const canSeeOriginalBody = await hasPermission(me, "view_deleted_message_body", db);
    const wire: ChatMessage[] = window.map((m) => ({
      id: m.id,
      roomId: m.kind === "whisper" ? room.id : m.roomId,
      userId: m.userId,
      characterId: m.characterId,
      displayName: m.displayName,
      kind: m.kind,
      body: m.deletedAt ? "" : m.body,
      color: m.color,
      createdAt: +m.createdAt,
      ...(m.toUserId ? { toUserId: m.toUserId } : {}),
      ...(m.toCharacterId ? { toCharacterId: m.toCharacterId } : {}),
      ...(m.toDisplayName ? { toDisplayName: m.toDisplayName } : {}),
      ...(m.replyToId ? { replyToId: m.replyToId } : {}),
      ...(m.replyToDisplayName ? { replyToDisplayName: m.replyToDisplayName } : {}),
      ...(m.replyToBodySnippet ? { replyToBodySnippet: m.replyToBodySnippet } : {}),
      ...(m.moodSnapshot ? { moodSnapshot: m.moodSnapshot } : {}),
      ...(m.npcVoicedBy ? { npcVoicedBy: m.npcVoicedBy } : {}),
      ...(m.threadCategoryId ? { threadCategoryId: m.threadCategoryId } : {}),
      ...(m.title ? { title: m.title } : {}),
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
      ...(m.editedAt ? { editedAt: +m.editedAt } : {}),
      ...(m.deletedAt ? { deletedAt: +m.deletedAt } : {}),
      ...(m.lockedAt ? { lockedAt: +m.lockedAt } : {}),
      ...(m.lastActivityAt ? { lastActivityAt: +m.lastActivityAt } : {}),
      ...(m.isSticky ? { isSticky: true } : {}),
      ...(m.cmdCss ? { cmdCss: m.cmdCss } : {}),
      ...((() => { const lp = linkPreviewFromRow(m.linkPreviewJson); return lp ? { linkPreview: lp } : {}; })()),
      ...(m.sceneImageUrl ? { sceneImageUrl: m.sceneImageUrl } : {}),
      ...(m.bodyHtml ? { bodyHtml: m.bodyHtml } : {}),
      ...(m.rankKey ? { rankKey: m.rankKey } : {}),
      ...(m.tier != null ? { tier: m.tier } : {}),
      // Site admins (with `view_deleted_message_body`) see the original
      // body of a deleted message attached on a separate `originalBody`
      // field so they can audit what was hidden. Mods + ordinary
      // viewers get the row without it; their renderer paints the bare
      // "[message removed]" placeholder. The flag is resolved once
      // above this map so we don't fire a permission lookup per row.
      ...(canSeeOriginalBody && m.deletedAt ? { originalBody: m.body } : {}),
    }));
    return { messages: wire };
  });

  /**
   * GET /rooms/:id/messages?before=<createdAt-ms>&limit=<N>
   *
   * Scroll-up pagination for the flat chat history. The initial backlog
   * delivered via `room:join` / `message:bulk` is capped at the most
   * recent 50 lines; this endpoint serves the older window that
   * scrolling past the top edge of the buffer needs. Same privacy /
   * ignore / whisper-party filters as the live backlog so the
   * server-side posture is consistent between "first 50" and "older
   * pages."
   *
   * Returns `{ messages, hasMore }` chronologically oldest → newest
   * within the page so the client can prepend in order. `hasMore` is
   * computed by overfetching one row past the limit so the client
   * doesn't need a separate count round-trip.
   */
  app.get<{
    Params: { id: string };
    Querystring: { before?: string; limit?: string };
  }>("/rooms/:id/messages", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.id)).limit(1))[0];
    if (!room) { reply.code(404); return { error: "no room" }; }
    if (room.type === "private") {
      const member = (await db
        .select()
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, me.id)))
        .limit(1))[0];
      if (!member) { reply.code(403); return { error: "not a member" }; }
    }
    const before = req.query.before ? parseInt(req.query.before, 10) : NaN;
    if (!Number.isFinite(before) || before <= 0) {
      reply.code(400);
      return { error: "before (ms) required" };
    }
    // Cap at 100: the scroll-up loader pulls 100-row batches so history
    // streams in a screenful at a time instead of dribbling; the default
    // stays 50 for any caller that omits the param. Overfetch (limit+1) makes
    // this a ~101-row read, still cheap.
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? "50", 10) || 50));

    // Apply the same hide filter the live backlog uses so a user they've
    // muted (one-way /ignore) or are blocked with (mutual) doesn't re-appear
    // when they scroll older.
    const ignoredIds = new Set(
      (await db
        .select({ ignoredUserId: ignores.ignoredUserId })
        .from(ignores)
        .where(eq(ignores.userId, me.id))).map((r) => r.ignoredUserId),
    );
    for (const blockedId of await blockedUserIdsFor(db, me.id)) ignoredIds.add(blockedId);
    // Whispers overlay across rooms, see the matching union in
    // sendRoomBacklogTo. Non-whisper rows are scoped to THIS room;
    // whisper rows the caller is a party to are pulled regardless of
    // their original room.
    const roomOrPartyWhisper = roomVisibilityWhere(room.id, me.id, room.serverId ?? DEFAULT_SERVER_ID);

    // Per-viewer `/clear` marker: never page back past the point this
    // user cleared the room. Keeps the scroll-up loader from resurrecting
    // history a /clear was meant to hide.
    const clearedAt = await getClearedAt(db, me.id, room.id);
    // Overfetch by one to detect hasMore without a separate count.
    const rows = await db
      .select()
      .from(messages)
      .where(and(
        roomOrPartyWhisper,
        lt(messages.createdAt, new Date(before)),
        clearedAt ? gt(messages.createdAt, clearedAt) : undefined,
      ))
      .orderBy(desc(messages.createdAt))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const window = (hasMore ? rows.slice(0, limit) : rows)
      .filter((m) => !ignoredIds.has(m.userId));
    // The DB pull was DESC for the limit boundary; flip to ASC so the
    // client can prepend in place without re-sorting.
    window.reverse();
    const canSeeOriginalBody = await hasPermission(me, "view_deleted_message_body", db);
    const wire: ChatMessage[] = window.map((m) => ({
      id: m.id,
      // Whispers from other rooms get re-keyed to the requested room so
      // the client appends them to that room's buffer.
      roomId: m.kind === "whisper" ? room.id : m.roomId,
      userId: m.userId,
      characterId: m.characterId,
      displayName: m.displayName,
      kind: m.kind,
      body: m.deletedAt ? "" : m.body,
      color: m.color,
      createdAt: +m.createdAt,
      ...(m.toUserId ? { toUserId: m.toUserId } : {}),
      ...(m.toCharacterId ? { toCharacterId: m.toCharacterId } : {}),
      ...(m.toDisplayName ? { toDisplayName: m.toDisplayName } : {}),
      ...(m.replyToId ? { replyToId: m.replyToId } : {}),
      ...(m.replyToDisplayName ? { replyToDisplayName: m.replyToDisplayName } : {}),
      ...(m.replyToBodySnippet ? { replyToBodySnippet: m.replyToBodySnippet } : {}),
      ...(m.moodSnapshot ? { moodSnapshot: m.moodSnapshot } : {}),
      ...(m.npcVoicedBy ? { npcVoicedBy: m.npcVoicedBy } : {}),
      ...(m.threadCategoryId ? { threadCategoryId: m.threadCategoryId } : {}),
      ...(m.title ? { title: m.title } : {}),
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
      ...(m.editedAt ? { editedAt: +m.editedAt } : {}),
      ...(m.deletedAt ? { deletedAt: +m.deletedAt } : {}),
      ...(m.lockedAt ? { lockedAt: +m.lockedAt } : {}),
      ...(m.lastActivityAt ? { lastActivityAt: +m.lastActivityAt } : {}),
      ...(m.isSticky ? { isSticky: true } : {}),
      ...(m.cmdCss ? { cmdCss: m.cmdCss } : {}),
      ...((() => { const lp = linkPreviewFromRow(m.linkPreviewJson); return lp ? { linkPreview: lp } : {}; })()),
      ...(m.sceneImageUrl ? { sceneImageUrl: m.sceneImageUrl } : {}),
      ...(m.bodyHtml ? { bodyHtml: m.bodyHtml } : {}),
      ...(m.rankKey ? { rankKey: m.rankKey } : {}),
      ...(m.tier != null ? { tier: m.tier } : {}),
      ...(canSeeOriginalBody && m.deletedAt ? { originalBody: m.body } : {}),
    }));
    // Hydrate poll state on any poll rows in this older page (same per-viewer
    // shape the live backlog attaches).
    const pollJsonById = new Map(window.filter((m) => m.kind === "poll").map((m) => [m.id, m.pollDataJson]));
    for (const w of wire) {
      if (w.kind !== "poll") continue;
      const state = await loadPollState(db, w.id, me.id, pollJsonById.get(w.id) ?? null);
      if (state) w.poll = state;
    }
    return { messages: wire, hasMore };
  });

  /**
   * GET /rooms/:id/export?ms=<window-ms>&tz=<minutes-east-of-utc>
   *
   * Download the room's recent messages as a self-contained HTML chat log
   * (timestamps + snapshotted author names + author colours). Emitted by the
   * `/export` command, which parses the user's duration and clamps it; we
   * re-clamp here defensively so a hand-crafted `ms` can't exceed retention or
   * the hard cap. Kept off the socket so generation never blocks live chat,
   * and bounded (one indexed range query + capped row count) so it can't slow
   * the server for other users.
   *
   * `tz` (minutes east of UTC, the caller's offset) renders wall-clock
   * timestamps that match what the user saw in chat; defaults to UTC.
   *
   * Auth: logged in + (for private rooms) a member — same posture as
   * GET /rooms/:id/messages. Visibility mirrors the live backlog: this room's
   * non-whisper lines + whispers the caller is a party to, minus ignored /
   * blocked authors, never past the caller's own /clear, deleted excluded.
   */
  app.get<{
    Params: { id: string };
    Querystring: { ms?: string; tz?: string; theme?: string };
  }>(
    "/rooms/:id/export",
    // Per-IP cap. Export builds a full HTML log over an indexed range (capped
    // at EXPORT_MAX_MESSAGES) — a deliberate, occasional user action (the
    // /export command), never polled. 10/min mirrors /stories/:id/reports and
    // is plenty for re-exporting a couple of windows while throttling a download loop.
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.id)).limit(1))[0];
    if (!room) { reply.code(404); return { error: "no room" }; }
    if (room.type === "private") {
      const member = (await db
        .select()
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, me.id)))
        .limit(1))[0];
      if (!member) { reply.code(403); return { error: "not a member" }; }
    }

    // Re-derive the window from the same rules the command used; never trust
    // the client `ms` beyond what's actually exportable. The retention clamp is
    // the EXPORTED ROOM's server value (NULL `room.serverId`, legacy/standalone,
    // → DEFAULT_SERVER_ID); a NULL override inherits the platform default, so
    // flag-off is byte-identical to the old `getSettings(db)` read.
    const settings = await getServerSettings(db, room.serverId ?? DEFAULT_SERVER_ID);
    const reqMs = req.query.ms ? parseInt(req.query.ms, 10) : DEFAULT_EXPORT_MS;
    const windowMs = clampExportMs(
      Number.isFinite(reqMs) && reqMs > 0 ? reqMs : DEFAULT_EXPORT_MS,
      settings.messageRetentionMs,
      room.messageExpiryMinutes,
    );
    const tzRaw = req.query.tz ? parseInt(req.query.tz, 10) : 0;
    const tzMinutes = Number.isFinite(tzRaw) ? Math.max(-14 * 60, Math.min(14 * 60, tzRaw)) : 0;
    const theme = req.query.theme === "light" ? "light" : "dark";

    const now = Date.now();
    const cutoff = new Date(now - windowMs);

    const ignoredIds = new Set(
      (await db
        .select({ ignoredUserId: ignores.ignoredUserId })
        .from(ignores)
        .where(eq(ignores.userId, me.id))).map((r) => r.ignoredUserId),
    );
    for (const blockedId of await blockedUserIdsFor(db, me.id)) ignoredIds.add(blockedId);
    const roomOrPartyWhisper = roomVisibilityWhere(room.id, me.id, room.serverId ?? DEFAULT_SERVER_ID);
    const clearedAt = await getClearedAt(db, me.id, room.id);

    // Most recent (window ∩ cap) rows DESC; overfetch one to detect that the
    // cap dropped older lines, then flip to chronological for the document.
    const rows = await db
      .select()
      .from(messages)
      .where(and(
        roomOrPartyWhisper,
        gt(messages.createdAt, cutoff),
        clearedAt ? gt(messages.createdAt, clearedAt) : undefined,
        isNull(messages.deletedAt),
      ))
      .orderBy(desc(messages.createdAt))
      .limit(EXPORT_MAX_MESSAGES + 1);
    const truncated = rows.length > EXPORT_MAX_MESSAGES;
    const capped = (truncated ? rows.slice(0, EXPORT_MAX_MESSAGES) : rows)
      .filter((m) => !ignoredIds.has(m.userId));
    capped.reverse();

    const exportRows: ExportMessageRow[] = capped.map((m) => ({
      kind: m.kind,
      displayName: m.displayName,
      body: m.body,
      color: m.color,
      createdAt: +m.createdAt,
      toDisplayName: m.toDisplayName,
      moodSnapshot: m.moodSnapshot,
      npcVoicedBy: m.npcVoicedBy,
    }));

    const rangeStartMs = exportRows.length ? exportRows[0]!.createdAt : now - windowMs;
    const rangeEndMs = exportRows.length ? exportRows[exportRows.length - 1]!.createdAt : now;

    // Build the canonical, signable payload from the SAME rows the document
    // renders — the stable DB snapshot (ids/bodies/timestamps), not the HTML.
    // A receipt of this export is recorded server-side so a downloaded log can
    // be proven authentic later, even after its messages age out of retention.
    const receiptId = `EXP-${nanoid()}`;
    const payload: ExportPayload = {
      version: EXPORT_MANIFEST_VERSION,
      receiptId,
      roomId: room.id,
      roomName: room.name,
      exportedByUserId: me.id,
      exportedByUsername: me.username,
      generatedAtMs: now,
      windowMs,
      rangeStartMs,
      rangeEndMs,
      messageCount: capped.length,
      truncated,
      messages: capped.map((m) => ({
        id: m.id,
        kind: m.kind,
        displayName: m.displayName,
        body: m.body,
        color: m.color,
        createdAt: +m.createdAt,
        toDisplayName: m.toDisplayName ?? null,
        moodSnapshot: m.moodSnapshot ?? null,
        npcVoicedBy: m.npcVoicedBy ?? null,
      })),
    };
    const { signature, contentHash } = signExportPayload(payload);
    const manifest: ExportManifest = {
      version: EXPORT_MANIFEST_VERSION,
      receiptId,
      algo: EXPORT_SIGN_ALGO,
      signature,
      payload,
    };
    await db.insert(exportReceipts).values({
      id: receiptId,
      roomId: room.id,
      roomName: room.name,
      exportedByUserId: me.id,
      exportedByUsername: me.username,
      generatedAt: now,
      windowMs,
      rangeStart: rangeStartMs,
      rangeEnd: rangeEndMs,
      messageCount: capped.length,
      truncated,
      contentHash,
      signature,
    });

    const html = buildChatLogHtml({
      roomName: room.name,
      exportedBy: me.username,
      generatedAtMs: now,
      windowMs,
      rangeStartMs,
      rangeEndMs,
      tzMinutes,
      messages: exportRows,
      truncated,
      theme,
      manifest,
    });

    const safeName = (room.name || "chat")
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "chat";
    reply
      .header("content-type", "text/html; charset=utf-8")
      .header("content-disposition", `attachment; filename="${safeName}-log.html"`)
      .header("cache-control", "no-store");
    return html;
  });

  /**
   * Anonymous READ gate for forum-board content: true when the room is a
   * board whose forum has PUBLIC BROWSING enabled (owner toggle,
   * migration 0237). Lets the /f/<slug> landing serve topics, threads,
   * and categories to logged-out visitors; everything else keeps the
   * 401. Posting paths never consult this — they all require a session.
   */
  async function boardAllowsAnonymousRead(roomId: string): Promise<boolean> {
    const room = (await db
      .select({ forumId: rooms.forumId, forumMembersOnly: rooms.forumMembersOnly })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1))[0];
    if (!room?.forumId) return false;
    // A private (members-only) board is NEVER anonymously readable, even when
    // the forum opts into public browsing (migration 0239).
    if (room.forumMembersOnly) return false;
    const f = (await db
      .select({ publicBrowsing: forums.publicBrowsing })
      .from(forums)
      .where(eq(forums.id, room.forumId))
      .limit(1))[0];
    return !!f?.publicBrowsing;
  }

  /**
   * GET /rooms/:id/messages/:messageId/thread
   *
   * Resolve any message id (topic OR reply) to the topic it belongs to,
   * and return the topic + its full reply chain. Used by the forum's
   * jump-to-message flow (search hit click, bookmark click, mention
   * click) so the client can open `ThreadModal` centered on the hit
   * without having to know up front whether the id points at a topic
   * or a reply.
   *
   * If the requested id is a top-level topic, `topic = self`. If it
   * points to a reply, the server walks `replyToId` once to find the
   * parent. Forum structure is two-level (topic → flat reply chain),
   * so we never need to recurse further. The returned `replies` array
   * is every non-deleted reply under the topic, chronologically.
   *
   * 404s:
   *   - message not found in this room
   *   - the topic (self or parent) was soft-deleted, forum-deletes
   *     are hidden from end-user surfaces; jumping to a removed topic
   *     should fail closed.
   *
   * Auth: any logged-in user. The same justification as the topics
   * endpoint applies, you can't jump to content in a room you haven't
   * joined, since the search/bookmark/mention surfaces only emit ids
   * for content you can see.
   */
  app.get<{ Params: { id: string; messageId: string } }>(
    "/rooms/:id/messages/:messageId/thread",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me && !(await boardAllowsAnonymousRead(req.params.id))) {
        reply.code(401); return { error: "auth" };
      }

      // Private board / category gate (migration 0239): deep links can't be
      // used to read a topic in a members-only board, nor one filed under a
      // members-only category, as a non-member.
      const readGate = await forumBoardReadGate(db, me, req.params.id);
      if (readGate.boardLocked) {
        reply.code(403);
        return { error: "This board is for forum members only.", code: "FORUM_BOARD_MEMBERS_ONLY" };
      }

      const roomId = req.params.id;
      const hit = (await db.select().from(messages).where(eq(messages.id, req.params.messageId)).limit(1))[0];
      if (!hit || hit.roomId !== roomId) {
        reply.code(404);
        return { error: "message not in this room" };
      }

      // Walk to the topic. `replyToId` is null on topics, set on
      // replies. Forum structure is two-level so one lookup max.
      const topicId = hit.replyToId ?? hit.id;
      const topicRow = (await db.select().from(messages).where(eq(messages.id, topicId)).limit(1))[0];
      if (!topicRow || topicRow.roomId !== roomId) {
        reply.code(404);
        return { error: "topic not in this room" };
      }
      if (topicRow.threadCategoryId && readGate.lockedCatIds.has(topicRow.threadCategoryId)) {
        reply.code(403);
        return { error: "This category is for forum members only.", code: "FORUM_BOARD_MEMBERS_ONLY" };
      }
      if (topicRow.deletedAt) {
        // Topic was soft-deleted, surface a 404 rather than handing
        // back a "[message removed]" shell. The jump-from surfaces
        // (search, bookmarks) already filter deleted rows server-
        // side; this is the belt-and-suspenders for racing deletes.
        reply.code(404);
        return { error: "topic removed" };
      }

      // Full reply chain under this topic, oldest first. Non-deleted
      // replies only, the modal's renderer paints "[message removed]"
      // for deletedAt rows but we don't emit them at all here, since
      // a deleted reply in a thread you're viewing is noise.
      const replyRows = await db
        .select()
        .from(messages)
        .where(and(
          eq(messages.roomId, roomId),
          eq(messages.replyToId, topicId),
          isNull(messages.deletedAt),
        ))
        .orderBy(asc(messages.createdAt));

      // Capture the permission resolution into a local before defining
      // the inner mapper so the async permission lookup runs once
      // outside the synchronous map. Anonymous viewers (public-browsing
      // boards) never see deleted bodies.
      const viewerIsAdmin = me ? await hasPermission(me, "view_deleted_message_body", db) : false;
      function rowToWire(m: typeof messages.$inferSelect): ChatMessage {
        return {
          id: m.id,
          roomId: m.roomId,
          userId: m.userId,
          characterId: m.characterId,
          displayName: m.displayName,
          kind: m.kind,
          body: m.body,
          color: m.color,
          createdAt: +m.createdAt,
          ...(m.toUserId ? { toUserId: m.toUserId } : {}),
          ...(m.toDisplayName ? { toDisplayName: m.toDisplayName } : {}),
          ...(m.replyToId ? { replyToId: m.replyToId } : {}),
          ...(m.replyToDisplayName ? { replyToDisplayName: m.replyToDisplayName } : {}),
          ...(m.replyToBodySnippet ? { replyToBodySnippet: m.replyToBodySnippet } : {}),
          ...(m.moodSnapshot ? { moodSnapshot: m.moodSnapshot } : {}),
          ...(m.npcVoicedBy ? { npcVoicedBy: m.npcVoicedBy } : {}),
          ...(m.npcStatsJson ? { npcStats: parseNpcStats(m.npcStatsJson) } : {}),
          ...(m.threadCategoryId ? { threadCategoryId: m.threadCategoryId } : {}),
          ...(m.title ? { title: m.title } : {}),
          ...(m.prefixId ? { prefixId: m.prefixId } : {}),
          ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
          ...(m.editedAt ? { editedAt: +m.editedAt } : {}),
          ...(m.deletedAt ? { deletedAt: +m.deletedAt } : {}),
          ...(m.lockedAt ? { lockedAt: +m.lockedAt } : {}),
          ...(m.lastActivityAt ? { lastActivityAt: +m.lastActivityAt } : {}),
          ...(m.isSticky ? { isSticky: true } : {}),
          ...(m.cmdCss ? { cmdCss: m.cmdCss } : {}),
        ...((() => { const lp = linkPreviewFromRow(m.linkPreviewJson); return lp ? { linkPreview: lp } : {}; })()),
          ...(m.sceneImageUrl ? { sceneImageUrl: m.sceneImageUrl } : {}),
          ...mentionsField(m.mentionsJson),
          ...(m.bodyHtml ? { bodyHtml: m.bodyHtml } : {}),
          ...(m.rankKey ? { rankKey: m.rankKey } : {}),
          ...(m.tier != null ? { tier: m.tier } : {}),
          ...(viewerIsAdmin && m.deletedAt ? { originalBody: m.body } : {}),
        };
      }

      const topicWire = rowToWire(topicRow);
      // Hydrate poll state on a poll topic (definition + tallies + this
      // viewer's ballot) so reopening a poll restores results. Replies are
      // never polls, so only the topic needs it.
      if (topicRow.kind === "poll") {
        const state = await loadPollState(db, topicRow.id, me?.id ?? null, topicRow.pollDataJson);
        if (state) topicWire.poll = state;
      }
      return {
        topic: topicWire,
        replies: replyRows.map(rowToWire),
      };
    },
  );

  /**
   * GET /rooms/:id/topics, paginated list of top-level topics in a
   * forum (nested-mode) room. Filters by category and orders by
   * `last_activity_at` DESC so the most-recently-active threads
   * surface first. Used by the forum view to load topics on room
   * enter, by the per-category numbered pagination strip, and by
   * the orphan-fetch path when a reply arrives for a topic not yet
   * in the client's buffer.
   *
   * Query params:
   *   - `category`: thread category id, `""` for uncategorized, or
   *      omitted for "all categories". Empty-string matches null
   *      threadCategoryId server-side.
   *   - `page`: 1-indexed page number. Defaults to 1.
   *   - `perPage`: bounded 5..100. When omitted, the admin-set
   *      site default (`forumTopicsPerPage`, migration 0193) is
   *      used. Clients can pass a tighter value for compact
   *      surfaces; the orphan-fetch path passes 1 to grab a
   *      specific topic by id, etc.
   *
   * Returns: `{ topics, page, perPage, totalPages, totalCount }`.
   * The client uses `totalPages` to render the numbered strip and
   * decides whether to disable Prev/Next based on `page`.
   *
   * Stickies behavior: stickies are returned on page 1 only,
   * BEFORE the non-sticky run, and are NOT counted against `perPage`.
   * The non-sticky run is paginated independently; `totalCount` and
   * `totalPages` describe the NON-STICKY pool only. This means
   * pages 2+ are pure-non-sticky timelines and page 1 carries
   * stickies as a header strip on top of `perPage` non-stickies.
   * Without that carve-out a page-1 with N stickies would push some
   * non-stickies into "the page after page 1", which made the page
   * numbers misleading.
   *
   * Deleted topics (`deletedAt` set) are excluded entirely, they
   * don't appear in the forum view for anyone (admins review via the
   * audit panel, not via topic listings).
   *
   * Auth: requires a logged-in user. Room membership / password is
   * NOT re-checked here because the user already had to join the
   * room (via `room:join` socket) to see the forum view in the
   * first place; the chat-message backlog (rooms/:id/messages) uses
   * the same model.
   */
  const topicsQuery = z.object({
    category: z.string().optional(),
    page: z.coerce.number().int().min(1).optional(),
    perPage: z.coerce.number().int().min(5).max(100).optional(),
    /**
     * LEGACY cursor, preserved so any in-flight clients running the
     * older "Load older" code path don't break mid-deploy. When
     * `before` is set we still cursor-page (no totalPages signal),
     * but `page` takes precedence when both arrive on the same
     * request. New clients should never set this.
     */
    before: z.coerce.number().int().positive().optional(),
    /** LEGACY alias for perPage on the cursor-page path. */
    limit: z.coerce.number().int().min(1).max(50).optional(),
  });

  app.get<{ Params: { id: string }; Querystring: unknown }>(
    "/rooms/:id/topics",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me && !(await boardAllowsAnonymousRead(req.params.id))) {
        reply.code(401); return { error: "auth" };
      }

      // Private board / category gate (migration 0239): non-members can't read
      // a members-only board at all, nor topics filed under a members-only
      // category. No-op for ordinary chat rooms.
      const readGate = await forumBoardReadGate(db, me, req.params.id);
      if (readGate.boardLocked) {
        reply.code(403);
        return { error: "This board is for forum members only.", code: "FORUM_BOARD_MEMBERS_ONLY" };
      }

      let q;
      try { q = topicsQuery.parse(req.query); }
      catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid query" }; }

      // Asking for a specific members-only category the viewer can't read.
      if (q.category && readGate.lockedCatIds.has(q.category)) {
        reply.code(403);
        return { error: "This category is for forum members only.", code: "FORUM_BOARD_MEMBERS_ONLY" };
      }

      const settings = await getSettings(db);
      const perPage = q.perPage ?? q.limit ?? settings.forumTopicsPerPage;
      const page = q.page ?? 1;
      // Cursor mode wins ONLY when no `page` was supplied AND a
      // `before` cursor IS supplied, that's the legacy "Load older"
      // call shape. Fresh clients always pass `page`, in which case
      // we ignore `before`.
      const useCursor = q.page === undefined && q.before !== undefined;
      const limit = perPage; // legacy `limit` was the page size; same alias.
      const roomId = req.params.id;

      // Build the WHERE clause. We always require:
      //   - same room
      //   - top-level (replyToId IS NULL)
      //   - not deleted
      // The category clause is conditional:
      //   - undefined → no filter (all categories)
      //   - ""        → threadCategoryId IS NULL (uncategorized)
      //   - <id>      → threadCategoryId === id
      // The cursor clause is also conditional:
      //   - undefined → first page
      //   - <ts>      → lastActivityAt < ts (older topics)
      const baseConditions = [
        eq(messages.roomId, roomId),
        isNull(messages.replyToId),
        isNull(messages.deletedAt),
        // Topics are `kind = "say"` (regular threads) or `"poll"` (poll
        // topics). The forum composer creates them with these kinds; replies
        // use "say". Every other top-level row, `system` (joins/leaves/watch
        // pings), `announce`, `scene`, `me`, `roll`, `npc`, `whisper`,
        // `ooc`, is a chat-shaped event, not a discussion thread, and must
        // not surface in the forum topics list.
        inArray(messages.kind, ["say", "poll"]),
      ];
      if (q.category !== undefined) {
        if (q.category === "") {
          baseConditions.push(isNull(messages.threadCategoryId));
        } else {
          baseConditions.push(eq(messages.threadCategoryId, q.category));
        }
      } else if (readGate.lockedCatIds.size) {
        // "All categories" view for a non-member: hide topics that live in a
        // members-only category, but keep uncategorized topics visible.
        baseConditions.push(
          or(
            isNull(messages.threadCategoryId),
            notInArray(messages.threadCategoryId, [...readGate.lockedCatIds]),
          )!,
        );
      }

      // Stickies are always returned on page 1 ONLY, and never count
      // against perPage, the non-sticky pool is paginated
      // independently below.
      let stickies: typeof messages.$inferSelect[] = [];
      if (useCursor ? q.before === undefined : page === 1) {
        // First page (both modes): pull every sticky for this scope.
        // Stickies are admin-set, so there should be few; no LIMIT.
        stickies = await db
          .select()
          .from(messages)
          .where(and(...baseConditions, eq(messages.isSticky, true)))
          .orderBy(desc(messages.lastActivityAt));
      }

      const nonStickyConditions = [...baseConditions, eq(messages.isSticky, false)];

      // Branch on pagination mode.
      let nonStickyPage: typeof messages.$inferSelect[];
      let hasMore: boolean;
      let totalCount = 0;
      let totalPages = 1;

      if (useCursor) {
        // Legacy cursor path, preserved for old clients mid-deploy.
        // No totals returned; the client either drops the new fields
        // (old code) or treats them as 0 (new code, but new code
        // shouldn't be hitting this path).
        if (q.before !== undefined) {
          nonStickyConditions.push(sql`${messages.lastActivityAt} < ${q.before}`);
        }
        const rows = await db
          .select()
          .from(messages)
          .where(and(...nonStickyConditions))
          .orderBy(desc(messages.lastActivityAt))
          .limit(limit + 1);
        hasMore = rows.length > limit;
        nonStickyPage = hasMore ? rows.slice(0, limit) : rows;
      } else {
        // Offset-paged numbered mode. We need the total count of
        // non-stickies in this scope so the client can render
        // numbered page controls. The COUNT runs in parallel with
        // the row fetch so we don't pay two sequential round-trips.
        const countRow = await db
          .select({ n: sql<number>`COUNT(*)` })
          .from(messages)
          .where(and(...nonStickyConditions));
        totalCount = Number(countRow[0]?.n ?? 0);
        totalPages = Math.max(1, Math.ceil(totalCount / perPage));
        const offset = (page - 1) * perPage;
        nonStickyPage = await db
          .select()
          .from(messages)
          .where(and(...nonStickyConditions))
          .orderBy(desc(messages.lastActivityAt))
          .limit(perPage)
          .offset(offset);
        // `hasMore` is preserved for back-compat on the wire shape;
        // new clients drive Next/Prev off totalPages instead.
        hasMore = page < totalPages;
      }

      const pageRows = [...stickies, ...nonStickyPage];

      // Per-server author flair (Servers Lift): light up each topic card with
      // the rank sigil / avatar-border / name style the author earned ON THE
      // SERVER THIS BOARD'S FORUM IS AFFILIATED TO (`forums.serverId`). Resolve
      // the affiliation via the room's `forumId`. When the room isn't a forum
      // board (`forumId` NULL) OR the forum has no affiliation (`serverId`
      // NULL), we ship NO `author*` fields and the cards render bare — the gate
      // is `sid !== null`. Flag-off / non-forum rooms therefore stay byte-
      // identical. We reuse `resolveTopicAuthorFlair` (the same batched,
      // `sid`-scoped cosmetic read the in-modal board route uses) so the two
      // surfaces never diverge.
      const sid = (
        await db
          .select({ serverId: forums.serverId })
          .from(rooms)
          .innerJoin(forums, eq(forums.id, rooms.forumId))
          .where(eq(rooms.id, roomId))
          .limit(1)
      )[0]?.serverId ?? null;
      const flairByIdentity = sid
        ? await resolveTopicAuthorFlair(
            db,
            sid,
            pageRows.map((m) => ({ userId: m.userId, characterId: m.characterId ?? null })),
          )
        : null;

      const canSeeOriginalBody = me ? await hasPermission(me, "view_deleted_message_body", db) : false;
      const topics: ChatMessage[] = pageRows.map((m) => {
        // Bare card unless the board's forum is affiliated. When affiliated,
        // spread the resolved per-server flair (its individual values may be
        // null for an author who hasn't earned/equipped that cosmetic there).
        // These ship together-or-not-at-all so the client's "did the server
        // send flair" gate holds, and the client prefers the per-server
        // `authorRankKey`/`authorTier` over the post-time `rankKey`/`tier`
        // snapshot below so a (re)affiliated forum shows CURRENT flair.
        const flair = flairByIdentity?.get(`${m.userId}::${m.characterId ?? ""}`) ?? null;
        return {
          id: m.id,
          roomId: m.roomId,
          userId: m.userId,
          characterId: m.characterId,
          displayName: m.displayName,
          kind: m.kind,
          body: m.body,
          color: m.color,
          createdAt: +m.createdAt,
          ...(m.toUserId ? { toUserId: m.toUserId } : {}),
          ...(m.toDisplayName ? { toDisplayName: m.toDisplayName } : {}),
          ...(m.replyToId ? { replyToId: m.replyToId } : {}),
          ...(m.replyToDisplayName ? { replyToDisplayName: m.replyToDisplayName } : {}),
          ...(m.replyToBodySnippet ? { replyToBodySnippet: m.replyToBodySnippet } : {}),
          ...(m.moodSnapshot ? { moodSnapshot: m.moodSnapshot } : {}),
          ...(m.npcVoicedBy ? { npcVoicedBy: m.npcVoicedBy } : {}),
          ...(m.npcStatsJson ? { npcStats: parseNpcStats(m.npcStatsJson) } : {}),
          ...(m.threadCategoryId ? { threadCategoryId: m.threadCategoryId } : {}),
          ...(m.title ? { title: m.title } : {}),
          ...(m.prefixId ? { prefixId: m.prefixId } : {}),
          ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
          ...(m.editedAt ? { editedAt: +m.editedAt } : {}),
          ...(m.deletedAt ? { deletedAt: +m.deletedAt } : {}),
          ...(m.lockedAt ? { lockedAt: +m.lockedAt } : {}),
          ...(m.lastActivityAt ? { lastActivityAt: +m.lastActivityAt } : {}),
          ...(m.isSticky ? { isSticky: true } : {}),
          ...(m.cmdCss ? { cmdCss: m.cmdCss } : {}),
          ...((() => { const lp = linkPreviewFromRow(m.linkPreviewJson); return lp ? { linkPreview: lp } : {}; })()),
          ...(m.sceneImageUrl ? { sceneImageUrl: m.sceneImageUrl } : {}),
          ...(m.bodyHtml ? { bodyHtml: m.bodyHtml } : {}),
          ...mentionsField(m.mentionsJson),
          ...(m.rankKey ? { rankKey: m.rankKey } : {}),
          ...(m.tier != null ? { tier: m.tier } : {}),
          ...(canSeeOriginalBody && m.deletedAt ? { originalBody: m.body } : {}),
          ...(flair
            ? {
                authorRankKey: flair.rankKey,
                authorTier: flair.tier,
                authorSelectedBorderRankKey: flair.selectedBorderRankKey,
                authorSelectedFreeformBorderKey: flair.selectedFreeformBorderKey,
                authorFreeformBorderConfig: flair.freeformBorderConfig,
                authorNameStyleKey: flair.nameStyleKey,
                authorNameStyleConfig: flair.nameStyleConfig,
              }
            : {}),
        };
      });
      // Reply counts per topic, so the COLLAPSED topic card shows the
      // true count without first opening the thread. Forum replies always
      // attach directly to the topic (`replyToId === topicId`; reply-to-
      // reply isn't a thing), so a single grouped count is exact. One
      // indexed IN lookup, bounded by perPage. Deleted replies excluded
      // to match the thread view. Harmless (0) for standalone nested rooms.
      const topicIdsForCount = pageRows.map((m) => m.id);
      const replyCountRows = topicIdsForCount.length
        ? await db
            .select({ parentId: messages.replyToId, n: sql<number>`count(*)` })
            .from(messages)
            .where(and(inArray(messages.replyToId, topicIdsForCount), isNull(messages.deletedAt)))
            .groupBy(messages.replyToId)
        : [];
      const replyCountBy = new Map(replyCountRows.map((r) => [r.parentId, Number(r.n)]));
      for (const t of topics) t.replyCount = replyCountBy.get(t.id) ?? 0;

      // Hydrate poll state on poll topics so the card renders the PollCard
      // (and the viewer's own ballot) without opening the thread first.
      const pollJsonById = new Map(pageRows.filter((m) => m.kind === "poll").map((m) => [m.id, m.pollDataJson]));
      for (const t of topics) {
        if (t.kind !== "poll") continue;
        const state = await loadPollState(db, t.id, me?.id ?? null, pollJsonById.get(t.id) ?? null);
        if (state) t.poll = state;
      }
      // Response shape:
      //   - `topics`, `hasMore` are kept for back-compat with any
      //     in-flight client that still consumed only these.
      //   - `page`, `perPage`, `totalPages`, `totalCount` are the
      //     new offset-pagination signals. On cursor-mode requests
      //     totalPages/totalCount are 0 since we don't compute them
      //     (would be an extra COUNT for a path nobody should be
      //     hitting going forward).
      // Per-viewer forum signals for THIS page's topics: unread (topic
      // activity newer than the viewer's read marker, or never opened)
      // and watched (subscription bell state). Two indexed IN lookups,
      // bounded by perPage. Only meaningful for forum boards, but
      // harmless (empty) for standalone nested rooms.
      let unreadTopicIds: string[] = [];
      let watchedTopicIds: string[] = [];
      const pageIds = topics.map((t) => t.id);
      if (me && pageIds.length > 0) {
        const { forumTopicReads, forumTopicWatches } = await import("../db/schema.js");
        const reads = await db
          .select({ topicId: forumTopicReads.topicId, lastReadAt: forumTopicReads.lastReadAt })
          .from(forumTopicReads)
          .where(and(eq(forumTopicReads.userId, me.id), inArray(forumTopicReads.topicId, pageIds)));
        const readAtBy = new Map(reads.map((r) => [r.topicId, +r.lastReadAt]));
        unreadTopicIds = topics
          .filter((t) => {
            if (t.userId === me.id && !readAtBy.has(t.id)) return false; // your own fresh topic isn't "unread"
            const seen = readAtBy.get(t.id);
            const last = +(t.lastActivityAt ?? t.createdAt);
            return seen === undefined || last > seen;
          })
          .map((t) => t.id);
        const watches = await db
          .select({ topicId: forumTopicWatches.topicId })
          .from(forumTopicWatches)
          .where(and(eq(forumTopicWatches.userId, me.id), inArray(forumTopicWatches.topicId, pageIds)));
        watchedTopicIds = watches.map((w) => w.topicId);
      }

      return {
        topics,
        hasMore,
        page: useCursor ? null : page,
        perPage,
        totalPages: useCursor ? 0 : totalPages,
        totalCount: useCursor ? 0 : totalCount,
        unreadTopicIds,
        watchedTopicIds,
      };
    },
  );

  /**
   * GET /rooms/:id/thread-categories, list the admin-defined thread
   * buckets for a room. Returned in the same `sortOrder asc, createdAt
   * asc` order the renderer applies, so the client can use the list
   * verbatim without re-sorting. Visible to any logged-in user (the
   * composer's category picker is the primary consumer); a non-member
   * peeking at the categories of a private room won't leak content,
   * since the picker is only meaningful AFTER you've joined.
   */
  app.get<{ Params: { id: string } }>("/rooms/:id/thread-categories", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me && !(await boardAllowsAnonymousRead(req.params.id))) {
      reply.code(401); return { error: "auth" };
    }
    // A private board's category list is itself withheld from non-members.
    const readGate = await forumBoardReadGate(db, me, req.params.id);
    if (readGate.boardLocked) {
      reply.code(403);
      return { error: "This board is for forum members only.", code: "FORUM_BOARD_MEMBERS_ONLY" };
    }
    const cats = await db
      .select()
      .from(roomThreadCategories)
      .where(eq(roomThreadCategories.roomId, req.params.id))
      .orderBy(asc(roomThreadCategories.sortOrder), asc(roomThreadCategories.createdAt));
    const out: ThreadCategory[] = cats.map((c) => ({
      id: c.id,
      roomId: c.roomId,
      name: c.name,
      sortOrder: c.sortOrder,
      createdAt: +c.createdAt,
      iconUrl: c.iconUrl ?? null,
      subtitle: c.subtitle ?? null,
      parentId: c.parentId ?? null,
      // Shown-but-locked: keep the chip but mark it so the client renders the
      // lock and never lets a non-member select into it.
      membersOnly: !!c.membersOnly,
      // Locked FOR THIS VIEWER (members-only + not a member). Drives hiding the
      // "+ New Topic" action so nobody opens an editor for a category the read
      // gate will then withhold. Empty set ⇒ false for non-board rooms.
      locked: readGate.lockedCatIds.has(c.id),
    }));
    return { categories: out };
  });

  /**
   * Admin: create a thread category. Allowed for site admin or room
   * owner (mirrors the room-edit pattern in admin/routes.ts). Returns
   * 409 on case-insensitive name conflict within the same room.
   */
  const createCategoryBody = z.object({
    name: z.string().min(1).max(40),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    subtitle: z.string().trim().max(140).nullable().optional(),
    /** Parent category (same room, itself top-level) ⇒ create a SUBcategory. */
    parentId: z.string().nullable().optional(),
    /** Private category (migration 0239): owner/mods/members only. */
    membersOnly: z.boolean().optional(),
  }).strict();

  /** Validate a requested parent for one-level nesting: must exist in
   *  this room, must be top-level itself, and (for moves) must not be
   *  the category or one of its children. Returns an error string. */
  async function validateCategoryParent(roomId: string, parentId: string, selfId?: string): Promise<string | null> {
    if (selfId && parentId === selfId) return "a category can't be its own parent";
    const parent = (await db
      .select()
      .from(roomThreadCategories)
      .where(and(eq(roomThreadCategories.id, parentId), eq(roomThreadCategories.roomId, roomId)))
      .limit(1))[0];
    if (!parent) return "parent category not found in this board";
    if (parent.parentId) return "subcategories can't have their own subcategories";
    return null;
  }

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/admin/rooms/:id/thread-categories",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.id)).limit(1))[0];
      if (!room) { reply.code(404); return { error: "no room" }; }
      const isOwner = room.ownerId === me.id;
      if (!(isOwner || (await hasPermission(me, "edit_any_room_metadata", db)))) {
        reply.code(403);
        return { error: "admin or room owner only" };
      }
      let body;
      try { body = createCategoryBody.parse(req.body); }
      catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }

      if (body.parentId) {
        const parentErr = await validateCategoryParent(room.id, body.parentId);
        if (parentErr) { reply.code(400); return { error: parentErr }; }
      }
      const id = nanoid();
      try {
        await db.insert(roomThreadCategories).values({
          id,
          roomId: room.id,
          name: body.name.trim(),
          sortOrder: body.sortOrder ?? 0,
          subtitle: body.subtitle?.trim() ? body.subtitle.trim() : null,
          parentId: body.parentId ?? null,
          membersOnly: body.membersOnly ?? false,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (/UNIQUE/i.test(msg)) {
          reply.code(409);
          return { error: "a category with that name already exists in this room" };
        }
        throw err;
      }
      return { id };
    },
  );

  const patchCategoryBody = z.object({
    name: z.string().min(1).max(40).optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    subtitle: z.string().trim().max(140).nullable().optional(),
    /** Move under a top-level parent (one level), or null → top level. */
    parentId: z.string().nullable().optional(),
    /** Private category (migration 0239): owner/mods/members only. */
    membersOnly: z.boolean().optional(),
  }).strict();

  app.patch<{ Params: { id: string; catId: string }; Body: unknown }>(
    "/admin/rooms/:id/thread-categories/:catId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.id)).limit(1))[0];
      if (!room) { reply.code(404); return { error: "no room" }; }
      const isOwner = room.ownerId === me.id;
      if (!(isOwner || (await hasPermission(me, "edit_any_room_metadata", db)))) {
        reply.code(403);
        return { error: "admin or room owner only" };
      }
      const row = (await db
        .select()
        .from(roomThreadCategories)
        .where(and(
          eq(roomThreadCategories.id, req.params.catId),
          eq(roomThreadCategories.roomId, room.id),
        ))
        .limit(1))[0];
      if (!row) { reply.code(404); return { error: "category not found" }; }

      let body;
      try { body = patchCategoryBody.parse(req.body); }
      catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }

      const update: Partial<typeof roomThreadCategories.$inferInsert> = {};
      if (body.name !== undefined) update.name = body.name.trim();
      if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
      if (body.membersOnly !== undefined) update.membersOnly = body.membersOnly;
      if (body.subtitle !== undefined) {
        update.subtitle = body.subtitle?.trim() ? body.subtitle.trim() : null;
      }
      if (body.parentId !== undefined) {
        if (body.parentId !== null) {
          const parentErr = await validateCategoryParent(room.id, body.parentId, row.id);
          if (parentErr) { reply.code(400); return { error: parentErr }; }
          // A category that has children of its own can't become a child
          // (that would create a second nesting level under the hood).
          const child = (await db
            .select({ id: roomThreadCategories.id })
            .from(roomThreadCategories)
            .where(eq(roomThreadCategories.parentId, row.id))
            .limit(1))[0];
          if (child) { reply.code(400); return { error: "move or delete its subcategories first" }; }
        }
        update.parentId = body.parentId;
      }
      if (Object.keys(update).length === 0) return { ok: true };
      try {
        await db.update(roomThreadCategories).set(update).where(eq(roomThreadCategories.id, row.id));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (/UNIQUE/i.test(msg)) {
          reply.code(409);
          return { error: "a category with that name already exists in this room" };
        }
        throw err;
      }
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; catId: string } }>(
    "/admin/rooms/:id/thread-categories/:catId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.id)).limit(1))[0];
      if (!room) { reply.code(404); return { error: "no room" }; }
      const isOwner = room.ownerId === me.id;
      if (!(isOwner || (await hasPermission(me, "edit_any_room_metadata", db)))) {
        reply.code(403);
        return { error: "admin or room owner only" };
      }
      // FK `ON DELETE SET NULL` on messages.thread_category_id means any
      // existing thread anchored to this bucket falls back to
      // "Uncategorized", history is preserved.
      await db
        .delete(roomThreadCategories)
        .where(and(
          eq(roomThreadCategories.id, req.params.catId),
          eq(roomThreadCategories.roomId, room.id),
        ));
      return { ok: true };
    },
  );
}
