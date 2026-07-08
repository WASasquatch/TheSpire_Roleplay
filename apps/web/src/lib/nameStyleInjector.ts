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
 *
 * Catalog vs preview are stored in SEPARATE `<style>` tags so the
 * admin Name-Styles editor's live preview can mutate freely without
 * clobbering the real catalog stylesheet. (Previously both wrote to
 * one tag, and any preview keystroke wiped every `.ns-*` rule the
 * Earning modal depended on, that's why "available" cards in the
 * dashboard rendered as plain dark text after touching the editor.)
 */

import type { NameStyleCatalogRow } from "./earning.js";
import { createNonceStyleTag } from "./injectStyle.js";

const CATALOG_TAG_ATTR = "data-name-styles";
const PREVIEW_TAG_ATTR = "data-name-style-preview";

/**
 * Idempotently inject the CSS for the live catalog into the shared
 * catalog `<style>` tag. Safe to call on every render / store update,
 * when the concatenated CSS is unchanged this is a no-op.
 */
export function injectNameStyles(styles: readonly NameStyleCatalogRow[]): void {
  writeStyleTag(CATALOG_TAG_ATTR, styles);
}

/**
 * Same as `injectNameStyles` but targets a SEPARATE `<style>` tag
 * reserved for admin-editor previews. Lives alongside the catalog
 * tag in <head> so editing a draft doesn't clobber the live styles
 * users see elsewhere on the page.
 */
export function injectNameStylePreview(styles: readonly NameStyleCatalogRow[]): void {
  writeStyleTag(PREVIEW_TAG_ATTR, styles);
}

/** Remove the preview `<style>` tag when the editor closes. */
export function clearNameStylePreview(): void {
  if (typeof document === "undefined") return;
  const tag = document.head.querySelector(`style[${PREVIEW_TAG_ATTR}]`);
  if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
}

function writeStyleTag(tagAttr: string, styles: readonly NameStyleCatalogRow[]): void {
  if (typeof document === "undefined") return; // SSR / test environments
  const concatenated = styles
    .map((s) => s.styleCss)
    .filter(Boolean)
    .join("\n\n");
  let tag = document.head.querySelector(`style[${tagAttr}]`) as HTMLStyleElement | null;
  if (!tag) {
    tag = createNonceStyleTag();
    tag.setAttribute(tagAttr, "");
    document.head.appendChild(tag);
  }
  if (tag.textContent === concatenated) return;
  tag.textContent = concatenated;
}
