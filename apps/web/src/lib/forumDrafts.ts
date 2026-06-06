/**
 * Per-topic forum-reply drafts, persisted to localStorage.
 *
 * The forum composer's text content is auto-saved against the
 * currently-active topic id so a user who switches topics, leaves
 * the room, refreshes, or closes the tab finds their half-written
 * reply waiting on return. Composer state is partitioned per topic:
 * switching from topic X to topic Y saves X's text and loads Y's,
 * so each thread carries its own draft independently.
 *
 * Lifecycle:
 *   - Save: every keystroke (debounced via the effect that hosts the
 *     auto-save) AND eagerly on topic-switch (the effect's cleanup
 *     fires before activeTopicId actually changes so no race).
 *   - Load: when activeTopicId flips to a non-null id with no in-
 *     memory text yet, the composer's value is seeded from storage.
 *   - Clear: on successful send (the reply is now persistent on the
 *     server, so the draft is redundant) AND on the periodic stale-
 *     prune at app mount.
 *
 * Storage shape: one JSON record per key, `{ text, savedAt }`. The
 * timestamp lets the prune sweep drop drafts that have aged past
 * the stale ceiling without us needing to track a separate index.
 *
 * Failure posture: every wrapper swallows errors. localStorage can
 * throw on quota, on private-browsing modes that disable it, on
 * JSON parse failures from a corrupted entry, etc. Losing a draft
 * is preferable to crashing the composer.
 */

const KEY_PREFIX = "forum-draft:";

/**
 * Drop drafts older than this on the next prune. Set generously so
 * a user who returns to a long-running topic after a vacation
 * still finds their half-finished reply, but bounded so the
 * localStorage footprint can't grow indefinitely from one-shot
 * abandoned drafts on long-tail topics.
 */
const STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface DraftRecord {
  text: string;
  savedAt: number;
}

/** Load the saved draft for a topic. Empty string when no draft, or
 *  when the stored entry is malformed / stale / unreadable. */
export function loadForumDraft(topicId: string): string {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + topicId);
    if (!raw) return "";
    const parsed = JSON.parse(raw) as Partial<DraftRecord>;
    if (!parsed || typeof parsed.text !== "string" || typeof parsed.savedAt !== "number") {
      // Corrupt, drop it so the next load doesn't keep tripping the
      // shape check.
      localStorage.removeItem(KEY_PREFIX + topicId);
      return "";
    }
    if (Date.now() - parsed.savedAt > STALE_MS) {
      localStorage.removeItem(KEY_PREFIX + topicId);
      return "";
    }
    return parsed.text;
  } catch {
    return "";
  }
}

/**
 * Save a draft for a topic. An empty-string `text` clears the
 * stored entry (no point storing a zero-length draft, the load
 * path treats "no entry" and "empty draft" identically anyway).
 */
export function saveForumDraft(topicId: string, text: string): void {
  try {
    if (text.length === 0) {
      localStorage.removeItem(KEY_PREFIX + topicId);
      return;
    }
    const record: DraftRecord = { text, savedAt: Date.now() };
    localStorage.setItem(KEY_PREFIX + topicId, JSON.stringify(record));
  } catch {
    // Quota / disabled storage. Drop on the floor; the composer's
    // in-memory state still holds the text.
  }
}

/** Drop the draft for a topic. Called on successful reply send and
 *  on a topic delete socket event (defensive, the topic is gone,
 *  the draft has nowhere to land). */
export function clearForumDraft(topicId: string): void {
  try {
    localStorage.removeItem(KEY_PREFIX + topicId);
  } catch {
    // Ignore.
  }
}

/**
 * Sweep localStorage and drop every `forum-draft:*` entry whose
 * `savedAt` is older than the stale ceiling (or unreadable). Cheap
 *, scans only the namespaced prefix, runs once per app mount. The
 * sweep also reclaims corrupt entries the load path can't parse,
 * so a single bad write doesn't leave a permanent dead key.
 */
export function pruneStaleForumDrafts(): void {
  try {
    const now = Date.now();
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(KEY_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as Partial<DraftRecord>;
        if (
          !parsed
          || typeof parsed.savedAt !== "number"
          || now - parsed.savedAt > STALE_MS
        ) {
          toRemove.push(key);
        }
      } catch {
        toRemove.push(key);
      }
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch {
    // Storage unavailable; nothing to prune.
  }
}
