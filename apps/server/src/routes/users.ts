import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import { isAdminRole, isMasterAdminRole, type ClientToServerEvents, type ServerToClientEvents } from "@thekeep/shared";
import { characters, messages, userEarning, users } from "../db/schema.js";
import { getSessionUser } from "./auth.js";
import { recordAudit } from "../audit.js";
import { canonicalizeNameForLookup, loweredSpaceCanonical, substringNameInsensitive } from "../lib/nameLookup.js";
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
  app.get<{ Querystring: { q?: string; offset?: string; limit?: string; rank?: string; sort?: string } }>("/users", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    const q = (req.query.q ?? "").trim().toLowerCase();
    const offset = Math.max(0, parseInt(req.query.offset ?? "0", 10) || 0);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit ?? "100", 10) || 100));
    // Optional rank filter (master pool rank). Empty string / missing
    // disables the filter. We don't validate against the rank catalog
    // here — an unknown key just returns zero matches, which is the
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
    // stored as `John Doe` (NBSP) — the user-directory and add-friend
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
            error: `directory has more than ${MAX_INMEMORY_SORT_USERS} users — narrow with ?q= or use ?sort=name/joined`,
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
    const sockets = await io.fetchSockets();
    const onlineUserIds = new Set<string>();
    for (const s of sockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (uid) onlineUserIds.add(uid);
    }

    if (matchedUserIds.length === 0) return { users: [], total: 0, offset, limit };

    // Rank lookup (master pool only — character pools cascade
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
      .where(sql`${userEarning.userId} IN (${sql.join(matchedUserIds.map((u) => sql`${u}`), sql`, `)})`);
    const rankByUser = new Map(rankRows.map((r) => [r.userId, { rankKey: r.rankKey, tier: r.tier }]));

    // Filter by rank AFTER the lookup so the SQL doesn't have to
    // INNER JOIN (which would silently drop unranked users). Users
    // with no earning row never match a rank filter — same outcome
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

    // Lifetime message count per user — single GROUP BY for the
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
        // three categories private — the sum would leak the bulk
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
    // ALREADY the right page in the right order — restore that order
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
              // 0 so they don't accidentally float to the top — opting
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
              // Historic default — online users first, then offline,
              // alphabetical within each band.
              const aOn = onlineUserIds.has(a.id) ? 0 : 1;
              const bOn = onlineUserIds.has(b.id) ? 0 : 1;
              if (aOn !== bOn) return aOn - bOn;
              return a.username.localeCompare(b.username);
            }
          }
        });

    const pageRows = sqlPaginated ? sorted : sorted.slice(offset, offset + limit);
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
        // Null when ANY per-element hide flag is set — the directory
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
  app.get<{ Querystring: { q?: string; offset?: string; limit?: string } }>("/admin/users", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me || !isAdminRole(me.role)) { reply.code(403); return { error: "admin only" }; }

    const q = (req.query.q ?? "").trim().toLowerCase();
    const offset = Math.max(0, parseInt(req.query.offset ?? "0", 10) || 0);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit ?? "100", 10) || 100));

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
          )
        : undefined,
    );

    // Total count + page in two queries — was: SELECT all, sort in
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
    }));

    return { users: page, total, offset, limit };
  });

  /**
   * Admin user editor. Two-tier gating:
   *   * Both `admin` and `masteradmin` reach this endpoint.
   *   * Plain `admin` may rename a user and may promote/demote within
   *     {user, trusted, mod, admin} — they can build the moderation
   *     team but can't mint another masteradmin and can't demote one
   *     either.
   *   * `email` and `disabled` mutations are master-only — both are
   *     "damage" levers (account lockout, identity reassignment).
   *   * Promoting TO masteradmin or demoting FROM masteradmin is
   *     master-only by definition; a plain admin attempting either
   *     gets 403 so they can't escalate themselves through a chained
   *     promotion or kneecap the only top-tier admin.
   *
   * Password reset is intentionally out of scope here — users go
   * through their own password-recovery flow for that.
   */
  app.patch<{ Params: { id: string }; Body: unknown }>("/admin/users/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me || !isAdminRole(me.role)) { reply.code(403); return { error: "admin only" }; }
    const masterOnly = isMasterAdminRole(me.role);
    const { id } = req.params;
    if (id === me.id) { reply.code(400); return { error: "use the profile editor for your own account" }; }
    const target = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
    if (!target || target.username === "system") { reply.code(404); return { error: "not found" }; }

    const { z } = await import("zod");
    const { MASTER_USERNAME_RX, MASTER_USERNAME_RULE_MESSAGE } = await import("./auth.js");
    // Mirror the master-username rule from /auth/register so admins editing a
    // user's name can't introduce a Unicode-confusable identifier. Import
    // the regex + message from auth.ts so both paths stay in sync — a
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

    // Master-only field gates. We reject EARLY (before any write) so a
    // plain admin's accidental form submit doesn't half-apply.
    if (!masterOnly) {
      if (body.email !== undefined) {
        reply.code(403); return { error: "master admin only: changing user emails" };
      }
      if (body.disabled !== undefined) {
        reply.code(403); return { error: "master admin only: enabling/disabling accounts" };
      }
      // Role transitions that touch the masteradmin tier are master-only
      // — both promotion TO it and demotion FROM it. Without the latter
      // guard, a plain admin could quietly demote the master who
      // appointed them.
      if (body.role === "masteradmin" || target.role === "masteradmin") {
        reply.code(403); return { error: "master admin only: changing the masteradmin role" };
      }
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

    // If we just disabled the account or downgraded their role, force-kick
    // any live sockets they have so they drop back to the splash instead
    // of lingering in chat with stale permissions until they happen to
    // interact (which would trigger auth:expired anyway, but only if they
    // type/click). DELETE already does this - PATCH should mirror it.
    const justDisabled = body.disabled === true && target.disabledAt == null;
    const justEnabled = body.disabled === false && target.disabledAt != null;
    const roleChanged = body.role !== undefined && body.role !== target.role;
    if (justDisabled || roleChanged) {
      const sockets = await io.fetchSockets();
      for (const s of sockets) {
        const uid = (s.data as { userId?: string }).userId;
        if (uid !== id) continue;
        s.emit("auth:expired");
        s.disconnect(true);
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

  /**
   * Admin password reset. Hashes the provided plaintext and writes
   * it to the target user's `password_hash`. Bumps the audit log and
   * disconnects any live sockets that account had so they're forced
   * to re-authenticate with the new password.
   *
   * Master-admin only — handing out password resets is the most
   * destructive single-user lever (effectively account takeover from
   * the admin chair). Plain admins can't reach it.
   */
  app.patch<{ Params: { id: string }; Body: unknown }>("/admin/users/:id/password", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me || !isMasterAdminRole(me.role)) { reply.code(403); return { error: "master admin only" }; }
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
    // Master-only: hard-deleting a user cascades through every FK and
    // is the most destructive single-row action in the system.
    if (!me || !isMasterAdminRole(me.role)) { reply.code(403); return { error: "master admin only" }; }
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
   * active-character name of an existing user — typos and dangling
   * `@bobs` stay as plain text instead of dressing up as a clickable
   * (but-broken) chip.
   *
   * Input names are lowercased on both sides for case-insensitive
   * matching. The response lists only the names that resolved; any
   * input name not in the response is implicitly invalid (the client
   * treats it as such).
   *
   * Hard cap of 64 names per call — a single message can only
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
    // mention strings against `valid` directly — see
    // apps/web/src/state/mentions.ts which canonicalizes on the read
    // side too. Dedupe via Set so duplicate or NBSP/space variants of
    // the same name collapse to one query argument.
    const canonicals = Array.from(new Set(
      raw
        .filter((n): n is string => typeof n === "string" && n.length > 0 && n.length <= 64)
        .map((n) => canonicalizeNameForLookup(n))
    )).slice(0, 64);
    if (canonicals.length === 0) return { valid: [] };

    // Master usernames first — globally unique, fast hit. NB: only
    // non-disabled accounts (the system sentinel + any deactivated
    // accounts shouldn't surface as clickable mentions).
    const userMatches = await db
      .select({ username: users.username })
      .from(users)
      .where(
        and(
          isNull(users.disabledAt),
          sql`${users.username} != 'system'`,
          sql`${loweredSpaceCanonical(users.username)} IN (${sql.join(canonicals.map((n) => sql`${n}`), sql`, `)})`,
        ),
      );
    const valid = new Set(userMatches.map((u) => canonicalizeNameForLookup(u.username)));

    // Character names — match against any non-deleted character of
    // a non-disabled owner. The active-character constraint that the
    // push pipeline (broadcast.ts) applies is intentionally NOT used
    // here: that gate is about whether a mention should ping someone
    // RIGHT NOW. The renderer's question is "is this a real name with
    // a clickable profile?" — and an inactive character still has a
    // profile.
    const remaining = canonicals.filter((n) => !valid.has(n));
    if (remaining.length > 0) {
      const charMatches = await db
        .select({ name: characters.name })
        .from(characters)
        .innerJoin(users, eq(users.id, characters.userId))
        .where(
          and(
            isNull(characters.deletedAt),
            isNull(users.disabledAt),
            sql`${loweredSpaceCanonical(characters.name)} IN (${sql.join(remaining.map((n) => sql`${n}`), sql`, `)})`,
          ),
        );
      for (const c of charMatches) valid.add(canonicalizeNameForLookup(c.name));
    }

    return { valid: Array.from(valid) };
  });

  /**
   * Identity-keyed autocomplete for DM compose + add-friend pickers.
   *
   * The legacy `/users` endpoint rolled character matches up under
   * their owning master so the UI ended up rendering "MasterName as
   * CharacterName" — a privacy leak that violated the project's
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
    // online dot regardless of which identity matched — being online
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
      /** The master username — used only by the server-side caller
       *  filter; the client should NOT render this on the suggestion
       *  row, since exposing it leaks the OOC/character relationship
       *  the partition is meant to hide. */
      masterUsername: string;
      avatarUrl: string | null;
      avatarCrop: { zoom: number; offsetX: number; offsetY: number };
      online: boolean;
    }

    const identities: IdentityRow[] = [];

    for (const u of masterRows) {
      if (u.userId === me.id) continue;
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
