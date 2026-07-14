/**
 * Cross-room message search, scoped to a whole SERVER (extended-LIKE v1).
 *
 * The in-rail SearchBar can search either a single room (the existing
 * `GET /rooms/:id/messages/search` in rooms.ts) or the ACTIVE SERVER. This
 * route is the "This server" side: it widens the hunt across every room the
 * viewer may see inside one server, returning each hit with its room + server
 * context so the client can render a breadcrumb ("in <room>" / "on <server>").
 *
 * PRIVACY IS THE WHOLE JOB. A cross-room search is a broadcast read: a single
 * missed visibility class leaks content the viewer could never otherwise see.
 * So the VISIBLE ROOM SET is computed server-side from EVERY gate the live
 * surfaces use, fail-closed, before a single body is scanned:
 *
 *   1. serverAuthority  — a suspended/banned server (migration 0306) is
 *      searchable ONLY by its staff; everyone else gets an empty result, same
 *      as the room can't be entered at all.
 *   2. Private rooms    — included ONLY when the viewer holds a `room_members`
 *      row (site admins are NOT bypassed; private chat stays private, matching
 *      the per-room search + bookmark gates).
 *   2b. room_role_gates  — a kind='access' row locks the room to holders of
 *      the gated usergroups (plus room owner / server staff / site staff);
 *      non-holders' searches never touch it, matching the rail/join/slug 404s.
 *   3. forumBoardReadGate — a members-only board is dropped wholesale; a board
 *      with members-only CATEGORIES is kept, but hits whose topic sits in a
 *      locked category are filtered out (replies inherit their topic's
 *      category, resolved off the topic exactly like the forum permalink).
 *   4. roomVisibilityWhere semantics — whispers are visible only to a party;
 *      targeted system rows only to their recipient; system noise + soft-
 *      deleted bodies are excluded outright.
 *   5. blockedUserIdsFor — any hit authored by an account the viewer is
 *      mutually blocked with is dropped (a block is global + per-master, so we
 *      drop by author userId).
 *
 * Ranking mirrors the per-room search: a LIKE candidate scan, an in-memory
 * frequency score (occurrences of the query in the body), recency tiebreaker.
 * SQLite FTS5 is the future upgrade; v1 is extended-LIKE, no migration.
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { isModeratorRole, type MessageSearchHit, type Role } from "@thekeep/shared";
import { messages, roomMembers, rooms, servers } from "../db/schema.js";
import { blockedUserIdsFor } from "../auth/blocks.js";
import { isolationVisibleSql } from "../auth/ageIsolation.js";
import { canSeeNsfw } from "../auth/ageGate.js";
import { maskForMinors } from "../realtime/minorLanguageFilter.js";
import { effectiveRoomNsfwWith, nsfwServerIds } from "../lib/nsfwRooms.js";
import {
  loadRoleGates,
  roleAccessDeniedWith,
  roomModRoomIdsFor,
  staffServerIdsFor,
  usergroupIdsFor,
} from "../lib/roleGates.js";
import { nsfwForumIds } from "../forums/nsfw.js";
import { forumBoardReadGate } from "../forums/authority.js";
import { serverAuthority } from "../servers/authority.js";
import { isServerModerationActive } from "../servers/moderation.js";
import { areServersEnabled, getSettings } from "../settings.js";
import { DEFAULT_SERVER_ID } from "../earning/pool.js";
import { escapeLike } from "../lib/nameLookup.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "./auth.js";

/**
 * The subset of a room row this route needs to resolve visibility + context.
 * Selected explicitly so a schema growth spurt doesn't drag extra columns
 * into the candidate scan.
 */
interface RoomForSearch {
  id: string;
  name: string;
  type: "public" | "private";
  forumId: string | null;
  serverId: string | null;
}

/**
 * Resolve the set of rooms inside `targetServerId` this viewer may search,
 * plus each visible room's name and the per-board locked-category set (empty
 * for non-forum rooms). Returns null when the server is moderated and the
 * viewer isn't staff (⇒ empty search, handled by the caller).
 *
 * The default (is_system) server ADOPTS orphan rooms (`server_id IS NULL`),
 * exactly like the `/rooms` rail query — so a freshly-created room that hasn't
 * been stamped yet is still searchable on the default server. Any other server
 * gets a strict `server_id = ?` match.
 */
async function visibleRoomsForServer(
  db: Db,
  // NsfwViewer fields (birthdate + hideNsfw) ride along so the room
  // universe can key on the SOFT tier (canSeeNsfw); the session satisfies
  // this structurally.
  me: { id: string; role: Role; isAdult: boolean; birthdate: string | null; hideNsfw: boolean },
  targetServerId: string,
  serversOn: boolean,
): Promise<{ rooms: Map<string, RoomForSearch>; lockedCatsByRoom: Map<string, Set<string>> } | null> {
  // serverAuthority moderation gate: a suspended/banned server is searchable
  // only by its owner/admins/mods (or global staff). Skip the check for the
  // default server (never moderated) and when the servers flag is off (every
  // room resolves to the default, so there is no sub-server to moderate).
  if (serversOn && targetServerId !== DEFAULT_SERVER_ID) {
    const sa = await serverAuthority(db, me, targetServerId);
    // No such server ⇒ nothing to search (fail closed, don't fall back to all).
    if (!sa.server) return null;
    if (isServerModerationActive(sa.server) && !sa.isMod) return null;
  }

  // Candidate room universe for this server. Mirrors the `/rooms` rail scope:
  // default server adopts NULL-serverId rooms; other servers match strictly.
  // Off the servers flag, every room is on the default server, so we take the
  // whole non-archived table (byte-identical to the pre-lift single-scope).
  const serverScope = serversOn
    ? targetServerId === DEFAULT_SERVER_ID
      ? or(eq(rooms.serverId, targetServerId), isNull(rooms.serverId))
      : eq(rooms.serverId, targetServerId)
    : undefined;

  const candidateRows = await db
    .select({
      id: rooms.id,
      name: rooms.name,
      type: rooms.type,
      forumId: rooms.forumId,
      serverId: rooms.serverId,
      ownerId: rooms.ownerId,
      isNsfw: rooms.isNsfw,
      // Staff-only rooms (migration 0363) must drop out of the searchable
      // universe for non-staff too, or a cross-room search leaks their bodies.
      staffOnly: rooms.staffOnly,
    })
    .from(rooms)
    .where(and(isNull(rooms.archivedAt), serverScope));

  // SOFT-tier universe exclusion (age plan, Phase 2/3): effectively-18+
  // rooms (own flag OR the server's) and whole 18+ FORUMS' boards fall out
  // of the searchable universe for every viewer who can't see NSFW —
  // minors AND adults with "Hide 18+ content" on. The forum tier and
  // pre-flip rows of 18+ rooms are never message-stamped, so the per-row
  // `canSeeNsfw` clause in the candidate scan can't catch them: keying the
  // universe on the SOFT tier is what keeps a hide-pref adult's results
  // consistent with the catalog/discover/topic lists that same preference
  // already filters. Direct links (the thread route) still open for them —
  // the HARD tier is unchanged.
  const nsfwServers = canSeeNsfw(me) ? null : await nsfwServerIds(db);
  const nsfwForums = canSeeNsfw(me) ? null : await nsfwForumIds(db);

  // The viewer's private-room memberships (one query, not per-room). A private
  // room is searchable ONLY when the viewer holds a members row; site admins
  // are deliberately NOT bypassed, matching the per-room search + bookmark gate.
  const myMemberRows = await db
    .select({ roomId: roomMembers.roomId })
    .from(roomMembers)
    .where(eq(roomMembers.userId, me.id));
  const myRoomIds = new Set(myMemberRows.map((r) => r.roomId));

  // Role-locked rooms (room_role_gates, migration 0349): a kind='access' row
  // makes the room invisible to non-holders on EVERY surface (rail, join,
  // by-slug, messages), so the searchable universe must drop it too or a
  // cross-room search becomes the one read that leaks its bodies. Same
  // batched shape as GET /rooms: one gate read for the whole candidate set,
  // then at most one membership + one staff read for the viewer.
  // Staff-only rooms (rooms.staff_only, migration 0363) drop from the search
  // universe the same way — a whole SEPARATE axis (no gate row), so detect it
  // off the room column and fold it into the same deny filter below.
  const roleGates = await loadRoleGates(db, candidateRows.map((r) => r.id));
  const hasAccessGates = [...roleGates.values()].some((g) => g.access.size > 0);
  const hasStaffOnly = candidateRows.some((r) => r.staffOnly);
  const gatesActive = hasAccessGates || hasStaffOnly;
  const isSiteStaff = isModeratorRole(me.role);
  const viewerGroupIds = hasAccessGates ? await usergroupIdsFor(db, me.id) : new Set<string>();
  const roleStaffServerIds = gatesActive && !isSiteStaff
    ? await staffServerIdsFor(db, me.id)
    : new Set<string>();
  // Staff-only rooms additionally admit the room's own mods.
  const staffRoomModIds = hasStaffOnly && !isSiteStaff
    ? await roomModRoomIdsFor(db, me.id, candidateRows.filter((r) => r.staffOnly).map((r) => r.id))
    : new Set<string>();

  const visible = new Map<string, RoomForSearch>();
  const lockedCatsByRoom = new Map<string, Set<string>>();

  for (const r of candidateRows) {
    if (nsfwServers && effectiveRoomNsfwWith(r, nsfwServers)) continue;
    if (nsfwForums && r.forumId && nsfwForums.has(r.forumId)) continue;
    if (r.type === "private" && !myRoomIds.has(r.id)) continue;
    if (
      gatesActive
      && roleAccessDeniedWith(me, r, roleGates.get(r.id)?.access, viewerGroupIds, roleStaffServerIds, staffRoomModIds)
    ) continue;

    if (r.forumId) {
      // Forum board: consult the per-section read gate. A fully members-only
      // board is dropped; otherwise keep it and remember which categories are
      // locked so we can filter topic-in-locked-category hits below.
      const gate = await forumBoardReadGate(db, me, r.id);
      if (gate.boardLocked) continue;
      if (gate.lockedCatIds.size > 0) lockedCatsByRoom.set(r.id, gate.lockedCatIds);
    }

    visible.set(r.id, {
      id: r.id,
      name: r.name,
      type: r.type,
      forumId: r.forumId,
      serverId: r.serverId,
    });
  }

  return { rooms: visible, lockedCatsByRoom };
}

export async function registerSearchRoutes(app: FastifyInstance, db: Db): Promise<void> {
  /**
   * GET /search/messages?q=<term>&serverId=<id>&limit=20
   *
   * Server-wide message search. `serverId` omitted ⇒ the default (system)
   * server. Auth-required. Rate-limited 30/min per IP, exactly like the
   * per-room search (a comparably heavy LIKE scan, now fanned across a server).
   */
  app.get<{ Querystring: { q?: string; serverId?: string; limit?: string } }>(
    "/search/messages",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }

      const q = (req.query.q ?? "").trim();
      if (!q) return { hits: [] as MessageSearchHit[] };
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit ?? "20", 10) || 20));

      const settings = await getSettings(db);
      const serversOn = areServersEnabled(settings);
      // Off the servers flag OR no param ⇒ the default server (which then adopts
      // every room, so "this server" == "everything the viewer can see").
      const targetServerId =
        serversOn && typeof req.query.serverId === "string" && req.query.serverId.trim()
          ? req.query.serverId.trim()
          : DEFAULT_SERVER_ID;

      const scope = await visibleRoomsForServer(db, me, targetServerId, serversOn);
      // Moderated server the viewer can't enter (or an unknown id) ⇒ empty, not
      // an error: same as the room being invisible in the rail.
      if (!scope || scope.rooms.size === 0) return { hits: [] as MessageSearchHit[] };

      const roomIds = [...scope.rooms.keys()];
      const like = `%${escapeLike(q)}%`;

      // Candidate scan: bodies matching the query in any visible room, minus
      // system noise + soft-deletes, with whispers filtered to a party. This is
      // the `roomVisibilityWhere` contract expressed inline (system rows are
      // excluded outright, so the targeted-recipient class is moot here).
      const rows = await db
        .select()
        .from(messages)
        .where(and(
          inArray(messages.roomId, roomIds),
          isNull(messages.deletedAt),
          sql`${messages.kind} != 'system'`,
          // Rich-format rows (migration 0352) match on their VISIBLE
          // text mirror so markup bytes can neither hide a hit nor
          // fabricate one; md rows keep matching the raw body.
          sql`COALESCE(${messages.bodyText}, ${messages.body}) LIKE ${like} ESCAPE '\\'`,
          // SOFT tier (age plan, Phase 2): rows stamped 18+ at write time —
          // a flipped-back room's 18+ era, and Phase 3's NSFW topic titles/
          // bodies — are dropped for minors, anonymous never reaches this
          // route, and adults with "Hide 18+ content" opt out here too.
          ...(canSeeNsfw(me) ? [] : [eq(messages.isNsfw, false)]),
          // Isolation (age plan, Phase 5): hits authored by an account the
          // viewer is isolated with drop in SQL, alongside the in-memory
          // blocked-author filter below. Undefined for non-isolating
          // viewer classes, so the common query shape is untouched.
          isolationVisibleSql(me, messages.userId),
          or(
            sql`${messages.kind} != 'whisper'`,
            eq(messages.userId, me.id),
            eq(messages.toUserId, me.id),
          ),
        ))
        .orderBy(desc(messages.createdAt))
        // Overfetch so the in-memory rank + block/category filters have options
        // before the final trim. Fanned across a server, so a wider net.
        .limit(limit * 8);

      // Mutual-block filter: drop any hit authored by an account the viewer is
      // blocked with (block is global + per-master ⇒ filter by author userId).
      const blocked = await blockedUserIdsFor(db, me.id);

      // Locked-category filter for forum boards: a reply inherits its topic's
      // category, so resolve the category off the TOPIC (replyToId ?? id). We
      // batch the parent lookups for replies in locked-category boards only.
      const lockedRoomIds = new Set(scope.lockedCatsByRoom.keys());
      const parentIdsToResolve = new Set<string>();
      for (const m of rows) {
        if (m.replyToId && lockedRoomIds.has(m.roomId)) parentIdsToResolve.add(m.replyToId);
      }
      const parentCatById = new Map<string, string | null>();
      if (parentIdsToResolve.size > 0) {
        const parents = await db
          .select({ id: messages.id, cat: messages.threadCategoryId })
          .from(messages)
          .where(inArray(messages.id, [...parentIdsToResolve]));
        for (const p of parents) parentCatById.set(p.id, p.cat ?? null);
      }

      const inLockedCategory = (m: typeof rows[number]): boolean => {
        const locked = scope.lockedCatsByRoom.get(m.roomId);
        if (!locked) return false;
        const catId = m.replyToId
          ? parentCatById.get(m.replyToId) ?? null
          : m.threadCategoryId ?? null;
        return !!catId && locked.has(catId);
      };

      const needle = q.toLowerCase();
      const hits = rows
        .filter((m) => !blocked.has(m.userId) && !inLockedCategory(m))
        .map((m): MessageSearchHit & { _ts: number } => {
          const matchText = m.format === "html" ? (m.bodyText ?? "") : m.body;
          const lc = matchText.toLowerCase();
          let count = 0;
          let idx = 0;
          while ((idx = lc.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
          const room = scope.rooms.get(m.roomId);
          // Effective server for context: the room's own server (NULL adopts the
          // default), which for this route is always `targetServerId`.
          const effectiveServerId = room?.serverId ?? targetServerId;
          return {
            id: m.id,
            roomId: m.roomId,
            userId: m.userId,
            displayName: m.displayName,
            kind: m.kind,
            snippet: matchText,
            createdAt: +m.createdAt,
            relevance: count,
            ...(m.replyToId ? { replyToId: m.replyToId } : {}),
            ...(room?.name ? { roomName: room.name } : {}),
            serverId: effectiveServerId,
            ...(m.title ? { title: m.title } : {}),
            _ts: +m.createdAt,
          };
        });
      hits.sort((a, b) => b.relevance - a.relevance || b._ts - a._ts);
      const top = hits.slice(0, limit);

      // Enrich with the server NAME once (single lookup, not per-hit). The
      // default server always resolves; a sub-server row is fetched by id.
      const serverName = await resolveServerName(db, targetServerId);
      const trimmed = top.map(({ _ts, ...rest }) => ({
        ...rest,
        ...(serverName ? { serverName } : {}),
      }));

      // Minor language filter (§J): snippets are raw bodies and titles are
      // raw topic titles — mask both for an under-18 viewer. Per-viewer
      // response objects, so in-place replacement is safe; adults skip the
      // loop entirely (byte-identical).
      if (!me.isAdult) {
        for (const h of trimmed) {
          h.snippet = maskForMinors(h.snippet) ?? h.snippet;
          if (h.title) h.title = maskForMinors(h.title) ?? h.title;
        }
      }

      return { hits: trimmed };
    },
  );
}

/**
 * The display name for a server id, or null when unknown. Cheap single-row
 * lookup; the caller resolves it once per request (all hits share one server).
 */
async function resolveServerName(db: Db, serverId: string): Promise<string | null> {
  const row = (await db
    .select({ name: servers.name })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1))[0];
  return row?.name ?? null;
}
