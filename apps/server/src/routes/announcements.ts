import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { announcementBanners } from "../db/schema.js";
import type { Db } from "../db/index.js";

/**
 * Public marquee banners endpoint. Unauthenticated — the rotating
 * banner is sitewide chrome that the chat shell paints for every
 * viewer, anonymous or signed-in. Returns the enabled set only;
 * disabled (draft) rows stay invisible.
 *
 * Sort order is `sort_order ASC, created_at ASC` so admin-chosen
 * ordering wins, with insertion order as a deterministic tiebreaker.
 */
export async function registerAnnouncementsRoutes(
  app: FastifyInstance,
  db: Db,
): Promise<void> {
  app.get("/announcements/banners", async () => {
    const rows = await db
      .select({
        id: announcementBanners.id,
        bodyHtml: announcementBanners.bodyHtml,
        sortOrder: announcementBanners.sortOrder,
        createdAt: announcementBanners.createdAt,
        updatedAt: announcementBanners.updatedAt,
      })
      .from(announcementBanners)
      .where(eq(announcementBanners.enabled, true))
      .orderBy(asc(announcementBanners.sortOrder), asc(announcementBanners.createdAt));
    return {
      banners: rows.map((r) => ({
        id: r.id,
        bodyHtml: r.bodyHtml,
        sortOrder: r.sortOrder,
        createdAt: +r.createdAt,
        updatedAt: +r.updatedAt,
      })),
    };
  });
}
