import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { escapeRegExp } from "@thekeep/shared";

/**
 * Characterization test for the consolidated `escapeRegExp` helper
 * (packages/shared/src/regex.ts), extracted byte-identically from the private
 * copy in apps/server/src/realtime/automod.ts. Pins the exact output the
 * inline `s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")` copy produced across a
 * table of edge cases so the move stays behavior-preserving, and verifies the
 * escaped string round-trips as a literal match in a real RegExp.
 */
describe("escapeRegExp", () => {
  const cases: Array<{ label: string; input: string; expected: string }> = [
    { label: "empty", input: "", expected: "" },
    { label: "plain word", input: "hello", expected: "hello" },
    { label: "unicode letters/digits untouched", input: "café123", expected: "café123" },
    { label: "dot", input: "a.b", expected: "a\\.b" },
    { label: "star", input: "a*b", expected: "a\\*b" },
    { label: "plus", input: "a+b", expected: "a\\+b" },
    { label: "question", input: "a?b", expected: "a\\?b" },
    { label: "caret", input: "^abc", expected: "\\^abc" },
    { label: "dollar", input: "abc$", expected: "abc\\$" },
    { label: "braces", input: "a{2}b", expected: "a\\{2\\}b" },
    { label: "parens", input: "(x)", expected: "\\(x\\)" },
    { label: "pipe", input: "a|b", expected: "a\\|b" },
    { label: "brackets", input: "[a-z]", expected: "\\[a-z\\]" },
    { label: "backslash", input: "a\\b", expected: "a\\\\b" },
    {
      label: "all metachars together",
      input: ".*+?^${}()|[]\\",
      expected: "\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\",
    },
    { label: "og:title style key", input: "og:title", expected: "og:title" },
    { label: "twitter:card style key", input: "twitter:card", expected: "twitter:card" },
  ];

  for (const c of cases) {
    test(c.label, () => {
      const got = escapeRegExp(c.input);
      assert.equal(got, c.expected, `escaped output for ${c.label}`);
      // The escaped source matches the original literal exactly.
      const rx = new RegExp(`^${got}$`);
      assert.ok(rx.test(c.input), `round-trips as literal for ${c.label}`);
    });
  }
});
