/**
 * Hardened, shared scrubber for dangerous `url()` schemes inside CSS.
 *
 * Consolidates three previously-divergent copies (finding I3):
 *   - server bio style-ATTRIBUTE scrub  (auth/html.ts `scrubStyleAttrValue`)
 *   - server bio `<style>`-BLOCK scrub   (auth/html.ts `scrubStyleBlocks`)
 *   - client render-time scope scrub     (web/lib/cssScope.ts `scrubStyleUrls`)
 *
 * The old copies drifted: the client one used a flat `[^)]*` matcher (no
 * nested-paren handling) and did NOT block `file:`. This version is the
 * single behavior for all three sites and is intentionally the STRICTER of
 * the set (defense-in-depth hardening, tracked as a labeled behavior change).
 *
 * Posture: a `url()` value may point at legitimate media, so we ALLOW every
 * benign form writers actually use:
 *   - `https:` / `http:` absolute URLs
 *   - protocol-relative `//cdn.example/x.png`
 *   - root-relative `/uploads/bg.png`
 *   - relative paths `img/border.png`
 * and BLOCK only the schemes that execute code or exfiltrate/read local
 * resources: `javascript:`, `vbscript:`, `data:`, `file:`.
 *
 * Evasion resistance: the scheme is decided against a CANONICALIZED copy of
 * the value (see {@link canonicalizeUrlForSchemeCheck}) so obfuscations like
 * `java\tscript:`, `jav&#09;ascript:`, `&#106;avascript:`, `javascript&colon;`
 * and embedded NUL / control chars are all caught. A value judged safe is
 * returned VERBATIM — canonicalization is only used for the decision, never
 * to rewrite a legitimate URL.
 */

/** Schemes neutralized inside `url()`. Lowercase, `:`-terminated. */
export const DANGEROUS_CSS_URL_SCHEMES = [
  "javascript:",
  "vbscript:",
  "data:",
  "file:",
] as const;

/**
 * Balanced-paren `url(...)` matcher. Alternates non-paren runs with a single
 * balanced inner pair so ONE level of nesting (`url(javascript:alert(1))`) is
 * consumed whole; a flat `[^)]*` would stop at the first `)` and leave a stray
 * paren behind. A fresh RegExp is built per call so no `lastIndex` state leaks
 * between invocations.
 */
const URL_FUNC_SOURCE = String.raw`url\s*\(((?:[^()]|\([^()]*\))*)\)`;

function fromCodePointSafe(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

/**
 * Reduce a raw `url()` inner value to the form we scheme-check:
 *   1. trim, then strip a single pair of surrounding quotes
 *   2. decode numeric HTML entities (`&#106;`, `&#x6a;`) and the whitespace-y
 *      / colon named entities an HTML parser expands inside a style ATTRIBUTE
 *      before CSS ever sees the value (`&Tab;`, `&NewLine;`, `&colon;`)
 *   3. delete every ASCII whitespace + control char (0x00-0x20, 0x7f) so
 *      `java\tscript:`, embedded NULs, and split schemes collapse
 *   4. lowercase
 */
export function canonicalizeUrlForSchemeCheck(inner: string): string {
  let v = inner.trim();
  v = v.replace(/^['"]/, "").replace(/['"]$/, "");
  // Hex numeric entities.
  v = v.replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) =>
    fromCodePointSafe(parseInt(hex, 16)),
  );
  // Decimal numeric entities.
  v = v.replace(/&#(\d+);?/g, (_m, dec: string) =>
    fromCodePointSafe(parseInt(dec, 10)),
  );
  // Named entities that would let an attacker split/hide a scheme.
  v = v
    .replace(/&Tab;/gi, "\t")
    .replace(/&NewLine;/gi, "\n")
    .replace(/&colon;/gi, ":");
  // Strip ALL ASCII whitespace + control chars (incl. NUL, DEL).
  // eslint-disable-next-line no-control-regex
  v = v.replace(/[\u0000-\u0020\u007f]/g, "");
  return v.toLowerCase();
}

/** True if a raw `url()` inner value resolves to a dangerous scheme. */
export function isDangerousCssUrl(inner: string): boolean {
  const canonical = canonicalizeUrlForSchemeCheck(inner);
  return DANGEROUS_CSS_URL_SCHEMES.some((scheme) => canonical.startsWith(scheme));
}

/**
 * Replace every `url(...)` carrying a dangerous scheme with an empty
 * `url('')` (single-quoted so it is inert inside an HTML double-quoted style
 * attribute as well as a `<style>` block). Legitimate `url()`s are preserved
 * byte-for-byte. This is the ONLY transform this helper performs — callers
 * keep their own `expression()` / `behavior:` / `-moz-binding` / structural
 * scrubs where they are.
 */
export function scrubCssUrlSchemes(css: string): string {
  const re = new RegExp(URL_FUNC_SOURCE, "gi");
  return css.replace(re, (match, inner: string) =>
    isDangerousCssUrl(inner) ? "url('')" : match,
  );
}
