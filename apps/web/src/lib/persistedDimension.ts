/**
 * Factory for a localStorage-backed, sanity-bounded pixel dimension (a
 * drag-resized panel width/height). Reading inside a `useState` initializer
 * (not a `useEffect`) means the first render already uses the saved value —
 * no visible "snap from default to saved" flash on mount — and the paired
 * writer persists it per-device.
 *
 * Three call sites shared this shape but diverged in ways that MUST be kept:
 *
 *   - **out-of-range handling.** Some clamp an out-of-range saved value into
 *     bounds (`'clamp'`); one rejects it back to the default (`'reject'`).
 *   - **max bound.** Some enforce a maximum; one intentionally has none
 *     (only a floor), so `max` is optional and, when omitted, no ceiling is
 *     imposed under either mode.
 *   - **SSR guard.** One reads inside an explicit `typeof window` guard that
 *     returns the default without touching storage; the others rely on the
 *     try/catch. Both yield the default off-DOM, but the flag preserves the
 *     exact code path.
 *
 * A naive single clamp would (a) impose a ceiling where one caller wants none
 * and (b) silently keep out-of-range values the reject caller discards — so
 * these are options, not assumptions.
 */

export interface PersistedDimensionConfig {
  /** localStorage key. */
  key: string;
  /** Lower bound (always enforced). */
  min: number;
  /** Optional upper bound. Omit for a floor-only dimension (no ceiling). */
  max?: number;
  /** Value used when nothing valid is stored. */
  default: number;
  /** How to treat a finite-but-out-of-range stored value:
   *  `'clamp'` folds it into `[min, max]`; `'reject'` discards it → default. */
  outOfRange: "clamp" | "reject";
  /** When true, return the default (without touching storage) off-DOM. */
  ssrGuard?: boolean;
}

export interface PersistedDimension {
  /** Hydrate the value from storage (for a `useState` initializer). */
  load: () => number;
  /** Persist the value (in a resize effect). */
  save: (value: number) => void;
}

export function createPersistedDimension(config: PersistedDimensionConfig): PersistedDimension {
  const { key, min, max, default: fallback, outOfRange, ssrGuard } = config;

  function load(): number {
    if (ssrGuard && typeof window === "undefined") return fallback;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return fallback;
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n)) return fallback;
      if (outOfRange === "reject") {
        if (n >= min && (max == null || n <= max)) return n;
        return fallback;
      }
      // 'clamp': floor at min, and cap at max only when a ceiling is set.
      const capped = max == null ? n : Math.min(max, n);
      return Math.max(min, capped);
    } catch {
      return fallback;
    }
  }

  function save(value: number): void {
    try {
      window.localStorage.setItem(key, String(value));
    } catch {
      /* private mode — the value just won't persist */
    }
  }

  return { load, save };
}
