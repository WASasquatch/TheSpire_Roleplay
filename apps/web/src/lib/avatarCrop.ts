/**
 * Shared avatar-crop renderer helpers.
 *
 * One place to translate an `AvatarCrop` value into the CSS that paints
 * the cropped portrait. Every avatar surface in the app routes through
 * here so the userlist, chat lines, profile hero, DM bubbles, world
 * member gallery, etc. can't get out of sync about what "zoomed crop"
 * looks like.
 *
 * Three output forms:
 *
 *   - `cropStyleFor(crop)`        → `React.CSSProperties | undefined`.
 *                                   Drop onto the `style` prop of a
 *                                   plain `<img>` rendered through
 *                                   React. Default crop maps to
 *                                   `undefined` so the legacy
 *                                   centered-cover render is byte-
 *                                   identical for unaffected users.
 *
 *   - `cropStyleAttr(crop)`       → `style="..."` attribute string.
 *                                   For HTML-template renderers that
 *                                   serialize an `<img>` tag and feed
 *                                   it to dangerouslySetInnerHTML
 *                                   (freeform-border template path).
 *                                   Returns the empty string for the
 *                                   default crop.
 *
 *   - `needsCropMask(crop)`       → bool. Tells the caller whether the
 *                                   img needs an `overflow-hidden`
 *                                   round wrapper around it. The
 *                                   `transform: scale()` we apply for
 *                                   zoom would otherwise spill past
 *                                   the circular avatar edge.
 *
 * Why scale + transform-origin instead of plain `background-position` +
 * `background-size`: the same focal point drives both `objectPosition`
 * (which decides which slice of the source shows up when content
 * overflows the box) and `transformOrigin` (which decides what point
 * the zoom expands around). Pinning both to the same coordinate makes
 * the zoom feel like it's zooming IN ON that point rather than around
 * the geometric center.
 */

import type { AvatarCrop } from "@thekeep/shared";
import { isDefaultAvatarCrop } from "@thekeep/shared";

export function cropStyleFor(
  crop: AvatarCrop | null | undefined,
): React.CSSProperties | undefined {
  if (!crop || isDefaultAvatarCrop(crop)) return undefined;
  return {
    objectPosition: `${crop.offsetX}% ${crop.offsetY}%`,
    transform: `scale(${crop.zoom})`,
    transformOrigin: `${crop.offsetX}% ${crop.offsetY}%`,
  };
}

export function cropStyleAttr(
  crop: AvatarCrop | null | undefined,
): string {
  if (!crop || isDefaultAvatarCrop(crop)) return "";
  // Inline CSS — kept single-quoted on values that may contain a
  // quote-safe payload (percent + scalar), and the attribute itself
  // is double-quoted. The downstream DOMPurify pass in TemplateAvatar
  // accepts `style` on `<img>` (it's in the FREEFORM_SANITIZER_ATTRS
  // allowlist) so this rides through the sanitizer intact.
  return ` style="object-position: ${crop.offsetX}% ${crop.offsetY}%; transform: scale(${crop.zoom}); transform-origin: ${crop.offsetX}% ${crop.offsetY}%;"`;
}

export function needsCropMask(
  crop: AvatarCrop | null | undefined,
): boolean {
  return !!crop && !isDefaultAvatarCrop(crop);
}
