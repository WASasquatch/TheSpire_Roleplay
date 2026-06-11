/**
 * Presence persistence across restarts.
 *
 * Away / mood / idle-ghost state lives only in memory (awayState, moodState,
 * and the idle-ghost registry in broadcast.ts), so a server restart — notably
 * a `remote-deploy.sh` Fly deploy — wipes it: everyone comes back "present"
 * and the "(idle)" rows vanish. This module snapshots that state to the DB on
 * graceful shutdown and restores it on the next boot, so a quick deploy keeps
 * idle/away intact.
 *
 * Why this composes cleanly with the rest of the presence system:
 *   - Online users just reconnect within the existing 30s boot-grace
 *     (broadcast.ts), which already suppresses the "has connected" spam; their
 *     restored away/mood marks show on the first presence broadcast.
 *   - Already-idle users are re-registered as idle ghosts, so they keep their
 *     "(idle)" row and their room stays open; a return clears the ghost
 *     silently via `consumePendingDisconnect`, a no-show is swept normally.
 *
 * Safety:
 *   - Stale-guarded: a snapshot older than {@link MAX_RESTORE_AGE_MS} is
 *     discarded, so a real multi-minute outage doesn't replay yesterday's
 *     "away: brb" — only a fast deploy restores.
 *   - One-shot: the row is deleted on read, so a later hard crash (no graceful
 *     shutdown) can't replay an old snapshot on the boot after.
 *   - The write is synchronous (better-sqlite3) and only touches in-memory
 *     maps + one upsert, so it is safe to call from a signal handler.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { presenceSnapshots } from "../db/schema.js";
import { exportAwayEntries, importAwayEntries, type AwaySnapshotEntry } from "./awayState.js";
import { exportMoodEntries, importMoodEntries, type MoodSnapshotEntry } from "./moodState.js";
import { exportIdleGhosts, importIdleGhosts, type IdleGhost } from "./broadcast.js";

/** Single-row id. We only ever keep one snapshot, the latest shutdown's. */
const SNAPSHOT_ID = "current";

/** Restore only if the shutdown was recent. A deploy is seconds; this window
 *  tolerates a slow one while discarding a genuine outage whose markers would
 *  be long stale. */
const MAX_RESTORE_AGE_MS = 15 * 60_000;

interface PresencePayload {
  away: AwaySnapshotEntry[];
  mood: MoodSnapshotEntry[];
  ghosts: IdleGhost[];
}

/**
 * Serialize the live away/mood/idle state and upsert it. Synchronous and
 * best-effort to call from a shutdown signal handler — no async I/O, just map
 * reads and one write that completes before `process.exit`.
 */
export function writePresenceSnapshot(db: Db): void {
  const payload: PresencePayload = {
    away: exportAwayEntries(),
    mood: exportMoodEntries(),
    ghosts: exportIdleGhosts(),
  };
  const json = JSON.stringify(payload);
  const savedAt = Date.now();
  db.insert(presenceSnapshots)
    .values({ id: SNAPSHOT_ID, payload: json, savedAt })
    .onConflictDoUpdate({ target: presenceSnapshots.id, set: { payload: json, savedAt } })
    .run();
}

/**
 * Load + clear the snapshot on boot, before the server starts accepting
 * reconnects. Always deletes the row (one-shot); restores only when fresh.
 */
export async function restorePresenceSnapshot(db: Db): Promise<void> {
  const row = db
    .select()
    .from(presenceSnapshots)
    .where(eq(presenceSnapshots.id, SNAPSHOT_ID))
    .limit(1)
    .all()[0];
  if (!row) return;
  // Drop it immediately so a later crash can't replay this on the next boot.
  db.delete(presenceSnapshots).where(eq(presenceSnapshots.id, SNAPSHOT_ID)).run();
  if (Date.now() - row.savedAt > MAX_RESTORE_AGE_MS) return;

  let payload: PresencePayload;
  try {
    payload = JSON.parse(row.payload) as PresencePayload;
  } catch {
    return; // corrupt snapshot, boot clean
  }
  importAwayEntries(payload.away ?? []);
  importMoodEntries(payload.mood ?? []);
  await importIdleGhosts(db, payload.ghosts ?? []);
}
