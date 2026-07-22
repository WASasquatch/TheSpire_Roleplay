/**
 * Inject the admin-authored CSS for free-form (non-rank-tied) avatar
 * borders into the document once. Parallel to nameStyleInjector, the
 * two systems use the same scoping pattern (CSS rules namespaced
 * under a per-row class) and the same per-response CSP nonce.
 *
 * Free-form borders that ship in `image_url` mode skip the injector
 * entirely (their renderer just overlays an `<img>` on the avatar).
 * Only `template`+`style_css` rows need their CSS spliced into the
 * page so the rendered DOM template resolves.
 *
 * Idempotent: when the concatenated CSS is unchanged the helper is a
 * no-op. Re-runs on every /earning/me fetch are cheap.
 */

import type { FreeformBorderRow } from "./earning.js";
import { requestCosmeticSweep } from "./cosmeticAnimationSync.js";
import { createNonceStyleTag } from "./injectStyle.js";

const CATALOG_TAG_ATTR = "data-freeform-borders";
const PREVIEW_TAG_ATTR = "data-freeform-border-preview";

/** Idempotently inject the catalog's free-form border CSS. */
export function injectFreeformBorders(borders: readonly FreeformBorderRow[]): void {
  writeStyleTag(CATALOG_TAG_ATTR, borders);
}

/** Same as `injectFreeformBorders` but targets the admin-editor
 *  preview tag, kept separate so editing a draft doesn't clobber
 *  the live styles users see elsewhere on the page. */
export function injectFreeformBorderPreview(borders: readonly FreeformBorderRow[]): void {
  writeStyleTag(PREVIEW_TAG_ATTR, borders);
}

/** Remove the preview `<style>` tag when the editor closes. */
export function clearFreeformBorderPreview(): void {
  if (typeof document === "undefined") return;
  const tag = document.head.querySelector(`style[${PREVIEW_TAG_ATTR}]`);
  if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
}

/**
 * Shared base styles for every template-mode border. Each catalog
 * row defines its `.b-<key>` rules on top of this preamble; the
 * `.av` and `.pic` selectors are the structural anchors the
 * templates assume. Without this preamble, every catalog row would
 * have to duplicate the same outer/inner + flex-center boilerplate.
 *
 * Ratio: `.av` is the FRAME (avatar + ring of border art); `.pic`
 * is the inner avatar circle. The 84/76 ratio yields a 4px native
 * frame ring, which scales to ~6.5px at the xl showcase tier
 * (TEMPLATE_TARGET_AVATAR_PX.xl / 76 ≈ 1.63 → 4 × 1.63 ≈ 6.5px) and
 * ~2-3px at inline tiers, readable at glance distance instead of
 * the sub-pixel 1.4px the original 82/76 ratio produced at sm.
 *
 * Border authors can override `.av { width / height }` on their own
 * `.b-<key>` selector if their design needs a wider frame.
 */
const BASE_PREAMBLE = `
.av {
  position: relative;
  width: 84px;
  height: 84px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform .3s ease;
}
.av .pic {
  width: 76px;
  height: 76px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  position: relative;
  overflow: hidden;
}
.av .pic img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
`;

function writeStyleTag(tagAttr: string, borders: readonly FreeformBorderRow[]): void {
  if (typeof document === "undefined") return;
  const concatenated = [
    BASE_PREAMBLE,
    ...borders.map((b) => b.styleCss ?? "").filter(Boolean),
  ].join("\n\n");
  let tag = document.head.querySelector(`style[${tagAttr}]`) as HTMLStyleElement | null;
  if (!tag) {
    tag = createNonceStyleTag();
    tag.setAttribute(tagAttr, "");
    document.head.appendChild(tag);
  }
  if (tag.textContent === concatenated) return;
  tag.textContent = concatenated;
  // Mirror nameStyleInjector: on a cold load this CSS (and its
  // @keyframes) can land after border wrappers already mounted and ran
  // their mount-time phase sync against nothing. Re-anchor every
  // cosmetic root now that the animations exist.
  requestCosmeticSweep();
}
