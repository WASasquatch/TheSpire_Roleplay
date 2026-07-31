/**
 * Point Excalidraw at our self-hosted fonts.
 *
 * Excalidraw builds its font URLs as `new URL(<relative path>, base)` where
 * base is `window.EXCALIDRAW_ASSET_PATH`, falling back to the esm.run CDN
 * when the global isn't set. That fallback is fatal in production: our CSP is
 * `font-src 'self' data: https://fonts.gstatic.com` with `connect-src 'self'`,
 * so every CDN request is blocked and canvas text silently renders in a
 * system font. (The same class of failure as the GrapesJS panel icons, which
 * came back blank in prod when their cdnjs stylesheet was blocked.)
 *
 * The files themselves are copied out of node_modules by
 * `apps/web/scripts/sync-excalidraw-assets.mjs`, which both `dev` and `build`
 * run. The trailing slash matters: the loader resolves relative paths
 * against this value.
 *
 * Must run BEFORE the Excalidraw chunk is imported, hence a bare module
 * side-effect called from the lazy loader rather than a React effect.
 */
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

export const OVERLOOK_ASSET_PATH = "/excalidraw-assets/";

let applied = false;

/** Idempotent; safe to call on every canvas mount. */
export function ensureExcalidrawAssetPath(): void {
  if (applied || typeof window === "undefined") return;
  window.EXCALIDRAW_ASSET_PATH = OVERLOOK_ASSET_PATH;
  applied = true;
}
