/**
 * Per-server earning-pool accessor (Servers Lift, Phase 5.7).
 *
 * The economy pools (`user_earning` / `character_earning`) are now grained by
 * (server_id, identity_id) — a person's XP / Currency / Rank / equipped
 * cosmetics are SEPARATE per server (migration 0283). Every read of a single
 * pool row must therefore key on a `serverId` as well as the owner id.
 *
 * This module is the single, typed funnel for those single-pool reads. All
 * direct `.from(userEarning) / .from(characterEarning)` single-row lookups in
 * the earning runtime route through {@link readPool} so:
 *   - the server_id filter is impossible to forget, and
 *   - a future CI grep gate can ban raw `.from(userEarning)` reads outside
 *     this file (the foundation called for in the task).
 *
 * FLAG-OFF SAFETY: until the servers flag is on and additional servers exist,
 * every caller passes {@link DEFAULT_SERVER_ID} (the only server, and the
 * Phase-2 backfill target), so `readPool` returns exactly the row it returns
 * today. Behavior is byte-identical with the flag off.
 *
 * NOTE: aggregate / leaderboard reads (`rankings.ts` et al.) that scan ALL
 * pools are intentionally NOT routed through here — they filter server_id in
 * their own queries. This accessor is for single-identity pool lookups.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import {
  characterEarning,
  rooms,
  serverMembers,
  servers,
  userEarning,
  users,
  type DbCharacterEarning,
  type DbUserEarning,
} from "../db/schema.js";

/**
 * The literal id of the undeletable default server (`is_system`). All legacy
 * data homes here (Phase-2 backfill) and it is the only server until the
 * servers flag is on, so it is the safe fallback for every credit/read whose
 * crediting room can't supply a serverId.
 */
export const DEFAULT_SERVER_ID = "server_spire_system";

export type EarningScope = "user" | "character";

/** A pool row for either scope, narrowed by the caller via the `scope` it asked for. */
export type PoolRow = DbUserEarning | DbCharacterEarning;

/**
 * Read a single earning pool row for `(serverId, scope, ownerId)`. Returns the
 * full row, or `undefined` when the pool doesn't exist yet on that server
 * (fresh identity). This is the canonical single-pool read for the earning
 * runtime — prefer it over a raw `.from(userEarning)/.from(characterEarning)`.
 */
export async function readPool(
  db: Db,
  serverId: string,
  scope: EarningScope,
  ownerId: string,
): Promise<PoolRow | undefined> {
  if (scope === "user") {
    return (await db
      .select()
      .from(userEarning)
      .where(and(eq(userEarning.serverId, serverId), eq(userEarning.userId, ownerId)))
      .limit(1))[0];
  }
  return (await db
    .select()
    .from(characterEarning)
    .where(and(eq(characterEarning.serverId, serverId), eq(characterEarning.characterId, ownerId)))
    .limit(1))[0];
}

/**
 * Resolve which server's per-server identity a PROFILE should render — the
 * profile OWNER's favorite/default server (`users.default_server_id`), else the
 * system default. A global profile view has no viewer-server context, so the
 * owner's chosen favorite is the anchor for EVERY per-server profile read
 * (collection, pet collection, equipped name style, banner, marquee + visitor
 * flair) so they all agree on one server.
 *
 * Resolution, in order:
 *   1. `users.default_server_id` is NULL → DEFAULT_SERVER_ID.
 *   2. It points at the system server → DEFAULT_SERVER_ID (same id; the system
 *      server needs no membership row, everyone is an implicit member).
 *   3. The server exists AND the owner still belongs to it (a `server_members`
 *      row) → that server.
 *   4. Otherwise (server deleted, or the owner left it) → DEFAULT_SERVER_ID.
 *
 * Step 4 is the application-level equivalent of the column's documented
 * "ON DELETE SET NULL": a stale / no-longer-a-member favorite reads exactly as
 * if it were unset. FLAG-OFF SAFETY: with the servers flag off no one has a
 * favorite set (the UI to set one is flag-gated), so every profile resolves to
 * DEFAULT_SERVER_ID — byte-identical to today.
 *
 * `ownerUserId` is the MASTER account id of the profile owner (the favorite is
 * an account-level preference; a character profile uses its owner's favorite).
 */
export async function resolveProfileServerId(db: Db, ownerUserId: string): Promise<string> {
  const u = (await db
    .select({ favorite: users.defaultServerId })
    .from(users)
    .where(eq(users.id, ownerUserId))
    .limit(1))[0];
  const favorite = u?.favorite ?? null;
  if (!favorite || favorite === DEFAULT_SERVER_ID) return DEFAULT_SERVER_ID;
  // The favorite must still exist, be live (servers are soft-archived, never
  // hard-deleted), and the owner must still be a member of it (the system
  // server is handled above; every other server needs a real membership row).
  // A miss on any of these falls back to the system default.
  const server = (await db
    .select({ id: servers.id, isSystem: servers.isSystem, status: servers.status })
    .from(servers)
    .where(eq(servers.id, favorite))
    .limit(1))[0];
  if (!server || server.status === "archived") return DEFAULT_SERVER_ID;
  if (server.isSystem) return server.id;
  const membership = (await db
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, favorite), eq(serverMembers.userId, ownerUserId)))
    .limit(1))[0];
  return membership ? favorite : DEFAULT_SERVER_ID;
}

/**
 * Resolve the serverId a credit should land on from the crediting room.
 * `rooms.serverId` is nullable (legacy/system rooms), so a missing value
 * (room not found, or NULL serverId) falls back to {@link DEFAULT_SERVER_ID}.
 * This is the canonical "derive from the crediting room, else default" step
 * the FLAG-OFF SAFETY RULE calls for: with the flag off every room homes to
 * the default server, so the credit lands in today's pool.
 */
export async function resolveRoomServerId(db: Db, roomId: string | null | undefined): Promise<string> {
  if (!roomId) return DEFAULT_SERVER_ID;
  const row = (await db
    .select({ serverId: rooms.serverId })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1))[0];
  return row?.serverId ?? DEFAULT_SERVER_ID;
}
