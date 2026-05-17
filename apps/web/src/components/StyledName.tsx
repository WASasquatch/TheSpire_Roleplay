/**
 * StyledName — renders a user's display name with their equipped
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
 *      between React, DOMPurify, JSX serialization, and the DOM — the
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
 *     (malformed admin template — safer to render plain than to
 *     omit the name entirely).
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import DOMPurify from "dompurify";
import { useEarning } from "../state/earning.js";
import { useActiveTheme } from "../lib/theme.js";

interface Props {
  displayName: string;
  styleKey?: string | null;
  config?: Record<string, unknown> | null;
  baseColor?: string | null | undefined;
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

export function StyledName({ displayName, styleKey, config, baseColor }: Props) {
  const snapshot = useEarning((s) => s.snapshot);
  const themeBg = useActiveTheme().bg;

  const styleRow = snapshot && styleKey
    ? snapshot.catalog.nameStyles.find((s) => s.key === styleKey)
    : null;

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
      tag = document.createElement("style");
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
  // setAttribute('style', cssText) AFTER React mounts — bypassing
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
    return <span style={baseColor ? { color: baseColor } : undefined}>{displayName}</span>;
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
  // cascade.
  const escapedName = escapeHtml(displayName);
  const merged = styleRow.template.replace(/\{username\}/g, escapedName);
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
    // Name-style colors are AESTHETIC choices — vivid greens, pastel
    // pinks, etc. — not chat-readability colors. Running them through
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
 * rendered blank — visible as the `--user-color1` vs `--user-color-1`
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
 * admin-authored `.ns-*` rule via the cascade — animations,
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
  const out: Record<string, string> = { ...cssVars };

  // Gradient family — classic background-clip text + transparent
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

  // Panning gradient — five-stop gradient with bigger pan distance
  // so the motion is unmistakable. Same fill-transparent pattern as
  // the gradient family above.
  if (c1 && c2 && className === "ns-pan") {
    out.backgroundImage = `linear-gradient(90deg, ${c1} 0%, ${c2} 25%, ${glow} 50%, ${c2} 75%, ${c1} 100%)`;
    out.backgroundSize = "400% 100%";
    out.WebkitBackgroundClip = "text";
    out.backgroundClip = "text";
    out.WebkitTextFillColor = "transparent";
    out.WebkitTextStroke = `1px ${outline}`;
    out.filter = `drop-shadow(0 0 4px ${glow})`;
  }

  // Pulse — solid color with breathing glow. The animation lives
  // on the .ns-pulse class rule (cycles drop-shadow from tight to
  // wide). Bake the static color + outline here.
  if (c1 && className === "ns-pulse") {
    out.color = c1;
    out.WebkitTextStroke = `1px ${outline}`;
  }

  // Shadow + glow filters re-baked with the glow color literal so
  // they show even when the CSS-var cascade misses.
  if (className === "ns-gradient-shadow") {
    out.filter = "drop-shadow(2px 3px 2px rgba(0,0,0,0.6))";
  }
  if (className === "ns-gradient-glow") {
    out.filter = `drop-shadow(0 0 4px ${glow}) drop-shadow(0 0 10px ${glow})`;
  }
  if (className === "ns-gradient-sg") {
    out.filter = `drop-shadow(2px 3px 2px rgba(0,0,0,0.7)) drop-shadow(0 0 8px ${glow})`;
  }

  return out as React.CSSProperties;
}
