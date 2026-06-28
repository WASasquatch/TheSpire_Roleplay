/**
 * Forum usergroups — default-group seeding + the auto-join rule engine.
 *
 * The DEFAULT group is the implicit baseline every participant belongs to; it
 * holds no member rows. It's seeded lazily (first time the owner opens the
 * Usergroups tab) with the full feature set so existing forums stay open.
 *
 * Non-default groups can carry auto-join rules (post/topic count, posted-in-
 * category, account/member age). `evaluateAutoGroups` runs cheaply after a
 * member posts: for each auto group the user isn't already in, it checks every
 * rule (AND) and adds an automatic membership when they all pass. Lazy /
 * event-driven — no cron; age rules simply take effect on the member's next
 * post past the threshold.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  FORUM_FEATURE_PERMISSIONS,
  parseForumAutoRules,
  serializeForumPermissions,
  type ForumAutoRule,
} from "@thekeep/shared";
import { forumMembers, forumUsergroupMembers, forumUsergroups, messages, rooms, users } from "../db/schema.js";
import type { Db } from "../db/index.js";

const DAY_MS = 86_400_000;

/** The live (non-archived) board room ids of a forum. */
export async function forumBoardIds(db: Db, forumId: string): Promise<string[]> {
  return (await db.select({ id: rooms.id }).from(rooms).where(and(eq(rooms.forumId, forumId), isNull(rooms.archivedAt)))).map((r) => r.id);
}

/** Get the forum's default usergroup, creating it (seeded with the full
 *  feature set) the first time it's needed so existing forums are unchanged. */
export async function ensureDefaultUsergroup(db: Db, forumId: string) {
  const existing = (await db.select().from(forumUsergroups)
    .where(and(eq(forumUsergroups.forumId, forumId), eq(forumUsergroups.isDefault, true))).limit(1))[0];
  if (existing) return existing;
  // Conflict-safe insert: the partial unique index (migration 0271,
  // one default per forum) makes a concurrent double-seed a no-op rather
  // than a second default row. Re-select the surviving default afterwards.
  await db.insert(forumUsergroups).values({
    id: nanoid(),
    forumId,
    name: "Members",
    isDefault: true,
    sortOrder: 0,
    permissionsJson: serializeForumPermissions([...FORUM_FEATURE_PERMISSIONS]),
    autoRulesJson: "[]",
  }).onConflictDoNothing();
  return (await db.select().from(forumUsergroups)
    .where(and(eq(forumUsergroups.forumId, forumId), eq(forumUsergroups.isDefault, true))).limit(1))[0];
}

/**
 * Re-evaluate a member's automatic usergroup memberships in a forum and add
 * them to any group whose every auto-rule they now satisfy. Cheap no-op when
 * the forum defines no auto-rule groups. Never removes memberships (earned
 * standing sticks); failures are swallowed by the caller.
 */
export async function evaluateAutoGroups(db: Db, forumId: string, userId: string): Promise<void> {
  const groups = (await db.select({ id: forumUsergroups.id, autoRulesJson: forumUsergroups.autoRulesJson })
    .from(forumUsergroups)
    .where(and(eq(forumUsergroups.forumId, forumId), eq(forumUsergroups.isDefault, false))))
    .map((g) => ({ id: g.id, rules: parseForumAutoRules(g.autoRulesJson) }))
    .filter((g) => g.rules.length > 0);
  if (!groups.length) return;

  // Already-held auto groups don't need re-checking.
  const alreadyIn = new Set(
    (await db.select({ groupId: forumUsergroupMembers.groupId }).from(forumUsergroupMembers)
      .where(and(eq(forumUsergroupMembers.userId, userId), inArray(forumUsergroupMembers.groupId, groups.map((g) => g.id)))))
      .map((m) => m.groupId),
  );
  const pending = groups.filter((g) => !alreadyIn.has(g.id));
  if (!pending.length) return;

  const boardIds = await forumBoardIds(db, forumId);
  // Lazily compute each metric only if some pending rule needs it.
  const needs = new Set<ForumAutoRule["kind"]>();
  for (const g of pending) for (const r of g.rules) needs.add(r.kind);

  const countWhere = boardIds.length ? and(inArray(messages.roomId, boardIds), eq(messages.userId, userId), isNull(messages.deletedAt)) : null;
  const num = (rows: { n: number }[]) => Number(rows[0]?.n ?? 0);

  let postCount = 0, topicCount = 0;
  if (countWhere && needs.has("post_count")) {
    postCount = num(await db.select({ n: sql<number>`count(*)` }).from(messages).where(countWhere));
  }
  if (countWhere && needs.has("topic_count")) {
    topicCount = num(await db.select({ n: sql<number>`count(*)` }).from(messages)
      .where(and(countWhere, isNull(messages.replyToId), sql`${messages.title} is not null`)));
  }
  let accountAgeDays = 0;
  if (needs.has("account_age_days")) {
    const u = (await db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId)).limit(1))[0];
    if (u) accountAgeDays = Math.floor((Date.now() - +u.createdAt) / DAY_MS);
  }
  let memberAgeDays: number | null = null;
  if (needs.has("member_age_days")) {
    const m = (await db.select({ joinedAt: forumMembers.joinedAt }).from(forumMembers)
      .where(and(eq(forumMembers.forumId, forumId), eq(forumMembers.userId, userId))).limit(1))[0];
    if (m) memberAgeDays = Math.floor((Date.now() - +m.joinedAt) / DAY_MS);
  }
  // posted_in_category answers are cached per category id.
  const catPosted = new Map<string, boolean>();
  async function hasPostedInCategory(categoryId: string): Promise<boolean> {
    if (!countWhere) return false;
    const cached = catPosted.get(categoryId);
    if (cached !== undefined) return cached;
    const n = num(await db.select({ n: sql<number>`count(*)` }).from(messages)
      .where(and(countWhere, eq(messages.threadCategoryId, categoryId))));
    const ok = n > 0;
    catPosted.set(categoryId, ok);
    return ok;
  }

  async function ruleMatches(rule: ForumAutoRule): Promise<boolean> {
    switch (rule.kind) {
      case "post_count": return postCount >= rule.min;
      case "topic_count": return topicCount >= rule.min;
      case "account_age_days": return accountAgeDays >= rule.min;
      case "member_age_days": return memberAgeDays !== null && memberAgeDays >= rule.min;
      case "posted_in_category": return hasPostedInCategory(rule.categoryId);
    }
  }

  for (const g of pending) {
    let all = true;
    for (const rule of g.rules) {
      if (!(await ruleMatches(rule))) { all = false; break; }
    }
    if (!all) continue;
    await db.insert(forumUsergroupMembers)
      .values({ groupId: g.id, userId, isAuto: true })
      .onConflictDoNothing();
  }
}
