#!/usr/bin/env node
/**
 * Re-port every built-in border's literal colors to `--c-*` CSS
 * variables, this time using SEMANTIC names derived from the
 * selector + CSS property that wraps each color, not the generic
 * `c1..cN` scheme the first pass used.
 *
 * Naming derivation:
 *   1. Tokenize the CSS into rules (split on `}`).
 *   2. For each rule, look at the rightmost class in the selector
 *      (the part after the border-class prefix), that's the
 *      "element role" (`ring`, `feather`, `ember`, `wing`, `petal`,
 *      `log`, etc.). Pseudo-elements collapse to `aura`/`shine`.
 *   3. For each literal color in the rule's body, look at the CSS
 *      property the color appears in (background / box-shadow /
 *      filter / border / color / text-shadow / outline) and map
 *      that to a role-suffix (bg / glow / shadow / etc.).
 *   4. Combine: `<element-role>-<property-role>-<N>` where N is the
 *      ordinal within that (element, property) bucket. So Phoenix's
 *      first feather background color is `feather-bg-1`, the second
 *      `feather-bg-2`, etc. Identical colors across the CSS dedup
 *      onto the same slot regardless of where they appear (so a
 *      single shared red updates everywhere).
 *
 * The numeric suffix lets the picker UI distinguish stops in a
 * multi-stop gradient (`ring-bg-1`, `ring-bg-2`, `ring-bg-3`,
 * `ring-bg-4`) without inventing fanciful per-stop labels that
 * would diverge across borders.
 */

import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "../data/thekeep.sqlite");

const HEX_RE = /#([0-9a-fA-F]{3,8})\b/g;
const RGBA_RE = /\brgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)/g;
// Strip every existing `var(--c-NAME, FALLBACK)` back down to just
// FALLBACK so we can re-name from scratch. Without this we'd nest
// var() inside var() on every re-port pass. Handles one level of
// nested parens (same flavor the matched extractor uses).
const STRIP_VAR_RE = /var\(\s*--c-[a-z][a-z0-9-]*\s*,\s*((?:[^()]|\([^()]*\))+?)\s*\)/gi;

// CSS property → role suffix. Property name is what comes before the
// `:` in `<prop>: <value>`. We sniff backward from each color match
// to find the property it belongs to.
const PROPERTY_ROLE = new Map([
  ["background", "bg"],
  ["background-color", "bg"],
  ["background-image", "bg"],
  ["box-shadow", "glow"],
  ["filter", "glow"],
  ["border", "edge"],
  ["border-color", "edge"],
  ["border-top-color", "edge"],
  ["border-bottom-color", "edge"],
  ["border-left-color", "edge"],
  ["border-right-color", "edge"],
  ["color", "ink"],
  ["text-shadow", "ink-shadow"],
  ["outline", "edge"],
  ["outline-color", "edge"],
  ["stroke", "stroke"],
  ["fill", "fill"],
]);

/** Pull the rightmost meaningful element role from a selector.
 *  E.g. `.b-phoenix-v4 .feather .inner` → `feather` (last non-pseudo
 *  class that isn't the border-class prefix). Pseudo-elements
 *  `::before`/`::after` collapse to `aura` because that's what they
 *  decorate in this catalog. */
function elementRoleFromSelector(selector) {
  // Strip the border-class prefix `b-<key>` (first `.b-...` token).
  const cleaned = selector
    .replace(/\.[a-z0-9-]+/gi, (m) => (m.startsWith(".b-") ? "" : m));
  // Handle pseudo-elements.
  if (/::?before\b/i.test(selector)) return "aura";
  if (/::?after\b/i.test(selector)) return "shine";
  // Pull the rightmost class name.
  const classes = [...cleaned.matchAll(/\.([a-z][a-z0-9-]*)/gi)].map((m) => m[1].toLowerCase());
  if (classes.length === 0) return "ring";
  let last = classes[classes.length - 1];
  // Collapse per-element variants (lf1, lf2, ft3, em5) to the family.
  last = last.replace(/(\d+)$/, "");
  // Map common short forms to longer ones.
  const aliases = {
    pic: "pic",
    av: "ring",
    "leaf-field": "leaf",
    "petal-field": "petal",
    "petal-pile": "petal-pile",
    "leaf-pile": "leaf-pile",
    "feather-ring": "feather",
    "flame-ring": "flame",
    "flame-stack": "flame",
    "ember-field": "ember",
    "haze": "haze",
    "ray": "ray",
    "wing": "wing",
    "gem": "gem",
    "gem-ruby": "gem-ruby",
    "gem-sapph": "gem-sapph",
    "gem-emer": "gem-emer",
    "gem-amth": "gem-amth",
    "sparkle": "sparkle",
    "bolt": "bolt",
    "drip": "drip",
    "scale": "scale",
    "qdot": "qdot",
    "ref": "ref",
    "star": "star",
    "glyph": "glyph",
    "rune": "rune",
    "shard": "shard",
    "arc": "arc",
    "lf": "leaf",
    "ft": "feather",
    "em": "ember",
    "ry": "ray",
    "sp": "sparkle",
    "bz": "bolt",
    "wL": "wing",
    "wR": "wing",
    "sc": "scale",
    "p": "petal",
    "d": "drip",
    "s": "star",
    "g": "glyph",
    "ml": "moonlight",
  };
  const fallback = last.replace(/[^a-z-]/g, "") || "ring";
  return aliases[last] ?? fallback;
}

/** Find the CSS property that a color match belongs to. Walks
 *  backward from the color's index, looking for the most recent
 *  `<word>:` pattern within the rule body. */
function propertyRoleFor(ruleBody, colorIndex) {
  // Look backward for `name:`. Stop at `;` or `{` to keep scoped.
  let i = colorIndex;
  let scanLimit = 0;
  while (i > 0 && scanLimit < 400) {
    i--;
    scanLimit++;
    const c = ruleBody[i];
    if (c === ";" || c === "{") {
      i++;
      break;
    }
  }
  // Now i is just after the last `;` or `{` (or 0). Read forward
  // until `:` to capture the property name.
  const slice = ruleBody.slice(i, colorIndex);
  const m = slice.match(/([a-z-]+)\s*:/i);
  if (!m) return "color";
  const propName = m[1].toLowerCase();
  return PROPERTY_ROLE.get(propName) ?? "color";
}

/** Returns `[bodies, finishers]`, the rule bodies and the stuff
 *  between them (selectors + `{`). When we rebuild we interleave
 *  them. Bodies don't include the trailing `}`. */
function splitRules(css) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "{") {
      if (depth === 0) {
        parts.push({ type: "selector", text: css.slice(start, i) });
        start = i + 1;
      }
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        parts.push({ type: "body", text: css.slice(start, i) });
        start = i + 1;
      }
    }
  }
  if (start < css.length) parts.push({ type: "selector", text: css.slice(start) });
  return parts;
}

function port(styleCss) {
  // Round-trip strip: collapse any existing `var(--c-X, FALLBACK)`
  // back to FALLBACK so we re-derive names from a clean slate. Run
  // repeatedly until the string stops changing, borders that were
  // ported twice (once with semantic names, once by the generic
  // c1..cN pass) end up doubly-wrapped like
  // `var(--c-ring-main, var(--c-c1, #b71c1c))` and need two strip
  // iterations to fully unwrap. The fixed-point loop bounds itself
  // at 8 iterations as a guardrail; real-world max we'd see is 2.
  let cleaned = styleCss;
  for (let i = 0; i < 8; i++) {
    const next = cleaned.replace(STRIP_VAR_RE, (_, fallback) => fallback);
    if (next === cleaned) break;
    cleaned = next;
  }

  const parts = splitRules(cleaned);
  // First pass: discover unique colors and their preferred slot name.
  // Map color → { name, count } where count tracks dedup hits.
  const slotByColor = new Map();
  const counters = new Map(); // (element-property) → next index

  function discoverInRule(selector, body) {
    const elementRole = elementRoleFromSelector(selector);
    const findAll = [];
    for (const m of body.matchAll(HEX_RE)) findAll.push({ at: m.index, text: m[0] });
    for (const m of body.matchAll(RGBA_RE)) findAll.push({ at: m.index, text: m[0] });
    findAll.sort((a, b) => a.at - b.at);
    for (const c of findAll) {
      if (slotByColor.has(c.text)) continue; // dedup
      const propRole = propertyRoleFor(body, c.at);
      const baseName = `${elementRole}-${propRole}`;
      const next = (counters.get(baseName) ?? 0) + 1;
      counters.set(baseName, next);
      slotByColor.set(c.text, `${baseName}-${next}`);
    }
  }

  let curSelector = "";
  for (const p of parts) {
    if (p.type === "selector") curSelector = p.text;
    else discoverInRule(curSelector, p.text);
  }

  // Second pass: substitute. Build the output by walking parts
  // again and wrapping each color literal in `var(--c-NAME, ORIG)`.
  let out = "";
  curSelector = "";
  for (const p of parts) {
    if (p.type === "selector") {
      out += p.text + "{";
      curSelector = p.text;
      continue;
    }
    let body = p.text;
    const findAll = [];
    for (const m of body.matchAll(HEX_RE)) findAll.push({ at: m.index, text: m[0] });
    for (const m of body.matchAll(RGBA_RE)) findAll.push({ at: m.index, text: m[0] });
    findAll.sort((a, b) => b.at - a.at); // right-to-left so indices stay stable
    for (const c of findAll) {
      const slot = slotByColor.get(c.text);
      const repl = `var(--c-${slot}, ${c.text})`;
      body = body.slice(0, c.at) + repl + body.slice(c.at + c.text.length);
    }
    out += body + "}";
  }
  // splitRules' trailing selector (anything after the last `}`)
  // doesn't exist in our case since each rule ends in `}`, but guard
  // anyway.
  return out;
}

function escapeSqlString(s) {
  return s.replace(/'/g, "''");
}

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare("SELECT key, style_css FROM freeform_borders WHERE is_builtin = 1").all();
  db.close();

  console.log("-- Re-port all built-in borders to use SEMANTIC `--c-*` slot");
  console.log("-- names derived from the selector + property context that");
  console.log("-- wraps each color, replacing the prior pass's generic");
  console.log("-- `c1..cN` scheme. Format: `<element>-<property>-<N>`,");
  console.log("-- e.g. `feather-bg-1`, `ring-glow-2`, `ember-shadow-3`.");
  console.log("-- Identical colors across the row dedup to one slot.");
  console.log("--");
  console.log("-- Side effect: any existing user config_json that referenced");
  console.log("-- `c1..cN` slot names will no longer apply (those keys");
  console.log("-- are dropped server-side at write time and are now also");
  console.log("-- dropped at render time). Owners can re-pick from the");
  console.log("-- new (more descriptive) slot list.");
  console.log("");
  for (const r of rows) {
    const ported = port(r.style_css);
    if (ported === r.style_css) continue;
    console.log(`UPDATE \`freeform_borders\``);
    console.log(`SET \`style_css\` = '${escapeSqlString(ported)}',`);
    console.log(`    \`updated_at\` = unixepoch() * 1000`);
    console.log(`WHERE \`key\` = '${r.key}' AND \`is_builtin\` = 1;`);
    console.log("--> statement-breakpoint");
    console.log("");
  }
}

main();
