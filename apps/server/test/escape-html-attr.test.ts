import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, escapeHtmlAttr } from "@thekeep/shared";

/**
 * Characterization test for the consolidated HTML escapers
 * (packages/shared/src/html.ts, findings H1 + H4).
 *
 * The single `&`-first core replaced ~8 private inline copies that each
 * escaped a slightly different character set. This test pins the exact
 * output for EVERY variant/option combination those copies produced, so
 * the consolidation stays byte-for-byte behavior-preserving at every call
 * site:
 *  - escapeHtml(s) ...................... `& < >`      (uiRoutes.escapeHtml, email/templates.esc)
 *  - escapeHtml(s, {doubleQuote}) ....... `& < > "`    (chatLog.escapeHtml/escapeAttrUrl, email/layout.esc)
 *  - escapeHtmlAttr(s) .................. `& < > " '`  (uiRoutes.escapeHtmlAttr, name/border templates)
 *  - escapeHtmlAttr(s) + collapse ....... seo.escapeHtmlAttr (whitespace collapse first)
 */
describe("escapeHtmlAttr (full attribute set: & < > \" ')", () => {
  const cases: Array<{ label: string; input: string; expected: string }> = [
    { label: "empty", input: "", expected: "" },
    { label: "plain text untouched", input: "hello world", expected: "hello world" },
    { label: "unicode letters untouched", input: "café ☃ 🙂", expected: "café ☃ 🙂" },
    { label: "ampersand", input: "a&b", expected: "a&amp;b" },
    { label: "less than", input: "a<b", expected: "a&lt;b" },
    { label: "greater than", input: "a>b", expected: "a&gt;b" },
    { label: "double quote", input: 'a"b', expected: "a&quot;b" },
    { label: "single quote", input: "a'b", expected: "a&#39;b" },
    {
      label: "all specials together",
      input: "&<>\"'",
      expected: "&amp;&lt;&gt;&quot;&#39;",
    },
    {
      label: "ampersand escaped first (no double-escape)",
      input: "&amp;",
      expected: "&amp;amp;",
    },
    {
      label: "script tag breakout attempt",
      input: '<script>alert("x")</script>',
      expected: "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    },
    {
      label: "attribute breakout attempt",
      input: '" onmouseover="alert(1)',
      expected: "&quot; onmouseover=&quot;alert(1)",
    },
  ];

  for (const c of cases) {
    test(c.label, () => {
      assert.equal(escapeHtmlAttr(c.input), c.expected, `escaped output for ${c.label}`);
    });
  }
});

describe("escapeHtml default (text set: & < > only)", () => {
  const cases: Array<{ label: string; input: string; expected: string }> = [
    { label: "empty", input: "", expected: "" },
    { label: "plain text untouched", input: "hello world", expected: "hello world" },
    { label: "ampersand", input: "a&b", expected: "a&amp;b" },
    { label: "less than", input: "a<b", expected: "a&lt;b" },
    { label: "greater than", input: "a>b", expected: "a&gt;b" },
    // Quotes are intentionally NOT escaped by the default (text-node) variant.
    { label: "double quote untouched", input: 'a"b', expected: 'a"b' },
    { label: "single quote untouched", input: "a'b", expected: "a'b" },
    {
      label: "all specials — only & < > escaped",
      input: "&<>\"'",
      expected: "&amp;&lt;&gt;\"'",
    },
    {
      label: "ampersand escaped first (no double-escape)",
      input: "&amp;",
      expected: "&amp;amp;",
    },
  ];

  for (const c of cases) {
    test(c.label, () => {
      assert.equal(escapeHtml(c.input), c.expected, `escaped output for ${c.label}`);
      // Passing an empty options object must match the default.
      assert.equal(escapeHtml(c.input, {}), c.expected, `escaped output (empty opts) for ${c.label}`);
    });
  }
});

describe("escapeHtml { doubleQuote } (text + dbl-quoted attr: & < > \")", () => {
  const cases: Array<{ label: string; input: string; expected: string }> = [
    { label: "double quote escaped", input: 'a"b', expected: "a&quot;b" },
    { label: "single quote untouched", input: "a'b", expected: "a'b" },
    {
      label: "all specials — & < > \" escaped, ' left",
      input: "&<>\"'",
      expected: "&amp;&lt;&gt;&quot;'",
    },
  ];

  for (const c of cases) {
    test(c.label, () => {
      assert.equal(
        escapeHtml(c.input, { doubleQuote: true }),
        c.expected,
        `escaped output for ${c.label}`,
      );
    });
  }
});

describe("escapeHtml { singleQuote } (& < > ')", () => {
  test("single quote escaped, double left", () => {
    assert.equal(escapeHtml("a'b\"c", { singleQuote: true }), "a&#39;b\"c");
  });
});

describe("escapeHtml { collapseWhitespace } — collapse BEFORE escape (seo)", () => {
  const cases: Array<{ label: string; input: string; opts: Parameters<typeof escapeHtml>[1]; expected: string }> = [
    {
      label: "runs of spaces collapse to one",
      input: "a    b",
      opts: { collapseWhitespace: true },
      expected: "a b",
    },
    {
      label: "newlines and tabs collapse to a single space",
      input: "line1\n\tline2   line3",
      opts: { collapseWhitespace: true },
      expected: "line1 line2 line3",
    },
    {
      label: "full seo variant: collapse then escape & < > \" '",
      input: 'a & b\n<c>  "d"  \'e\'',
      opts: { collapseWhitespace: true, doubleQuote: true, singleQuote: true },
      expected: "a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;",
    },
    {
      label: "leading/trailing whitespace collapses (not trimmed)",
      input: "  x  ",
      opts: { collapseWhitespace: true },
      expected: " x ",
    },
  ];

  for (const c of cases) {
    test(c.label, () => {
      assert.equal(escapeHtml(c.input, c.opts), c.expected, `escaped output for ${c.label}`);
    });
  }
});
