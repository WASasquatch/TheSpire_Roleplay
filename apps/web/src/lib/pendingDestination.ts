/**
 * A "return here after auth" localStorage slot. The anonymous community/forum
 * landings remember the destination the visitor came for; after the
 * login/registration round-trip the authed boot reads it back and drops them
 * where the shared link promised.
 *
 * The value is JSON `{slug, name, at}` (the name feeds the auth banner's
 * "you're registering to access <X>" copy; `at` is the write timestamp). A
 * legacy plain-slug string — or `{slug, name}` without a timestamp — still
 * parses so in-flight round-trips across a deploy don't break.
 *
 * `maxAgeMs` expires stale entries on read (removed + treated as absent).
 * Slots whose redemption merely navigates don't need it; slots whose
 * redemption MUTATES state (the server-invite auto-join) must set it so an
 * abandoned auth round-trip can't fire weeks later.
 *
 * The community and forum landings had byte-identical read/write logic that
 * differed only in the storage key, so each landing builds one of these with
 * its own key and re-exports the read/key under its existing public names.
 */

export interface PendingDestination {
  /** The localStorage key this slot uses. */
  readonly storageKey: string;
  /** Read the pending destination (JSON `{slug, name}` or legacy plain slug). */
  read: () => { slug: string; name: string | null } | null;
  /** Remember a destination before sending the visitor through auth. */
  write: (slug: string, name: string | null) => void;
}

export function createPendingDestination(
  storageKey: string,
  opts?: { maxAgeMs?: number },
): PendingDestination {
  function read(): { slug: string; name: string | null } | null {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return null;
      if (raw.startsWith("{")) {
        const j = JSON.parse(raw) as { slug?: string; name?: string; at?: number };
        if (!j.slug) return null;
        if (opts?.maxAgeMs && typeof j.at === "number" && Date.now() - j.at > opts.maxAgeMs) {
          window.localStorage.removeItem(storageKey);
          return null;
        }
        return { slug: j.slug, name: j.name ?? null };
      }
      return { slug: raw, name: null };
    } catch {
      return null;
    }
  }

  function write(slug: string, name: string | null): void {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ slug, name, at: Date.now() }));
    } catch {
      /* private mode — the visitor just lands in chat instead */
    }
  }

  return { storageKey, read, write };
}
