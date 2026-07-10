import "./helpers/env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  LANGUAGE_TAGS,
  LANGUAGE_TAG_MAX,
  languageTagByKey,
  parseTagList,
  sanitizeLanguageTags,
  serializeTagList,
} from "@thekeep/shared";

/**
 * Profile language tags (migration 0342): the predefined catalog the
 * profile editor picks from and the sanitizer the PUT /me/profile route
 * runs. The column stores a comma list via serializeTagList/parseTagList,
 * so every key must survive that round-trip (i.e. stay lowercase).
 */

describe("language tag catalog", () => {
  test("keys are unique, lowercase, and survive the tag-list storage round-trip", () => {
    const keys = LANGUAGE_TAGS.map((t) => t.key);
    assert.equal(new Set(keys).size, keys.length, "duplicate keys");
    for (const t of LANGUAGE_TAGS) {
      assert.equal(t.key, t.key.toLowerCase(), `key not lowercase: ${t.key}`);
      assert.ok(t.label.trim().length > 0, `empty label for ${t.key}`);
      assert.ok(t.short.trim().length > 0, `empty short for ${t.key}`);
      assert.ok(t.flag.trim().length > 0, `empty flag for ${t.key}`);
      assert.equal(languageTagByKey.get(t.key), t);
    }
    // The comma-list column storage must reproduce the keys exactly.
    assert.deepEqual(parseTagList(serializeTagList(keys)), keys);
    // Compact codes are what mobile chips show — collisions would make
    // two different tags indistinguishable there.
    const shorts = LANGUAGE_TAGS.map((t) => t.short);
    assert.equal(new Set(shorts).size, shorts.length, "duplicate short codes");
  });

  test("ships the requested variants: English regionals + both Spanish forms", () => {
    for (const key of ["en-us", "en-gb", "en-au", "en-ca", "es-es", "es-419"]) {
      assert.ok(languageTagByKey.has(key), `missing catalog entry: ${key}`);
    }
    assert.ok(LANGUAGE_TAG_MAX >= 2 && LANGUAGE_TAG_MAX <= 10);
  });
});

describe("sanitizeLanguageTags", () => {
  test("whitelists against the catalog, normalizes, dedupes, and caps", () => {
    // Unknown keys drop silently; casing + padding normalize; first
    // occurrence wins and order is preserved (it's the display order).
    assert.deepEqual(
      sanitizeLanguageTags([" EN-GB ", "klingon", "es-419", "en-gb", "ja"]),
      ["en-gb", "es-419", "ja"],
    );
    // Cap at LANGUAGE_TAG_MAX even when more valid keys are sent.
    const many = LANGUAGE_TAGS.map((t) => t.key);
    assert.equal(sanitizeLanguageTags(many).length, LANGUAGE_TAG_MAX);
    assert.deepEqual(sanitizeLanguageTags(many), many.slice(0, LANGUAGE_TAG_MAX));
  });

  test("tolerates garbage payloads", () => {
    assert.deepEqual(sanitizeLanguageTags(undefined), []);
    assert.deepEqual(sanitizeLanguageTags("en-gb"), []);
    assert.deepEqual(sanitizeLanguageTags({ 0: "en-gb" }), []);
    assert.deepEqual(sanitizeLanguageTags([42, null, {}, "", "  ", "en-us"]), ["en-us"]);
  });
});
