import { and, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { bookmarks, messages, pinnedMessages } from "../db/schema.js";

/**
 * Before the retention janitor HARD-DELETEs a batch of doomed messages,
 * stamp `archived_at` on any bookmark that points at one AND already holds
 * a display snapshot. That flips those bookmarks to "archived" so the GET
 * route serves the frozen copy (with `archived: true`) instead of
 * [removed] once the message row is gone. Bookmarks with no snapshot
 * (legacy rows saved before migration 0314) are left alone, they can't be
 * reconstructed, so they correctly fall through to [removed].
 *
 * The same write freezes the source row's 18+ stamp into
 * `snapshot_is_nsfw` (migration 0341, age-restriction plan): once the
 * message row is gone the GET route's minor gate can no longer join the
 * live `messages.isNsfw`, so the archived-snapshot branch reads this copy
 * instead. Stamped here at ARCHIVE time — the last moment the live row is
 * readable — so a forum topic's mutable NSFW re-tag lands at its final
 * value; written both ways (true AND false) so a stale migration-backfill
 * value can't survive a later re-tag.
 *
 * PINNED MESSAGES get the mirror re-stamp in the same pass: a pin's
 * `is_nsfw` (migration 0340) is otherwise frozen at PIN time only, so a
 * topic pinned while SFW and re-tagged 18+ later would expire into a
 * snapshot-only pin whose stale stamp keeps serving the 18+-era body to
 * minors forever — the live-row join that catches re-tags can no longer
 * see it. Refreshing from the doomed rows here (also written both ways,
 * BEFORE the hard delete nulls the FK) closes that window; live pins are
 * unaffected because readers prefer the live join while the source exists.
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
  const doomedRows = await db
    .select({ id: messages.id, isNsfw: messages.isNsfw })
    .from(messages)
    .where(doomed);
  if (doomedRows.length === 0) return;
  // Two passes, one per stamp value, so each batched UPDATE stays a flat
  // `messageId IN (...)` instead of a per-row CASE.
  const partitions: Array<{ ids: string[]; isNsfw: boolean }> = [
    { ids: doomedRows.filter((r) => !r.isNsfw).map((r) => r.id), isNsfw: false },
    { ids: doomedRows.filter((r) => r.isNsfw).map((r) => r.id), isNsfw: true },
  ];
  for (const { ids, isNsfw } of partitions) {
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500);
      await db
        .update(bookmarks)
        .set({ archivedAt: Date.now(), snapshotIsNsfw: isNsfw })
        .where(and(
          inArray(bookmarks.messageId, batch),
          isNull(bookmarks.archivedAt),
          sql`${bookmarks.snapshotBody} IS NOT NULL`,
        ));
      // Mirror re-stamp for pins about to go snapshot-only (see header).
      await db
        .update(pinnedMessages)
        .set({ isNsfw })
        .where(inArray(pinnedMessages.messageId, batch));
    }
  }
}
