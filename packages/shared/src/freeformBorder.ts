/**
 * Free-form border color customization helpers.
 *
 * Convention: any `var(--c-<name>)` reference in a border's
 * `style_css` marks a customizable color slot. Authors write
 * `var(--c-ring-main, #00e5ff)` with a hex fallback so the catalog
 * row renders correctly out of the box; users who own the border
 * may override any subset of those slots via the
 * `PATCH /earning/me/freeform-borders/:key/config` endpoint.
 *
 * Storage shape: per-identity ownership row's `configJson` is a
 * JSON-stringified `Record<string, string>` keyed WITHOUT the
 * `--c-` prefix (saves bytes; the renderer adds the prefix back
 * when inlining). Values are arbitrary CSS color strings (`#hex`,
 * `rgb()`, named colors, the server validates only that the value
 * is a short string under the per-value cap; CSS-level validation
 * is delegated to the browser).
 */

/** Maximum length of a single color value in `configJson`. Tight
 *  cap because well-formed CSS colors are short (`#ff10f0`,
 *  `rgba(255,16,240,.5)`, `goldenrod`). Anything longer is almost
 *  certainly malformed or an attempt to smuggle other CSS. */
export const FREEFORM_COLOR_VALUE_MAX = 80;

/** Maximum number of customizable slots one border may define.
 *  Aurora needs 3, Crown jewels needs 6, so 24 is comfortable
 *  headroom for elaborate admin-authored borders. Server clamps
 *  config writes to this many entries. */
export const FREEFORM_CONFIG_MAX_ENTRIES = 24;

/**
 * Walk the catalog row's `style_css` and return the deduped list
 * of `--c-<name>` variable names referenced anywhere (without the
 * `--c-` prefix). Caller uses this to render the customization UI
 * AND to filter incoming config writes (any key not in the
 * extracted set is silently dropped, clients can't smuggle
 * arbitrary `--*` declarations onto the wrapper).
 *
 * Returns names in first-seen order so the UI presents slots in
 * the order the author wrote them in the CSS (typically following
 * visual importance, base color first, accents last).
 */
export function extractFreeformBorderVars(styleCss: string | null | undefined): string[] {
  if (!styleCss) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  // Match `--c-` followed by a CSS identifier (letters/digits/hyphens).
  // The leading `--` is part of the spec for custom properties; the
  // `c-` namespace narrows it to the customizable subset and keeps
  // utility vars (e.g. internal layout vars an author might use)
  // out of the user-facing picker list.
  const re = /--c-([a-z][a-z0-9-]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(styleCss)) !== null) {
    const name = m[1]!.toLowerCase();
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Same as `extractFreeformBorderVars` but ALSO captures each var's
 * `var(--c-name, <default>)` fallback color. The picker UI uses the
 * fallback as the "starting color" so unpicked swatches show what the
 * border actually renders with, without this, every untouched slot
 * read as white, masking which slot drives which visible color.
 *
 * Returns first-seen fallback per var. If the author uses the var in
 * multiple places with different fallbacks, the first occurrence
 * wins, same posture as the variable name extraction. If the var
 * appears without a fallback (e.g. `var(--c-foo)` only), the fallback
 * is null.
 *
 * Fallback parsing is regex-based and intentionally simple. It
 * captures hex (#rgb/#rrggbb/#rrggbbaa), rgb(), and rgba(),
 * the only color forms the catalog's CSS actually uses. Anything
 * exotic (named colors, hsl, color-mix, etc.) falls through with
 * a null default; the picker then shows a neutral swatch.
 */
export function extractFreeformBorderVarsWithDefaults(
  styleCss: string | null | undefined,
): Array<{ name: string; defaultColor: string | null }> {
  if (!styleCss) return [];
  const out: Array<{ name: string; defaultColor: string | null }> = [];
  const seen = new Map<string, number>();
  // Match: var(--c-NAME [, FALLBACK])
  // The fallback group `(?:[^()]|\([^()]*\))+?` matches "non-paren
  // chars OR a single-level nested paren group", necessary because
  // an `rgba(255,87,34,.45)` fallback contains its own `)`, and a
  // naive `[^)]+?` would stop at rgba's close paren and drop the
  // last `)` from the captured value. With one level of nested
  // parens supported, every color form the catalog actually uses
  // (hex, rgb(), rgba()) round-trips cleanly.
  const re = /var\(\s*--c-([a-z][a-z0-9-]*)\s*(?:,\s*((?:[^()]|\([^()]*\))+?)\s*)?\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(styleCss)) !== null) {
    const name = m[1]!.toLowerCase();
    const fallbackRaw = m[2]?.trim() ?? null;
    const defaultColor = fallbackRaw && isColorish(fallbackRaw) ? fallbackRaw : null;
    if (seen.has(name)) {
      // First occurrence's default wins; later mentions only update
      // null → non-null (so an early `var(--c-x)` with no fallback
      // doesn't permanently hide a later `var(--c-x, #abc)` default).
      const i = seen.get(name)!;
      if (out[i]!.defaultColor == null && defaultColor != null) {
        out[i] = { name, defaultColor };
      }
      continue;
    }
    seen.set(name, out.length);
    out.push({ name, defaultColor });
  }
  return out;
}

const COLOR_RE = /^(#(?:[0-9a-fA-F]{3,8})|rgba?\([^)]+\))$/;
function isColorish(s: string): boolean {
  return COLOR_RE.test(s.trim());
}

/**
 * Parse a stored configJson into a typed map. Returns an empty
 * object on null / invalid JSON / wrong shape, failure is silent
 * because a corrupt config column shouldn't break the render path.
 * Values are coerced to strings; non-string values are dropped.
 */
export function parseFreeformBorderConfig(json: string | null | undefined): Record<string, string> {
  if (!json) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return {}; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

/**
 * Compose the inline-style object that wires the user's config
 * into the BorderedAvatar wrapper. Each `key → value` becomes a
 * `--c-<key>: <value>` CSS custom-property declaration; the cascade
 * carries them into the `.av .b-<key>` template where
 * `var(--c-name, <fallback>)` references pick them up.
 *
 * Returns a React CSSProperties object (the index signature for
 * `--*` is loose in TS but stringly-typed access works). Caller
 * spreads it into the wrapper's `style={...}`.
 *
 * Filters by `allowedVars` if provided, callers pass the result of
 * `extractFreeformBorderVars(styleCss)` to drop unknown keys before
 * they reach the DOM. This is the second line of defense after the
 * server-side filter; the first line is the PATCH endpoint dropping
 * unknown keys at write time.
 */
export function freeformBorderInlineVars(
  config: Record<string, string>,
  allowedVars?: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const allowSet = allowedVars ? new Set(allowedVars) : null;
  for (const [k, v] of Object.entries(config)) {
    if (allowSet && !allowSet.has(k)) continue;
    out[`--c-${k}`] = v;
  }
  return out;
}

/**
 * Validate a config entry: key must be a CSS identifier (so it
 * doesn't smuggle anything via the `--c-` prefix), value must be
 * a short string. Hex / rgb / named color formats all pass, full
 * CSS-color validation is delegated to the browser, which silently
 * ignores invalid values (no XSS surface since the value goes into
 * a CSS custom property, not arbitrary CSS, and CSS variables
 * can't break out of property values).
 */
export function isValidFreeformBorderConfigKey(key: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(key) && key.length <= 40;
}

export function isValidFreeformBorderConfigValue(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > FREEFORM_COLOR_VALUE_MAX) return false;
  // Reject obvious injection patterns even though `--c-*` properties
  // can't actually escape a CSS value context: catch `;`, `{`, `}`,
  // `</style>`, `expression(`. Belt-and-suspenders.
  if (/[;{}<>]/.test(value)) return false;
  return true;
}
