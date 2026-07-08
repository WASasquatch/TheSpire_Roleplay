import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { slugRx } from "@thekeep/shared";

/**
 * Characterization test for the consolidated `slugRx(max)` helper
 * (packages/shared/src/slug.ts), extracted byte-identically from six inline
 * copies of the "tight" slug format-validation regex:
 *   - max 60 (Shape A): routes/worlds.ts, routes/stories.ts, commands/builtins/room.ts
 *   - max 42 (Shape B): routes/emoticons.ts, servers/emoticons.ts, EmoticonSubmissionModal.tsx
 *
 * Pins the exact accept/reject decisions of the original literals
 *   /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/   (max 60)
 *   /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/   (max 42)
 * so the move stays behavior-preserving. The divergent Shape C
 * (`[a-z0-9_-]{1,32}`) is intentionally NOT covered by this helper.
 */
describe("slugRx", () => {
  test("built regex matches the original literals exactly", () => {
    assert.equal(slugRx(60).source, /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.source);
    assert.equal(slugRx(42).source, /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/.source);
    // No flags on either the literal or the built regex.
    assert.equal(slugRx(60).flags, "");
    assert.equal(slugRx(42).flags, "");
  });

  const cases: Array<{ label: string; input: string; accepts60: boolean; accepts42: boolean }> = [
    { label: "empty", input: "", accepts60: false, accepts42: false },
    { label: "single alnum", input: "a", accepts60: true, accepts42: true },
    { label: "single digit", input: "7", accepts60: true, accepts42: true },
    { label: "plain word", input: "hello", accepts60: true, accepts42: true },
    { label: "internal hyphen", input: "a-b", accepts60: true, accepts42: true },
    { label: "digits + hyphen", input: "room-42", accepts60: true, accepts42: true },
    { label: "leading hyphen", input: "-abc", accepts60: false, accepts42: false },
    { label: "trailing hyphen", input: "abc-", accepts60: false, accepts42: false },
    { label: "uppercase rejected", input: "Abc", accepts60: false, accepts42: false },
    { label: "underscore rejected", input: "a_b", accepts60: false, accepts42: false },
    { label: "space rejected", input: "a b", accepts60: false, accepts42: false },
    { label: "double hyphen internal ok", input: "a--b", accepts60: true, accepts42: true },
    { label: "42 chars", input: "a".repeat(42), accepts60: true, accepts42: true },
    { label: "43 chars", input: "a".repeat(43), accepts60: true, accepts42: false },
    { label: "60 chars", input: "a".repeat(60), accepts60: true, accepts42: false },
    { label: "61 chars", input: "a".repeat(61), accepts60: false, accepts42: false },
  ];

  for (const c of cases) {
    test(c.label, () => {
      assert.equal(slugRx(60).test(c.input), c.accepts60, `slugRx(60) on ${JSON.stringify(c.input)}`);
      assert.equal(slugRx(42).test(c.input), c.accepts42, `slugRx(42) on ${JSON.stringify(c.input)}`);
    });
  }
});
