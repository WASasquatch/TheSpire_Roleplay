/**
 * Tiny memoized fetcher for the most recently published Scriptorium
 * story. Backs the `{scriptorium:latest:story}` UI-route chip whose
 * label resolves dynamically at render time.
 *
 * Why a shared cache: a single page can host many chips (multiple
 * announcement banners + the marquee + per-message scheduled-
 * announce lines). Each surface that mounts a chip would otherwise
 * fire its own GET, hammering the splash endpoint for the same
 * "which story is on top right now?" answer. The 30s TTL is short
 * enough that a freshly-published story surfaces within roughly
 * one minute even if the viewer doesn't reload, long enough that
 * a busy chat with dozens of dynamic chips doesn't N+1 the server.
 *
 * Result shape mirrors what the chip + dispatcher need: the
 * story id (so the click handler can open the StoryReader) plus
 * the title (so the chip can show "Latest: <Title>"). Returns
 * `null` when nothing is published yet or the fetch fails — the
 * chip falls back to a static label in that case.
 */

export interface LatestStoryRef {
  id: string;
  title: string;
  /** Pre-computed permalink slug — handy if a future click path
   *  wants to navigate via URL instead of opening the reader modal. */
  slug: string;
  /** Author's master username, for the title-bar attribution. */
  authorUsername: string;
}

interface CacheCell {
  result: LatestStoryRef | null;
  expiresAt: number;
  inFlight: Promise<LatestStoryRef | null> | null;
}

const TTL_MS = 30_000;
const cache: CacheCell = { result: null, expiresAt: 0, inFlight: null };

/**
 * Get the latest published story, caching the result for {@link TTL_MS}.
 * Concurrent callers during a single fetch coalesce on the same
 * in-flight promise so we never issue two `/stories/splash` GETs
 * for the same tick.
 */
export async function fetchLatestPublishedStory(): Promise<LatestStoryRef | null> {
  const now = Date.now();
  if (cache.result !== null && now < cache.expiresAt) return cache.result;
  if (cache.inFlight) return cache.inFlight;
  cache.inFlight = (async () => {
    try {
      const r = await fetch("/stories/splash?limit=1");
      if (!r.ok) return null;
      const j = (await r.json()) as {
        entries?: Array<{ id?: string; slug?: string; title?: string; author?: { masterUsername?: string } }>;
      };
      const first = j.entries?.[0];
      if (!first || !first.id || !first.title) return null;
      const result: LatestStoryRef = {
        id: first.id,
        title: first.title,
        slug: first.slug ?? "",
        authorUsername: first.author?.masterUsername ?? "",
      };
      cache.result = result;
      cache.expiresAt = Date.now() + TTL_MS;
      return result;
    } catch {
      return null;
    } finally {
      cache.inFlight = null;
    }
  })();
  return cache.inFlight;
}

/**
 * Force the next call to re-fetch. Useful for tests + the post-
 * publish flow (a brand-new story should show up in the chip
 * without the viewer waiting for the TTL to expire).
 */
export function invalidateLatestStoryCache(): void {
  cache.result = null;
  cache.expiresAt = 0;
}
