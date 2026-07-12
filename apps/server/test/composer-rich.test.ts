import "./helpers/env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  composerDocPlainText,
  htmlClipboardToComposerDoc,
  matchChatFontOpen,
  normalizeComposerDoc,
  parseChatMarkdown,
  serializeComposerDoc,
  type ComposerDoc,
  type ComposerInlineMark,
  type ComposerLine,
  type ComposerLineKind,
  type ComposerSpan,
  type ComposerTextSize,
} from "@thekeep/shared";
import { buildChatLogHtml, type ExportMessageRow } from "../src/export/chatLog.js";

/**
 * Rich-content (color + bucketed size) coverage for the composer's
 * wire grammar:
 *
 *   1. `<font color="#hex" size="1-4">` serializes/parses losslessly,
 *      alone and nested with every other mark,
 *   2. HTML-clipboard pastes from Gmail / Google Docs / Word carry
 *      color + size onto the marks (buckets, never raw px),
 *   3. clamping: any font-size unit maps to the NEAREST bucket, wire
 *      sizes outside 1..4 clamp on parse, garbage drops,
 *   4. hostile color/style payloads sanitize away everywhere,
 *   5. the HTML export renders the construct XSS-safely,
 *   6. old-format messages (color-only, or none) round-trip
 *      byte-identically — the wire format is extended, never changed.
 */

function doc(...lines: ComposerLine[]): ComposerDoc {
  return { lines };
}
function line(kind: ComposerLineKind, ...spans: ComposerSpan[]): ComposerLine {
  return { kind, spans };
}
function t(text: string, marks?: ComposerInlineMark[], extra?: Partial<ComposerSpan>): ComposerSpan {
  const s: ComposerSpan = { text };
  if (marks?.length) s.marks = marks;
  if (extra?.link) s.link = extra.link;
  if (extra?.color) s.color = extra.color;
  if (extra?.size) s.size = extra.size;
  return s;
}

function assertRoundTrip(d: ComposerDoc, msg?: string) {
  const wire = serializeComposerDoc(d);
  const back = parseChatMarkdown(wire);
  assert.deepEqual(
    normalizeComposerDoc(back),
    normalizeComposerDoc(d),
    msg ?? `round-trip failed for wire: ${JSON.stringify(wire)}`,
  );
}

describe("size mark serialization", () => {
  test("each bucket emits its wire value", () => {
    assert.equal(serializeComposerDoc(doc(line("text", t("hi", [], { size: "small" })))), '<font size="1">hi</font>');
    assert.equal(serializeComposerDoc(doc(line("text", t("hi", [], { size: "large" })))), '<font size="3">hi</font>');
    assert.equal(serializeComposerDoc(doc(line("text", t("hi", [], { size: "huge" })))), '<font size="4">hi</font>');
  });

  test("color + size share ONE font tag (color attribute first)", () => {
    assert.equal(
      serializeComposerDoc(doc(line("text", t("hi", [], { color: "#a1b2c3", size: "huge" })))),
      '<font color="#a1b2c3" size="4">hi</font>',
    );
  });

  test("color-only output is byte-identical to the legacy form", () => {
    assert.equal(
      serializeComposerDoc(doc(line("text", t("hi", [], { color: "#a1b2c3" })))),
      '<font color="#a1b2c3">hi</font>',
    );
  });

  test("size nests with every other mark and round-trips", () => {
    const combos: ComposerSpan[] = [
      t("bold", ["bold"], { size: "large" }),
      t("italic", ["italic"], { size: "small" }),
      t("both", ["bold", "italic"], { size: "huge", color: "#ff0000" }),
      t("struck", ["strike"], { size: "large", color: "#0f0" }),
      t("hidden", ["spoiler"], { size: "huge" }),
      t("undies", ["underline"], { size: "small", color: "#123456" }),
      t("mono", ["code"], { size: "large" }),
      t("linked", [], { link: "https://example.com/x", size: "huge", color: "#abcdef" }),
    ];
    for (const span of combos) {
      assertRoundTrip(doc(line("text", span)), JSON.stringify(span));
    }
  });

  test("adjacent runs with different sizes serialize as separate tags", () => {
    const d = doc(line("text", t("a", [], { size: "small" }), t("b", [], { size: "huge" }), t("c")));
    assert.equal(serializeComposerDoc(d), '<font size="1">a</font><font size="4">b</font>c');
    assertRoundTrip(d);
  });

  test("a shared color across differently-sized spans stays correct (no font-in-font nesting)", () => {
    const d = doc(
      line(
        "text",
        t("same", [], { color: "#ff0000" }),
        t("bigger", [], { color: "#ff0000", size: "large" }),
      ),
    );
    const wire = serializeComposerDoc(d);
    assert.equal(wire, '<font color="#ff0000">same</font><font color="#ff0000" size="3">bigger</font>');
    assertRoundTrip(d);
  });

  test("literal </font> inside a sized span drops the mark instead of mis-closing", () => {
    assert.equal(serializeComposerDoc(doc(line("text", t("a</font>b", [], { size: "large" })))), "a</font>b");
  });

  test("markup still counts toward the serialized wire length", () => {
    const d = doc(line("text", t("hello", [], { size: "huge" })));
    assert.equal(composerDocPlainText(d), "hello");
    assert.equal(serializeComposerDoc(d).length, '<font size="4">hello</font>'.length);
  });
});

describe("wire parse clamping (matchChatFontOpen)", () => {
  test("integer sizes outside 1..4 clamp to the nearest bucket", () => {
    assert.equal(serializeComposerDoc(parseChatMarkdown('<font size="9">x</font>')), '<font size="4">x</font>');
    assert.equal(serializeComposerDoc(parseChatMarkdown('<font size="0">x</font>')), '<font size="1">x</font>');
    assert.equal(serializeComposerDoc(parseChatMarkdown('<font size="7">x</font>')), '<font size="4">x</font>');
  });

  test("size 2 is explicit-normal: tag consumed, no mark", () => {
    const d = parseChatMarkdown('<font size="2">x</font>');
    assert.equal(composerDocPlainText(d), "x");
    assert.equal(serializeComposerDoc(d), "x");
  });

  test("non-integer sizes reject the whole tag to literal text", () => {
    for (const s of ['<font size="abc">x</font>', '<font size="1em">x</font>', '<font size="-1">x</font>', '<font size="">x</font>']) {
      assert.equal(serializeComposerDoc(parseChatMarkdown(s)), s, s);
    }
  });

  test("attribute whitelist: any other attribute stays literal", () => {
    for (const s of [
      '<font face="Arial" size="3">x</font>',
      '<font onmouseover="alert(1)" color="#fff">x</font>',
      '<font style="color:red">x</font>',
      '<font size="3" href="javascript:alert(1)">x</font>',
    ]) {
      assert.equal(matchChatFontOpen(s), null, s);
      assert.equal(serializeComposerDoc(parseChatMarkdown(s)), s, s);
    }
  });

  test("attribute order and quoting are flexible", () => {
    const m = matchChatFontOpen("<font size='3' color=#a1b2c3>rest");
    assert.ok(m);
    assert.equal(m.color, "#a1b2c3");
    assert.equal(m.size, "large");
  });

  test("hostile color values reject the tag", () => {
    for (const s of [
      '<font color="javascript:alert(1)">x</font>',
      '<font color="expression(alert(1))">x</font>',
      '<font color="url(http://evil)">x</font>',
      '<font color="red;background:url(x)">x</font>',
    ]) {
      assert.equal(matchChatFontOpen(s), null, s);
      assert.equal(serializeComposerDoc(parseChatMarkdown(s)), s, s);
    }
  });
});

describe("old-format messages round-trip unchanged", () => {
  const legacy = [
    '<font color="#a83232">red text</font>',
    'mixed **bold** and <font color="#fff">white</font> tails',
    '<font color="red">invalid stays literal</font>',
    "<font>bare font stays literal</font>",
    "no marks at all",
    "**bold** ~~strike~~ ||spoiler|| `code`",
  ];
  for (const s of legacy) {
    test(JSON.stringify(s), () => {
      assert.equal(serializeComposerDoc(parseChatMarkdown(s)), s);
    });
  }
});

describe("random round-trip property over color+size combos", () => {
  let seed = 0x51c3a7;
  function rnd(): number {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) % 100000) / 100000;
  }
  function pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(rnd() * arr.length)]!;
  }
  const WORDS = ["ember", "spire", "gate9", "dawn patrol", "x"];
  const MARK_SETS: ComposerInlineMark[][] = [
    [], ["bold"], ["italic"], ["strike"], ["underline"], ["spoiler"], ["code"],
    ["bold", "italic"], ["bold", "strike"], ["spoiler", "bold"],
  ];
  const SIZES: Array<ComposerTextSize | undefined> = [undefined, "small", "large", "huge"];
  const COLORS: Array<string | undefined> = [undefined, "#a1b2c3", "#f00"];

  test("parse(serialize(doc)) reproduces 300 random rich docs", () => {
    for (let iter = 0; iter < 300; iter++) {
      const lines: ComposerLine[] = [];
      const lineCount = 1 + Math.floor(rnd() * 2);
      for (let li = 0; li < lineCount; li++) {
        const spans: ComposerSpan[] = [];
        const spanCount = Math.floor(rnd() * 4);
        for (let si = 0; si < spanCount; si++) {
          const extra: Partial<ComposerSpan> = {};
          const size = pick(SIZES);
          const color = pick(COLORS);
          if (size) extra.size = size;
          if (color) extra.color = color;
          spans.push(t(pick(WORDS), [...pick(MARK_SETS)], extra));
          if (si < spanCount - 1) spans.push(t(" "));
        }
        lines.push(line("text", ...spans));
      }
      assertRoundTrip(doc(...lines), `iteration ${iter}`);
    }
  });
});

describe("HTML paste: color + size mapping", () => {
  test("Gmail clipboard (legacy <font size> + <font color>)", () => {
    const html =
      '<div dir="ltr">plain <font size="1">tiny</font> <font size="4">big</font> ' +
      '<font size="6">giant</font> <font color="#ff0000">red</font></div>';
    const d = htmlClipboardToComposerDoc(html);
    assert.equal(
      serializeComposerDoc(d),
      'plain <font size="1">tiny</font> <font size="3">big</font> <font size="4">giant</font> <font color="#ff0000">red</font>',
    );
  });

  test("Google Docs clipboard (pt sizes + colors; stamped #000000 is default, not a mark)", () => {
    const html =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-77">' +
      '<p dir="ltr" style="line-height:1.38;">' +
      '<span style="font-size:11pt;font-family:Arial;color:#000000;font-weight:400;">normal </span>' +
      '<span style="font-size:24pt;font-family:Arial;color:#ff0000;font-weight:400;">big red</span>' +
      '<span style="font-size:8pt;font-family:Arial;color:#000000;font-weight:400;"> fine</span>' +
      "</p></b>";
    const d = htmlClipboardToComposerDoc(html);
    assert.equal(
      serializeComposerDoc(d),
      'normal <font color="#ff0000" size="4">big red</font><font size="1"> fine</font>',
    );
  });

  test("Word clipboard (pt sizes + named colors)", () => {
    const html =
      "<html><head><style>p.MsoNormal{margin:0}</style></head><body>" +
      "<p class=MsoNormal><span style='font-size:7.0pt;color:red'>fine print</span> normal " +
      "<span style='font-size:26.0pt'>HUGE</span><o:p></o:p></p></body></html>";
    const d = htmlClipboardToComposerDoc(html);
    assert.equal(
      serializeComposerDoc(d),
      '<font color="#ff0000" size="1">fine print</font> normal <font size="4">HUGE</font>',
    );
  });

  test("bucket clamping: 7pt → small, 72px → huge, keywords map, garbage drops", () => {
    const cases: Array<[string, string]> = [
      ['<span style="font-size:7pt">x</span>', '<font size="1">x</font>'],
      ['<span style="font-size:72px">x</span>', '<font size="4">x</font>'],
      ['<span style="font-size:1.5em">x</span>', '<font size="3">x</font>'],
      ['<span style="font-size:200%">x</span>', '<font size="4">x</font>'],
      ['<span style="font-size:x-small">x</span>', '<font size="1">x</font>'],
      ['<span style="font-size:xx-large">x</span>', '<font size="4">x</font>'],
      ['<span style="font-size:medium">x</span>', "x"],
      ['<span style="font-size:16px">x</span>', "x"],
      ['<span style="font-size:banana">x</span>', "x"],
      ['<span style="font-size:calc(1px + 2em)">x</span>', "x"],
      ["<big>x</big>", '<font size="3">x</font>'],
      ["<small>x</small>", '<font size="1">x</font>'],
    ];
    for (const [html, wire] of cases) {
      assert.equal(serializeComposerDoc(htmlClipboardToComposerDoc(html)), wire, html);
    }
  });

  test("explicit-normal font-size inside a sized parent resets to normal", () => {
    const html = '<div style="font-size:24pt">big <span style="font-size:medium">normal</span> big</div>';
    assert.equal(
      serializeComposerDoc(htmlClipboardToComposerDoc(html)),
      '<font size="4">big </font>normal<font size="4"> big</font>',
    );
  });

  test("color formats: rgb() and named colors normalize to hex; near-transparent drops", () => {
    const cases: Array<[string, string]> = [
      ['<span style="color:rgb(18, 52, 86)">x</span>', '<font color="#123456">x</font>'],
      ['<span style="color:tomato">x</span>', '<font color="#ff6347">x</font>'],
      ['<span style="color:#A1B2C3">x</span>', '<font color="#a1b2c3">x</font>'],
      ['<span style="color:rgba(255,0,0,0.1)">x</span>', "x"],
      ['<span style="color:rgba(255,0,0,0.9)">x</span>', '<font color="#ff0000">x</font>'],
      ['<span style="color:windowtext">x</span>', "x"],
      ['<span style="color:inherit">x</span>', "x"],
      ["<font color=\"green\">x</font>", '<font color="#008000">x</font>'],
    ];
    for (const [html, wire] of cases) {
      assert.equal(serializeComposerDoc(htmlClipboardToComposerDoc(html)), wire, html);
    }
  });

  test("background-color, font-family and alignment do NOT map", () => {
    const html =
      '<p style="text-align:center"><span style="background-color:#ff0000;font-family:Comic Sans MS">x</span></p>';
    assert.equal(serializeComposerDoc(htmlClipboardToComposerDoc(html)), "x");
  });

  test("hostile style payloads sanitize away", () => {
    const cases = [
      '<span style="color:javascript:alert(1)">x</span>',
      '<span style="color:expression(alert(1))">x</span>',
      '<span style="color:url(http://evil)">x</span>',
      '<font color="javascript:alert(1)">x</font>',
      '<span style="font-size:expression(alert(1))">x</span>',
    ];
    for (const html of cases) {
      const wire = serializeComposerDoc(htmlClipboardToComposerDoc(html));
      assert.equal(wire, "x", html);
    }
  });

  test("color + size survive combined with structural marks", () => {
    const html =
      '<p><b><span style="color:#ff0000;font-size:24pt">loud</span></b> and ' +
      '<i><span style="color:#0000ff;font-size:8pt">quiet</span></i></p>';
    assert.equal(
      serializeComposerDoc(htmlClipboardToComposerDoc(html)),
      '<font color="#ff0000" size="4">**loud**</font> and <font color="#0000ff" size="1">*quiet*</font>',
    );
  });

  test("plain-text lookalike stays byte-exact through parse (no clipboard involved)", () => {
    const s = 'literal <font size="3">already-marked</font> draft';
    assert.equal(serializeComposerDoc(parseChatMarkdown(s)), s);
  });
});

describe("HTML export renders color + size safely", () => {
  function exportBodies(bodies: string[], theme: "dark" | "light" = "dark"): string {
    const messages: ExportMessageRow[] = bodies.map((body, i) => ({
      kind: "say",
      displayName: `speaker${i}`,
      body,
      color: null,
      createdAt: 1_700_000_000_000 + i * 1000,
    }));
    return buildChatLogHtml({
      roomName: "test room",
      exportedBy: "tester",
      generatedAtMs: 1_700_000_100_000,
      windowMs: 3_600_000,
      rangeStartMs: 1_700_000_000_000,
      rangeEndMs: 1_700_000_010_000,
      tzMinutes: 0,
      messages,
      truncated: false,
      theme,
    });
  }

  test("colored + sized body → a styled span with fixed em buckets", () => {
    const html = exportBodies(['<font color="#00ff00" size="3">green large</font>']);
    assert.ok(html.includes('<span style="color:#00ff00;font-size:1.35em">green large</span>'), html);
    assert.ok(!html.includes("&lt;font color=&quot;#00ff00&quot;"), "tag should have been consumed");
  });

  test("size-only body and explicit-normal size", () => {
    const html = exportBodies(['<font size="4">shout</font>', '<font size="2">calm</font>']);
    assert.ok(html.includes('<span style="font-size:1.75em">shout</span>'), html);
    assert.ok(html.includes("<span>calm</span>"), html);
  });

  test("near-black inline color is legibility-nudged on the dark theme (stored bytes untouched)", () => {
    const html = exportBodies(['<font color="#010101">shadow</font>']);
    assert.ok(!html.includes("color:#010101"), "should not paint near-black on a dark bg");
    assert.ok(/<span style="color:#[0-9a-fA-F]{6}">shadow<\/span>/.test(html), html);
  });

  test("wire sizes clamp in the export too", () => {
    const html = exportBodies(['<font size="72">x</font>']);
    assert.ok(html.includes('font-size:1.75em'), html);
  });

  test("hostile font tags stay escaped literal text", () => {
    const html = exportBodies([
      '<font color="javascript:alert(1)">x</font>',
      '<font onclick="alert(1)" size="3">x</font>',
    ]);
    assert.ok(!/<span style="color:javascript/.test(html), html);
    assert.ok(html.includes("&lt;font color="), "invalid tag must stay escaped");
    assert.ok(html.includes("&lt;font onclick="), "unknown attribute must stay escaped");
    assert.ok(!html.includes("<font"), "no raw font tag may survive");
  });

  test("script bodies stay escaped alongside the font handling", () => {
    const html = exportBodies(['<script>alert(1)</script><font size="3">ok</font>']);
    assert.ok(html.includes("&lt;script&gt;"), html);
    assert.ok(html.includes('<span style="font-size:1.35em">ok</span>'), html);
  });

  test("nested openers never compound em buckets (inner opener + surplus closer stay literal)", () => {
    const body = '<font size="4">'.repeat(3) + "x" + "</font>".repeat(3);
    const html = exportBodies([body]);
    // Exactly ONE sized span, mirroring the live renderer's first-match
    // close: inner openers degrade to literal text, surplus closers too.
    assert.equal((html.match(/font-size:1\.75em/g) ?? []).length, 1, html);
    assert.ok(html.includes("&lt;font size=&quot;4&quot;&gt;"), html);
    assert.ok(html.includes("&lt;/font&gt;"), html);
    assert.ok(!html.includes("<font"), html);
  });

  test("an opener with no closer stays escaped literal text", () => {
    const html = exportBodies(['<font size="4">dangling']);
    assert.ok(html.includes("&lt;font size=&quot;4&quot;&gt;dangling"), html);
    assert.ok(!html.includes("font-size:1.75em"), html);
  });

  test("a closer with no opener stays escaped literal text", () => {
    const html = exportBodies(["stray</font> text"]);
    assert.ok(html.includes("stray&lt;/font&gt; text"), html);
    assert.ok(!html.includes("</span> text"), html);
  });
});

describe("guardrails on the shared opener matcher", () => {
  test("duplicated attributes reject the tag to literal text", () => {
    assert.equal(matchChatFontOpen('<font color="#aaa" color="#bbb">x</font>'), null);
    assert.equal(matchChatFontOpen('<font size="3" size="4">x</font>'), null);
    assert.equal(matchChatFontOpen('<font color="#aaa" size="3" color="#bbb">x</font>'), null);
  });

  test("tag-stripped visible text (the automod view) cannot be keyword-split by markup", () => {
    // <font size="2"> is explicit-normal: it renders pixel-identically to
    // the bare word in every client. The moderation view must see the
    // joined visible text.
    const visible = composerDocPlainText(parseChatMarkdown('bad<font size="2">word</font>'));
    assert.equal(visible, "badword");
    assert.equal(
      composerDocPlainText(parseChatMarkdown('b<font color="#fff">a</font>**d**word')),
      "badword",
    );
  });
});
