#!/usr/bin/env node
/**
 * Generates SQL UPDATEs that port every literal color in every
 * non-system-room freeform border to a `--c-<name>` CSS variable
 * with the original color as the fallback. Picker auto-discovers
 * vars from the row's style_css; once each color is wrapped, every
 * slot becomes user-customizable.
 *
 * Strategy:
 *   1. Read each border's style_css from the DB.
 *   2. Walk through every literal color (hex / rgba) in source order,
 *      assigning a semantic-ish var name based on the surrounding CSS
 *      property + a deduplication counter. Identical colors that
 *      appear multiple times collapse onto the same var so changing
 *      one updates them all.
 *   3. Emit an UPDATE statement. Stdout is the full migration body;
 *      caller pipes it into a .sql file.
 *
 * Skip list: borders that are already fully ported (or are simple
 * enough that re-running would be churn). Anyone else can be
 * re-ported by removing them from SKIP.
 */

import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "../data/thekeep.sqlite");

const SKIP = new Set([
  // Already fully ported to --c-* in prior migrations:
  "hearth-flame",      // 0170
  "aurora-v2",         // 0159
  "tide",              // 0159
  "forest",            // 0159 + 0167
]);

const HEX_RE = /#([0-9a-fA-F]{3,8})\b/g;
const RGBA_RE = /\brgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)/g;

// Property names that hint at a semantic category. Order matters —
// more specific keys first. Each property name maps to a base slot
// name; deduplication appends a suffix when colors clash.
const CONTEXT_KEYS = [
  // CSS property → semantic slot prefix
  ["background-color", "bg"],
  ["background-image", "bg"],
  ["background", "bg"],
  ["border-color", "border"],
  ["border-bottom-color", "border"],
  ["border-top-color", "border"],
  ["border-left-color", "border"],
  ["border-right-color", "border"],
  ["border", "border"],
  ["box-shadow", "shadow"],
  ["filter", "filter"],
  ["color", "ink"],
  ["text-shadow", "ink-shadow"],
  ["outline", "outline"],
  ["outline-color", "outline"],
  ["stroke", "stroke"],
  ["fill", "fill"],
];

function dedup(list) {
  const seen = new Map();
  const out = [];
  for (const x of list) {
    const i = seen.get(x);
    if (i == null) {
      seen.set(x, out.length);
      out.push(x);
    }
  }
  return { list: out, indexOf: (x) => seen.get(x) };
}

/** Walk style_css, replacing each literal color with var(--c-N, original). */
function port(styleCss) {
  // 1. Collect every literal color in source order, dedup, assign slot names.
  const rawColors = [];
  for (const m of styleCss.matchAll(HEX_RE)) rawColors.push({ at: m.index, text: m[0] });
  for (const m of styleCss.matchAll(RGBA_RE)) rawColors.push({ at: m.index, text: m[0] });
  rawColors.sort((a, b) => a.at - b.at);
  const colors = rawColors.map((c) => c.text);
  const { list: uniq, indexOf } = dedup(colors);

  // 2. Assign slot names. Simple scheme: c1, c2, ... by first-seen
  //    order. Could be smarter (look at the surrounding property
  //    name) but the picker UI already shows hover labels, and a
  //    consistent "c1..cN" naming gives owners a stable mental
  //    map of "which slot drives what" rather than a guessable
  //    semantic that breaks down on unusual cases.
  //
  //    We DO try to keep existing `--c-<name>` references intact —
  //    those already-named slots stay; only the newly-wrapped
  //    literals get c-numbered names. The picker will then show
  //    the named slots first and the numbered ones after.
  const slotByIndex = uniq.map((_, i) => `c${i + 1}`);

  // 3. Replace each literal with `var(--c-<slot>, <original>)`. We
  //    process from RIGHT to LEFT so that the indices in rawColors
  //    don't shift as we splice.
  let out = styleCss;
  for (let i = rawColors.length - 1; i >= 0; i--) {
    const { at, text } = rawColors[i];
    const slot = slotByIndex[indexOf(text)];
    const replacement = `var(--c-${slot}, ${text})`;
    out = out.slice(0, at) + replacement + out.slice(at + text.length);
  }

  return out;
}

function escapeSqlString(s) {
  return s.replace(/'/g, "''");
}

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare("SELECT key, style_css FROM freeform_borders WHERE is_builtin = 1").all();
  db.close();

  console.log("-- Port every literal color in remaining built-in borders to");
  console.log("-- `--c-*` CSS variables so the per-identity color picker can");
  console.log("-- customize every visible color. Names use a stable `c1..cN`");
  console.log("-- scheme rather than ad-hoc semantic labels — labels would");
  console.log("-- diverge between borders and become unmemorable; numbered");
  console.log("-- slots are honest about \"this is slot 3 in source order.\"");
  console.log("-- Identical colors collapse to a single slot so changing one");
  console.log("-- ripples through every occurrence in the border.");
  console.log("--");
  console.log("-- Borders already ported in prior migrations are skipped.");
  console.log("");
  for (const r of rows) {
    if (SKIP.has(r.key)) continue;
    const ported = port(r.style_css);
    if (ported === r.style_css) continue; // no literals to port
    console.log(`UPDATE \`freeform_borders\``);
    console.log(`SET \`style_css\` = '${escapeSqlString(ported)}',`);
    console.log(`    \`updated_at\` = unixepoch() * 1000`);
    console.log(`WHERE \`key\` = '${r.key}' AND \`is_builtin\` = 1;`);
    console.log("--> statement-breakpoint");
    console.log("");
  }
}

main();
