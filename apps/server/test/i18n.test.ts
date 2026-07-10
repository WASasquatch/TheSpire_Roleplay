import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { I18N_NAMESPACES, SUPPORTED_LOCALES } from "@thekeep/shared";
import { i18n, localeForUser, parseAcceptLanguage, tFor } from "../src/i18n.js";

/**
 * Phase-0 plumbing test for the server i18n instance (src/i18n.ts). Proves
 * the shared catalog resolves through the `@thekeep/shared` `./locales/*`
 * exports entry at runtime (importing the module already loaded every file
 * from disk), that every namespace is pre-registered, and that the three
 * helpers Phase 3 will lean on behave: recipient-locale lookup, en fallback,
 * and Accept-Language parsing for logged-out flows.
 */
describe("server i18n", () => {
  test("boots with every namespace pre-registered", () => {
    assert.equal(i18n.isInitialized, true);
    for (const ns of I18N_NAMESPACES) {
      assert.ok(i18n.options.ns?.includes(ns), `namespace ${ns} registered`);
    }
  });

  test("en catalog loaded from disk", () => {
    // Seed key shipped with the Phase-0 catalog bootstrap.
    assert.equal(tFor("en", "common:appName"), "The Spire");
    assert.equal(tFor("en", "errors:somethingWentWrong"), "Something went wrong");
  });

  test("tFor defaults to en for null/undefined/unknown locales", () => {
    assert.equal(tFor(null, "common:appName"), "The Spire");
    assert.equal(tFor(undefined, "common:appName"), "The Spire");
    assert.equal(tFor("zz", "common:appName"), "The Spire");
  });

  test("unfilled es keys fall back to the en value", () => {
    // The es catalog ships as empty skeletons until the translation phase;
    // lookups must fall through to en rather than echoing the key.
    assert.equal(tFor("es", "common:appName"), "The Spire");
  });

  test("localeForUser reads users.locale with en fallback", () => {
    assert.equal(localeForUser({ locale: "es" }), "es");
    assert.equal(localeForUser({ locale: null }), "en");
    assert.equal(localeForUser({ locale: "de" }), "en");
    assert.equal(localeForUser(null), "en");
    assert.equal(localeForUser(undefined), "en");
  });

  test("parseAcceptLanguage picks the best supported match", () => {
    assert.equal(parseAcceptLanguage("es-MX,es;q=0.9,en;q=0.8"), "es");
    assert.equal(parseAcceptLanguage("fr-FR,fr;q=0.9"), "en");
    assert.equal(parseAcceptLanguage("fr;q=0.9,es;q=0.8"), "es");
    // q-weights outrank listing order.
    assert.equal(parseAcceptLanguage("en;q=0.5,es;q=0.9"), "es");
    assert.equal(parseAcceptLanguage(""), "en");
    assert.equal(parseAcceptLanguage(null), "en");
    assert.equal(parseAcceptLanguage(undefined), "en");
    assert.equal(parseAcceptLanguage("*"), "en");
  });

  test("SUPPORTED_LOCALES is the en+es wave", () => {
    assert.deepEqual([...SUPPORTED_LOCALES], ["en", "es"]);
  });
});
