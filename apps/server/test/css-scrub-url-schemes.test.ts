import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  scrubCssUrlSchemes,
  isDangerousCssUrl,
  canonicalizeUrlForSchemeCheck,
  DANGEROUS_CSS_URL_SCHEMES,
} from "@thekeep/shared";
import { sanitizeBio } from "../src/auth/html.js";

/**
 * Pins the CORRECTED behavior of the consolidated `url()`-scheme scrubber
 * (finding I3 — packages/shared/src/cssSanitize.ts). Three divergent copies
 * (server style-attr scrub, server <style>-block scrub, client render-time
 * scope scrub) are now one hardened function.
 *
 * Two things are asserted:
 *   1. NORMAL PATH UNCHANGED — legitimate url()s (https, http, protocol-
 *      relative, root-relative /uploads, relative) survive byte-for-byte.
 *   2. EDGE CASE CORRECTED — dangerous schemes (javascript/vbscript/data/
 *      file) are blocked UNIFORMLY, including whitespace/control-char and
 *      HTML-entity obfuscations that NONE of the old copies caught, and the
 *      client copy's two prior gaps (no `file:` block, flat non-nested-paren
 *      matcher) are closed.
 */
describe("scrubCssUrlSchemes — legitimate url()s are preserved (normal path)", () => {
  const allow = [
    "background: url(https://cdn.example.com/bg.png)",
    "background: url(http://cdn.example.com/bg.png)",
    "background: url('https://cdn.example.com/bg.png')",
    'background: url("https://cdn.example.com/bg.png")',
    // protocol-relative
    "background: url(//cdn.example.com/bg.png)",
    // root-relative upload (the common profile-background/border case)
    "border-image: url(/uploads/borders/frame-42.png)",
    "background: url('/uploads/backgrounds/night.jpg')",
    // relative path
    "background: url(img/border.png)",
    // no url() at all
    "color: #ff0; font-weight: bold",
    // a value that merely CONTAINS a scheme-like word but not as a url scheme
    "background: url(/uploads/javascript-tutorial.png)",
  ];
  for (const css of allow) {
    test(`preserves: ${css}`, () => {
      assert.equal(scrubCssUrlSchemes(css), css, "legit url() must pass through unchanged");
    });
  }
});

describe("scrubCssUrlSchemes — dangerous schemes are blocked (edge case)", () => {
  const block: Array<{ label: string; css: string }> = [
    { label: "javascript:", css: "background: url(javascript:alert(1))" },
    { label: "javascript: quoted", css: "background: url('javascript:alert(1)')" },
    { label: "javascript: double-quoted", css: 'background: url("javascript:alert(1)")' },
    { label: "vbscript:", css: "background: url(vbscript:msgbox(1))" },
    { label: "data:", css: "background: url(data:text/html,<script>1</script>)" },
    { label: "data: image svg", css: "background: url('data:image/svg+xml,<svg/>')" },
    // file: — the client copy previously did NOT block this
    { label: "file:", css: "background: url(file:///etc/passwd)" },
    // uppercase / mixed case
    { label: "JAVASCRIPT: uppercase", css: "background: url(JAVASCRIPT:alert(1))" },
    { label: "JaVaScRiPt: mixed", css: "background: url(JaVaScRiPt:alert(1))" },
    // leading whitespace inside url()
    { label: "leading spaces", css: "background: url(   javascript:alert(1)   )" },
    // control-char / whitespace evasion inside the scheme
    { label: "tab split", css: "background: url(java\tscript:alert(1))" },
    { label: "newline split", css: "background: url(java\nscript:alert(1))" },
    { label: "NUL split", css: "background: url(java\u0000script:alert(1))" },
    // HTML numeric-entity evasions (decoded by the HTML parser in a style attr)
    { label: "decimal entity char", css: "background: url(&#106;avascript:alert(1))" },
    { label: "decimal entity tab split", css: "background: url(java&#09;script:alert(1))" },
    { label: "hex entity char", css: "background: url(&#x6a;avascript:alert(1))" },
    // named-entity colon evasion
    { label: "colon entity", css: "background: url(javascript&colon;alert(1))" },
  ];
  for (const { label, css } of block) {
    test(`blocks: ${label}`, () => {
      const out = scrubCssUrlSchemes(css);
      assert.match(out, /url\(''\)/, "dangerous url() replaced with empty url('')");
      assert.doesNotMatch(
        out.toLowerCase(),
        /javascript:|vbscript:|data:|file:/,
        "no dangerous scheme survives",
      );
      // No stray unbalanced paren left behind (nested-paren handling).
      assert.doesNotMatch(out, /url\(''\)\)/, "no dangling ) left after nested-paren match");
    });
  }
});

describe("scrubCssUrlSchemes — structural correctness", () => {
  test("nested-paren payload is consumed whole (no stray paren)", () => {
    // The old client flat `[^)]*` matcher would stop at the first ) and
    // leave `alert(1))` behind. The balanced matcher consumes it all.
    assert.equal(scrubCssUrlSchemes("url(javascript:alert(1))"), "url('')");
  });

  test("multiple url()s in one value are each handled independently", () => {
    const css = "background: url(/uploads/ok.png), url(javascript:alert(1))";
    assert.equal(scrubCssUrlSchemes(css), "background: url(/uploads/ok.png), url('')");
  });

  test("empty url('') is idempotent", () => {
    assert.equal(scrubCssUrlSchemes("background: url('')"), "background: url('')");
  });
});

describe("isDangerousCssUrl / canonicalizeUrlForSchemeCheck", () => {
  test("dangerous scheme list is the hardened set", () => {
    assert.deepEqual([...DANGEROUS_CSS_URL_SCHEMES], [
      "javascript:",
      "vbscript:",
      "data:",
      "file:",
    ]);
  });

  test("canonicalizer collapses whitespace/control/entities and lowercases", () => {
    assert.equal(canonicalizeUrlForSchemeCheck("  'JAVA\tSCRIPT:x' "), "javascript:x");
    assert.equal(canonicalizeUrlForSchemeCheck("&#106;avascript:x"), "javascript:x");
    assert.equal(canonicalizeUrlForSchemeCheck("javascript&colon;x"), "javascript:x");
  });

  test("isDangerousCssUrl allow/block", () => {
    assert.equal(isDangerousCssUrl("/uploads/bg.png"), false);
    assert.equal(isDangerousCssUrl("https://x/y.png"), false);
    assert.equal(isDangerousCssUrl("//cdn/x.png"), false);
    assert.equal(isDangerousCssUrl("javascript:alert(1)"), true);
    assert.equal(isDangerousCssUrl("data:text/html,x"), true);
    assert.equal(isDangerousCssUrl("file:///etc/passwd"), true);
  });
});

describe("sanitizeBio — hardened scrub is live at ALL call sites", () => {
  test("style ATTRIBUTE: legit /uploads background survives", () => {
    const html = '<div style="background: url(/uploads/backgrounds/night.jpg)">hi</div>';
    const out = sanitizeBio(html);
    assert.match(out, /url\(\/uploads\/backgrounds\/night\.jpg\)/);
  });

  test("style ATTRIBUTE: javascript: url is neutralized", () => {
    const html = '<div style="background: url(javascript:alert(1))">hi</div>';
    const out = sanitizeBio(html);
    assert.doesNotMatch(out.toLowerCase(), /javascript:/);
  });

  test("<style> BLOCK: legit https background survives, data: url blocked", () => {
    const html =
      "<style>.a{background:url(https://cdn.example.com/bg.png)}" +
      ".b{background:url(data:text/html,<x>)}</style>";
    const out = sanitizeBio(html);
    assert.match(out, /url\(https:\/\/cdn\.example\.com\/bg\.png\)/);
    assert.doesNotMatch(out.toLowerCase(), /url\(data:/);
  });

  test("<style> BLOCK: file: url is now blocked (hardening)", () => {
    const html = "<style>.a{background:url(file:///etc/passwd)}</style>";
    const out = sanitizeBio(html);
    assert.doesNotMatch(out.toLowerCase(), /file:/);
  });
});
