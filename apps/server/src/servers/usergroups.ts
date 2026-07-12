/**
 * Server usergroups — default-group seeding + the auto-join rule engine.
 *
 * The DEFAULT group is the implicit baseline every participant belongs to; it
 * holds no member rows. It's seeded lazily (first time the owner opens the
 * Usergroups tab) with the full FEATURE set so existing servers stay open —
 * every member keeps "post / create rooms / upload / use emoticons / invite"
 * until an owner deliberately narrows the default group. Usergroups grant
 * member FEATURES only (moderation power comes from the role tier), so a group
 * — default or named — can never mint a moderator.
 *
 * Mirror of `forums/usergroups.ts`: the resolver that turns groups into a
 * permission set lives in `servers/authority.ts` (`resolveUsergroupPerms`),
 * exactly as the forum module keeps it inside `forums/authority.ts`.
 *
 * Non-default groups can carry auto-join rules (`server_usergroups
 * .auto_rules_json`): message count, posted-in-room, account age, server-member
 * age. `evaluateServerAutoGroups` runs cheaply after a member posts — for each
 * auto group the user isn't already in, it checks every rule (AND) and adds an
 * automatic membership when they all pass. Lazy / event-driven (no cron); age
 * rules take effect on the member's next post past the threshold; memberships
 * are never auto-removed (earned standing sticks).
 */
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  SERVER_FEATURE_PERMISSIONS,
  parseServerAutoRules,
  serializeServerFeaturePermissions,
  type ServerAutoRule,
} from "@thekeep/shared";
import { messages, rooms, serverMembers, serverUsergroupMembers, serverUsergroups, users } from "../db/schema.js";
import { DEFAULT_SERVER_ID } from "../earning/pool.js";
import type { Db } from "../db/index.js";

const DAY_MS = 86_400_000;

/** The live (non-archived) room ids of a server — the surface the auto-group
 *  metrics (message count, posted-in-room) scope to, matching the forum
 *  `forumBoardIds` helper. Legacy NULL-serverId rooms are adopted by the
 *  default/system server (the documented NULL-adoption contract used by
 *  `roomInServer`), so auto-rules on the default server count them too. */
export async function serverRoomIds(db: Db, serverId: string): Promise<string[]> {
  const where = serverId === DEFAULT_SERVER_ID
    ? and(isNull(rooms.archivedAt), or(eq(rooms.serverId, serverId), isNull(rooms.serverId)))
    : and(isNull(rooms.archivedAt), eq(rooms.serverId, serverId));
  return (await db.select({ id: rooms.id }).from(rooms).where(where)).map((r) => r.id);
}

/** Get the server's default usergroup, creating it (seeded with the full
 *  FEATURE set) the first time it's needed so existing servers are unchanged. */
export async function ensureDefaultUsergroup(db: Db, serverId: string) {
  const existing = (await db.select().from(serverUsergroups)
    .where(and(eq(serverUsergroups.serverId, serverId), eq(serverUsergroups.isDefault, true))).limit(1))[0];
  if (existing) return existing;
  // Conflict-safe insert: the partial unique index (migration 0275,
  // one default per server) makes a concurrent double-seed a no-op rather
  // than a second default row. Re-select the surviving default afterwards.
  await db.insert(serverUsergroups).values({
    id: nanoid(),
    serverId,
    name: "Members",
    isDefault: true,
    sortOrder: 0,
    permissionsJson: serializeServerFeaturePermissions([...SERVER_FEATURE_PERMISSIONS]),
    autoRulesJson: "[]",
  }).onConflictDoNothing();
  return (await db.select().from(serverUsergroups)
    .where(and(eq(serverUsergroups.serverId, serverId), eq(serverUsergroups.isDefault, true))).limit(1))[0];
}

/**
 * The named (non-default) usergroups `userId` holds in `serverId`, in the
 * owner's display order — the profile "Roles" badge feed. Server-contextual
 * by design: the caller resolves WHICH server (the viewer's current one)
 * and an offsite view simply never calls this. Default groups are excluded
 * (implicit everyone — a badge on every profile says nothing).
 */
export async function serverRolesFor(
  db: Db,
  serverId: string,
  userId: string,
): Promise<Array<{ name: string; color: string | null }>> {
  const rows = await db
    .select({ name: serverUsergroups.name, color: serverUsergroups.color })
    .from(serverUsergroupMembers)
    .innerJoin(serverUsergroups, eq(serverUsergroups.id, serverUsergroupMembers.groupId))
    .where(and(
      eq(serverUsergroupMembers.userId, userId),
      eq(serverUsergroups.serverId, serverId),
      eq(serverUsergroups.isDefault, false),
    ))
    .orderBy(asc(serverUsergroups.sortOrder), asc(serverUsergroups.createdAt));
  return rows.map((r) => ({ name: r.name, color: r.color ?? null }));
}

/**
 * Userlist badge pick, batched over a whole occupant set (migration 0348):
 * for each user in `userIds`, the group with the HIGHEST `sort_order`
 * (createdAt tie-break — i.e. the last group in the owner's display order)
 * among this server's named groups with `showBadge` enabled that the user
 * belongs to. Viewer-agnostic by design so it can ride the shared presence
 * payload; one query per room so presence broadcasts stay O(1) in queries.
 * Default groups are excluded (implicit everyone — a badge on every row
 * says nothing). Empty map when no group opts in.
 */
export async function userlistBadgesFor(
  db: Db,
  serverId: string,
  userIds: string[],
): Promise<Map<string, { name: string; color: string | null }>> {
  const out = new Map<string, { name: string; color: string | null }>();
  if (!userIds.length) return out;
  const rows = await db
    .select({
      userId: serverUsergroupMembers.userId,
      name: serverUsergroups.name,
      color: serverUsergroups.color,
    })
    .from(serverUsergroupMembers)
    .innerJoin(serverUsergroups, eq(serverUsergroups.id, serverUsergroupMembers.groupId))
    .where(and(
      eq(serverUsergroups.serverId, serverId),
      eq(serverUsergroups.isDefault, false),
      eq(serverUsergroups.showBadge, true),
      inArray(serverUsergroupMembers.userId, userIds),
    ))
    .orderBy(asc(serverUsergroups.sortOrder), asc(serverUsergroups.createdAt));
  // Rows arrive in ascending display order; later writes overwrite earlier
  // ones, so each user ends up with their highest-sort_order badge group.
  for (const r of rows) out.set(r.userId, { name: r.name, color: r.color ?? null });
  return out;
}

/**
 * Re-evaluate a member's automatic usergroup memberships in a server and add
 * them to any group whose every auto-rule they now satisfy. Cheap no-op when
 * the server defines no auto-rule groups. Never removes memberships (earned
 * standing sticks); failures are swallowed by the caller. Returns true when
 * at least one membership was granted, so the post path can pulse the rooms
 * tree — an auto-earned role may unlock role-gated rooms (migration 0349).
 */
export async function evaluateServerAutoGroups(db: Db, serverId: string, userId: string): Promise<boolean> {
  const groups = (await db.select({ id: serverUsergroups.id, autoRulesJson: serverUsergroups.autoRulesJson })
    .from(serverUsergroups)
    .where(and(eq(serverUsergroups.serverId, serverId), eq(serverUsergroups.isDefault, false))))
    .map((g) => ({ id: g.id, rules: parseServerAutoRules(g.autoRulesJson) }))
    .filter((g) => g.rules.length > 0);
  if (!groups.length) return false;

  // Already-held auto groups don't need re-checking.
  const alreadyIn = new Set(
    (await db.select({ groupId: serverUsergroupMembers.groupId }).from(serverUsergroupMembers)
      .where(and(eq(serverUsergroupMembers.userId, userId), inArray(serverUsergroupMembers.groupId, groups.map((g) => g.id)))))
      .map((m) => m.groupId),
  );
  const pending = groups.filter((g) => !alreadyIn.has(g.id));
  if (!pending.length) return false;

  const roomIds = await serverRoomIds(db, serverId);
  // Lazily compute each metric only if some pending rule needs it.
  const needs = new Set<ServerAutoRule["kind"]>();
  for (const g of pending) for (const r of g.rules) needs.add(r.kind);

  const countWhere = roomIds.length ? and(inArray(messages.roomId, roomIds), eq(messages.userId, userId), isNull(messages.deletedAt)) : null;
  const num = (rows: { n: number }[]) => Number(rows[0]?.n ?? 0);

  let messageCount = 0;
  if (countWhere && needs.has("message_count")) {
    messageCount = num(await db.select({ n: sql<number>`count(*)` }).from(messages).where(countWhere));
  }
  let accountAgeDays = 0;
  if (needs.has("account_age_days")) {
    const u = (await db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId)).limit(1))[0];
    if (u) accountAgeDays = Math.floor((Date.now() - +u.createdAt) / DAY_MS);
  }
  let memberAgeDays: number | null = null;
  if (needs.has("member_age_days")) {
    const m = (await db.select({ joinedAt: serverMembers.joinedAt }).from(serverMembers)
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId))).limit(1))[0];
    if (m) memberAgeDays = Math.floor((Date.now() - +m.joinedAt) / DAY_MS);
  }
  // posted_in_room answers are cached per room id.
  const roomPosted = new Map<string, boolean>();
  async function hasPostedInRoom(roomId: string): Promise<boolean> {
    if (!roomIds.includes(roomId)) return false;
    const cached = roomPosted.get(roomId);
    if (cached !== undefined) return cached;
    const n = num(await db.select({ n: sql<number>`count(*)` }).from(messages)
      .where(and(eq(messages.roomId, roomId), eq(messages.userId, userId), isNull(messages.deletedAt))));
    const ok = n > 0;
    roomPosted.set(roomId, ok);
    return ok;
  }

  async function ruleMatches(rule: ServerAutoRule): Promise<boolean> {
    switch (rule.kind) {
      case "message_count": return messageCount >= rule.min;
      case "account_age_days": return accountAgeDays >= rule.min;
      case "member_age_days": return memberAgeDays !== null && memberAgeDays >= rule.min;
      case "posted_in_room": return hasPostedInRoom(rule.roomId);
    }
  }

  let granted = false;
  for (const g of pending) {
    let all = true;
    for (const rule of g.rules) {
      if (!(await ruleMatches(rule))) { all = false; break; }
    }
    if (!all) continue;
    await db.insert(serverUsergroupMembers)
      .values({ groupId: g.id, userId, isAuto: true })
      .onConflictDoNothing();
    granted = true;
  }
  return granted;
}
