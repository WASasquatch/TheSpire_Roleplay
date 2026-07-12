import "./helpers/env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  composerDocPlainText,
  htmlClipboardToComposerDoc,
  normalizeComposerDoc,
  parseChatMarkdown,
  serializeComposerDoc,
  type ComposerDoc,
  type ComposerInlineMark,
  type ComposerLine,
  type ComposerLineKind,
  type ComposerSpan,
} from "@thekeep/shared";

/**
 * The composer's WYSIWYG editor serializes to the SAME markdown a
 * textarea would have sent (the wire format is frozen), so the
 * serializer/parser pair carries the correctness burden:
 *
 *   1. plain text — slash commands, tokens, NBSP names, leading
 *      whitespace — must round-trip BYTE-identically (identity
 *      serialization; the command pipeline never sees a change),
 *   2. parse(serialize(doc)) must reproduce the document over the
 *      supported mark set (what you see is what the recipient's
 *      renderer shows),
 *   3. the serialized length is the wire truth the 0/4000 counter and
 *      the TOO_LONG gate count,
 *   4. pasted HTML maps onto the supported mark set only.
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

describe("identity serialization (plain text is byte-exact)", () => {
  const NBSP = " ";
  const cases = [
    "/me waves at everyone",
    `/whisper The${NBSP}Watcher meet me at the gate`,
    `/give The${NBSP}Doctor 2 gold coin`,
    "/duel @cid:abc123XYZ",
    " :O", // leading space is the ':' shortcut escape — must survive
    "@cid:abc123 hello there",
    ":smile_big:3: and a plain :P",
    "//literal slash",
    "2 * 3 * 4 = 24",
    "snake_case_var stays flat",
    "a || b (lone pipes)",
    "unclosed **bold and *italic",
    "trailing backslash \\",
    "\\*escaped\\* stays literal-with-backslashes",
    "line one\nline two\n\nline four",
    "> quoted line stays as typed",
    "- dashed line stays as typed",
    "http://example.com/a_(b)_c bare autolink",
    "ends with newline\n",
  ];
  for (const s of cases) {
    test(JSON.stringify(s), () => {
      assert.equal(serializeComposerDoc(parseChatMarkdown(s)), s);
    });
  }
});

describe("mark serialization (canonical wire forms)", () => {
  test("simple marks", () => {
    assert.equal(serializeComposerDoc(doc(line("text", t("hi", ["bold"])))), "**hi**");
    assert.equal(serializeComposerDoc(doc(line("text", t("hi", ["italic"])))), "*hi*");
    assert.equal(serializeComposerDoc(doc(line("text", t("hi", ["strike"])))), "~~hi~~");
    assert.equal(serializeComposerDoc(doc(line("text", t("hi", ["underline"])))), "<u>hi</u>");
    assert.equal(serializeComposerDoc(doc(line("text", t("hi", ["spoiler"])))), "||hi||");
    assert.equal(serializeComposerDoc(doc(line("text", t("hi", ["code"])))), "`hi`");
    assert.equal(
      serializeComposerDoc(doc(line("text", t("hi", [], { link: "https://x.com/a" })))),
      "[hi](https://x.com/a)",
    );
    assert.equal(
      serializeComposerDoc(doc(line("text", t("hi", [], { color: "#a1b2c3" })))),
      '<font color="#a1b2c3">hi</font>',
    );
  });

  test("bold+italic co-extensive uses ***", () => {
    assert.equal(serializeComposerDoc(doc(line("text", t("both", ["bold", "italic"])))), "***both***");
  });

  test("nested runs serialize with the longest run outermost", () => {
    const d = doc(line("text", t("a ", ["bold"]), t("b", ["bold", "italic"]), t(" c", ["bold"])));
    assert.equal(serializeComposerDoc(d), "**a *b* c**");
    assertRoundTrip(d);
  });

  test("whitespace at asterisk-mark edges is expelled outside the delimiters", () => {
    assert.equal(serializeComposerDoc(doc(line("text", t("hi ", ["bold"]), t("there")))), "**hi** there");
    const nbspEdge = doc(line("text", t("hi ", ["italic"]), t("x")));
    assert.equal(serializeComposerDoc(nbspEdge), "*hi* x");
  });

  test("colliding content falls back to HTML aliases the renderer accepts", () => {
    assert.equal(serializeComposerDoc(doc(line("text", t("a**b", ["bold"])))), "<b>a**b</b>");
    assert.equal(serializeComposerDoc(doc(line("text", t("a*b", ["italic"])))), "<i>a*b</i>");
    assert.equal(serializeComposerDoc(doc(line("text", t("a~~b", ["strike"])))), "<s>a~~b</s>");
    assert.equal(serializeComposerDoc(doc(line("text", t("a`b", ["code"])))), "<code>a`b</code>");
  });

  test("spoiler with || content drops the mark instead of emitting a misparse", () => {
    assert.equal(serializeComposerDoc(doc(line("text", t("a||b", ["spoiler"])))), "a||b");
  });

  test("link with ] in the label or ) in the URL drops the link", () => {
    assert.equal(
      serializeComposerDoc(doc(line("text", t("a]b", [], { link: "https://x.com" })))),
      "a]b",
    );
    assert.equal(
      serializeComposerDoc(doc(line("text", t("ok", [], { link: "https://x.com/a)b" })))),
      "ok",
    );
  });

  test("quote and bullet lines carry their prefixes", () => {
    const d = doc(
      line("quote", t("said ", []), t("boldly", ["bold"])),
      line("bullet", t("first")),
      line("bullet", t("second")),
      line("text", t("plain")),
    );
    assert.equal(serializeComposerDoc(d), "> said **boldly**\n- first\n- second\nplain");
    assertRoundTrip(d);
  });

  test("empty lines survive", () => {
    const d = doc(line("text", t("a")), line("text"), line("text", t("b")));
    assert.equal(serializeComposerDoc(d), "a\n\nb");
    assertRoundTrip(d);
  });
});

describe("round-trip property over the mark set", () => {
  // Deterministic PRNG so a failure reproduces.
  let seed = 0x2f6e2b1;
  function rnd(): number {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) % 100000) / 100000;
  }
  function pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(rnd() * arr.length)]!;
  }
  const WORDS = ["lore", "spire", "watch", "gate9", "ember", "the watcher", "arc", "x", "dawn patrol"];
  const MARK_SETS: ComposerInlineMark[][] = [
    [], ["bold"], ["italic"], ["underline"], ["strike"], ["spoiler"], ["code"],
    ["bold", "italic"], ["bold", "strike"], ["italic", "underline"],
    ["bold", "italic", "strike"], ["spoiler", "bold"], ["underline", "strike"],
  ];
  const KINDS: ComposerLineKind[] = ["text", "text", "text", "quote", "bullet"];

  function randomSpan(): ComposerSpan {
    const s = t(pick(WORDS), [...pick(MARK_SETS)]);
    const r = rnd();
    if (r < 0.12) s.link = "https://example.com/path";
    else if (r < 0.2) s.color = "#a1b2c3";
    return s;
  }

  test("parse(serialize(doc)) reproduces 300 random docs", () => {
    for (let iter = 0; iter < 300; iter++) {
      const lineCount = 1 + Math.floor(rnd() * 3);
      const lines: ComposerLine[] = [];
      for (let li = 0; li < lineCount; li++) {
        const spanCount = Math.floor(rnd() * 4);
        const spans: ComposerSpan[] = [];
        for (let si = 0; si < spanCount; si++) {
          spans.push(randomSpan());
          // Separate spans so adjacent same-mark runs don't have to merge
          // ambiguously against differently-marked twins.
          if (si < spanCount - 1) spans.push(t(" "));
        }
        lines.push(line(pick(KINDS), ...spans));
      }
      assertRoundTrip(doc(...lines), `iteration ${iter}`);
    }
  });
});

describe("serialized length is the wire truth", () => {
  test("marks add wire length beyond the visible text", () => {
    const d = doc(line("text", t("hello", ["bold"])));
    assert.equal(composerDocPlainText(d), "hello");
    assert.equal(serializeComposerDoc(d).length, "**hello**".length);
  });
  test("a doc whose plain text fits the cap can still exceed it serialized", () => {
    const spans: ComposerSpan[] = [];
    for (let i = 0; i < 500; i++) {
      spans.push(t("abcd", i % 2 === 0 ? ["bold"] : []));
    }
    const d = doc(line("text", ...spans));
    const wire = serializeComposerDoc(d);
    assert.equal(composerDocPlainText(d).length, 2000);
    assert.ok(wire.length === 2000 + 250 * 4, `wire length ${wire.length}`);
    assert.ok(wire.length > 2000);
  });
});

describe("newlines (Enter=send is client-side; Shift+Enter yields \\n)", () => {
  test("multi-line docs serialize with \\n and re-parse to the same lines", () => {
    const d = parseChatMarkdown("first\nsecond");
    assert.equal(d.lines.length, 2);
    assert.equal(serializeComposerDoc(d), "first\nsecond");
  });
  test("blank lines are preserved exactly", () => {
    assert.equal(serializeComposerDoc(parseChatMarkdown("a\n\n\nb")), "a\n\n\nb");
  });
});

describe("command passthrough", () => {
  test("a slash-command draft parses to plain spans (no marks) and serializes identically", () => {
    const s = "/whisper someone check **this** out";
    const d = parseChatMarkdown(s);
    // The whole command line stays a plain, unmarked span — command
    // drafts hydrate literally, delimiters and all…
    const first = d.lines[0]!.spans[0]!;
    assert.ok(first.text.startsWith("/whisper someone check"));
    assert.equal(first.marks, undefined);
    // …and the wire is byte-identical.
    assert.equal(serializeComposerDoc(d), s);
  });
  test("underscore names in commands hydrate literally (no italic rewrite)", () => {
    const s = "/w _Shadow_ hi";
    const d = parseChatMarkdown(s);
    assert.equal(d.lines[0]!.spans[0]!.marks, undefined);
    assert.equal(composerDocPlainText(d), s);
    assert.equal(serializeComposerDoc(d), s);
  });
  test("marks on a command line serialize as the visible plain text", () => {
    // Toolbar/inherited marks must never wrap command bytes — the
    // dispatcher needs `/` as the first byte and verbatim args.
    const d = doc(line("text", t("/w Bob secret", ["bold"])));
    assert.equal(serializeComposerDoc(d), "/w Bob secret");
  });
  test("quote/bullet blocks around a command line drop their prefixes", () => {
    assert.equal(serializeComposerDoc(doc(line("quote", t("/away")))), "/away");
    assert.equal(
      serializeComposerDoc(doc(line("quote", t("/roll 2d6")), line("bullet", t("second")))),
      "/roll 2d6\nsecond",
    );
  });
  test("identity tokens and emoticon tokens stay literal", () => {
    const s = "/duel @cid:aBc-123 :goblin:7:";
    const d = parseChatMarkdown(s);
    assert.equal(composerDocPlainText(d), s);
    assert.equal(serializeComposerDoc(d), s);
  });
});

describe("HTML paste mapping", () => {
  test("Google Docs clipboard (font-weight spans inside a normal-weight <b> wrapper)", () => {
    const html =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1234">' +
      '<p dir="ltr" style="line-height:1.38;margin-top:0pt;">' +
      '<span style="font-size:11pt;font-family:Arial;color:#000000;font-weight:700;font-style:normal;">Bold lead </span>' +
      '<span style="font-size:11pt;font-family:Arial;color:#000000;font-weight:400;font-style:italic;">then italic</span>' +
      "</p>" +
      '<p dir="ltr"><span style="font-weight:400;">plain tail</span></p>' +
      "</b>";
    const d = htmlClipboardToComposerDoc(html);
    assert.equal(serializeComposerDoc(d), "**Bold lead** *then italic*\nplain tail");
  });

  test("Word clipboard (mso list paragraphs, o:p noise, conditional comments)", () => {
    const html =
      "<html><head><style>p.MsoNormal{margin:0}</style></head><body>" +
      '<p class="MsoNormal">Hello <b>world</b><o:p></o:p></p>' +
      "<p class=MsoListParagraph style='mso-list:l0 level1 lfo1'><![if !supportLists]>" +
      "<span style='mso-list:Ignore'>·<span style='font:7.0pt \"Times New Roman\"'>&nbsp;&nbsp;</span></span>" +
      "<![endif]>Item one<o:p></o:p></p>" +
      "<p class=MsoListParagraph style='mso-list:l0 level1 lfo1'><![if !supportLists]>" +
      "<span style='mso-list:Ignore'>·<span style='font:7.0pt \"Times New Roman\"'>&nbsp;&nbsp;</span></span>" +
      "<![endif]>Item <i>two</i></p>" +
      "</body></html>";
    const d = htmlClipboardToComposerDoc(html);
    assert.equal(serializeComposerDoc(d), "Hello **world**\n- Item one\n- Item *two*");
  });

  test("browser copy (semantic tags, links, lists, blockquote)", () => {
    const html =
      "Intro <b>bold</b> and <a href=\"https://example.com/x\">a link</a>" +
      "<ul><li>one</li><li><em>two</em></li></ul>" +
      "<blockquote><p>wise words</p></blockquote>";
    const d = htmlClipboardToComposerDoc(html);
    assert.equal(
      serializeComposerDoc(d),
      "Intro **bold** and [a link](https://example.com/x)\n- one\n- *two*\n> wise words",
    );
  });

  test("unsupported structure drops to plain text, never raw HTML", () => {
    const html =
      "<table><tr><td>cell A</td><td>cell B</td></tr></table>" +
      '<img src="https://x.com/y.png" alt="pic"><script>alert(1)</script>' +
      "<h1>Heading</h1>";
    const d = htmlClipboardToComposerDoc(html);
    const wire = serializeComposerDoc(d);
    assert.ok(!wire.includes("<"), wire);
    assert.ok(wire.includes("cell A"));
    assert.ok(!wire.includes("alert"), wire);
    assert.ok(wire.includes("Heading"));
  });

  test("javascript: links are not linkified", () => {
    const d = htmlClipboardToComposerDoc('<a href="javascript:alert(1)">click</a>');
    assert.equal(serializeComposerDoc(d), "click");
  });

  test("colors and font sizes carry through as font marks", () => {
    const d = htmlClipboardToComposerDoc('<span style="color:#ff0000;font-size:30px">red</span>');
    assert.equal(serializeComposerDoc(d), '<font color="#ff0000" size="4">red</font>');
  });

  test("underline and strike via CSS map to marks", () => {
    const d = htmlClipboardToComposerDoc(
      '<span style="text-decoration:underline">u</span> <span style="text-decoration:line-through">s</span>',
    );
    assert.equal(serializeComposerDoc(d), "<u>u</u> ~~s~~");
  });
});
