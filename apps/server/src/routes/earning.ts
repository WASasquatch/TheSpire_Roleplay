/**
 * Earning, public + self routes.
 *
 * - `GET /earning/me` returns the caller's wallet + active-character
 *   earning + unacknowledged rank-up notifications + the catalog
 *   slice the dashboard needs (ranks, tiers, name styles, cosmetics).
 *
 * - `GET /earning/users/:id` returns the public slice, rank/tier
 *   and currency (currency hidden when the target has
 *   `hideCurrencyCount = 1`).
 *
 * - `GET /earning/me/ledger` is the paginated activity history.
 *
 * - `PATCH /earning/me/settings` toggles the Currency privacy flag.
 *
 * - `GET /earning/me/notifications` and `POST .../rankup/ack` back
 *   the rank-up ribbon.
 *
 * Admin endpoints live in admin/earning.ts so the admin auth gate
 * already applies.
 *
 * MOVE-ONLY split (Phase 3): the route handlers were relocated into
 * ./earning/catalog.ts (reads) and ./earning/mutations.ts (writes);
 * shared helpers live in ./earning/shared.ts. This file stays the
 * barrel: it still exports `registerEarningRoutes` on the same import
 * path, defines the three db/io-capturing closures the routes need,
 * and invokes the two sub-registrars in order.
 */

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { serverSettings } from "../db/schema.js";
import { DEFAULT_SERVER_ID } from "../earning/pool.js";
import { serverAuthority } from "../servers/authority.js";
import { getSettings, areServersEnabled } from "../settings.js";
import type { getSessionUser } from "./auth.js";
import { type Io, type SubsystemToggles } from "./earning/shared.js";
import { registerEarningCatalogRoutes } from "./earning/catalog.js";
import { registerEarningMutationRoutes } from "./earning/mutations.js";

export async function registerEarningRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  /**
   * Re-broadcast occupant presence in every room the user has a live
   * socket in. Called after any change that affects how the user's
   * name renders to peers (name-style equip, border equip, inline-
   * avatar toggle, name-style color config), those cosmetics ride
   * the occupant cache, not the message wire, so without a presence
   * refresh other tabs / peers don't see the change until something
   * else triggers a broadcast (a join, a /char switch). Mirrors the
   * pattern in /me/profile (apps/server/src/routes/characters.ts:741).
   */
  async function rebroadcastPresenceForUser(userId: string): Promise<void> {
    const sockets = await io.fetchSockets();
    const rooms = new Set<string>();
    for (const s of sockets) {
      if ((s.data as { userId?: string }).userId !== userId) continue;
      for (const r of s.rooms) if (r.startsWith("room:")) rooms.add(r.slice(5));
    }
    if (rooms.size === 0) return;
    const { broadcastPresence } = await import("../realtime/broadcast.js");
    for (const roomId of rooms) await broadcastPresence(io, db, roomId);
  }

  /**
   * Resolve the caller's ACTIVE economy server for any earning route.
   *
   * Canonical resolver, factored out of `/earning/me` so every
   * read/shop/equip route below partitions on the same rule:
   *   - A non-default `?serverId=` is honored ONLY when the multi-server
   *     feature is live AND the caller may view that server's economy
   *     (the server exists and the caller is a member — owner/admin/mod
   *     fold into serverAuthority.isMember, and the manage_any_server
   *     staff override folds into isOwner ⇒ isMember).
   *   - Anything else (flag off, missing/blank query, already the
   *     default, an unknown id, or a server the caller can't see) falls
   *     back to DEFAULT_SERVER_ID so the route stays byte-identical to
   *     the legacy single-server behavior and never errors or leaks a
   *     foreign pool. The query-absent / already-default fast path skips
   *     every extra DB hit, keeping the flag-off path zero-overhead.
   */
  async function resolveActiveServerId(
    me: NonNullable<Awaited<ReturnType<typeof getSessionUser>>>,
    requestedServerId: string | undefined,
  ): Promise<string> {
    if (
      requestedServerId &&
      requestedServerId !== DEFAULT_SERVER_ID &&
      areServersEnabled(await getSettings(db))
    ) {
      const authority = await serverAuthority(db, me, requestedServerId);
      // Require canParticipate, not raw membership: a globally suspended/banned
      // (or 18+-frozen) server must not keep serving its economy pool. This
      // routes a frozen-server member back onto the DEFAULT pool, consistent
      // with the other fallbacks, so the moderation gate stays the single
      // chokepoint the server-moderation plan intends.
      if (authority.server && authority.isMember && authority.canParticipate) return requestedServerId;
    }
    return DEFAULT_SERVER_ID;
  }

  /**
   * Per-server EARNING SUBSYSTEM toggles (migration 0293). A server owner can
   * shut off a whole earning subsystem for THEIR server; when off, its catalog
   * section is omitted from the dashboard and its purchase routes 403. The six
   * toggle columns live on `server_settings` and are nullable: NULL means
   * "inherit the platform default", which is ON for every subsystem.
   *
   * DEFAULT_SERVER_ID (and therefore the flag-off path, which always resolves to
   * it) is hard-coded to all-ON without a DB read — The Spire's own economy has
   * no subsystem-disable concept and stays byte-identical to today. Only a
   * resolved non-default `sid` reads its row; an absent row (server never tuned
   * a toggle) inherits → all-ON as well.
   */
  const ALL_SUBSYSTEMS_ON: SubsystemToggles = {
    shop: true,
    ranks: true,
    nameStyles: true,
    borders: true,
    roomTransitions: true,
    cosmetics: true,
  };

  async function resolveSubsystemToggles(sid: string): Promise<SubsystemToggles> {
    // The default server (and the flag-off path that always lands on it) never
    // disables a subsystem: skip the read and return all-ON so the legacy
    // single-server behavior is byte-identical.
    if (sid === DEFAULT_SERVER_ID) return ALL_SUBSYSTEMS_ON;
    const row = (await db
      .select({
        shopEnabled: serverSettings.shopEnabled,
        ranksEnabled: serverSettings.ranksEnabled,
        nameStylesEnabled: serverSettings.nameStylesEnabled,
        bordersEnabled: serverSettings.bordersEnabled,
        roomTransitionsEnabled: serverSettings.roomTransitionsEnabled,
        cosmeticsEnabled: serverSettings.cosmeticsEnabled,
      })
      .from(serverSettings)
      .where(eq(serverSettings.serverId, sid))
      .limit(1))[0];
    if (!row) return ALL_SUBSYSTEMS_ON;
    // NULL = inherit = ON; only an explicit `false` disables a subsystem.
    return {
      shop: row.shopEnabled ?? true,
      ranks: row.ranksEnabled ?? true,
      nameStyles: row.nameStylesEnabled ?? true,
      borders: row.bordersEnabled ?? true,
      roomTransitions: row.roomTransitionsEnabled ?? true,
      cosmetics: row.cosmeticsEnabled ?? true,
    };
  }

  const deps = { app, db, io, rebroadcastPresenceForUser, resolveActiveServerId, resolveSubsystemToggles };
  await registerEarningCatalogRoutes(deps);
  await registerEarningMutationRoutes(deps);
}
