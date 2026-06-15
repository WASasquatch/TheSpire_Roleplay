import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Error boundary with stale-deploy recovery.
 *
 * The app code-splits: react-player lazy-loads its provider chunks
 * (YouTube/Vimeo/…), the profile designer and hls.js are dynamic imports,
 * etc. Each is fetched on demand by name (e.g. `/assets/YouTube-<hash>.js`).
 * When a NEW build ships, the server replaces the hashed assets — so a tab
 * still running the OLD bundle asks for a chunk hash that no longer exists.
 * The server's SPA 404 handler answers that GET with the themed 404 HTML
 * (text/html), the module fetch is rejected for the wrong MIME type, and
 * React (via the internal <Suspense> a rejected `lazy()` throws into) bubbles
 * the error up. With no boundary that unmounted the WHOLE tree to a blank
 * page — the reported "click a Cinemas room → crash, but refresh works" bug:
 * a full reload pulls the fresh index.html + matching chunks, a client-side
 * navigation into the stale chunk does not.
 *
 * So on a chunk-load error we do exactly what the user did manually — reload
 * once to pick up the current build — guarded by a short-lived sessionStorage
 * timestamp so a genuinely broken deploy can't loop. Any other error (or a
 * second failure right after a reload) renders the `fallback` instead, which
 * for a scoped boundary (e.g. the Theater panel) keeps the rest of the app —
 * chat included — alive.
 */

const RELOAD_KEY = "tk:chunkReloadAt";
const RELOAD_LOOP_GUARD_MS = 12_000;

/** Heuristic: is this the browser's "couldn't fetch a dynamic import" error?
 *  Messages differ across engines, so match the known shapes broadly. */
function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? "");
  return (
    /dynamically imported module/i.test(msg) ||      // Chrome/Firefox dynamic import()
    /Importing a module script failed/i.test(msg) || // Safari dynamic import()
    /error loading dynamically imported/i.test(msg) ||
    /Loading chunk \d+ failed/i.test(msg) ||          // webpack-style (defensive)
    /ChunkLoadError/i.test(msg) ||
    /disallowed MIME type/i.test(msg)
  );
}

/** True if we auto-reloaded very recently — used to break a reload loop when a
 *  reload doesn't actually resolve the failure (a genuinely broken asset). */
function recentlyReloaded(): boolean {
  try {
    const raw = sessionStorage.getItem(RELOAD_KEY);
    if (!raw) return false;
    const t = Number(raw);
    return Number.isFinite(t) && Date.now() - t < RELOAD_LOOP_GUARD_MS;
  } catch {
    return false;
  }
}

interface Props {
  children: ReactNode;
  /** Short tag for the console log so a crash points at the right subtree. */
  label?: string;
  /** Shown when the error isn't a (recoverable) stale-chunk load. Receives a
   *  `reset` that clears the boundary so the subtree can try to re-render. */
  fallback?: (reset: () => void) => ReactNode;
}

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    // A stale tab whose chunk was purged by a newer deploy: reload ONCE to
    // fetch the current build. The guard stops an infinite reload loop if the
    // asset is actually missing/broken rather than just stale.
    if (isChunkLoadError(error) && !recentlyReloaded()) {
      try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch { /* private mode */ }
      window.location.reload();
      return;
    }
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ""}]`, error, info.componentStack);
  }

  reset = () => this.setState({ failed: false });

  override render() {
    if (this.state.failed) {
      // While the chunk-error reload is in flight there's nothing to paint;
      // the page is about to navigate away.
      if (this.props.fallback) return this.props.fallback(this.reset);
      return null;
    }
    return this.props.children;
  }
}
