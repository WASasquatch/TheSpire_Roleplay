/**
 * Per-identity in-memory mood state.
 *
 * Mirror of `awayState.ts` for the `/mood` command. Mood used to live
 * on `users.current_mood` (one column on the master row), so setting
 * a mood while voicing Character A bled the same mood onto Character
 * B and the master OOC handle. That collapsed the per-identity
 * contract the rest of the app honors (color, avatar, name style,
 * away) and made it impossible for Character A and Character B to
 * carry distinct moods at the same time.
 *
 * Keying mirrors `awayState`: `${userId}::${characterId ?? ""}`.
 * Lifetime is in-process: cleared on full disconnect (see
 * `clearAllMoodForUser` + the index.ts disconnect handler), wiped
 * on server restart. Mood snapshots persist on past message rows
 * via `messages.mood_snapshot`, so transient in-memory state is
 * sufficient for the live userlist + outgoing-snapshot use cases.
 */

function key(userId: string, characterId: string | null): string {
  return `${userId}::${characterId ?? ""}`;
}

const byIdentity = new Map<string, string>();

export function getMood(userId: string, characterId: string | null): string | null {
  return byIdentity.get(key(userId, characterId)) ?? null;
}

export function setMood(
  userId: string,
  characterId: string | null,
  mood: string,
): void {
  byIdentity.set(key(userId, characterId), mood);
}

export function clearMood(userId: string, characterId: string | null): void {
  byIdentity.delete(key(userId, characterId));
}

export function clearAllMoodForUser(userId: string): void {
  const prefix = `${userId}::`;
  for (const k of byIdentity.keys()) {
    if (k.startsWith(prefix)) byIdentity.delete(k);
  }
}

export interface MoodSnapshotEntry {
  userId: string;
  characterId: string | null;
  mood: string;
}

/** Dump every mood entry for the presence snapshot (graceful-shutdown
 *  persistence). Key shape mirrors awayState: `${userId}::${characterId ?? ""}`. */
export function exportMoodEntries(): MoodSnapshotEntry[] {
  const out: MoodSnapshotEntry[] = [];
  for (const [k, v] of byIdentity) {
    const sep = k.indexOf("::");
    out.push({ userId: k.slice(0, sep), characterId: k.slice(sep + 2) || null, mood: v });
  }
  return out;
}

/** Reload mood entries on boot. */
export function importMoodEntries(entries: MoodSnapshotEntry[]): void {
  for (const e of entries) {
    byIdentity.set(key(e.userId, e.characterId), e.mood);
  }
}
