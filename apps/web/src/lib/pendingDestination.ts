/**
 * A "return here after auth" localStorage slot. The anonymous community/forum
 * landings remember the destination the visitor came for; after the
 * login/registration round-trip the authed boot reads it back and drops them
 * where the shared link promised.
 *
 * The value is JSON `{slug, name}` (the name feeds the auth banner's "you're
 * registering to access <X>" copy). A legacy plain-slug string still parses so
 * in-flight round-trips across a deploy don't break.
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

export function createPendingDestination(storageKey: string): PendingDestination {
  function read(): { slug: string; name: string | null } | null {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return null;
      if (raw.startsWith("{")) {
        const j = JSON.parse(raw) as { slug?: string; name?: string };
        return j.slug ? { slug: j.slug, name: j.name ?? null } : null;
      }
      return { slug: raw, name: null };
    } catch {
      return null;
    }
  }

  function write(slug: string, name: string | null): void {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ slug, name }));
    } catch {
      /* private mode — the visitor just lands in chat instead */
    }
  }

  return { storageKey, read, write };
}
