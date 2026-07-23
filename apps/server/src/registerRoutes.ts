// The io-dependent route registration block, lifted verbatim from index.ts's
// main(). These registrars all run after the Socket.IO server exists (several
// take `io` for socket-room introspection / presence rebroadcast). The three
// interleaved boot hooks that live inside this block — initPush, initGeoDb, and
// backfillTheaterTitles — are kept in their exact original positions so the boot
// order and side effects are unchanged.
import { dirname } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import type { Db } from "./db/index.js";
import type { CommandRegistry } from "./commands/registry.js";
import { getSessionUser } from "./routes/auth.js";
import { getSettings } from "./settings.js";
import { registerCharacterRoutes } from "./routes/characters.js";
import { registerAffiliateRoutes } from "./routes/affiliates.js";
import { registerBookmarkRoutes } from "./routes/bookmarks.js";
import { registerDirectMessageRoutes } from "./routes/directMessages.js";
import { registerStaffRoutes } from "./routes/staff.js";
import { registerEmoticonRoutes } from "./routes/emoticons.js";
import { registerFriendsRoutes } from "./routes/friends.js";
import { registerBlockRoutes } from "./routes/blocks.js";
import { registerJournalRoutes } from "./routes/journal.js";
import { registerDataExportRoutes } from "./routes/dataExport.js";
import { registerLinkRoutes } from "./routes/links.js";
import { registerWorldRoutes } from "./routes/worlds.js";
import { registerStoryRoutes } from "./routes/stories.js";
import { registerForumRoutes } from "./routes/forums.js";
import { registerServerRoutes } from "./routes/servers.js";
import { registerAdminServerRoutes } from "./admin/servers.js";
import { registerNpcRoutes } from "./routes/npcs.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerReportRoutes } from "./routes/reports.js";
import { registerPushRoutes } from "./routes/push.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerRoomReadsRoutes } from "./routes/roomReads.js";
import { registerSearchRoutes } from "./routes/search.js";
import { initGeoDb } from "./analytics/geoDb.js";
import { backfillTheaterTitles } from "./realtime/theaterTitleBackfill.js";
import { initPush } from "./push.js";
import { registerRoomsRoutes } from "./routes/rooms.js";
import { registerEarningRoutes } from "./routes/earning.js";
import { registerArcadeRoutes } from "./routes/arcade.js";
import { registerUrugalRoutes } from "./routes/arcadeUrugal.js";
import { registerGrimholdRoutes } from "./routes/arcadeGrimhold.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { registerSplashRankingRoutes } from "./routes/splashRankings.js";
import { registerAnalyticsRoutes } from "./analytics/ingest.js";
import { registerAnalyticsAdminRoutes } from "./analytics/admin.js";
import { registerThesaurusRoutes } from "./routes/thesaurus.js";
import { registerUsersRoutes } from "./routes/users.js";
import { registerAdminRoutes } from "./admin/routes.js";

/**
 * Register every route module that depends on the Socket.IO server, plus the
 * three interleaved boot hooks (push VAPID init, MaxMind geo DB, theater-title
 * backfill). Call once, after `io` is constructed and the pre-io routes are
 * registered.
 */
export async function registerAllRoutes(
  baseApp: FastifyInstance,
  deps: {
    db: Db;
    io: IoServer<ClientToServerEvents, ServerToClientEvents>;
    registry: CommandRegistry;
    uploadsRoot: string;
    dbPath: string;
  },
): Promise<void> {
  const { db, io, registry, uploadsRoot, dbPath } = deps;
  // Routes that need io for socket-room introspection (currently-online
  // occupants per room, presence rebroadcast on character delete, etc.) -
  // registered after io is constructed.
  await registerCharacterRoutes(baseApp, db, io);
  await registerLinkRoutes(baseApp, db);
  await registerJournalRoutes(baseApp, db);
  await registerDataExportRoutes(baseApp, db, uploadsRoot);
  await registerAffiliateRoutes(baseApp, db);
  await registerBookmarkRoutes(baseApp, db);
  await registerWorldRoutes(baseApp, db, io, uploadsRoot);
  await registerStoryRoutes(baseApp, db, io);
  await registerForumRoutes(baseApp, db, io, uploadsRoot);
  await registerServerRoutes(baseApp, db, io, uploadsRoot, registry);
  await registerAdminServerRoutes(baseApp, db, io);
  await registerNpcRoutes(baseApp, db);
  await registerFriendsRoutes(baseApp, db, io);
  await registerBlockRoutes(baseApp, db, io);
  await registerDirectMessageRoutes(baseApp, db, io);
  await registerStaffRoutes(baseApp, db);
  await registerEmoticonRoutes(baseApp, db, io, uploadsRoot);
  await registerMessageRoutes(baseApp, db, io);
  await registerReportRoutes(baseApp, db);
  await registerPushRoutes(baseApp, db);
  await registerNotificationRoutes(baseApp, db, io);
  // Per-channel unread/mute reads (Batch 2). Needs `io` because the read/mute
  // routes emit "room:unread" sockets to the caller's tabs. Same 3-arg shape as
  // registerNotificationRoutes.
  await registerRoomReadsRoutes(baseApp, db, io);
  // Server-wide message search (Batch 2). GET /search/messages, (app, db) only.
  await registerSearchRoutes(baseApp, db);
  // Generate VAPID keys at first boot if missing, then configure web-push.
  // Idempotent on subsequent starts; survives deploys via the persisted keys.
  await initPush(db);
  await registerStatsRoutes(baseApp, db, io);
  // Public homepage member-rankings marquee (anonymous, cached).
  await registerSplashRankingRoutes(baseApp, db);
  // First-party analytics ingest (client beacon) + admin read endpoints
  // (plan_ext.md §5). Both no-op / stay staff-gated when the master
  // `analyticsEnabled` switch is off. `/a/e` is anonymous-safe + rate-limited;
  // `/admin/analytics/*` is gated by `view_admin_analytics`. `/a` and `/admin`
  // are already in the SPA-fallback apiPrefixes list.
  await registerAnalyticsRoutes(baseApp, db);
  await registerAnalyticsAdminRoutes(baseApp, db);
  // Optional MaxMind GeoLite2-City accuracy upgrade for analytics geo. The DB
  // lives on the persistent /data volume (sibling of the SQLite file) so it
  // survives restarts; nothing downloads unless an admin has stored a key.
  // resolveGeo falls back to the bundled geoip-lite snapshot when this is off
  // or a download fails. Fire-and-forget: the reader loads in the background.
  {
    const s = await getSettings(db);
    void initGeoDb(
      dirname(dbPath),
      s.maxmindAccountId && s.maxmindLicenseKey
        ? { accountId: s.maxmindAccountId, licenseKey: s.maxmindLicenseKey }
        : null,
    );
  }
  // Retroactively title legacy /theater playlist items that were queued as bare
  // YouTube URLs (before auto-titling, or while the Data API was down). One-shot,
  // background, idempotent, no-op unless a YouTube key is configured.
  void backfillTheaterTitles(io, db);
  await registerEarningRoutes(baseApp, db, io);
  await registerArcadeRoutes(baseApp, db, io);
  await registerUrugalRoutes(baseApp, db, io);
  await registerGrimholdRoutes(baseApp, db, io);
  await registerThesaurusRoutes(baseApp, db);
  await registerUsersRoutes(baseApp, db, io);
  await registerRoomsRoutes(baseApp, db, io);
  await registerAdminRoutes(baseApp, {
    db,
    io,
    registry,
    uploadsRoot,
    getSessionUser: (req) => getSessionUser(req, db),
  });
}
