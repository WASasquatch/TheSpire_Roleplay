/**
 * Default rail category for NEW rooms (migration 0351) — the single
 * creation-time chokepoint every room-creation path consults so they all
 * agree: the console POST /servers/:id/rooms, the member-facing /go,
 * /private and /gopair commands, and the site-admin POST /admin/rooms
 * (which homes rooms on the default server).
 *
 * Precedence (an explicit categoryId in the request always wins BEFORE this
 * helper is called; callers only reach it with no explicit choice):
 *   1. role mapping — the creator holds a usergroup in this server with a
 *      `room_category_role_defaults` row; among several, the
 *      highest-sortOrder group wins (createdAt tie-break — the same pick
 *      rule as the userlist badge, servers/usergroups.ts);
 *   2. the server's `room_categories.is_default` category;
 *   3. null — the uncategorized bucket, exactly as before the feature.
 *
 * Creation-time only: nothing here ever moves an existing room, and a
 * server with no categories (no is_default, no role rows) resolves null.
 */

import { and, asc, eq } from "drizzle-orm";
import {
  roomCategories,
  roomCategoryRoleDefaults,
  serverUsergroupMembers,
  serverUsergroups,
} from "../db/schema.js";
import type { Db } from "../db/index.js";

export async function defaultRoomCategoryFor(
  db: Db,
  serverId: string | null,
  creatorUserId: string,
): Promise<string | null> {
  if (!serverId) return null;
  // Role-mapped defaults the creator holds in THIS server, in ascending
  // display order; the last row is the highest-sortOrder role, mirroring
  // userlistBadgesFor's later-write-wins pick. Cascades keep the join clean:
  // a deleted category or usergroup takes its mapping row with it.
  const mapped = await db
    .select({ categoryId: roomCategoryRoleDefaults.categoryId })
    .from(roomCategoryRoleDefaults)
    .innerJoin(serverUsergroups, eq(serverUsergroups.id, roomCategoryRoleDefaults.usergroupId))
    .innerJoin(
      serverUsergroupMembers,
      and(
        eq(serverUsergroupMembers.groupId, serverUsergroups.id),
        eq(serverUsergroupMembers.userId, creatorUserId),
      ),
    )
    .where(eq(serverUsergroups.serverId, serverId))
    .orderBy(asc(serverUsergroups.sortOrder), asc(serverUsergroups.createdAt));
  const rolePick = mapped[mapped.length - 1]?.categoryId;
  if (rolePick) return rolePick;
  const serverDefault = (await db
    .select({ id: roomCategories.id })
    .from(roomCategories)
    .where(and(eq(roomCategories.serverId, serverId), eq(roomCategories.isDefault, true)))
    .limit(1))[0];
  return serverDefault?.id ?? null;
}
