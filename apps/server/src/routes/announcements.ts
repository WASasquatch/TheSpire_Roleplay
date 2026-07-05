import type { FastifyInstance } from "fastify";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { announcementBanners } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { DEFAULT_SERVER_ID } from "../earning/pool.js";

/**
 * Public marquee banners endpoint. Unauthenticated, the rotating
 * banner is sitewide chrome that the chat shell paints for every
 * viewer, anonymous or signed-in. Returns the enabled set only;
 * disabled (draft) rows stay invisible.
 *
 * Server scope (correctness): a banner is either PLATFORM-wide (the
 * default/system server) or scoped to ONE community server. The client
 * passes the viewer's CURRENT server (`?serverId=`, read from the room
 * they're in) so we can return the default/system banners PLUS that one
 * server's banners — never another community's. Without this filter every
 * enabled community-server banner leaked site-wide.
 *
 * The default/system server stores its rows either as `server_id IS NULL`
 * (legacy/adopted-by-default) OR the explicit default id, so we accept both
 * for the platform-wide half of the OR.
 *
 * Sort order is `sort_order ASC, created_at ASC` so admin-chosen
 * ordering wins, with insertion order as a deterministic tiebreaker.
 */
export async function registerAnnouncementsRoutes(
  app: FastifyInstance,
  db: Db,
): Promise<void> {
  app.get<{ Querystring: { serverId?: string } }>(
    "/announcements/banners",
    async (req) => {
      const current = typeof req.query.serverId === "string" ? req.query.serverId : null;
      // Platform-wide half: default id OR the legacy NULL scope.
      const platformScope = or(
        isNull(announcementBanners.serverId),
        eq(announcementBanners.serverId, DEFAULT_SERVER_ID),
      );
      // Add the viewer's current community server when it's a real, non-default
      // id (never trust it blindly for anything but this scoping OR).
      const scope =
        current && current !== DEFAULT_SERVER_ID
          ? or(platformScope, eq(announcementBanners.serverId, current))
          : platformScope;
      const rows = await db
        .select({
          id: announcementBanners.id,
          bodyHtml: announcementBanners.bodyHtml,
          sortOrder: announcementBanners.sortOrder,
          serverId: announcementBanners.serverId,
          createdAt: announcementBanners.createdAt,
          updatedAt: announcementBanners.updatedAt,
        })
        .from(announcementBanners)
        .where(and(eq(announcementBanners.enabled, true), scope))
        .orderBy(asc(announcementBanners.sortOrder), asc(announcementBanners.createdAt));
      return {
        // Tag each row with the stream it belongs to so the shell can keep the
        // two sources SEPARATE (app vs the viewer's current server) and show one
        // at a time, instead of merging them into a single rotation. A row is a
        // SERVER row only when it's stamped with the viewer's current
        // community server; the default id + the legacy NULL scope are the
        // platform-wide APP stream.
        banners: rows.map((r) => ({
          id: r.id,
          bodyHtml: r.bodyHtml,
          sortOrder: r.sortOrder,
          source:
            current && current !== DEFAULT_SERVER_ID && r.serverId === current
              ? ("server" as const)
              : ("app" as const),
          createdAt: +r.createdAt,
          updatedAt: +r.updatedAt,
        })),
      };
    },
  );
}
