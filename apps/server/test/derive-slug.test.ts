import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { deriveSlug } from "@thekeep/shared";

/**
 * Characterization test for the consolidated `deriveSlug` helper
 * (packages/shared/src/slug.ts), extracted byte-identically from four copies:
 * the canonical `world.ts` slug + its `story.ts` twin (dash sep, 60 cap), the
 * server inline copy (dash sep, 40 cap), and the forum inline copy (`_` sep,
 * 40 cap). Pins the exact output each original copy produced so the move stays
 * behavior-preserving. The edge-trim regex is built from `sep`, so the forum
 * variant must trim `_`, not `-`.
 */
describe("deriveSlug", () => {
  // Default: dash separator, 60-char cap (world + story copies).
  const dashDefault: Array<{ label: string; input: string; expected: string }> = [
    { label: "empty", input: "", expected: "" },
    { label: "plain word", input: "hello", expected: "hello" },
    { label: "uppercased", input: "HELLO World", expected: "hello-world" },
    { label: "spaces collapse", input: "a   b", expected: "a-b" },
    { label: "punctuation → dash", input: "The Spire: A Tale!", expected: "the-spire-a-tale" },
    { label: "trim leading/trailing", input: "  --Hello--  ", expected: "hello" },
    { label: "only symbols → empty", input: "!!!@@@", expected: "" },
    { label: "unicode dropped", input: "café", expected: "caf" },
    { label: "digits kept", input: "room 42", expected: "room-42" },
    { label: "underscore is non-alnum → dash", input: "a_b", expected: "a-b" },
    {
      label: "60-char cap",
      input: "a".repeat(80),
      expected: "a".repeat(60),
    },
  ];
  for (const c of dashDefault) {
    test(`default ${c.label}`, () => {
      assert.equal(deriveSlug(c.input), c.expected);
      // Explicit defaults must equal the implicit ones.
      assert.equal(deriveSlug(c.input, { sep: "-", max: 60 }), c.expected);
    });
  }

  // Server variant: dash separator, 40-char cap.
  const dash40: Array<{ label: string; input: string; expected: string }> = [
    { label: "short unchanged", input: "My Server", expected: "my-server" },
    { label: "40-char cap", input: "a".repeat(50), expected: "a".repeat(40) },
    { label: "trim dashes", input: "--x--", expected: "x" },
  ];
  for (const c of dash40) {
    test(`sep=- max=40 ${c.label}`, () => {
      assert.equal(deriveSlug(c.input, { max: 40 }), c.expected);
    });
  }

  // Forum variant: underscore separator, 40-char cap; edge-trim on `_`.
  const underscore40: Array<{ label: string; input: string; expected: string }> = [
    { label: "spaces → underscore", input: "My Forum", expected: "my_forum" },
    { label: "punctuation → underscore", input: "Tales & Lore!", expected: "tales_lore" },
    { label: "trim underscores", input: "  __hello__  ", expected: "hello" },
    { label: "40-char cap", input: "b".repeat(50), expected: "b".repeat(40) },
    { label: "dash is non-alnum → underscore", input: "a-b", expected: "a_b" },
  ];
  for (const c of underscore40) {
    test(`sep=_ max=40 ${c.label}`, () => {
      assert.equal(deriveSlug(c.input, { sep: "_", max: 40 }), c.expected);
    });
  }
});
