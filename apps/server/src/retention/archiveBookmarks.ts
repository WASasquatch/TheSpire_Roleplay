import { and, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { bookmarks, messages } from "../db/schema.js";

/**
 * Before the retention janitor HARD-DELETEs a batch of doomed messages,
 * stamp `archived_at` on any bookmark that points at one AND already holds
 * a display snapshot. That flips those bookmarks to "archived" so the GET
 * route serves the frozen copy (with `archived: true`) instead of
 * [removed] once the message row is gone. Bookmarks with no snapshot
 * (legacy rows saved before migration 0314) are left alone, they can't be
 * reconstructed, so they correctly fall through to [removed].
 *
 * IMPORTANT: this runs ONLY on the retention/expiry sweep. /trash, mod-
 * delete, and ban-purge live elsewhere and deliberately do NOT set
 * archived_at, so deliberately-removed content stays [removed].
 */
export async function archiveDoomedBookmarks(
  db: Db,
  doomed: ReturnType<typeof and> | undefined,
): Promise<void> {
  // Never run against an undefined predicate (that would match every
  // message). Both call sites pass a concrete AND, this is belt-and-braces.
  if (!doomed) return;
  const doomedIds = (await db.select({ id: messages.id }).from(messages).where(doomed))
    .map((r) => r.id);
  if (doomedIds.length === 0) return;
  for (let i = 0; i < doomedIds.length; i += 500) {
    const batch = doomedIds.slice(i, i + 500);
    await db
      .update(bookmarks)
      .set({ archivedAt: Date.now() })
      .where(and(
        inArray(bookmarks.messageId, batch),
        isNull(bookmarks.archivedAt),
        sql`${bookmarks.snapshotBody} IS NOT NULL`,
      ));
  }
}
