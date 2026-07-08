import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CHAR_NAME_RX, canonicalizeNameForLookup, normalizeCharName } from "@thekeep/shared";

/**
 * Characterization test for the consolidated character-name helpers
 * (packages/shared/src/names.ts), extracted byte-identically from the two
 * server creation paths: `/char create` (commands/builtins/char.ts) and the
 * `POST /characters` route (routes/characters.ts). Pins the exact accept/
 * reject and trim behavior the originals produced. NBSP (U+00A0) is allowed
 * and interior NBSP is PRESERVED (the Alt+0160 parser-safe-name rule); an
 * ASCII space is still accepted for backward compatibility.
 */
describe("CHAR_NAME_RX", () => {
  const cases: Array<{ label: string; input: string; valid: boolean }> = [
    { label: "plain letters", input: "Alice", valid: true },
    { label: "ascii space accepted", input: "The Watcher", valid: true },
    { label: "nbsp accepted", input: "The Watcher", valid: true },
    { label: "apostrophe + hyphen", input: "O\'Brien-Smith", valid: true },
    { label: "digits + underscore", input: "Agent_007", valid: true },
    { label: "unicode letter", input: "Renée", valid: true },
    { label: "single char", input: "x", valid: true },
    { label: "40 chars", input: "a".repeat(40), valid: true },
    { label: "empty rejected", input: "", valid: false },
    { label: "41 chars rejected", input: "a".repeat(41), valid: false },
    { label: "punctuation rejected", input: "hi!", valid: false },
    { label: "at-sign rejected", input: "a@b", valid: false },
    { label: "tab rejected", input: "a\tb", valid: false },
    { label: "newline rejected", input: "a\nb", valid: false },
  ];
  for (const c of cases) {
    test(c.label, () => {
      assert.equal(CHAR_NAME_RX.test(c.input), c.valid);
    });
  }
});

describe("normalizeCharName", () => {
  const cases: Array<{ label: string; input: string; expected: string }> = [
    { label: "no change", input: "Alice", expected: "Alice" },
    { label: "trim ascii edges", input: "  hi  ", expected: "hi" },
    { label: "trim nbsp edges", input: " hi ", expected: "hi" },
    { label: "preserve interior nbsp", input: "a b", expected: "a b" },
    { label: "preserve interior ascii space", input: "a b", expected: "a b" },
    { label: "empty stays empty", input: "", expected: "" },
    { label: "all whitespace to empty", input: "   ", expected: "" },
  ];
  for (const c of cases) {
    test(c.label, () => {
      assert.equal(normalizeCharName(c.input), c.expected);
    });
  }
});

/**
 * Characterization test for `canonicalizeNameForLookup`, consolidated from
 * the server name-lookup helper (apps/server/src/lib/nameLookup.ts) and its
 * two client render-path twins (apps/web/src/lib/markdown.tsx and
 * components/MessageList.tsx). Pins the exact fold: lowercase + NBSP
 * (U+00A0) -> ASCII space, with NO trim. Fold order differed across the
 * originals (lowercase-then-replace vs replace-then-lowercase) but is
 * result-identical, so these outputs must match every former copy exactly.
 * Only U+00A0 folds; other space-like codepoints are left untouched.
 */
describe("canonicalizeNameForLookup", () => {
  const cases: Array<{ label: string; input: string; expected: string }> = [
    { label: "lowercases", input: "Alice", expected: "alice" },
    { label: "fold nbsp to ascii space", input: "The Watcher", expected: "the watcher" },
    { label: "ascii space unchanged", input: "The Watcher", expected: "the watcher" },
    { label: "nbsp and case together", input: "JOHN DOE", expected: "john doe" },
    { label: "multiple nbsp folded", input: "a b c", expected: "a b c" },
    { label: "no trim leading nbsp", input: " hi", expected: " hi" },
    { label: "no trim trailing space", input: "hi ", expected: "hi " },
    { label: "empty stays empty", input: "", expected: "" },
    { label: "thin space NOT folded", input: "a b", expected: "a b" },
    { label: "zwsp NOT folded", input: "a​b", expected: "a​b" },
    { label: "tab NOT folded", input: "a\tb", expected: "a\tb" },
  ];
  for (const c of cases) {
    test(c.label, () => {
      assert.equal(canonicalizeNameForLookup(c.input), c.expected);
    });
  }
});