import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import { roleRank, type ClientToServerEvents, type ServerToClientEvents } from "@thekeep/shared";
import { hasPermission } from "../auth/permissions.js";
import { auditLog, characters, messages, sessions, userEarning, userIpLog, users } from "../db/schema.js";
import { getSessionUser } from "./auth.js";
import { blockedUserIdsFor } from "../auth/blocks.js";
import { recordAudit } from "../audit.js";
import { canonicalizeNameForLookup, loweredSpaceCanonical, substringNameInsensitive } from "../lib/nameLookup.js";
import { DEFAULT_SERVER_ID } from "../earning/pool.js";
import type { Db } from "../db/index.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

const MAX_LIMIT = 200;
/**
 * Ceiling on the in-memory sort path. Modes like "online" + "messages"
 * (and any query carrying a `?rank=` filter) need the FULL matched set
 * loaded to sort correctly, so we can't push pagination into SQL for
 * them. To prevent the route from OOMing on a directory of tens of
 * thousands of users, we refuse the request past this cap and ask the
 * caller to narrow with `?q=` first. The cap is generous enough that
 * realistic populations + a search-as-you-type UI never trip it.
 */
const MAX_INMEMORY_SORT_USERS = 5000;

/**
 * Public-facing user directory endpoint. Authenticated users only - we don't
 * leak the registered population to the public internet. Each row carries
 * the master account plus that account's characters so the UI can render
 * them grouped (master on top, characters indented underneath).
 *
 * Sensitive fields (email, role, IP) are NOT included; admin tooling has its
 * own /admin/users that includes them.
 */
export async function registerUsersRoutes(
  app: FastifyInstance,
  db: Db,
  io: Io,
): Promise<void> {
  /**
   * Member-spotlight resolver for the {users:latest|random} and
   * {users:character:latest|random} UI-route chips. Returns ONE member
   * to open: a `token` (username for masters, `@cid:<id>` for
   * characters) the client feeds to `profile:fetch`, plus a
   * `displayName` for the chip label.
   *
   * Discovery posture mirrors `lookupRandomProfile`: only public,
   * non-NSFW, non-disabled identities (and never the system account) so
   * a chip can't surface a hidden/disabled/NSFW member. `latest` =
   * newest by createdAt; `random` = a uniform SQL pick (re-rolls each
   * call, so the client must not cache it).
   */
  app.get<{ Querystring: { scope?: string; pick?: string } }>("/members/spotlight", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const scope = req.query.scope === "character" ? "character" : "user";
    const pick = req.query.pick === "random" ? "random" : "latest";

    if (scope === "user") {
      const row = (await db
        .select({ username: users.username })
        .from(users)
        .where(and(
          isNull(users.disabledAt),
          eq(users.isPublic, true),
          eq(users.isNsfw, false),
          sql`${users.username} != 'system'`,
        ))
        .orderBy(pick === "random" ? sql`RANDOM()` : desc(users.createdAt))
        .limit(1))[0];
      return { member: row ? { token: row.username, displayName: row.username } : null };
    }

    const row = (await db
      .select({ id: characters.id, name: characters.name })
      .from(characters)
      .innerJoin(users, eq(users.id, characters.userId))
      .where(and(
        isNull(characters.deletedAt),
        isNull(users.disabledAt),
        eq(characters.isPublic, true),
        eq(characters.isNsfw, false),
      ))
      .orderBy(pick === "random" ? sql`RANDOM()` : desc(characters.createdAt))
      .limit(1))[0];
    return { member: row ? { token: `@cid:${row.id}`, displayName: row.name } : null };
  });

  app.get<{ Querystring: { q?: string; offset?: string; limit?: string; rank?: string; sort?: string } }>("/users", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    const q = (req.query.q ?? "").trim().toLowerCase();
    const offset = Math.max(0, parseInt(req.query.offset ?? "0", 10) || 0);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit ?? "100", 10) || 100));
    // Optional rank filter (master pool rank). Empty string / missing
    // disables the filter. We don't validate against the rank catalog
    // here, an unknown key just returns zero matches, which is the
    // same shape an admin-disabled rank would produce.
    const rankFilter = (req.query.rank ?? "").trim();
    // Sort mode. Default mirrors the historic behavior: online first,
    // then alphabetical. New modes let the UI surface "most active"
    // and "newest" without paging through everyone alphabetically.
    const sortMode: "online" | "messages" | "joined" | "name" = (() => {
      const s = (req.query.sort ?? "").trim().toLowerCase();
      if (s === "messages" || s === "joined" || s === "name") return s;
      return "online";
    })();

    // Match search query against master username OR any of the user's
    // character names. Disabled accounts (disabledAt set) and the
    // system sentinel are excluded. Comparison is space-insensitive
    // (NBSP folds to ASCII space) so typing `john d` matches a master
    // stored as `John Doe` (NBSP), the user-directory and add-friend
    // autocomplete both flow through this endpoint, so the fold here
    // is what makes Alt+0160 names findable without the searcher
    // having to know to type Alt+0160 themselves.
    let matchedUserIds: string[];
    // When set, the no-search path pushed LIMIT/OFFSET into SQL and
    // matchedUserIds already represents the page in SQL-sorted order.
    // The hydration steps still run on this smaller set, but the
    // bottom-of-route in-memory `.sort()` + `.slice()` is bypassed so
    // we don't re-paginate or re-sort.
    let sqlPaginated: { total: number; order: string[] } | null = null;
    if (q) {
      const byMaster = await db
        .select({ id: users.id })
        .from(users)
        .where(and(
          isNull(users.disabledAt),
          sql`${users.username} != 'system'`,
          substringNameInsensitive(users.username, q),
        ));
      const byChar = await db
        .select({ userId: characters.userId })
        .from(characters)
        .where(and(
          isNull(characters.deletedAt),
          substringNameInsensitive(characters.name, q),
        ));
      matchedUserIds = [...new Set([
        ...byMaster.map((r) => r.id),
        ...byChar.map((r) => r.userId),
      ])];
    } else {
      // No search query. Two regimes:
      //  - Modes that REQUIRE the full match set in memory
      //    (online/messages sort hydrate runtime data not in the
      //    users table; rank filter intersects with a separate
      //    table). Capped at MAX_INMEMORY_SORT_USERS to bound memory.
      //  - Pure-SQL-sortable modes ("name" / "joined" with no rank
      //    filter): push LIMIT/OFFSET into the SQL query so the
      //    page is the size driver, not the directory population.
      const baseWhere = and(isNull(users.disabledAt), sql`${users.username} != 'system'`);
      if (rankFilter || sortMode === "online" || sortMode === "messages") {
        const allMasters = await db
          .select({ id: users.id })
          .from(users)
          .where(baseWhere)
          .limit(MAX_INMEMORY_SORT_USERS + 1);
        if (allMasters.length > MAX_INMEMORY_SORT_USERS) {
          reply.code(413);
          return {
            error: `directory has more than ${MAX_INMEMORY_SORT_USERS} users, narrow with ?q= or use ?sort=name/joined`,
          };
        }
        matchedUserIds = allMasters.map((r) => r.id);
      } else {
        const orderBy = sortMode === "joined"
          ? sql`${users.createdAt} desc`
          : sql`lower(${users.username})`;
        const pageRows = await db
          .select({ id: users.id })
          .from(users)
          .where(baseWhere)
          .orderBy(orderBy)
          .limit(limit)
          .offset(offset);
        const totalRow = (await db
          .select({ n: sql<number>`count(*)` })
          .from(users)
          .where(baseWhere))[0];
        // matchedUserIds is now the PAGE (already SQL-sorted +
        // limited). The hydration code below uses the same array;
        // the in-memory `.sort()` + `.slice()` at the bottom of the
        // route is bypassed via the `sqlPaginated` flag.
        matchedUserIds = pageRows.map((r) => r.id);
        sqlPaginated = { total: totalRow?.n ?? 0, order: matchedUserIds };
      }
    }

    // Online lookup happens up-front so the alphabetical-online sort
    // and the "messages" sort can both reference the set without two
    // separate fetchSockets() round trips.
    //
    // Incognito moderators are stripped from the online set so the
    // directory + mention autocomplete + friends list all report them
    // as offline. The incognito feature's contract is "global invisible
    //, no trace"; surfacing them with an online dot here would directly
    // contradict that. We could resolve this with a per-user DB lookup
    // for every socket, but the cardinality is small (typical staff
    // on at one time is < 5) and a single batched SELECT keeps it cheap
    // even at scale: one query enumerates incognito users, then we
    // subtract those ids from the socket-derived set.
    const sockets = await io.fetchSockets();
    const rawOnlineUserIds = new Set<string>();
    for (const s of sockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (uid) rawOnlineUserIds.add(uid);
    }
    let onlineUserIds = rawOnlineUserIds;
    if (rawOnlineUserIds.size > 0) {
      const incognitoRows = await db
        .select({ id: users.id })
        .from(users)
        .where(and(
          eq(users.incognitoMode, true),
          sql`${users.id} IN (${sql.join([...rawOnlineUserIds].map((u) => sql`${u}`), sql`, `)})`,
        ));
      if (incognitoRows.length > 0) {
        const incognitoSet = new Set(incognitoRows.map((r) => r.id));
        onlineUserIds = new Set([...rawOnlineUserIds].filter((id) => !incognitoSet.has(id)));
      }
    }

    if (matchedUserIds.length === 0) return { users: [], total: 0, offset, limit };

    // Rank lookup (master pool only, character pools cascade
    // independently and would confuse a single "rank" column on a
    // user row). Joined in via a separate query rather than a SQL
    // join so the matched-user-ids list stays the size driver and
    // the response shape is consistent for users with no earning row.
    const rankRows = await db
      .select({
        userId: userEarning.userId,
        rankKey: userEarning.rankKey,
        tier: userEarning.tier,
      })
      .from(userEarning)
      // Admin user list shows the master pool rank; with no per-server
      // context here, scope to the default server (flag-off: the only
      // pool, byte-identical to today).
      .where(and(
        eq(userEarning.serverId, DEFAULT_SERVER_ID),
        sql`${userEarning.userId} IN (${sql.join(matchedUserIds.map((u) => sql`${u}`), sql`, `)})`,
      ));
    const rankByUser = new Map(rankRows.map((r) => [r.userId, { rankKey: r.rankKey, tier: r.tier }]));

    // Filter by rank AFTER the lookup so the SQL doesn't have to
    // INNER JOIN (which would silently drop unranked users). Users
    // with no earning row never match a rank filter, same outcome
    // as "rank ≠ requested".
    if (rankFilter) {
      matchedUserIds = matchedUserIds.filter((uid) => rankByUser.get(uid)?.rankKey === rankFilter);
    }
    const total = matchedUserIds.length;
    if (matchedUserIds.length === 0) {
      return {
        users: [],
        total: sqlPaginated ? sqlPaginated.total : 0,
        offset,
        limit,
      };
    }

    // Lifetime message count per user, single GROUP BY for the
    // matched set. Same kind set the profile `chatMessages` counter
    // uses, plus topics/replies, so the row's number matches "all
    // visible posts you've ever made" without forcing the user to
    // open the profile to see it. Soft-deleted rows excluded;
    // system / cmd / announce / whisper kinds excluded (they're
    // either server chrome or private).
    const countRows = await db
      .select({
        userId: messages.userId,
        n: sql<number>`count(*)`,
      })
      .from(messages)
      .where(and(
        sql`${messages.userId} IN (${sql.join(matchedUserIds.map((u) => sql`${u}`), sql`, `)})`,
        isNull(messages.deletedAt),
        sql`${messages.kind} IN ('say', 'me', 'ooc', 'roll', 'scene', 'npc')`,
      ))
      .groupBy(messages.userId);
    const messageCountByUser = new Map(countRows.map((r) => [r.userId, Number(r.n)]));

    const userRows = await db
      .select({
        id: users.id,
        username: users.username,
        gender: users.gender,
        avatarUrl: users.avatarUrl,
        chatColor: users.chatColor,
        awayMessage: users.awayMessage,
        activeCharacterId: users.activeCharacterId,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
        // Per-element privacy flags. Pulled here so we can null the
        // summed `messageCount` for users who've opted any of the
        // three categories private, the sum would leak the bulk
        // even if every per-category count on the profile is hidden.
        hideChatMessageCount: users.hideChatMessageCount,
        hideForumTopicCount: users.hideForumTopicCount,
        hideForumReplyCount: users.hideForumReplyCount,
      })
      .from(users)
      .where(sql`${users.id} IN (${sql.join(matchedUserIds.map((u) => sql`${u}`), sql`, `)})`);

    const charRows = await db
      .select({
        id: characters.id,
        userId: characters.userId,
        name: characters.name,
        avatarUrl: characters.avatarUrl,
      })
      .from(characters)
      .where(and(
        isNull(characters.deletedAt),
        sql`${characters.userId} IN (${sql.join(matchedUserIds.map((u) => sql`${u}`), sql`, `)})`,
      ))
      .orderBy(asc(characters.name));

    const charsByUser = new Map<string, typeof charRows>();
    for (const c of charRows) {
      const list = charsByUser.get(c.userId) ?? [];
      list.push(c);
      charsByUser.set(c.userId, list);
    }

    // Effective message-count getter that respects per-element
    // privacy. When the user has ANY of the three hide flags set, the
    // summed count would still leak the bulk of their activity even
    // though each per-category number is private. The fix: treat
    // their messageCount as null (rendered "private") at the
    // directory level, and sort them as 0 in the messages sort so
    // hiding doesn't accidentally float them to the top of "most
    // active".
    function effectiveCount(uid: string, hideChat: boolean, hideTopics: boolean, hideReplies: boolean): number | null {
      if (hideChat || hideTopics || hideReplies) return null;
      return messageCountByUser.get(uid) ?? 0;
    }

    const hideFlagsByUser = new Map(userRows.map((u) => [u.id, {
      chat: u.hideChatMessageCount,
      topics: u.hideForumTopicCount,
      replies: u.hideForumReplyCount,
    }]));

    // When the no-search SQL-paginated path was used, `userRows` is
    // ALREADY the right page in the right order, restore that order
    // (the IN() fetch above doesn't preserve it) and skip the
    // in-memory sort + slice entirely. The `total` returned to the
    // client is the SELECT COUNT(*) we ran during pagination.
    const sorted = sqlPaginated
      ? (() => {
          const ix = new Map(sqlPaginated.order.map((id, i) => [id, i]));
          return [...userRows].sort((a, b) => (ix.get(a.id) ?? 0) - (ix.get(b.id) ?? 0));
        })()
      : userRows.sort((a, b) => {
          switch (sortMode) {
            case "messages": {
              // Highest message count first. Privacy-hidden users sort as
              // 0 so they don't accidentally float to the top, opting
              // into privacy means accepting demoted directory ordering.
              // Ties break alphabetically so the list stays stable for
              // users at the same level.
              const aFlags = hideFlagsByUser.get(a.id);
              const bFlags = hideFlagsByUser.get(b.id);
              const aN = aFlags ? (effectiveCount(a.id, aFlags.chat, aFlags.topics, aFlags.replies) ?? 0) : 0;
              const bN = bFlags ? (effectiveCount(b.id, bFlags.chat, bFlags.topics, bFlags.replies) ?? 0) : 0;
              if (aN !== bN) return bN - aN;
              return a.username.localeCompare(b.username);
            }
            case "joined": {
              // Newest accounts first. Useful for spotting fresh members
              // to welcome / vouch for.
              return +b.createdAt - +a.createdAt;
            }
            case "name": {
              // Pure alphabetical, ignoring online status. Easier to scan
              // when you're looking for a specific user and you don't
              // know whether they're online.
              return a.username.localeCompare(b.username);
            }
            case "online":
            default: {
              // Historic default, online users first, then offline,
              // alphabetical within each band.
              const aOn = onlineUserIds.has(a.id) ? 0 : 1;
              const bOn = onlineUserIds.has(b.id) ? 0 : 1;
              if (aOn !== bOn) return aOn - bOn;
              return a.username.localeCompare(b.username);
            }
          }
        });

    // Drop anyone the viewer is blocked with (either direction) from the
    // directory + add-friend autocomplete. Blocks are rare, so post-filtering
    // the page (rather than threading NOT IN through both pagination regimes)
    // is acceptable; at worst a page returns slightly fewer than `limit`.
    const blockedSet = await blockedUserIdsFor(db, me.id);
    const pageRowsRaw = sqlPaginated ? sorted : sorted.slice(offset, offset + limit);
    const pageRows = blockedSet.size ? pageRowsRaw.filter((u) => !blockedSet.has(u.id)) : pageRowsRaw;
    const page = pageRows.map((u) => {
      const rank = rankByUser.get(u.id) ?? null;
      return {
        userId: u.id,
        username: u.username,
        gender: u.gender,
        avatarUrl: u.avatarUrl,
        chatColor: u.chatColor,
        online: onlineUserIds.has(u.id),
        away: u.awayMessage != null,
        awayMessage: u.awayMessage,
        activeCharacterId: u.activeCharacterId,
        createdAt: +u.createdAt,
        lastLoginAt: u.lastLoginAt ? +u.lastLoginAt : null,
        // Master-pool rank (key + tier). Null when the user has no
        // earning row yet or is below the lowest enabled tier. The
        // client resolves the rank name + sigil URL via the cached
        // earning catalog rather than re-shipping it here per-row.
        rankKey: rank?.rankKey ?? null,
        rankTier: rank?.tier ?? null,
        // Lifetime visible-post count (chat + forum). Powers the
        // "Most active" sort + the per-row badge in UsersModal.
        // Null when ANY per-element hide flag is set, the directory
        // sum would otherwise leak the bulk the user is trying to
        // keep private. Renderer should display "private" in place.
        messageCount: effectiveCount(u.id, u.hideChatMessageCount, u.hideForumTopicCount, u.hideForumReplyCount),
        characters: (charsByUser.get(u.id) ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          avatarUrl: c.avatarUrl,
        })),
      };
    });

    return {
      users: page,
      total: sqlPaginated ? sqlPaginated.total : total,
      offset,
      limit,
    };
  });

  /** Admin: same shape as /users plus email/role/disabled state. */
  app.get<{ Querystring: { q?: string; offset?: string; limit?: string; ip?: string; state?: string } }>("/admin/users", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me || !(await hasPermission(me, "view_user_directory_secure", db))) { reply.code(403); return { error: "admin only" }; }

    const q = (req.query.q ?? "").trim().toLowerCase();
    // `state=disabled` filters server-side to disabled accounts. The
    // UsersTab's other state facets (online / offline / away) are runtime
    // presence and stay client-side, but "disabled" is a DB column, so
    // filtering it here is what makes ALL disabled accounts surface — not
    // just the ones that happened to land in the first page (the bug:
    // client-side filtering a username-ordered page missed disabled users
    // past row `limit`).
    const stateFilter = (req.query.state ?? "").trim();
    const offset = Math.max(0, parseInt(req.query.offset ?? "0", 10) || 0);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit ?? "100", 10) || 100));
    // Optional IP filter, when set, scopes the result to every user who has
    // touched this IP - either a login (sessions) or later event-time activity
    // (user_ip_log). Used by the UsersTab's "alts on this IP" click affordance
    // so an admin can pivot from one user's IP chip to every other account
    // that shares it. Unioning both tables means a roaming long-lived session
    // (whose login IP differs from its current one) still surfaces here.
    // Empty string = no filter.
    const ipFilter = (req.query.ip ?? "").trim();
    const ipScopedUserIds = ipFilter
      ? new Set([
          ...(await db
            .select({ userId: sessions.userId })
            .from(sessions)
            .where(eq(sessions.ip, ipFilter))).map((r) => r.userId),
          ...(await db
            .select({ userId: userIpLog.userId })
            .from(userIpLog)
            .where(eq(userIpLog.ip, ipFilter))).map((r) => r.userId),
        ])
      : null;

    // Admin search includes email + disabled accounts (for moderation review).
    // `q` is escaped for SQL LIKE wildcards so an admin pasting a literal
    // `_` doesn't match every row of the user table.
    const escapedQ = q.replace(/[%_]/g, (c) => `\\${c}`);
    const whereExpr = and(
      sql`${users.username} != 'system'`,
      q
        ? or(
            sql`lower(${users.username}) LIKE ${"%" + escapedQ + "%"} ESCAPE '\\'`,
            sql`lower(${users.email}) LIKE ${"%" + escapedQ + "%"} ESCAPE '\\'`,
            // Also match by CHARACTER name so an admin who only knows a
            // user by one of their roleplay personas can find the owning
            // OOC account. Deleted characters are included on purpose:
            // moderation often needs to trace an account by a persona it
            // has since deleted (e.g. ban-evasion). The matched account
            // already surfaces its full character roster in each row, so
            // the admin can see which persona produced the hit.
            inArray(
              users.id,
              db
                .select({ userId: characters.userId })
                .from(characters)
                .where(sql`lower(${characters.name}) LIKE ${"%" + escapedQ + "%"} ESCAPE '\\'`),
            ),
          )
        : undefined,
      // The IP filter narrows to a deliberately-targeted set; when no
      // ip arg is supplied we leave this branch as undefined so the
      // and() collapses to the unfiltered query.
      ipScopedUserIds && ipScopedUserIds.size > 0
        ? inArray(users.id, [...ipScopedUserIds])
        : ipScopedUserIds // empty set → match nothing
          ? sql`1 = 0`
          : undefined,
      // Server-side disabled-state filter (see note above).
      stateFilter === "disabled" ? isNotNull(users.disabledAt) : undefined,
    );

    // Total count + page in two queries, was: SELECT all, sort in
    // memory, slice. That pattern returned every non-system user on
    // every admin-panel open; at 10× current population it would ship
    // multi-MB and stall the event loop on the .sort() pass.
    const totalRow = (await db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(whereExpr))[0];
    const total = totalRow?.n ?? 0;

    const all = await db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        role: users.role,
        gender: users.gender,
        avatarUrl: users.avatarUrl,
        chatColor: users.chatColor,
        awayMessage: users.awayMessage,
        activeCharacterId: users.activeCharacterId,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
        disabledAt: users.disabledAt,
      })
      .from(users)
      .where(whereExpr)
      .orderBy(sql`lower(${users.username})`)
      .limit(limit)
      .offset(offset);

    const ids = all.map((u) => u.id);
    const charRows = ids.length
      ? await db
          .select({ id: characters.id, userId: characters.userId, name: characters.name, deletedAt: characters.deletedAt })
          .from(characters)
          .where(inArray(characters.userId, ids))
          .orderBy(asc(characters.name))
      : [];
    const charsByUser = new Map<string, typeof charRows>();
    for (const c of charRows) {
      const list = charsByUser.get(c.userId) ?? [];
      list.push(c);
      charsByUser.set(c.userId, list);
    }

    // Per-user IP aggregation, unioning two sources:
    //   * sessions   - the address each session LOGGED IN from (createdAt as
    //                  the timestamp). Frozen at login.
    //   * user_ip_log - addresses captured on later activity (socket connect,
    //                  room switch, chat send, authenticated posts) with a
    //                  true `last_seen_at`.
    // Merging both means a long-lived session that has since roamed networks
    // surfaces every address it has used - freshest first - instead of only
    // the one it first logged in from. We dedupe by IP keeping the newest
    // timestamp and keep the top 5 per user. At page sizes of ≤100 users with
    // bounded per-user rows the result-set is tiny and the in-memory reduce is
    // cheap. SQLite has no clean per-group LIMIT, so the dedup is app-side.
    const RECENT_IPS_PER_USER = 5;
    interface RecentIp { ip: string; lastSeenAt: number; altCount: number }
    const recentIpsByUser = new Map<string, RecentIp[]>();
    if (ids.length > 0) {
      // Step 1: collect (user, ip, ts) signals from both tables, keeping the
      // newest timestamp per (user, ip).
      const perUser = new Map<string, Map<string, number>>();
      const bump = (userId: string, ip: string, ts: number) => {
        const m = perUser.get(userId) ?? new Map<string, number>();
        const prev = m.get(ip);
        if (prev === undefined || ts > prev) m.set(ip, ts);
        perUser.set(userId, m);
      };

      const pageSessionRows = await db
        .select({ userId: sessions.userId, ip: sessions.ip, createdAt: sessions.createdAt })
        .from(sessions)
        .where(and(inArray(sessions.userId, ids), sql`${sessions.ip} IS NOT NULL`));
      for (const r of pageSessionRows) if (r.ip) bump(r.userId, r.ip, +r.createdAt);

      const pageLogRows = await db
        .select({ userId: userIpLog.userId, ip: userIpLog.ip, lastSeenAt: userIpLog.lastSeenAt })
        .from(userIpLog)
        .where(inArray(userIpLog.userId, ids));
      for (const r of pageLogRows) bump(r.userId, r.ip, +r.lastSeenAt);

      // Step 2: gather every distinct IP across the page so alt-count resolves
      // in one grouped query per table.
      const distinctIps = new Set<string>();
      for (const m of perUser.values()) for (const ip of m.keys()) distinctIps.add(ip);

      // Step 3: alt-count = distinct accounts seen on each IP across BOTH
      // tables, minus the user themselves. We pull distinct (ip, userId) pairs
      // (GROUP BY both columns) and union them into a per-IP user set, so an
      // account present in both tables on one IP isn't counted twice. This
      // also spans users OUTSIDE the current page, so an IP shared with a user
      // not in view still reports a non-zero alt count.
      const usersByIp = new Map<string, Set<string>>();
      if (distinctIps.size > 0) {
        const ipsArr = [...distinctIps];
        const sessPairs = await db
          .select({ ip: sessions.ip, userId: sessions.userId })
          .from(sessions)
          .where(inArray(sessions.ip, ipsArr))
          .groupBy(sessions.ip, sessions.userId);
        const logPairs = await db
          .select({ ip: userIpLog.ip, userId: userIpLog.userId })
          .from(userIpLog)
          .where(inArray(userIpLog.ip, ipsArr))
          .groupBy(userIpLog.ip, userIpLog.userId);
        for (const r of [...sessPairs, ...logPairs]) {
          if (!r.ip) continue;
          const s = usersByIp.get(r.ip) ?? new Set<string>();
          s.add(r.userId);
          usersByIp.set(r.ip, s);
        }
      }

      // Step 4: stitch the per-user IP lists with alt-count + truncation.
      for (const [userId, m] of perUser.entries()) {
        const arr: RecentIp[] = [];
        for (const [ip, ts] of m.entries()) {
          const total = usersByIp.get(ip)?.size ?? 1;
          arr.push({ ip, lastSeenAt: ts, altCount: Math.max(0, total - 1) });
        }
        arr.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
        recentIpsByUser.set(userId, arr.slice(0, RECENT_IPS_PER_USER));
      }
    }

    const sockets = await io.fetchSockets();
    const onlineUserIds = new Set<string>();
    for (const s of sockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (uid) onlineUserIds.add(uid);
    }

    const page = all.map((u) => ({
      userId: u.id,
      username: u.username,
      email: u.email,
      role: u.role,
      gender: u.gender,
      avatarUrl: u.avatarUrl,
      chatColor: u.chatColor,
      online: onlineUserIds.has(u.id),
      away: u.awayMessage != null,
      awayMessage: u.awayMessage,
      activeCharacterId: u.activeCharacterId,
      createdAt: +u.createdAt,
      lastLoginAt: u.lastLoginAt ? +u.lastLoginAt : null,
      disabled: u.disabledAt != null,
      disabledAt: u.disabledAt ? +u.disabledAt : null,
      characters: (charsByUser.get(u.id) ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        deleted: c.deletedAt != null,
      })),
      // Up to 5 distinct IPs the user has logged in from, newest-first,
      // each with the count of OTHER accounts that have also used the
      // same IP. Used by the UsersTab to spot ban-evasion or shared-
      // device patterns at a glance.
      recentIps: recentIpsByUser.get(u.id) ?? [],
    }));

    return { users: page, total, offset, limit };
  });

  /**
   * Admin user editor. Two-tier gating:
   *   * Both `admin` and `masteradmin` reach this endpoint.
   *   * Plain `admin` may rename a user and may promote/demote within
   *     {user, trusted, mod, admin}, they can build the moderation
   *     team but can't mint another masteradmin and can't demote one
   *     either.
   *   * `email` and `disabled` mutations are master-only, both are
   *     "damage" levers (account lockout, identity reassignment).
   *   * Promoting TO masteradmin or demoting FROM masteradmin is
   *     master-only by definition; a plain admin attempting either
   *     gets 403 so they can't escalate themselves through a chained
   *     promotion or kneecap the only top-tier admin.
   *
   * Password reset is intentionally out of scope here, users go
   * through their own password-recovery flow for that.
   */
  app.patch<{ Params: { id: string }; Body: unknown }>("/admin/users/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me || !(await hasPermission(me, "edit_user_basic", db))) { reply.code(403); return { error: "admin only" }; }
    // Per-field permission resolution. `edit_user_basic` is the
    // baseline gate above; sensitive fields each carry their own
    // key so an install can let an admin manage usernames + role
    // without also handing them the email or disable buttons.
    const canEditEmail = await hasPermission(me, "edit_user_email", db);
    const canDisableEnable = (await hasPermission(me, "disable_user", db))
      && (await hasPermission(me, "enable_user", db));
    // Masteradmin promotion / demotion is hardcoded masteradmin-only
    // (per the plan's hardcoded-exceptions list), there is NO
    // catalog key for it, so a misclick on the matrix can't grant
    // it. We check for the underlying tier here.
    const canTouchMasteradminTier = me.role === "masteradmin";
    const { id } = req.params;
    if (id === me.id) { reply.code(400); return { error: "use the profile editor for your own account" }; }
    const target = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
    if (!target || target.username === "system") { reply.code(404); return { error: "not found" }; }

    const { z } = await import("zod");
    const { MASTER_USERNAME_RX, MASTER_USERNAME_RULE_MESSAGE } = await import("./auth.js");
    // Mirror the master-username rule from /auth/register so admins editing a
    // user's name can't introduce a Unicode-confusable identifier. Import
    // the regex + message from auth.ts so both paths stay in sync, a
    // duplicated regex here would drift the moment one side gets relaxed.
    const masterUsernameSchema = z
      .string()
      .min(2)
      .max(40)
      .transform((s) => s.normalize("NFKC"))
      .refine((s) => MASTER_USERNAME_RX.test(s), {
        message: MASTER_USERNAME_RULE_MESSAGE,
      });
    const body = z.object({
      username: masterUsernameSchema.optional(),
      email: z.string().email().max(200).optional(),
      role: z.enum(["user", "trusted", "mod", "admin", "masteradmin"]).optional(),
      disabled: z.boolean().optional(),
    }).parse(req.body);

    // Per-field gates. Reject EARLY (before any write) so a half-
    // permissioned admin's form submit doesn't half-apply. Each
    // field carries its own permission key so the matrix can hand
    // out narrow grants (e.g. "edit usernames only", "enable/disable
    // accounts only") without giving up the others.
    if (body.email !== undefined && !canEditEmail) {
      reply.code(403); return { error: "missing permission: edit_user_email" };
    }
    if (body.disabled !== undefined && !canDisableEnable) {
      reply.code(403); return { error: "missing permission: disable_user / enable_user" };
    }
    // Role transitions that touch the masteradmin tier are
    // hardcoded masteradmin-only (per plan.md's hardcoded exceptions).
    // No catalog key, putting it on the matrix would let a misclick
    // strand the install with no top-tier authority.
    if ((body.role === "masteradmin" || target.role === "masteradmin") && !canTouchMasteradminTier) {
      reply.code(403); return { error: "master admin only: changing the masteradmin role" };
    }
    // Role-hierarchy gate. The granular `edit_user_basic` key makes
    // the endpoint callable, but the actor still can't grant a role
    // higher than their own (matrix-laddering refusal, see plan.md's
    // hardcoded exceptions). Applies in both directions: setting a
    // target TO a higher tier and demoting a target FROM a higher
    // tier are both refused unless the actor outranks the change.
    if (body.role !== undefined && roleRank(body.role) > roleRank(me.role)) {
      reply.code(403); return { error: "cannot grant a tier higher than your own" };
    }
    if (roleRank(target.role) > roleRank(me.role)) {
      reply.code(403); return { error: "cannot edit a user who outranks you" };
    }

    // Username conflict check (case-insensitive). Email is no longer unique.
    if (body.username && body.username.toLowerCase() !== target.username.toLowerCase()) {
      const dup = (await db.select().from(users).where(sql`lower(${users.username}) = ${body.username.toLowerCase()}`).limit(1))[0];
      if (dup) { reply.code(409); return { error: "username already in use" }; }
    }

    const update: Partial<typeof users.$inferInsert> = {};
    if (body.username !== undefined) update.username = body.username;
    if (body.email !== undefined) update.email = body.email;
    if (body.role !== undefined) update.role = body.role;
    if (body.disabled !== undefined) update.disabledAt = body.disabled ? new Date() : null;
    await db.update(users).set(update).where(eq(users.id, id));

    const justDisabled = body.disabled === true && target.disabledAt == null;
    const justEnabled = body.disabled === false && target.disabledAt != null;
    const roleChanged = body.role !== undefined && body.role !== target.role;
    if (justDisabled) {
      // Authoritative logout: revoke every session row AND drop live
      // sockets with the reason shown on the splash. The old emit-then-
      // immediate-disconnect here raced the transport (the event often
      // never arrived) and left the session rows valid, so the client
      // quietly auto-reconnected and stayed in chat — the "disabled
      // users aren't logged out" bug.
      const { forceLogoutUser } = await import("../auth/session.js");
      await forceLogoutUser(io, db, id, "Your account has been disabled by an administrator.");
    } else if (roleChanged) {
      // Role changes keep their sessions (they should log straight back
      // in with refreshed permissions); just bounce the sockets. The
      // flush delay lets auth:expired actually reach the client before
      // the transport closes.
      const sockets = await io.fetchSockets();
      for (const s of sockets) {
        const uid = (s.data as { userId?: string }).userId;
        if (uid !== id) continue;
        s.emit("auth:expired");
        setTimeout(() => { try { s.disconnect(true); } catch { /* gone */ } }, 250);
      }
    }

    if (justDisabled) {
      await recordAudit(db, {
        actorUserId: me.id,
        action: "user_disable",
        targetUserId: id,
      });
    } else if (justEnabled) {
      await recordAudit(db, {
        actorUserId: me.id,
        action: "user_enable",
        targetUserId: id,
      });
    }
    if (roleChanged && body.role) {
      // Map role transitions to the most-specific audit action so reports
      // can filter cleanly. Trust transitions get their own actions; admin
      // bumps share `promote_admin`/`demote_admin` with the chat command.
      let action: import("@thekeep/shared").AuditAction = "promote_mod";
      if (body.role === "masteradmin") action = "promote_masteradmin";
      else if (target.role === "masteradmin") action = "demote_masteradmin";
      else if (body.role === "admin") action = "promote_admin";
      else if (target.role === "admin") action = "demote_admin";
      else if (body.role === "trusted") action = "promote_trusted";
      else if (target.role === "trusted") action = "demote_trusted";
      else if (body.role === "mod") action = "promote_mod";
      else action = "demote_mod";
      await recordAudit(db, {
        actorUserId: me.id,
        action,
        targetUserId: id,
        metadata: { priorRole: target.role, nextRole: body.role },
      });
    }

    return { ok: true };
  });

  /* ----------------------------------------------------------------- *
   *  Account bans (timed, with reason), reviewable on the profile.
   *
   *  Distinct from the admin `disabled` toggle above: a ban is a mod
   *  action carrying a reason + issuer and may auto-expire. It ALSO sets
   *  `disabledAt` so every existing login/chat/visibility gate blocks the
   *  account with zero new enforcement points; unban / expiry clears both.
   * ----------------------------------------------------------------- */

  /** Upper bound on a timed ban (~5 years). `durationMs: null` = permanent. */
  const MAX_BAN_MS = 5 * 365 * 24 * 60 * 60 * 1000;

  /** Ban a user account. Gated by `ban_account`; mods can't ban peers or up. */
  app.post<{ Params: { id: string }; Body: unknown }>("/users/:id/ban", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (!(await hasPermission(me, "ban_account", db))) {
      reply.code(403); return { error: "missing permission: ban_account" };
    }
    const { id } = req.params;
    if (id === me.id) { reply.code(400); return { error: "you cannot ban your own account" }; }
    const target = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
    if (!target || target.username === "system") { reply.code(404); return { error: "not found" }; }
    // No banning a peer or anyone who outranks you. Keeps mods from
    // banning each other / admins, mirroring the role-edit hierarchy gate.
    if (roleRank(target.role) >= roleRank(me.role)) {
      reply.code(403); return { error: "cannot ban a user at or above your role" };
    }

    const { z } = await import("zod");
    const body = z.object({
      durationMs: z.number().int().positive().max(MAX_BAN_MS).nullable(),
      reason: z.string().trim().min(1).max(1000),
    }).parse(req.body);

    const now = new Date();
    const bannedUntil = body.durationMs != null ? new Date(now.getTime() + body.durationMs) : null;
    await db
      .update(users)
      .set({
        bannedAt: now,
        bannedUntil,
        banReason: body.reason,
        bannedById: me.id,
        // Reuse the disable gate so login + chat + visibility all block.
        disabledAt: now,
      })
      .where(eq(users.id, id));

    // Authoritative logout: revoke sessions + drop live sockets with the
    // ban reason on the splash. Same path the admin disable uses.
    const { forceLogoutUser } = await import("../auth/session.js");
    const untilNote = bannedUntil ? ` until ${bannedUntil.toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
    await forceLogoutUser(io, db, id, `Your account has been banned${untilNote}. Reason: ${body.reason}`);

    // Mirror the ban onto the user's recent public IPs so they can't just
    // register burner accounts from the same network to keep harassing. Timed
    // bans produce a timed IP block; unban clears it. Best-effort.
    let ipCount = 0;
    try {
      const { banIpsForUser, loadBannedIpCache } = await import("../auth/ipBan.js");
      ipCount = await banIpsForUser(db, id, { until: bannedUntil, reason: body.reason, bannedById: me.id });
      await loadBannedIpCache(db); // make the new blocks live app-wide immediately
    } catch { /* IP mirroring is best-effort; the account ban already committed */ }

    await recordAudit(db, {
      actorUserId: me.id,
      action: "account_ban",
      targetUserId: id,
      reason: body.reason,
      metadata: { until: bannedUntil ? bannedUntil.getTime() : null, durationMs: body.durationMs, ipsBlocked: ipCount },
    });
    return { ok: true, ipsBlocked: ipCount };
  });

  /** Lift an account ban early. Gated by `unban_account`. */
  app.post<{ Params: { id: string }; Body: unknown }>("/users/:id/unban", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (!(await hasPermission(me, "unban_account", db))) {
      reply.code(403); return { error: "missing permission: unban_account" };
    }
    const { id } = req.params;
    const target = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
    if (!target) { reply.code(404); return { error: "not found" }; }
    // Only clear `disabledAt` when THIS was a ban; a plain admin-disabled
    // account that was never banned must stay disabled.
    const wasBanned = target.bannedAt != null;
    await db
      .update(users)
      .set({
        bannedAt: null,
        bannedUntil: null,
        banReason: null,
        bannedById: null,
        ...(wasBanned ? { disabledAt: null } : {}),
      })
      .where(eq(users.id, id));
    if (wasBanned) {
      // Lift the IP blocks this user's ban produced.
      try {
        const { unbanIpsForUser, loadBannedIpCache } = await import("../auth/ipBan.js");
        await unbanIpsForUser(db, id);
        await loadBannedIpCache(db); // drop the lifted blocks from the live gate at once
      } catch { /* best-effort */ }
      await recordAudit(db, { actorUserId: me.id, action: "account_unban", targetUserId: id });
    }
    return { ok: true };
  });

  /**
   * Mod-only ban review for a single account: current ban status + history.
   * Gated by `ban_account` so the data never reaches non-mod viewers (it's
   * deliberately NOT folded into the public `/profiles/:name` payload).
   */
  app.get<{ Params: { id: string } }>("/users/:id/moderation", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (!(await hasPermission(me, "ban_account", db))) {
      reply.code(403); return { error: "missing permission: ban_account" };
    }
    const { id } = req.params;
    const target = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
    if (!target) { reply.code(404); return { error: "not found" }; }

    const now = Date.now();
    const active = target.bannedAt != null
      && (target.bannedUntil == null || +target.bannedUntil > now);
    let bannedByName: string | null = null;
    if (active && target.bannedById) {
      const issuer = (await db.select({ username: users.username }).from(users).where(eq(users.id, target.bannedById)).limit(1))[0];
      bannedByName = issuer?.username ?? null;
    }

    // History: this account's ban/unban audit rows, newest first, with
    // actor names resolved in one follow-up query.
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(
        eq(auditLog.targetUserId, id),
        inArray(auditLog.action, ["account_ban", "account_unban"]),
      ))
      .orderBy(desc(auditLog.createdAt))
      .limit(50);
    const actorIds = [...new Set(rows.map((r) => r.actorUserId))];
    const actors = actorIds.length
      ? await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, actorIds))
      : [];
    const actorName = new Map(actors.map((a) => [a.id, a.username]));
    const history = rows.map((r) => {
      let until: number | null = null;
      if (r.metadataJson) {
        try { until = (JSON.parse(r.metadataJson) as { until?: number | null }).until ?? null; }
        catch { until = null; }
      }
      return {
        action: r.action,
        at: +r.createdAt,
        by: actorName.get(r.actorUserId) ?? "(unknown)",
        reason: r.reason ?? null,
        until,
      };
    });

    return {
      ban: active
        ? {
            bannedAt: target.bannedAt ? +target.bannedAt : null,
            bannedUntil: target.bannedUntil ? +target.bannedUntil : null,
            reason: target.banReason ?? null,
            by: bannedByName,
          }
        : null,
      history,
    };
  });

  /**
   * Admin password reset. Hashes the provided plaintext and writes
   * it to the target user's `password_hash`. Bumps the audit log and
   * disconnects any live sockets that account had so they're forced
   * to re-authenticate with the new password.
   *
   * Master-admin only, handing out password resets is the most
   * destructive single-user lever (effectively account takeover from
   * the admin chair). Plain admins can't reach it.
   */
  app.patch<{ Params: { id: string }; Body: unknown }>("/admin/users/:id/password", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me || !(await hasPermission(me, "reset_user_password", db))) { reply.code(403); return { error: "master admin only" }; }
    const { id } = req.params;
    const target = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
    if (!target || target.username === "system") { reply.code(404); return { error: "not found" }; }

    const { z } = await import("zod");
    const body = z.object({
      newPassword: z.string().min(8).max(200),
    }).parse(req.body);

    const { hashPassword } = await import("../auth/passwords.js");
    const hash = await hashPassword(body.newPassword);
    await db.update(users).set({ passwordHash: hash }).where(eq(users.id, id));

    // Force-kick any live sessions so they have to re-auth.
    const sockets = await io.fetchSockets();
    for (const s of sockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (uid !== id) continue;
      s.emit("auth:expired");
      s.disconnect(true);
    }

    await recordAudit(db, {
      actorUserId: me.id,
      action: "password_reset",
      targetUserId: id,
    });
    return { ok: true };
  });

  /**
   * Hard-delete a user. Cascades through every FK - characters, room_members,
   * messages (kept by `set null` for displayName history), bans, mutes,
   * sessions. System and self are off-limits.
   */
  app.delete<{ Params: { id: string } }>("/admin/users/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    // Master-only by default: hard-deleting a user cascades through every FK and
    // is the most destructive single-row action in the system.
    if (!me || !(await hasPermission(me, "hard_delete_user", db))) { reply.code(403); return { error: "master admin only" }; }
    const { id } = req.params;
    if (id === me.id) { reply.code(400); return { error: "you cannot delete your own account" }; }
    const target = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
    if (!target || target.username === "system") { reply.code(404); return { error: "not found" }; }

    // Disconnect any live sockets so they stop receiving events immediately.
    const sockets = await io.fetchSockets();
    for (const s of sockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (uid === id) s.disconnect(true);
    }

    await db.delete(users).where(eq(users.id, id));
    await recordAudit(db, {
      actorUserId: me.id,
      action: "user_disable",
      // The user row is gone (cascade); store enough metadata to reconstruct.
      metadata: { hardDelete: true, username: target.username, email: target.email },
    });
    return { ok: true };
  });

  /**
   * Batch-resolve a list of `@mention` names to "exists or not."
   *
   * Used by the message renderer so a mention chip only lights up
   * when the name actually resolves to a master username OR the
   * active-character name of an existing user, typos and dangling
   * `@bobs` stay as plain text instead of dressing up as a clickable
   * (but-broken) chip.
   *
   * Input names are lowercased on both sides for case-insensitive
   * matching. The response lists only the names that resolved; any
   * input name not in the response is implicitly invalid (the client
   * treats it as such).
   *
   * Hard cap of 64 names per call, a single message can only
   * contain so many mentions, and most messages have ≤2. The renderer
   * batches across visible messages but won't exceed the cap.
   */
  app.post<{ Body: unknown }>("/mentions/resolve", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    const body = req.body as { names?: unknown };
    const raw = Array.isArray(body?.names) ? body.names : [];
    // Canonicalize each input to lowercase + space-folded form so a
    // mention typed as `@John Doe` (ASCII space) matches a master
    // stored as `John Doe` (NBSP). The response also speaks the
    // canonical form so the client can compare its own canonicalized
    // mention strings against `valid` directly, see
    // apps/web/src/state/mentions.ts which canonicalizes on the read
    // side too. Dedupe via Set so duplicate or NBSP/space variants of
    // the same name collapse to one query argument.
    const canonicals = Array.from(new Set(
      raw
        .filter((n): n is string => typeof n === "string" && n.length > 0 && n.length <= 64)
        .map((n) => canonicalizeNameForLookup(n))
    )).slice(0, 64);
    if (canonicals.length === 0) return { valid: [] };

    // Blocked accounts (either direction) are invisible: their mention must
    // not light up as a clickable chip for the viewer.
    const blocked = await blockedUserIdsFor(db, me.id);

    // Master usernames first, globally unique, fast hit. NB: only
    // non-disabled accounts (the system sentinel + any deactivated
    // accounts shouldn't surface as clickable mentions).
    const userMatches = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(
        and(
          isNull(users.disabledAt),
          sql`${users.username} != 'system'`,
          sql`${loweredSpaceCanonical(users.username)} IN (${sql.join(canonicals.map((n) => sql`${n}`), sql`, `)})`,
        ),
      );
    const valid = new Set(
      userMatches.filter((u) => !blocked.has(u.id)).map((u) => canonicalizeNameForLookup(u.username)),
    );

    // Character names, match against any non-deleted character of
    // a non-disabled owner. The active-character constraint that the
    // push pipeline (broadcast.ts) applies is intentionally NOT used
    // here: that gate is about whether a mention should ping someone
    // RIGHT NOW. The renderer's question is "is this a real name with
    // a clickable profile?", and an inactive character still has a
    // profile.
    const remaining = canonicals.filter((n) => !valid.has(n));
    if (remaining.length > 0) {
      const charMatches = await db
        .select({ ownerId: users.id, name: characters.name })
        .from(characters)
        .innerJoin(users, eq(users.id, characters.userId))
        .where(
          and(
            isNull(characters.deletedAt),
            isNull(users.disabledAt),
            sql`${loweredSpaceCanonical(characters.name)} IN (${sql.join(remaining.map((n) => sql`${n}`), sql`, `)})`,
          ),
        );
      for (const c of charMatches) if (!blocked.has(c.ownerId)) valid.add(canonicalizeNameForLookup(c.name));
    }

    return { valid: Array.from(valid) };
  });

  /**
   * Resolve identity TOKENS (`@id:<userId>` / `@cid:<characterId>`) to their
   * current display names, so the chat composer can show the author WHO a
   * pasted-or-inserted token references before they send (an `@cid:` token is
   * an opaque nanoid otherwise). Batched + block-aware, mirroring
   * `/mentions/resolve`:
   *   - `id`  → the master account's username (skips disabled + the `system`
   *             sentinel).
   *   - `cid` → the character's name (skips deleted characters + characters of
   *             disabled owners).
   * Either direction of a block hides the identity (no name leak). Tokens that
   * don't resolve are simply omitted from the response; the client treats a
   * missing token as "unknown identity".
   */
  app.post<{ Body: unknown }>("/mentions/resolve-tokens", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    const body = req.body as { tokens?: unknown };
    const rawTokens = Array.isArray(body?.tokens) ? body.tokens : [];
    const idIds: string[] = [];
    const cidIds: string[] = [];
    const seen = new Set<string>();
    for (const t of rawTokens) {
      if (!t || typeof t !== "object") continue;
      const kind = (t as { kind?: unknown }).kind;
      const id = (t as { id?: unknown }).id;
      if ((kind !== "id" && kind !== "cid") || typeof id !== "string" || !id || id.length > 64) continue;
      const key = `${kind}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      (kind === "id" ? idIds : cidIds).push(id);
      if (seen.size >= 128) break; // hard cap on a single request's fan-out
    }
    if (idIds.length === 0 && cidIds.length === 0) return { resolved: [] };

    const blocked = await blockedUserIdsFor(db, me.id);
    const resolved: Array<{ kind: "id" | "cid"; id: string; name: string }> = [];

    if (idIds.length > 0) {
      const rows = await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(and(
          inArray(users.id, idIds),
          isNull(users.disabledAt),
          sql`${users.username} != 'system'`,
        ));
      for (const u of rows) if (!blocked.has(u.id)) resolved.push({ kind: "id", id: u.id, name: u.username });
    }

    if (cidIds.length > 0) {
      const rows = await db
        .select({ id: characters.id, name: characters.name, ownerId: users.id })
        .from(characters)
        .innerJoin(users, eq(users.id, characters.userId))
        .where(and(
          inArray(characters.id, cidIds),
          isNull(characters.deletedAt),
          isNull(users.disabledAt),
        ));
      for (const c of rows) if (!blocked.has(c.ownerId)) resolved.push({ kind: "cid", id: c.id, name: c.name });
    }

    return { resolved };
  });

  /**
   * Identity-keyed autocomplete for DM compose + add-friend pickers.
   *
   * The legacy `/users` endpoint rolled character matches up under
   * their owning master so the UI ended up rendering "MasterName as
   * CharacterName", a privacy leak that violated the project's
   * "characters are their own accounts" contract. This endpoint
   * returns each matching identity as its own row instead, so a
   * user typing `King` sees the character `KingArthur` and the
   * master `KingdomOfMen` as two distinct, equally-rankable
   * suggestions. The caller picks one identity directly; no
   * follow-up disambiguation round-trip needed.
   *
   * Query: `?q=<substring>&limit=<n>`. Empty `q` returns `[]`.
   * Caller's own identities are excluded so the picker can't offer
   * "DM yourself."
   */
  app.get<{ Querystring: { q?: string; limit?: string } }>("/identities/autocomplete", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    const q = (req.query.q ?? "").trim();
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit ?? "8", 10) || 8));
    if (!q) return { identities: [] };

    // Match master usernames and character names INDEPENDENTLY. The
    // two queries run in parallel so a populated install doesn't pay
    // a serial round-trip on every keystroke.
    const [masterRows, charRows] = await Promise.all([
      db
        .select({
          userId: users.id,
          username: users.username,
          avatarUrl: users.avatarUrl,
          avatarZoom: users.avatarZoom,
          avatarOffsetX: users.avatarOffsetX,
          avatarOffsetY: users.avatarOffsetY,
        })
        .from(users)
        .where(and(
          isNull(users.disabledAt),
          sql`${users.username} != 'system'`,
          substringNameInsensitive(users.username, q),
        ))
        .limit(limit * 2),  // overfetch so the merge sort can keep "best matches first" even after self-exclude trims.
      db
        .select({
          characterId: characters.id,
          characterName: characters.name,
          userId: characters.userId,
          avatarUrl: characters.avatarUrl,
          avatarZoom: characters.avatarZoom,
          avatarOffsetX: characters.avatarOffsetX,
          avatarOffsetY: characters.avatarOffsetY,
          ownerUsername: users.username,
          ownerDisabledAt: users.disabledAt,
        })
        .from(characters)
        .innerJoin(users, eq(users.id, characters.userId))
        .where(and(
          isNull(characters.deletedAt),
          substringNameInsensitive(characters.name, q),
        ))
        .limit(limit * 2),
    ]);

    // Online lookup once, keyed by master userId. Used to surface the
    // online dot regardless of which identity matched, being online
    // is a USER property; a master sitting on Character A still
    // means Character B is "reachable" from a DM perspective.
    const sockets = await io.fetchSockets();
    const onlineUserIds = new Set<string>();
    for (const s of sockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (uid) onlineUserIds.add(uid);
    }

    interface IdentityRow {
      kind: "user" | "character";
      userId: string;
      characterId: string | null;
      displayName: string;
      /** The master username, used only by the server-side caller
       *  filter; the client should NOT render this on the suggestion
       *  row, since exposing it leaks the OOC/character relationship
       *  the partition is meant to hide. */
      masterUsername: string;
      avatarUrl: string | null;
      avatarCrop: { zoom: number; offsetX: number; offsetY: number };
      online: boolean;
    }

    // Blocked accounts (either direction) are invisible to the viewer, so
    // they can't surface as DM / add-friend suggestions.
    const blocked = await blockedUserIdsFor(db, me.id);

    const identities: IdentityRow[] = [];

    for (const u of masterRows) {
      if (u.userId === me.id) continue;
      if (blocked.has(u.userId)) continue;
      identities.push({
        kind: "user",
        userId: u.userId,
        characterId: null,
        displayName: u.username,
        masterUsername: u.username,
        avatarUrl: u.avatarUrl,
        avatarCrop: { zoom: u.avatarZoom, offsetX: u.avatarOffsetX, offsetY: u.avatarOffsetY },
        online: onlineUserIds.has(u.userId),
      });
    }

    for (const c of charRows) {
      if (c.ownerDisabledAt) continue;
      if (c.userId === me.id) continue;
      if (blocked.has(c.userId)) continue;
      identities.push({
        kind: "character",
        userId: c.userId,
        characterId: c.characterId,
        displayName: c.characterName,
        masterUsername: c.ownerUsername,
        avatarUrl: c.avatarUrl,
        avatarCrop: { zoom: c.avatarZoom, offsetX: c.avatarOffsetX, offsetY: c.avatarOffsetY },
        online: onlineUserIds.has(c.userId),
      });
    }

    // Sort: exact-prefix match wins, then online, then displayName
    // ascending. Same ranking the friends-rail uses so the order
    // feels familiar to existing users.
    const qLower = q.toLowerCase();
    identities.sort((a, b) => {
      const aPrefix = a.displayName.toLowerCase().startsWith(qLower) ? 0 : 1;
      const bPrefix = b.displayName.toLowerCase().startsWith(qLower) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });

    return { identities: identities.slice(0, limit) };
  });
}
