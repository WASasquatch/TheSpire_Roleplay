import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  maskForMinors,
  rebuildMinorFilter,
  type MinorFilterSettings,
} from "../src/realtime/minorLanguageFilter.js";
import { ensureSiteSettings, updateSettings } from "../src/settings.js";
import { createUser, makeTestDb } from "./helpers/harness.js";

/**
 * The minor language filter decides what under-18 accounts read across every
 * fan-out surface, so its matching contract is covered by tests rather than
 * trusted to eyeball QA:
 *
 *   - null means CLEAN — the caller serves the original object untouched, so
 *     a false "null" leaks profanity to minors and a false "masked" garbles
 *     innocent chat. Both directions are asserted.
 *   - The bypass arsenal from plan_ext.md §J (leetspeak, spacing, repeated
 *     characters, Unicode confusables) must keep matching: obscenity ships
 *     the spacing transformer DISABLED and the module deliberately restores
 *     it, so a regression here would be silent.
 *   - Admin overlay terms + never-censor words are the owner's only tuning
 *     levers; their semantics (literal, case-insensitive, same bypass
 *     pipeline; whitelist wins) are locked down here.
 *
 * Unit cases drive the module singleton directly via `rebuildMinorFilter`;
 * every test seeds its own config first, so ordering never leaks state. The
 * final describe block exercises the real settings chain (in-memory DB →
 * ensureSiteSettings/updateSettings → rebuild hook).
 */

function cfg(overrides: Partial<MinorFilterSettings> = {}): MinorFilterSettings {
  return {
    minorFilterEnabled: true,
    minorFilterTerms: [],
    minorFilterAllow: [],
    ...overrides,
  };
}

describe("maskForMinors: base English list", () => {
  beforeEach(() => rebuildMinorFilter(cfg()));

  test("masks a base-list word, keeping the first character", () => {
    assert.equal(maskForMinors("shit"), "s***");
  });

  test("masks inside a sentence and leaves the rest intact", () => {
    assert.equal(maskForMinors("well shit, that hurt"), "well s***, that hurt");
  });

  test("returns null for clean text (caller serves the original untouched)", () => {
    assert.equal(maskForMinors("Hello there, how are you today?"), null);
    assert.equal(maskForMinors("a perfectly nice sentence"), null);
  });

  test("returns null for the empty string", () => {
    assert.equal(maskForMinors(""), null);
  });

  test("is case-insensitive", () => {
    const masked = maskForMinors("SHIT");
    assert.notEqual(masked, null);
    assert.ok(masked!.includes("***"));
  });
});

describe("maskForMinors: bypass arsenal (plan_ext.md §J)", () => {
  beforeEach(() => rebuildMinorFilter(cfg()));

  test("leetspeak: sh1t", () => {
    assert.equal(maskForMinors("sh1t"), "s***");
  });

  test("spaced letters: f u c k", () => {
    // obscenity 0.4.x ships skip-non-alphabetic commented OUT of its English
    // preset; the module restores it. This is the regression canary.
    const masked = maskForMinors("f u c k");
    assert.notEqual(masked, null, "spaced-out profanity must still match");
    assert.ok(masked!.startsWith("f"), "keep-first-character strategy");
    assert.ok(masked!.includes("*"));
    assert.ok(!/fuck/i.test(masked!));
  });

  test("punctuation-separated letters: f.u.c.k / f-u-c-k", () => {
    for (const probe of ["f.u.c.k", "f-u-c-k"]) {
      const masked = maskForMinors(probe);
      assert.notEqual(masked, null, `${probe} must still match`);
      assert.ok(masked!.includes("*"));
    }
  });

  test("more spaced-out words: s h i t / b i t c h", () => {
    assert.notEqual(maskForMinors("s h i t"), null);
    assert.notEqual(maskForMinors("b i t c h"), null);
  });

  test("repeated characters: fuuuck / shiiit", () => {
    assert.equal(maskForMinors("fuuuck"), "f***");
    assert.equal(maskForMinors("shiiit"), "s***");
  });

  test("unicode confusables: fυck (Greek upsilon)", () => {
    const masked = maskForMinors("fυck");
    assert.notEqual(masked, null);
    assert.ok(masked!.includes("*"));
  });

  test("spacing does not create cross-word false positives", () => {
    // The reason upstream disabled the spacing transformer; the dataset's
    // word-boundary patterns keep these clean and this must stay true.
    assert.equal(maskForMinors("push it to the repo"), null);
    assert.equal(maskForMinors("the grass hit my leg"), null);
    assert.equal(maskForMinors("his expertise is vast"), null);
    assert.equal(maskForMinors("working the night shift"), null);
  });

  test("spacing does not defeat the preset whitelist mid-sentence", () => {
    // Regression net for the spaced-pass union: with separators skipped, a
    // hit inside "analyst" used to map back to a span absorbing the
    // preceding space plus one letter ("e anal"), which escaped the
    // whitelisted "analyst" span and masked everyday words mid-sentence.
    // The union now requires a spaced-pass ADDITION to span two or more
    // separators (the genuine "f u c k" signature), so these stay clean.
    assert.equal(maskForMinors("a fine analyst"), null);
    assert.equal(maskForMinors("the analog device"), null);
    assert.equal(maskForMinors("old analogue synth"), null);
    assert.equal(maskForMinors("she moaned analytically"), null);
    assert.equal(maskForMinors("the canal and the analysis"), null);
  });

  test("built-in whitelist: Scunthorpe-class words pass", () => {
    assert.equal(maskForMinors("I live in Scunthorpe"), null);
    assert.equal(maskForMinors("the class is full"), null);
    assert.equal(maskForMinors("an assassin appears"), null);
  });
});

describe("maskForMinors: built-in never-censor seed", () => {
  beforeEach(() => rebuildMinorFilter(cfg()));

  test("everyday Spanish words containing a collapsed English term stay visible", () => {
    // The preset's whitelist only covers English forms ("analysis"), so
    // these masked before the BUILT_IN_ALLOW seed. A preset upgrade must
    // not regress them — es ships at 100% UI coverage.
    assert.equal(maskForMinors("analizar"), null);
    assert.equal(maskForMinors("análisis"), null);
    assert.equal(maskForMinors("anales"), null);
    assert.equal(maskForMinors("vamos con el análisis"), null);
  });

  test("English RP-register casualties stay visible", () => {
    // "annals": "nn" collapses onto "anal"; "shiitake" collapses over
    // "shit". Both are in the built-in seed, no admin action needed.
    assert.equal(maskForMinors("the annals of history"), null);
    assert.equal(maskForMinors("shiitake mushrooms"), null);
  });

  test("Penistone (Yorkshire town / surname) stays visible", () => {
    // The upstream whitelist covers "Scunthorpe" itself but not this
    // neighbor; it sits in the built-in seed so RP place-name vocabulary
    // survives out of the box.
    assert.equal(maskForMinors("a trip to Penistone"), null);
    assert.equal(maskForMinors("penistone"), null);
  });

  test("the seed does not blunt real profanity nearby", () => {
    assert.equal(maskForMinors("shit happens"), "s*** happens");
    assert.notEqual(maskForMinors("análisis de shit"), null);
  });

  test("Spanish profanity is the ADMIN overlay's job (preset is English-only)", () => {
    // Document the lever rather than the gap: the base list does not know
    // Spanish, so the owner adds terms in Admin → Settings.
    rebuildMinorFilter(cfg({ minorFilterTerms: ["mierda"] }));
    assert.equal(maskForMinors("mierda"), "m*****");
    assert.notEqual(maskForMinors("m i e r d a"), null, "overlay rides the bypass pipeline");
  });
});

describe("maskForMinors: admin overlay terms", () => {
  test("an added word is masked with the d*** shape", () => {
    // "damn" is NOT in obscenity's English list, so this hit can only come
    // from the overlay.
    rebuildMinorFilter(cfg({ minorFilterTerms: ["damn"] }));
    assert.equal(maskForMinors("damn"), "d***");
    assert.equal(maskForMinors("Damn it"), "D*** it");
  });

  test("overlay terms ride the same bypass pipeline (leet + spacing)", () => {
    rebuildMinorFilter(cfg({ minorFilterTerms: ["damn"] }));
    assert.notEqual(maskForMinors("d4mn"), null);
    assert.notEqual(maskForMinors("d a m n"), null);
  });

  test("added words with doubled letters match their own spelling (collapse parity)", () => {
    // Both matcher pipelines collapse duplicate letters in the INPUT
    // ("dammit" reaches the matcher as "damit"), so a verbatim pattern
    // with a doubled letter could never match anything. compileMatchers
    // registers the collapsed spelling instead, which covers both forms.
    // (Star COUNT over a collapsed span is an obscenity span-mapping
    // internal — "dammit" masks as "d****" — so assert shape, not width.)
    rebuildMinorFilter(cfg({ minorFilterTerms: ["dammit", "perra", "upper"] }));
    for (const word of ["dammit", "perra", "upper"]) {
      const masked = maskForMinors(word);
      assert.notEqual(masked, null, `added "${word}" must mask its own spelling`);
      assert.ok(masked!.startsWith(word[0]!), "keep-first-character strategy");
      assert.ok(masked!.includes("**"), "the rest is starred");
      assert.ok(!masked!.includes(word.slice(1)), `"${word}" must not leak through`);
    }
    // The collapsed misspellings live in the same transformed space and
    // keep matching too.
    assert.notEqual(maskForMinors("damit"), null);
    assert.notEqual(maskForMinors("pera"), null);
  });

  test("collapse thresholds: b/e/o/l/s/g keep their doubles, so those words match exactly", () => {
    // The preset keeps runs of b/e/o/l/s/g at TWO ("ball" stays "ball"),
    // so those terms must NOT be over-collapsed to "bal" (which would
    // shift the masked span).
    rebuildMinorFilter(cfg({ minorFilterTerms: ["ball"] }));
    assert.equal(maskForMinors("ball"), "b***");
  });

  test("overlay entries match literally: pattern metacharacters cannot break the rebuild", () => {
    rebuildMinorFilter(cfg({ minorFilterTerms: ["w[rd?", "damn"] }));
    // The odd entry matches itself, escaped, not as pattern syntax...
    assert.notEqual(maskForMinors("w[rd?"), null);
    // ...and the rest of the overlay still compiled and works.
    assert.equal(maskForMinors("damn"), "d***");
  });

  test("without the overlay the same word is clean", () => {
    rebuildMinorFilter(cfg());
    assert.equal(maskForMinors("damn"), null);
  });
});

describe("maskForMinors: admin never-censor list", () => {
  test("frees a Scunthorpe-class false positive of the base list", () => {
    // "analizando" (a conjugation OUTSIDE the built-in seed, which only
    // carries the infinitive "analizar") collapses over "anal" and IS
    // masked by the base list — exactly the false positive the admin
    // allowlist exists for.
    rebuildMinorFilter(cfg());
    assert.equal(maskForMinors("analizando"), "a***izando");
    rebuildMinorFilter(cfg({ minorFilterAllow: ["analizando"] }));
    assert.equal(maskForMinors("analizando"), null);
    assert.equal(maskForMinors("ANALIZANDO"), null, "allowlist is case-insensitive");
  });

  test("does not blunt the filter outside the allowed span", () => {
    rebuildMinorFilter(cfg({ minorFilterAllow: ["analizando"] }));
    assert.equal(maskForMinors("shit happens"), "s*** happens");
  });

  test("wins over an overlay term it contains", () => {
    rebuildMinorFilter(cfg({ minorFilterTerms: ["damn"], minorFilterAllow: ["damnation"] }));
    assert.equal(maskForMinors("pure damnation"), null);
    assert.equal(maskForMinors("damn"), "d***", "the bare term itself stays masked");
  });
});

describe("maskForMinors: master switch", () => {
  test("disabled: always null, even for the dirtiest input", () => {
    rebuildMinorFilter(cfg({ minorFilterEnabled: false, minorFilterTerms: ["damn"] }));
    assert.equal(maskForMinors("fuck"), null);
    assert.equal(maskForMinors("sh1t"), null);
    assert.equal(maskForMinors("damn"), null);
  });

  test("re-enabling via rebuild restores masking", () => {
    rebuildMinorFilter(cfg({ minorFilterEnabled: false }));
    assert.equal(maskForMinors("shit"), null);
    rebuildMinorFilter(cfg());
    assert.equal(maskForMinors("shit"), "s***");
  });
});

describe("settings chain: rebuild hook", () => {
  test("ensureSiteSettings seeds the filter with the migration defaults (ON, no overlay)", async () => {
    // Poison the module state first so the assertion proves ensureSiteSettings
    // actually rebuilt from the DB row rather than riding leftovers.
    rebuildMinorFilter(cfg({ minorFilterEnabled: false }));
    const { db } = makeTestDb();
    const s = await ensureSiteSettings(db);
    assert.equal(s.minorFilterEnabled, true, "default ON is deliberate (protective-by-default)");
    assert.deepEqual(s.minorFilterTerms, []);
    assert.deepEqual(s.minorFilterAllow, []);
    assert.equal(maskForMinors("shit"), "s***");
    assert.equal(maskForMinors("damn"), null);
  });

  test("updateSettings takes effect on the very next mask call", async () => {
    const { db } = makeTestDb();
    await ensureSiteSettings(db);
    const admin = await createUser(db, { role: "masteradmin" });

    // Flip the master switch off.
    let s = await updateSettings(db, { minorFilterEnabled: false }, admin.id);
    assert.equal(s.minorFilterEnabled, false);
    assert.equal(maskForMinors("fuck"), null);

    // Back on with an overlay term + an allowlisted false positive (one
    // OUTSIDE the built-in seed, so the pass proves the stored list is
    // live). The stored lists come back trimmed with empties dropped.
    s = await updateSettings(
      db,
      {
        minorFilterEnabled: true,
        minorFilterTerms: [" damn ", "", "damn"],
        minorFilterAllow: ["analizando"],
      },
      admin.id,
    );
    assert.deepEqual(s.minorFilterTerms, ["damn"]);
    assert.deepEqual(s.minorFilterAllow, ["analizando"]);
    assert.equal(maskForMinors("damn"), "d***");
    assert.equal(maskForMinors("analizando"), null);
    assert.equal(maskForMinors("shit"), "s***");

    // Clearing the overlay un-masks the added word again.
    s = await updateSettings(db, { minorFilterTerms: [] }, admin.id);
    assert.deepEqual(s.minorFilterTerms, []);
    assert.equal(maskForMinors("damn"), null);
  });
});
