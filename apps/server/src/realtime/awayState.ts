/**
 * Per-identity in-memory away state.
 *
 * The `/away` and `/back` commands used to write to `users.away_message`
 *, a single column on the master row, so going away in one tab made
 * EVERY other tab of the same account (including different characters
 * and OOC) also show as away. Per the per-identity contract used
 * elsewhere in the app (userlist dedupe, color/avatar snapshots, name
 * styles), away should be scoped to the (userId, characterId) tuple
 * the user is currently voicing.
 *
 * This module owns that scoping. Entries are keyed by the same
 * identity tuple `currentOccupants` deduplicates on, and the chat
 * userlist render reads from here rather than the master column.
 *
 * Lifetime: in-memory only. Server restart wipes the table (away is
 * a transient session signal, not a persistent setting), and a full
 * disconnect of every socket voicing a given identity clears that
 * identity's entry, so a user who closes every tab and comes back
 * later starts present rather than carrying a stale "away: brb"
 * marker from yesterday.
 */

function key(userId: string, characterId: string | null): string {
  // Mirrors the `${userId}::${characterId ?? ""}` shape used by
  // `currentOccupants` so downstream code that already builds an
  // identity key doesn't need a second helper.
  return `${userId}::${characterId ?? ""}`;
}

interface AwayEntry {
  message: string;
  since: number;
}

const byIdentity = new Map<string, AwayEntry>();

export function getAway(userId: string, characterId: string | null): AwayEntry | null {
  return byIdentity.get(key(userId, characterId)) ?? null;
}

export function setAway(
  userId: string,
  characterId: string | null,
  message: string,
): void {
  byIdentity.set(key(userId, characterId), { message, since: Date.now() });
}

export function clearAway(userId: string, characterId: string | null): void {
  byIdentity.delete(key(userId, characterId));
}

/**
 * Drop every away entry belonging to a given user. Called on the
 * "fully offline" branch of the socket disconnect handler so a user
 * who closes their browser doesn't come back to a stale away mark
 * inherited from their previous session.
 *
 * NOT called on a per-tab disconnect, a sibling tab voicing the
 * same identity might still want to keep the mark, and a sibling
 * tab voicing a DIFFERENT identity has its own entry that this
 * mass-clear would erroneously sweep too. Use the per-identity
 * `clearAway` from the more granular disconnect path if needed
 * later.
 */
export function clearAllAwayForUser(userId: string): void {
  const prefix = `${userId}::`;
  for (const k of byIdentity.keys()) {
    if (k.startsWith(prefix)) byIdentity.delete(k);
  }
}

export interface AwaySnapshotEntry {
  userId: string;
  characterId: string | null;
  message: string;
  since: number;
}

/** Dump every away entry for the presence snapshot (graceful-shutdown
 *  persistence). The map key is `${userId}::${characterId ?? ""}`; we split on
 *  the FIRST "::" so the (colon-free nanoid) ids round-trip exactly. */
export function exportAwayEntries(): AwaySnapshotEntry[] {
  const out: AwaySnapshotEntry[] = [];
  for (const [k, v] of byIdentity) {
    const sep = k.indexOf("::");
    out.push({
      userId: k.slice(0, sep),
      characterId: k.slice(sep + 2) || null,
      message: v.message,
      since: v.since,
    });
  }
  return out;
}

/** Reload away entries on boot, preserving the original `since` so "away for
 *  X" stays accurate across the restart. */
export function importAwayEntries(entries: AwaySnapshotEntry[]): void {
  for (const e of entries) {
    byIdentity.set(key(e.userId, e.characterId), { message: e.message, since: e.since });
  }
}
