/**
 * Server usergroups — default-group seeding + the live-room helper.
 *
 * The DEFAULT group is the implicit baseline every participant belongs to; it
 * holds no member rows. It's seeded lazily (first time the owner opens the
 * Usergroups tab) with the full FEATURE set so existing servers stay open —
 * every member keeps "post / create rooms / upload / use emoticons / invite"
 * until an owner deliberately narrows the default group. Moderation keys are
 * NOT in the default baseline (they're granted per-mod or via a non-default
 * group), so seeding the default group never mints a moderator.
 *
 * Mirror of `forums/usergroups.ts`: the resolver that turns groups into a
 * permission set lives in `servers/authority.ts` (`resolveUsergroupPerms`),
 * exactly as the forum module keeps it inside `forums/authority.ts`.
 *
 * Non-default groups may later carry auto-join rules (`server_usergroups
 * .auto_rules_json`), matching the forum auto-group engine. The shared
 * server-side rule TYPES (parse/serialize, the rule kinds) are not part of
 * Phase 0's registry, so the auto-group evaluator is intentionally NOT cloned
 * here yet — it lands with the rule types in a later phase. This file ships the
 * pieces the Phase-4 routes need now: default-group seeding + the board-room
 * lookup the evaluator will reuse.
 */
import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { SERVER_FEATURE_PERMISSIONS, serializeServerPermissions } from "@thekeep/shared";
import { rooms, serverUsergroups } from "../db/schema.js";
import type { Db } from "../db/index.js";

/** The live (non-archived) room ids of a server — the surface the auto-group
 *  metrics (post/topic counts, posted-in-room) will scope to, matching the
 *  forum `forumBoardIds` helper. */
export async function serverRoomIds(db: Db, serverId: string): Promise<string[]> {
  return (await db.select({ id: rooms.id }).from(rooms).where(and(eq(rooms.serverId, serverId), isNull(rooms.archivedAt)))).map((r) => r.id);
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
    permissionsJson: serializeServerPermissions([...SERVER_FEATURE_PERMISSIONS]),
    autoRulesJson: "[]",
  }).onConflictDoNothing();
  return (await db.select().from(serverUsergroups)
    .where(and(eq(serverUsergroups.serverId, serverId), eq(serverUsergroups.isDefault, true))).limit(1))[0];
}
