/**
 * StyledName, renders a user's display name with their equipped
 * name-style template applied.
 *
 * Render strategy:
 *   1. Look up the catalog row by `styleKey`.
 *   2. Parse the (admin-authored) template into `{tag, className}` if
 *      it matches the simple shape `<tag class="ns-…">{username}</tag>`.
 *      Every shipped built-in matches that shape; admin-authored
 *      custom templates that don't fall through to the DOMPurify path.
 *   3. Generate a unique per-instance class (`nst-<rand>`) and inject
 *      a real CSS rule `.<instanceClass> { --user-color-1: …; … }`
 *      into a per-instance `<style>` tag. This is the bulletproof
 *      way to plumb CSS custom properties from React onto the styled
 *      element: every other path we tried (React `style={{ "--x": v }}`,
 *      cascade from a parent `<span>` wrapper, regex-inject `style="…"`
 *      into the template before DOMPurify) lost the vars somewhere
 *      between React, DOMPurify, JSX serialization, and the DOM, the
 *      visual symptom was every gradient-style render appearing blank
 *      because `var(--user-color-1, currentColor)` fell back to
 *      currentColor which resolved to `transparent` (the same rule
 *      sets `color: transparent` for the background-clip mask). A
 *      real CSS rule is immune to all of those pitfalls.
 *
 * Falls back to plain text whenever:
 *   - styleKey is null (user has nothing equipped),
 *   - styleKey doesn't match an enabled catalog entry (admin
 *     disabled / deleted the style after the user equipped it),
 *   - the template doesn't contain the `{username}` placeholder
 *     (malformed admin template, safer to render plain than to
 *     omit the name entirely).
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import DOMPurify from "dompurify";
import { useEarning } from "../../state/earning.js";
import { useChat } from "../../state/store.js";
import type { NameStyleCatalogRow } from "../../lib/earning.js";
import { applyNameStylePlaceholders } from "../../lib/nameStyleTemplate.js";
import { createNonceStyleTag } from "../../lib/injectStyle.js";
import { useActiveTheme } from "../../lib/theme.js";

interface Props {
  displayName: string;
  styleKey?: string | null;
  config?: Record<string, unknown> | null;
  baseColor?: string | null | undefined;
  /**
   * Admin-editor escape hatch: when set, bypass the snapshot catalog
   * lookup and render against this in-progress style row directly.
   * Used by the Name-Styles preview pane so an unsaved draft renders
   * even though its key isn't in the live catalog yet. Pair with
   * `injectNameStylePreview` to make the row's CSS reachable.
   */
  overrideRow?: NameStyleCatalogRow | null;
  /**
   * Bypass the viewer's "disable name styles" flair opt-out. Set on
   * cosmetic-shop / picker / admin previews (EarningDashboard,
   * AdminEarningTab) so a user who turned name styles off for performance
   * can still SEE the styles they're browsing or managing. Ambient
   * surfaces (chat, userlist, profile) leave it off and honor the pref.
   */
  preview?: boolean;
}

/** Allowed inline tags inside a custom name-style template (fallback path). */
const SANITIZER_TAGS = ["span", "b", "i", "em", "strong", "u", "s", "small", "sub", "sup", "mark"];
const SANITIZER_ATTRS = ["class", "style", "data-*"];

/** Tags the simple-template parser will accept. */
const SIMPLE_TEMPLATE_TAGS = new Set(SANITIZER_TAGS);

function parseSimpleTemplate(template: string): { tag: string; className: string } | null {
  const m = template.trim().match(/^<([a-z]+)\s+class="([^"]+)">\s*\{username\}\s*<\/([a-z]+)>$/i);
  if (!m) return null;
  const tag = m[1]!.toLowerCase();
  if (m[3]!.toLowerCase() !== tag) return null;
  if (!SIMPLE_TEMPLATE_TAGS.has(tag)) return null;
  return { tag, className: m[2]! };
}

let instanceCounter = 0;
function nextInstanceId(): string {
  instanceCounter += 1;
  return `nst-${instanceCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function StyledName({ displayName, styleKey, config, baseColor, overrideRow, preview }: Props) {
  const snapshot = useEarning((s) => s.snapshot);
  const themeBg = useActiveTheme().bg;
  // Viewer opt-out: when on (and this isn't a shop/admin preview), the
  // equipped style is ignored and the name renders as plain text.
  const disableNameStyles = useChat((s) => s.flairPrefs.disableNameStyles);
  const styleDisabled = disableNameStyles && !preview;

  // `overrideRow` wins when set, admin preview pane passes the
  // in-progress draft directly. Otherwise resolve from the live
  // catalog via the styleKey lookup (unless the viewer disabled styles).
  const styleRow = overrideRow ?? (!styleDisabled && snapshot && styleKey
    ? snapshot.catalog.nameStyles.find((s) => s.key === styleKey)
    : null);

  // Stable per-instance class name. Used both to scope the injected
  // CSS rule and as a className on the styled element.
  const instanceClass = useMemo(() => nextInstanceId(), []);

  const cssVars = useMemo(() => {
    if (!styleRow || !config) return {} as Record<string, string>;
    return resolveCssVars(config, themeBg);
  }, [styleRow, config, themeBg]);

  // Inject (and update on every change) a per-instance `<style>` tag
  // that scopes the CSS vars to this element's instance class.
  // Cleanup removes the tag on unmount so we don't leak <style>
  // nodes for every chat line we've ever rendered.
  const styleTagRef = useRef<HTMLStyleElement | null>(null);
  useEffect(() => {
    if (typeof document === "undefined") return;
    let tag = styleTagRef.current;
    if (!tag) {
      // Stamp the CSP nonce so strict prod `style-src 'self' 'nonce-…'`
      // doesn't block this dynamic stylesheet. The meta tag carrying
      // the nonce is rendered server-side into the SPA shell and is
      // stable for the life of the page (it rotates per server
      // response, captured once at module load in CSP_NONCE).
      tag = createNonceStyleTag();
      tag.setAttribute("data-name-style-instance", instanceClass);
      document.head.appendChild(tag);
      styleTagRef.current = tag;
    }
    const entries = Object.entries(cssVars);
    if (entries.length === 0) {
      tag.textContent = "";
      return;
    }
    const decls = entries.map(([k, v]) => `${k}: ${escapeCssValue(v)};`).join(" ");
    tag.textContent = `.${instanceClass} { ${decls} }`;
  }, [instanceClass, cssVars]);
  useEffect(() => {
    return () => {
      const tag = styleTagRef.current;
      if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
      styleTagRef.current = null;
    };
  }, []);

  // Ref to the styled element. Used to push the inline style via
  // setAttribute('style', cssText) AFTER React mounts, bypassing
  // React's style-prop serialization entirely. Every other path
  // we tried (style={cssVars}, per-instance <style> tag with the
  // vars, setProperty('--user-color-1', …)) silently failed to land
  // the gradient in the user's DOM; setAttribute on the actual
  // element is the bottom-line guarantee.
  const styledRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = styledRef.current;
    if (!el) return;
    if (!styleRow) { el.removeAttribute("style"); return; }
    const simple = parseSimpleTemplate(styleRow.template);
    const className = simple?.className ?? "";
    const baked = bakeStyleForClassName(className, cssVars);
    const cssText = Object.entries(baked)
      .map(([k, v]) => `${cssKeyToProp(k)}: ${v}`)
      .join("; ");
    el.setAttribute("style", cssText);
  }, [styleRow, cssVars]);

  if (!styleRow) {
    // 0.2em right padding so the surrounding "]" / ":" punctuation in
    // chat lines isn't flush against the last glyph. Matches the
    // padding the baker applies on the styled-name path so plain and
    // styled names share consistent breathing room.
    const baseStyle: React.CSSProperties = { paddingRight: "0.2em" };
    if (baseColor) baseStyle.color = baseColor;
    return <span style={baseStyle}>{displayName}</span>;
  }

  const simple = parseSimpleTemplate(styleRow.template);
  if (simple) {
    const Tag = simple.tag as "span";
    return (
      <Tag
        ref={styledRef as React.Ref<HTMLSpanElement>}
        className={`${simple.className} ${instanceClass}`}
      >
        {displayName}
      </Tag>
    );
  }

  // Custom-template fallback. The instance class is added as a
  // wrapping span; the inner element inherits the vars via the
  // cascade. Placeholder substitution (`{username}`, `{username-span}`)
  // lives in lib/nameStyleTemplate so the admin preview renders the
  // same expansion users see at runtime.
  const merged = applyNameStylePlaceholders(styleRow.template, displayName);
  const clean = DOMPurify.sanitize(merged, {
    ALLOWED_TAGS: SANITIZER_TAGS,
    ALLOWED_ATTR: SANITIZER_ATTRS,
    KEEP_CONTENT: true,
  });
  if (!clean) {
    return <span style={baseColor ? { color: baseColor } : undefined}>{displayName}</span>;
  }
  return (
    <span
      className={instanceClass}
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}

function resolveCssVars(config: Record<string, unknown>, _themeBg: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== "string" || value.length === 0) continue;
    const varName = `--user-${kebab(key)}`;
    // Name-style colors are AESTHETIC choices, vivid greens, pastel
    // pinks, etc., not chat-readability colors. Running them through
    // `legibleAgainstBg` flattened the user's bright picks to muted
    // dark variants for "contrast", which collapsed two-stop gradients
    // into near-monochrome dark blobs. We skip the legibility shift
    // here and let the user's literal colors render. (Chat author
    // colors still go through `legibleAgainstBg` in resolveMessageColor
    // where readability does matter.)
    out[varName] = value;
  }
  return out;
}

/**
 * camelCase → kebab-case. Also inserts a dash between a letter and a
 * trailing digit so `color1` → `color-1` (matches the catalog CSS
 * which uses `var(--user-color-1, …)`). Without this digit handling
 * the CSS-var names emitted into the inline style didn't match what
 * `.ns-gradient` looked up, every var fell back to currentColor
 * (= transparent on the gradient mask rule), and every preview
 * rendered blank, visible as the `--user-color1` vs `--user-color-1`
 * mismatch in the DevTools inspector.
 */
function kebab(camel: string): string {
  return camel
    .replace(/([A-Z])/g, "-$1")
    .replace(/([a-zA-Z])(\d)/g, "$1-$2")
    .toLowerCase();
}

function looksLikeColor(v: string): boolean {
  return /^#?[0-9a-fA-F]{3,8}$/.test(v) || /^(rgb|hsl|color)/i.test(v);
}

/** Strip characters that would break out of a CSS declaration value. */
function escapeCssValue(v: string): string {
  return v.replace(/[\\;}]/g, "");
}

/**
 * Convert a CSSProperties-shaped key (`backgroundImage`,
 * `WebkitBackgroundClip`, `--user-color-1`) into the kebab-case CSS
 * property name we emit into the inline style string. Custom
 * properties (`--*`) pass through verbatim; vendor-prefixed keys
 * (`Webkit*`) become `-webkit-*`; everything else is camelCase →
 * kebab-case.
 */
function cssKeyToProp(key: string): string {
  if (key.startsWith("--")) return key;
  if (key.startsWith("Webkit")) {
    return "-webkit-" + key.slice(6).replace(/([A-Z])/g, "-$1").toLowerCase();
  }
  return key.replace(/([A-Z])/g, "-$1").toLowerCase();
}

/**
 * Bake admin-styled visuals directly into an inline style for the
 * built-in `ns-*` template classes. Inline `style` overrides class
 * declarations, so even if the page's stylesheet wasn't loaded yet
 * or the CSS-var cascade failed (it has, repeatedly, in ways we
 * couldn't observe), the gradient / pulse / glow still renders.
 *
 * Anything we don't override here still inherits from the
 * admin-authored `.ns-*` rule via the cascade, animations,
 * background-clip + color: transparent for gradient classes, etc.
 * Each branch also re-emits the CSS vars so a downstream rule that
 * still wants `var(--user-color-1)` can pick it up.
 */
function bakeStyleForClassName(className: string, cssVars: Record<string, string>): React.CSSProperties {
  const c1 = cssVars["--user-color-1"];
  const c2 = cssVars["--user-color-2"];
  const glow = cssVars["--user-glow"] ?? "rgba(255,170,80,0.9)";
  const outline = cssVars["--user-outline"] ?? "rgba(0,0,0,0.9)";
  // Seed with the CSS vars so the original admin CSS (which uses
  // `var(--user-color-1)`) still works wherever the cascade DOES
  // land. The inline-baked declarations below override the relevant
  // properties on top.
  //
  // `padding-right: 0.2em` on every styled name widens the inline
  // box just enough that gradient-clip-text styles paint their
  // gradient pixels under italic glyph overflow (the slant on the
  // last letter of an italic admin name otherwise extends past the
  // text-advance box, has no gradient to clip to, and renders
  // transparent, looking like the slant was sheared off). Solid-
  // color styles get the same padding too so the chat-line "]" / ":"
  // punctuation isn't flush against the styled glyph.
  const out: Record<string, string> = { ...cssVars, paddingRight: "0.2em" };

  // Gradient family, classic background-clip text + transparent
  // text-fill pattern. The `-webkit-text-fill-color: transparent`
  // makes the glyph fill transparent (without zeroing `color`),
  // letting the background gradient show through via the text mask.
  // `-webkit-text-stroke` adds a thin outline at the glyph edge.
  //
  // Important: we DON'T set `paint-order: stroke fill`. Combining
  // paint-order with background-clip:text turned out to break the
  // gradient composite in some browsers (the fill got skipped and
  // text rendered as a solid dark mass). Default paint order works
  // correctly: fill first (gradient via clip), stroke after
  // (outline overlays the glyph edge).
  if (c1 && c2 && (className === "ns-gradient" || className === "ns-gradient-shadow" || className === "ns-gradient-glow" || className === "ns-gradient-sg")) {
    // Use `backgroundImage` (longhand) instead of `background`
    // shorthand so we don't accidentally reset the class's
    // `background-clip: text`.
    out.backgroundImage = `linear-gradient(90deg, ${c1}, ${c2})`;
    out.WebkitBackgroundClip = "text";
    out.backgroundClip = "text";
    out.WebkitTextFillColor = "transparent";
    out.WebkitTextStroke = `${className === "ns-gradient-sg" ? "2px" : "1px"} ${outline}`;
  }

  // Panning gradient, five-stop gradient with bigger pan distance
  // so the motion is unmistakable. Same fill-transparent pattern as
  // the gradient family above.
  if (c1 && c2 && className === "ns-pan") {
    out.backgroundImage = `linear-gradient(90deg, ${c1} 0%, ${c2} 25%, ${glow} 50%, ${c2} 75%, ${c1} 100%)`;
    out.backgroundSize = "400% 100%";
    out.WebkitBackgroundClip = "text";
    out.backgroundClip = "text";
    out.WebkitTextFillColor = "transparent";
    out.WebkitTextStroke = `1px ${outline}`;
    // Halved glow (was 4px), matches the softer drop-shadow widths in
    // migration 0080. Keep the inline fallback and the .ns-pan
    // catalog rule synchronized so user.config-driven glow colors
    // render the same regardless of which path lands the CSS.
    out.filter = `drop-shadow(0 0 2px ${glow})`;
  }

  // Pulse, solid color with breathing glow. The animation lives
  // on the .ns-pulse class rule (cycles drop-shadow from tight to
  // wide). Bake the static color + outline here.
  if (c1 && className === "ns-pulse") {
    out.color = c1;
    out.WebkitTextStroke = `1px ${outline}`;
  }

  // Billboard, solid color + white outline + dark drop-shadows.
  // Distinct from the gradient family in that there's no
  // background-clip text trickery, so paint-order: stroke fill
  // works (and is necessary) to put the outline BEHIND the fill.
  // Default outline is white, falling back to whatever the user
  // overrode via --user-outline.
  if (c1 && className === "ns-billboard") {
    out.color = c1;
    // Default to a white outline for the marquee look; user-outline
    // override comes through via the cssVars seed at the top.
    const billboardOutline = cssVars["--user-outline"] ?? "rgba(255,255,255,0.95)";
    out.WebkitTextStroke = `2px ${billboardOutline}`;
    // paint-order works here because we're NOT using background-clip
    // text (the gradient family's issue from migration 0072 doesn't
    // apply). Stroke first, then fill on top, the white outline sits
    // behind the colored letters instead of bleeding over the glyph
    // edges.
    (out as Record<string, string>).paintOrder = "stroke fill";
    out.filter = "drop-shadow(2px 3px 3px rgba(0,0,0,0.85)) drop-shadow(0 0 6px rgba(0,0,0,0.5))";
  }

  // Stencil, outline only, transparent fill. Same paint-order story
  // as billboard (safe since no clip-text). Outline defaults to white;
  // user-outline overrides for colored stencils.
  if (className === "ns-stencil") {
    out.color = "transparent";
    const stencilOutline = cssVars["--user-outline"] ?? "rgba(255,255,255,0.95)";
    out.WebkitTextStroke = `2px ${stencilOutline}`;
    out.filter = "drop-shadow(0 0 1px rgba(0,0,0,0.4))";
  }

  // Chrome, vertical metallic gradient. Same clip-text recipe as the
  // horizontal gradient family but the gradient direction is 180deg
  // (top→middle→bottom). Three stops: highlight at top + bottom,
  // shadow in the middle, that "tube of metal lit from above" look.
  if (c1 && c2 && className === "ns-chrome") {
    out.backgroundImage = `linear-gradient(180deg, ${c1} 0%, ${c2} 45%, ${c2} 55%, ${c1} 100%)`;
    out.WebkitBackgroundClip = "text";
    out.backgroundClip = "text";
    out.WebkitTextFillColor = "transparent";
    out.WebkitTextStroke = `1px ${outline}`;
  }

  // Glassy, semi-translucent fill + thin white outline + soft inner
  // glow. Solid-color path (cascade-safe), bakes the filter stack so a
  // missed cascade still produces the frosted-glass look.
  if (c1 && className === "ns-glassy") {
    out.color = c1;
    const glassyOutline = cssVars["--user-outline"] ?? "rgba(255,255,255,0.85)";
    out.WebkitTextStroke = `1px ${glassyOutline}`;
    out.filter = "drop-shadow(0 0 3px rgba(255,255,255,0.5)) drop-shadow(0 1px 2px rgba(0,0,0,0.35))";
  }

  // Comic Pop, solid + thick white outline + hard offset shadow.
  // Same paint-order recipe as billboard but with a 0-blur shadow
  // (`0` for the blur radius is what produces the hard cartoon shadow
  // instead of a soft blur).
  if (c1 && className === "ns-comic-pop") {
    out.color = c1;
    const comicOutline = cssVars["--user-outline"] ?? "rgba(255,255,255,0.95)";
    out.WebkitTextStroke = `2px ${comicOutline}`;
    (out as Record<string, string>).paintOrder = "stroke fill";
    out.filter = "drop-shadow(3px 3px 0 rgba(0,0,0,0.85))";
  }

  // Neon Tube, bright fill with a same-color halo. The halo comes
  // from text-shadow (not drop-shadow filter) so it hugs the glyph
  // edges instead of the bounding box, that's what makes it read as
  // "tube of light" rather than "object lit by a backlight".
  if (c1 && className === "ns-neon-tube") {
    out.color = c1;
    out.textShadow = `0 0 3px ${c1}, 0 0 7px ${c1}`;
    out.WebkitTextStroke = `0.5px ${outline}`;
  }

  // Marquee, same paint as comic-pop but the catalog rule owns the
  // blink animation. Baker only needs the static color/outline/halo;
  // animation rides the cascade since it's an @keyframes definition
  // (no CSS-var dependency).
  if (c1 && className === "ns-marquee") {
    out.color = c1;
    const marqueeOutline = cssVars["--user-outline"] ?? "rgba(255,255,255,0.9)";
    out.WebkitTextStroke = `1px ${marqueeOutline}`;
    out.filter = `drop-shadow(0 0 3px ${glow})`;
  }

  // Synthwave, 2-stop vertical gradient + cyan-glow drop. Pairs with
  // the gradient family's clip-text but uses 180deg + a colored
  // drop-shadow underneath instead of a horizontal sweep.
  if (c1 && c2 && className === "ns-synthwave") {
    out.backgroundImage = `linear-gradient(180deg, ${c1} 0%, ${c2} 100%)`;
    out.WebkitBackgroundClip = "text";
    out.backgroundClip = "text";
    out.WebkitTextFillColor = "transparent";
    const synthOutline = cssVars["--user-outline"] ?? "rgba(255,255,255,0.5)";
    out.WebkitTextStroke = `1px ${synthOutline}`;
    out.filter = `drop-shadow(0 2px 3px ${glow})`;
  }

  // Aurora Borealis, 3-stop tropical gradient. Animation handles
  // the hue-rotation on the catalog rule; baker just sets the
  // gradient mask + stroke so the static look is right when the
  // animation isn't running (paused tabs, reduced-motion preference).
  if (c1 && c2 && className === "ns-aurora-borealis") {
    out.backgroundImage = `linear-gradient(90deg, ${c1} 0%, ${glow} 50%, ${c2} 100%)`;
    out.WebkitBackgroundClip = "text";
    out.backgroundClip = "text";
    out.WebkitTextFillColor = "transparent";
    out.WebkitTextStroke = `1px ${outline}`;
  }

  // Hearth Fire, vertical fire-palette gradient. The pan animation
  // lives on the catalog rule (background-position keyframes); baker
  // sets the static gradient + stroke + halo so the base look paints
  // even when the cascade misses. `backgroundSize: 100% 250%` so the
  // animated background-position cycle still has room to slide once
  // the cascade does land.
  if (c1 && c2 && className === "ns-hearth-fire") {
    out.backgroundImage = `linear-gradient(0deg, ${c2} 0%, ${c1} 50%, ${glow} 100%)`;
    out.backgroundSize = "100% 250%";
    out.WebkitBackgroundClip = "text";
    out.backgroundClip = "text";
    out.WebkitTextFillColor = "transparent";
    out.WebkitTextStroke = `0.5px ${outline}`;
    out.filter = `drop-shadow(0 -2px 4px ${glow})`;
  }

  // Embers, same fire gradient base as Hearth Fire. The particle
  // pseudos (::before / ::after) and their rise animation live in the
  // catalog rule only, pseudo-element CSS can't be re-emitted via
  // inline `style` on the host element, so this fallback covers only
  // the gradient mask and halo. If the catalog CSS hasn't loaded the
  // user will see a static fire-gradient name (no particles); once
  // the cascade lands the embers start cycling.
  if (c1 && c2 && className === "ns-embers") {
    out.backgroundImage = `linear-gradient(0deg, ${c2} 0%, ${c1} 45%, ${glow} 100%)`;
    out.backgroundSize = "100% 220%";
    out.WebkitBackgroundClip = "text";
    out.backgroundClip = "text";
    out.WebkitTextFillColor = "transparent";
    out.WebkitTextStroke = `0.5px ${outline}`;
    out.filter = `drop-shadow(0 -2px 5px ${glow})`;
  }

  // Neon Sign, lit state baked. Solid color face + neon-pink halo
  // via text-shadow (inner) and drop-shadow filter (outer). The
  // flicker keyframes live in the catalog rule; this fallback just
  // makes sure the lit look is right when the catalog CSS hasn't
  // landed yet (the name reads as a static glowing sign until then,
  // then starts cycling once the cascade applies).
  if (c1 && className === "ns-neon-sign") {
    out.color = c1;
    const neonGlow = cssVars["--user-glow"] ?? "#ff1493";
    out.textShadow = `0 0 2px ${neonGlow}, 0 0 6px ${neonGlow}, 0 0 12px ${neonGlow}`;
    // Static lit-state filter. Migration 0092 collapsed the
    // dim-breath + dead-blip flicker into a single animation that
    // explicitly sets filter on every keyframe, so the inline
    // baker fallback just needs to render the lit baseline for
    // the brief moment before the catalog rule loads and takes
    // over via its keyframes.
    out.filter = `drop-shadow(0 0 2px ${neonGlow}) drop-shadow(0 0 5px ${neonGlow})`;
  }

  // Shadow + glow filters re-baked with the glow color literal so
  // they show even when the CSS-var cascade misses. Widths kept in
  // lockstep with migration 0080's softened catalog values.
  if (className === "ns-gradient-shadow") {
    out.filter = "drop-shadow(2px 3px 2px rgba(0,0,0,0.6))";
  }
  if (className === "ns-gradient-glow") {
    out.filter = `drop-shadow(0 0 2px ${glow}) drop-shadow(0 0 5px ${glow})`;
  }
  if (className === "ns-gradient-sg") {
    out.filter = `drop-shadow(2px 3px 2px rgba(0,0,0,0.7)) drop-shadow(0 0 4px ${glow})`;
  }

  return out as React.CSSProperties;
}
