/**
 * BorderedAvatar, round avatar with an optional border frame
 * overlaid on top.
 *
 * Two border systems share this renderer:
 *
 *   1. **Rank-tier borders** (the original), driven by `borderRankKey`,
 *      look up `catalog.rankTiers` for the Tier IV `borderImageUrl`,
 *      and paint that PNG as an overlay on top of the avatar.
 *
 *   2. **Free-form borders** (migration 0149), driven by
 *      `freeformBorderKey`, look up `catalog.freeformBorders`. Each
 *      row ships in EITHER `imageUrl` mode (overlay <img>, same code
 *      path as rank-tier) OR `template`+`styleCss` mode (admin-
 *      authored DOM template with the literal `{avatar}` placeholder,
 *      rendered via dangerouslySetInnerHTML after a DOMPurify pass).
 *      Template-mode borders bring their OWN sizing via their scoped
 *      CSS, the BorderedAvatar size prop only governs the inline /
 *      showcase decision (and is ignored on template-mode rows).
 *
 * Resolution order: freeform first, rank-tier as fallback. The
 * freeform slot is the user's deliberate "this is my cosmetic"
 * choice; the rank-tier slot is the gated reward. When both are set
 * (e.g. a user with a rank border equipped AS WELL AS a flair one),
 * the freeform wins.
 *
 * Architecture for rank-tier / image-based borders (per user's
 * prescription):
 *   1. **Outer container**, the layout slot. Sized to fit the
 *      ornate frame design, NOT just the avatar.
 *   2. **Avatar layer**, centered inside the container at the
 *      avatar's intrinsic visual size.
 *   3. **Frame overlay**, fills the container, painted on TOP of
 *      the avatar.
 *
 * Inline (xs/sm/md) vs showcase (lg/xl) modes:
 *   - **xs (chat-line)**, skip ornate frames entirely. The chat-line
 *     row was never the place for a 2× frame. Image-based / rank
 *     borders are suppressed; template borders are also skipped at
 *     xs since their CSS targets a fixed pixel size.
 *   - **sm/md/lg/xl**, render the frame at the catalog-defined size.
 *
 * Fallback: when no avatar URL is provided, renders a circular
 * initials chip in the keep-banner color.
 */

import { useEffect, useState } from "react";
import DOMPurify from "dompurify";
import type { AvatarCrop } from "@thekeep/shared";
import { extractFreeformBorderVars, freeformBorderInlineVars } from "@thekeep/shared";
import { useEarning } from "../../state/earning.js";
import { useChat } from "../../state/store.js";
import { applyFreeformBorderPlaceholders } from "../../lib/freeformBorderTemplate.js";
import { cropStyleAttr, cropStyleFor } from "../../lib/avatarCrop.js";
import { ensureInjectedStyle } from "../../lib/injectStyle.js";

export type BorderedAvatarSize = "xs" | "sm" | "md" | "lg" | "xl";
type Size = BorderedAvatarSize;

/** Avatar (portrait) diameter per size. */
const AVATAR_SIZE: Record<Size, string> = {
  xs: "clamp(31px, 2.125rem, 41px)",
  sm: "clamp(32px, 2.2rem, 40px)",
  md: "32px",
  lg: "64px",
  xl: "124px",
};

const CONTAINER_SCALE: Record<Size, number> = {
  xs: 1,
  sm: 1.5,
  md: 1.5,
  lg: 1.5,
  xl: 1.5,
};

/** Tags the freeform template sanitizer accepts. Wider than the
 *  name-style tag list because borders use structural elements
 *  (div + nested decorative spans for leaves, sparks, bolts, etc.). */
const FREEFORM_SANITIZER_TAGS = ["div", "span", "img", "i", "b", "em", "strong", "small", "sub", "sup", "mark"];
const FREEFORM_SANITIZER_ATTRS = ["class", "style", "src", "alt", "loading", "referrerpolicy", "data-*"];

/** Native dimensions every template assumes via the injector
 *  preamble, `.av` is 84px square (FRAME, including ring), `.pic`
 *  (inner avatar circle) is 76px. The 4px difference per side
 *  produces a ~6.5px ring at xl scale and ~2.3px at inline tiers.
 *  The render path scales by `targetAvatarPx / TEMPLATE_NATIVE_PIC`
 *  to land the visible avatar at the right size for each slot.
 *
 *  The frame was originally 82px (3px ring native, ~1.4px at sm)
 *  but a 1.4px ring sat below the comfortable visibility threshold
 *  on small slots, the userlist row showed proportionally-correct
 *  but visually invisible borders. Bumping native ring 1px makes
 *  the inline-tier ring readable without overhauling the per-slot
 *  scale math. xl thickens proportionally; the additional weight
 *  reads as a cleaner accent at showcase size, not chunky. */
const TEMPLATE_NATIVE_AV = 84;
const TEMPLATE_NATIVE_PIC = 76;

/** Target on-screen avatar diameter per slot, in pixels, for the
 *  template-mode render path. These are fixed numbers (not the
 *  responsive clamp() strings AVATAR_SIZE carries) because
 *  `transform: scale(<value>)` requires a unitless number, and
 *  `scale(calc(<length> / <length>))` resolves to a length in every
 *  current browser, invalidating the scale call entirely. Templates
 *  lose the chat-line-font-scale responsiveness as a result; rank-
 *  tier and image-mode borders still flow with clamp() because
 *  their renderer uses CSS-length math directly.
 *
 *  Inline-tier targets (sm, md) are slightly larger than the
 *  default non-template avatar (clamp ~32-40px) so the visible ring
 *  has room to render without smearing into the row's text. The
 *  template wrapper has overflow:visible, so the few extra pixels
 *  bleed cleanly into the row's gutter. */
const TEMPLATE_TARGET_AVATAR_PX: Record<Size, number> = {
  xs: 32,    // unused, xs skips template borders entirely
  sm: 44,    // userlist row, boosted from 36 so the ring reads at glance distance
  md: 40,    // forum post avatar, boosted from 32 for the same reason
  lg: 64,    // mid-size preview
  xl: 124,   // catalog showcase
};



/** Inline freeform border row, supplied directly for previews when
 *  the row may not be present in the user-facing catalog snapshot
 *  (admin views show disabled rows; submission previews ship the
 *  draft before any DB write). Mirrors the wire shape of
 *  `FreeformBorderRow` from `lib/earning.ts` so the same data flows
 *  through unchanged. */
export interface FreeformBorderOverride {
  key: string;
  imageUrl?: string | null;
  template?: string | null;
  styleCss?: string | null;
}

interface Props {
  avatarUrl: string | null | undefined;
  /** Owner-picked zoom + focal point applied to the avatar image.
   *  Optional, when omitted (or the default identity crop is passed
   *  in) the component renders the legacy centered-cover image with
   *  no transform, preserving the pre-feature look for callers that
   *  haven't been threaded with crop data yet. */
  avatarCrop?: AvatarCrop | null;
  /** Display name, used to derive the initials fallback. */
  name: string;
  /** Rank whose tier-IV border PNG should frame the avatar. */
  borderRankKey?: string | null;
  /** Free-form border key from migration 0149's `freeform_borders`
   *  catalog. Takes precedence over `borderRankKey` when both are
   *  set, see resolution order in the file header. */
  freeformBorderKey?: string | null;
  /** Direct inline override, bypasses the catalog lookup. Used by
   *  the admin Free-form Borders tab so disabled rows still preview,
   *  and by the editor's live-preview before a row is saved. Wins
   *  over `freeformBorderKey` when both are set. CSS for the
   *  override is injected into the document via an `aria-hidden`
   *  `<style>` element local to this component. */
  freeformOverride?: FreeformBorderOverride | null;
  /** Per-identity color customization for the freeform border,
   *  map of var-name (without `--c-` prefix) → CSS color value.
   *  The renderer inlines these as `--c-<name>` CSS custom
   *  properties on the wrapper; the cascade reaches the
   *  `.av .b-<key>` template's `var(--c-name, <fallback>)`
   *  references and overrides their fallbacks. Pass null/undefined
   *  to use the catalog row's CSS fallbacks. */
  freeformConfig?: Record<string, string> | null;
  size?: Size;
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  className?: string;
  /**
   * Bypass the viewer's "disable border styles" flair opt-out. Set on
   * cosmetic-shop / picker / admin previews (EarningDashboard,
   * AdminEarningTab) so a user who turned borders off for performance can
   * still SEE the frames they're browsing or managing. Ambient surfaces
   * (chat, userlist, profile) leave it off and honor the pref — the avatar
   * still renders, just without the border frame.
   */
  preview?: boolean;
}

export function BorderedAvatar({
  avatarUrl,
  avatarCrop,
  name,
  borderRankKey,
  freeformBorderKey,
  freeformOverride,
  freeformConfig,
  size = "sm",
  onClick,
  title,
  className,
  preview,
}: Props) {
  const snapshot = useEarning((s) => s.snapshot);
  // Viewer opt-out: when on (and this isn't a shop/admin preview), no
  // border frame is resolved — the avatar still renders, just bare.
  const disableBorderStyles = useChat((s) => s.flairPrefs.disableBorderStyles);
  const bordersDisabled = disableBorderStyles && !preview && !freeformOverride;
  const avatarSize = AVATAR_SIZE[size];
  const containerScale = CONTAINER_SCALE[size];
  const [errored, setErrored] = useState(false);
  const showAvatar = !!avatarUrl && !errored;

  // Resolve the crop into the inline-style payload the img picks up.
  // Shared with every other avatar surface via `lib/avatarCrop` so a
  // single zoom/pan picker drives the userlist, chat lines, profile
  // hero, DM bubbles, world member gallery, and freeform-border
  // templates in lockstep.
  const cropStyle = cropStyleFor(avatarCrop);

  // Resolve which border (if any) applies. Freeform wins over rank-
  // tier; within freeform, image-based and template-based are
  // exclusive (server validates on write). Override (when supplied)
  // bypasses the snapshot lookup entirely, used by admin previews
  // for disabled rows that aren't in the user-facing catalog.
  const freeformRow = freeformOverride ?? (
    !bordersDisabled && freeformBorderKey && snapshot
      ? snapshot.catalog.freeformBorders.find((b) => b.key === freeformBorderKey)
      : null
  );
  const rankBorderUrl = !bordersDisabled && borderRankKey && snapshot
    ? snapshot.catalog.rankTiers.find((t) => t.rankKey === borderRankKey && t.tier === 4)?.borderImageUrl ?? null
    : null;
  // Template-mode freeform border. Skipped at `xs` (chat-line) since
  // the catalog CSS targets fixed pixel sizes that throw off the
  // chat-line layout.
  const freeformTemplate = freeformRow?.template && containerScale > 1 ? freeformRow : null;
  // Image-mode freeform border falls into the same overlay path as
  // rank-tier borders.
  const freeformImageUrl = freeformRow?.imageUrl && containerScale > 1 ? freeformRow.imageUrl : null;
  const overlayBorderUrl = freeformImageUrl ?? rankBorderUrl;

  // Template-mode renders its own outer markup with its own sizing,
  // so we bypass the rank-tier container math entirely.
  if (freeformTemplate?.template) {
    // Pass the row's styleCss in BOTH override and catalog modes,
    // override-mode needs it because the CSS isn't in the global
    // injector yet, catalog-mode needs it so the var-extraction can
    // resolve which `--c-*` slots the template actually references
    // (the injector inlines the same CSS globally; this is a harmless
    // duplicate that scopes the rules to the portal subtree).
    return (
      <TemplateAvatar
        template={freeformTemplate.template}
        styleCss={freeformTemplate.styleCss ?? null}
        avatarUrl={showAvatar ? avatarUrl : null}
        avatarCrop={avatarCrop ?? null}
        name={name}
        size={size}
        {...(freeformConfig ? { freeformConfig } : {})}
        {...(onClick ? { onClick } : {})}
        {...(title ? { title } : {})}
        {...(className ? { className } : {})}
      />
    );
  }

  // Rank-tier / image-mode freeform / no border, original layout.
  const useFrameContainer = !!overlayBorderUrl && containerScale > 1;
  const containerSize = useFrameContainer ? `calc(${avatarSize} * ${containerScale})` : avatarSize;
  const containerWidth = (size === "sm" && !useFrameContainer)
    ? `calc(${avatarSize} * ${CONTAINER_SCALE.sm})`
    : containerSize;

  const wrapper = (
    <span
      className={`relative inline-block shrink-0 ${className ?? ""}`}
      style={{ width: containerWidth, height: containerSize }}
    >
      <span
        className="absolute"
        style={{
          left: "50%",
          top: "50%",
          width: avatarSize,
          height: avatarSize,
          transform: "translate(-50%, -50%)",
        }}
      >
        {showAvatar ? (
          // When a non-default crop is in play we wrap the img in an
          // overflow-hidden round clip and let the inner img grow past
          // it via the scale transform. The wrapper carries the
          // border + circular mask so the zoomed image looks cropped
          // to the circle, without this, the scale transform would
          // visibly spill past the avatar's edge.
          cropStyle ? (
            <span
              className="block h-full w-full overflow-hidden rounded-full border border-keep-rule"
            >
              <img
                src={avatarUrl!}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={() => setErrored(true)}
                className="h-full w-full object-cover"
                style={cropStyle}
              />
            </span>
          ) : (
            <img
              src={avatarUrl!}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setErrored(true)}
              className="h-full w-full rounded-full border border-keep-rule object-cover"
            />
          )
        ) : (
          <span
            aria-hidden
            className="flex h-full w-full items-center justify-center rounded-full border border-keep-rule bg-keep-banner text-[10px] font-semibold uppercase tracking-wide text-keep-muted"
          >
            {initialsFor(name)}
          </span>
        )}
      </span>
      {overlayBorderUrl && useFrameContainer ? (
        <img
          src={overlayBorderUrl}
          alt=""
          aria-hidden
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full select-none"
        />
      ) : null}
    </span>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={(e) => onClick(e)}
        title={title}
        className="inline-block rounded-full bg-transparent p-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-keep-action"
      >
        {wrapper}
      </button>
    );
  }
  return wrapper;
}

/**
 * Template-mode avatar renderer.
 *
 * Renders the template in-place at the layout slot, no portal. The
 * scaled visual escapes its 82px native frame via `overflow: visible`
 * on the wrapping span, so box-shadow glows and pseudo-element
 * decorations (petals, sparks, rays) paint past the avatar circle.
 * Bleed propagates up the ancestor chain until it hits an
 * `overflow: hidden`/`auto` boundary, typically the Earning modal's
 * scroll pane or the userlist rail. That's the right behavior: the
 * avatar gets to escape its immediate row but stays inside the modal
 * it was rendered in.
 *
 * Earlier versions used `createPortal(..., document.body)` so the
 * bleed could clear every ancestor's clipping. The cost was the
 * visual hovered over the modal header / outside the scroll pane
 * when the row scrolled out of view, which required a synthetic
 * occlusion check walking up the ancestor chain on every scroll.
 * Both problems disappear by rendering in place and letting natural
 * CSS clipping do its job.
 */
function TemplateAvatar({
  template,
  styleCss,
  avatarUrl,
  avatarCrop,
  name,
  size,
  freeformConfig,
  onClick,
  title,
  className,
}: {
  template: string;
  styleCss: string | null;
  avatarUrl: string | null | undefined;
  /** Owner-chosen zoom + focal point. Threaded through to the template's
   *  `<img>` placeholder so freeform-border templates honor the same
   *  crop as the plain-render path. The template's own picture
   *  container provides the circular clip, so no extra wrapper is
   *  added (which would otherwise shave the border decoration). */
  avatarCrop: AvatarCrop | null;
  name: string;
  size: Size;
  freeformConfig?: Record<string, string> | null;
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  className?: string;
}) {
  const targetAvatarPx = TEMPLATE_TARGET_AVATAR_PX[size];
  const scaleFactor = targetAvatarPx / TEMPLATE_NATIVE_PIC;
  const wrapperPx = TEMPLATE_NATIVE_AV * scaleFactor;

  // Override-mode rows ship CSS that isn't in the global injector
  // preamble, so it must be injected here — but through the nonce
  // helper, never a raw <style> child: prod CSP (style-src 'nonce-…')
  // drops un-nonced tags, which silently unstyled these borders on
  // remote. Keyed by a content hash so repeated renders and identical
  // catalog duplicates collapse to one head tag.
  useEffect(() => {
    if (!styleCss) return;
    let hash = 5381;
    for (let i = 0; i < styleCss.length; i++) hash = ((hash << 5) + hash + styleCss.charCodeAt(i)) | 0;
    ensureInjectedStyle(`ff-border-${(hash >>> 0).toString(36)}`, styleCss);
  }, [styleCss]);

  const merged = applyFreeformBorderPlaceholders(template, {
    avatarUrl,
    name,
    cropStyleAttr: cropStyleAttr(avatarCrop),
  });
  const clean = DOMPurify.sanitize(merged, {
    ALLOWED_TAGS: FREEFORM_SANITIZER_TAGS,
    ALLOWED_ATTR: FREEFORM_SANITIZER_ATTRS,
    KEEP_CONTENT: true,
  });

  // Resolve the per-identity color overrides into `--c-<name>: <value>`
  // inline declarations. `extractFreeformBorderVars` gates the keys
  // against what the template actually references, so a stale config
  // entry from a previous border can't smuggle properties onto the
  // wrapper. The cascade carries them into the template's
  // `var(--c-name, <fallback>)` references and overrides their
  // fallbacks.
  const customVars = freeformConfig && styleCss
    ? freeformBorderInlineVars(freeformConfig, extractFreeformBorderVars(styleCss))
    : null;

  const visual = (
    <span
      className={`relative inline-block shrink-0 ${className ?? ""}`}
      style={{
        width: `${wrapperPx}px`,
        height: `${wrapperPx}px`,
        verticalAlign: "middle",
        // Bleed past the 82px native frame, sized for the unscaled
        // template; the wrapper has no clipping so glows + falling
        // petals reach into the row's gutter.
        overflow: "visible",
      }}
      title={title}
    >
      {/* Override-mode CSS is injected into <head> via the nonce
          helper in the effect above (CSP: raw <style> children are
          dropped in prod); catalog hits additionally ride the global
          injector preamble — harmless duplicate when both present. */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: `${TEMPLATE_NATIVE_AV}px`,
          height: `${TEMPLATE_NATIVE_AV}px`,
          transformOrigin: "top left",
          transform: `scale(${scaleFactor})`,
          // Decorations (petals, sparks, rays, glows) deliberately bleed past
          // the frame via the wrapper's overflow:visible and into the row's
          // gutter / the userlist rail. At the default pointer-events:auto that
          // bleed would sit over — and SWALLOW clicks on — adjacent controls
          // (the rail's menu / character-switch buttons, the editor's Save),
          // breaking the app for anyone who equips such a border. Make the
          // whole decoration layer click-transparent; pointer-events inherits,
          // so the scaled template's descendant decorations + their
          // pseudo-elements are covered too. The avatar itself stays clickable
          // via the wrapping <button> when onClick is set (it catches the
          // bubbled click regardless of this layer).
          pointerEvents: "none",
          ...(customVars ?? {}),
        } as React.CSSProperties}
        dangerouslySetInnerHTML={{ __html: clean }}
      />
    </span>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={(e) => onClick(e)}
        title={title}
        className="inline-block bg-transparent p-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-keep-action"
      >
        {visual}
      </button>
    );
  }
  return visual;
}

function initialsFor(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}
