/**
 * Inject the admin-authored name-style CSS into the document once.
 *
 * Each enabled style ships with a CSS block scoped to its unique
 * wrapper class (`.ns-<key>`) and references CSS custom properties
 * (`--user-color-1`, `--user-color-2`, `--user-glow`) the renderer
 * sets inline per user from their per-style config. We splice every
 * style's CSS into a single `<style data-name-styles>` element on
 * the document head so multiple rendered names share one stylesheet.
 *
 * Re-injection is idempotent: the helper diffs against the existing
 * tag content and only rewrites when the catalog changed. Admin
 * edits to a template's CSS arrive via the next /earning/me fetch
 * and the renderer re-injects on the next call.
 */

import type { NameStyleCatalogRow } from "./earning.js";

const STYLE_TAG_ATTR = "data-name-styles";

/**
 * Idempotently inject the CSS for every passed style into the
 * document head. Safe to call on every render / store update — when
 * the concatenated CSS is unchanged this is a no-op.
 */
export function injectNameStyles(styles: readonly NameStyleCatalogRow[]): void {
  if (typeof document === "undefined") return; // SSR / test environments
  const concatenated = styles
    .map((s) => s.styleCss)
    .filter(Boolean)
    .join("\n\n");
  let tag = document.head.querySelector(`style[${STYLE_TAG_ATTR}]`) as HTMLStyleElement | null;
  if (!tag) {
    tag = document.createElement("style");
    tag.setAttribute(STYLE_TAG_ATTR, "");
    document.head.appendChild(tag);
  }
  if (tag.textContent === concatenated) return;
  tag.textContent = concatenated;
}
