import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isHiddenIncognitoIdentity } from "../src/realtime/broadcast.js";

/**
 * Characterization test for the canonical per-IDENTITY incognito visibility
 * predicate (apps/server/src/realtime/broadcast.ts, finding M4). Six inline
 * copies of `who.incognitoMode && (charId ?? null) === (who.incognitoCharacterId ?? null)`
 * were replaced with calls to this helper; these cases pin the exact truth
 * table (incognito off → never hidden; hidden ONLY when the passed identity is
 * the exact one the account went incognito AS; null/undefined normalized to
 * null and treated as the OOC/master identity).
 */

describe("isHiddenIncognitoIdentity", () => {
  const cases: Array<{
    label: string;
    who: { incognitoMode: boolean; incognitoCharacterId: string | null };
    characterId: string | null;
    expected: boolean;
  }> = [
    {
      label: "not incognito, matching char → visible",
      who: { incognitoMode: false, incognitoCharacterId: "c1" },
      characterId: "c1",
      expected: false,
    },
    {
      label: "not incognito, OOC → visible",
      who: { incognitoMode: false, incognitoCharacterId: null },
      characterId: null,
      expected: false,
    },
    {
      label: "incognito as c1, voicing c1 → hidden",
      who: { incognitoMode: true, incognitoCharacterId: "c1" },
      characterId: "c1",
      expected: true,
    },
    {
      label: "incognito as c1, voicing c2 → visible (different identity)",
      who: { incognitoMode: true, incognitoCharacterId: "c1" },
      characterId: "c2",
      expected: false,
    },
    {
      label: "incognito as c1, voicing OOC (null) → visible",
      who: { incognitoMode: true, incognitoCharacterId: "c1" },
      characterId: null,
      expected: false,
    },
    {
      label: "incognito as OOC (null), voicing OOC (null) → hidden",
      who: { incognitoMode: true, incognitoCharacterId: null },
      characterId: null,
      expected: true,
    },
    {
      label: "incognito as OOC (null), voicing c1 → visible",
      who: { incognitoMode: true, incognitoCharacterId: null },
      characterId: "c1",
      expected: false,
    },
  ];

  for (const c of cases) {
    test(c.label, () => {
      assert.equal(isHiddenIncognitoIdentity(c.who, c.characterId), c.expected);
    });
  }

  test("undefined char-id normalizes to null (OOC) via ?? null", () => {
    // Sites pass raw char-id sources; the helper's `?? null` makes undefined
    // behave identically to explicit null.
    const who = { incognitoMode: true, incognitoCharacterId: null };
    assert.equal(isHiddenIncognitoIdentity(who, undefined as unknown as string | null), true);
  });
});
