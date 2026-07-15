import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { renderCommandTemplate } from "../src/commands/template.js";

/**
 * Custom-command template engine (apps/server/src/commands/template.ts).
 * Pins the variable/function/loop grammar, the argument + rng + loop
 * additions, the enhanced {if:} comparisons, backward compatibility with the
 * original tokens, and the expansion DoS bounds. RNG + clock are injected so
 * every case is deterministic.
 */

/** Deterministic rng: yields each value in turn, then repeats the last. */
function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

const render = (
  tpl: string,
  opts: { name?: string; positional?: string[]; rng?: number[]; args?: string; now?: Date } = {},
) =>
  renderCommandTemplate(tpl, {
    name: opts.name ?? "WAS",
    roomId: "room1",
    positional: opts.positional,
    args: opts.args,
    rng: opts.rng ? seqRng(opts.rng) : () => 0,
    now: opts.now,
  });

describe("command template — variables", () => {
  test("{sender}/{name} resolve to the display name", () => {
    assert.equal(render("{sender} waves"), "WAS waves");
    assert.equal(render("{name} waves"), "WAS waves");
  });

  test("{target} is the first positional arg", () => {
    assert.equal(render("hugs {target}", { positional: ["Alice", "Bob"] }), "hugs Alice");
    assert.equal(render("hugs {target}", { positional: [] }), "hugs ");
  });

  test("{arg:N} is 1-based; missing args render empty", () => {
    assert.equal(render("{arg:1} d{arg:2}", { positional: ["3", "20"] }), "3 d20");
    assert.equal(render("[{arg:3}]", { positional: ["a", "b"] }), "[]");
  });

  test("{arg:0} / non-numeric arg index is left literal", () => {
    assert.equal(render("{arg:0}", { positional: ["a"] }), "{arg:0}");
    assert.equal(render("{arg:x}", { positional: ["a"] }), "{arg:x}");
  });

  test("{date} uses UTC; {room} passes through", () => {
    assert.equal(render("{date}", { now: new Date("2026-07-15T12:00:00Z") }), "2026-07-15");
    assert.equal(render("{room}"), "room1");
    assert.match(render("{time}"), /^\d\d:\d\d$/);
  });

  test("unknown tokens are left literal", () => {
    assert.equal(render("{bogus} and {name}"), "{bogus} and WAS");
  });
});

describe("command template — {rng:A:B}", () => {
  test("inclusive range, floor of rng()", () => {
    assert.equal(render("{rng:1:6}", { rng: [0] }), "1");
    assert.equal(render("{rng:1:6}", { rng: [0.5] }), "4"); // 1 + floor(0.5*6)=1+3
    assert.equal(render("{rng:1:6}", { rng: [0.999] }), "6");
  });

  test("swaps reversed bounds", () => {
    assert.equal(render("{rng:6:1}", { rng: [0] }), "1");
  });

  test("bounds can themselves be templated", () => {
    assert.equal(render("{rng:1:{arg:1}}", { positional: ["20"], rng: [0.999] }), "20");
  });

  test("malformed rng is left literal", () => {
    assert.equal(render("{rng:1}", { rng: [0] }), "{rng:1}");
    assert.equal(render("{rng:a:b}", { rng: [0] }), "{rng:a:b}");
  });
});

describe("command template — loops", () => {
  test("default space separator", () => {
    assert.equal(render("<loop:3>x</loop>"), "x x x");
  });

  test('sep="" joins with nothing; custom sep works', () => {
    assert.equal(render('<loop:3 sep="">x</loop>'), "xxx");
    assert.equal(render('<loop:3 sep=", ">x</loop>'), "x, x, x");
  });

  test("{loop} is the 1-based pass index", () => {
    assert.equal(render("<loop:3>{loop}</loop>"), "1 2 3");
  });

  test("body is re-evaluated each pass (fresh rng)", () => {
    // 1+floor(v*6): 0.65->4->? actually values chosen for 1..6 spread
    assert.equal(render("<loop:3>{rng:1:6}</loop>", { rng: [0, 0.5, 0.999] }), "1 4 6");
  });

  test("count can be an argument (the dice example)", () => {
    const out = render(
      "{sender} rolls {arg:1} d{arg:2}: <loop:{arg:1}>{rng:1:{arg:2}}</loop>",
      { positional: ["3", "20"], rng: [0.65, 0.35, 0.05] },
    );
    assert.equal(out, "WAS rolls 3 d20: 14 8 2");
  });

  test("count expression may contain a comparison operator", () => {
    // The '>' inside the {if:} count must not be mistaken for the loop header
    // terminator. arg1=5 → 5>2 → count 3.
    assert.equal(render("<loop:{if:{arg:1}>2|3|1}>x</loop>", { positional: ["5"] }), "x x x");
    assert.equal(render("<loop:{if:{arg:1}>2|3|1}>x</loop>", { positional: ["0"] }), "x");
  });

  test('sep value may contain ">"', () => {
    assert.equal(render('<loop:2 sep=" > ">x</loop>'), "x > x");
  });

  test("nested loops evaluate fresh per outer pass", () => {
    const out = render('<loop:2 sep=";"><loop:2 sep="">{rng:1:2}</loop></loop>', {
      rng: [0, 0.99, 0, 0.99],
    });
    assert.equal(out, "12;12");
  });

  test("non-numeric count is left literal", () => {
    assert.equal(render("<loop:abc>x</loop>"), "<loop:abc>x</loop>");
  });

  test("zero / negative count renders empty", () => {
    assert.equal(render("[<loop:0>x</loop>]"), "[]");
    assert.equal(render("[<loop:-3>x</loop>]"), "[]");
  });
});

describe("command template — {if:} conditionals", () => {
  test("bare truthiness (empty/0/false are false)", () => {
    assert.equal(render("{if:{arg:1}|has|none}", { positional: ["x"] }), "has");
    assert.equal(render("{if:{arg:1}|has|none}", { positional: [] }), "none");
    assert.equal(render("{if:0|y|n}"), "n");
    assert.equal(render("{if:false|y|n}"), "n");
  });

  test("numeric comparisons", () => {
    assert.equal(render("{if:{arg:1}>10|big|small}", { positional: ["15"] }), "big");
    assert.equal(render("{if:{arg:1}>10|big|small}", { positional: ["3"] }), "small");
    assert.equal(render("{if:{arg:1}>=20|max|below}", { positional: ["20"] }), "max");
    assert.equal(render("{if:{arg:1}<=1|crit|ok}", { positional: ["1"] }), "crit");
  });

  test("string comparisons", () => {
    assert.equal(render("{if:{arg:1}==yes|y|n}", { positional: ["yes"] }), "y");
    assert.equal(render("{if:{arg:1}!=yes|other|yes}", { positional: ["no"] }), "other");
  });

  test("else branch is optional", () => {
    assert.equal(render("{if:1>2|then}"), "");
  });
});

describe("command template — backward compatibility", () => {
  test("{roll:NdM}", () => {
    assert.equal(render("{roll:1d6}", { rng: [0.5] }), "4");
    assert.equal(render("{roll:2d6}", { rng: [0, 0.999] }), "7"); // 1 + 6
    assert.equal(render("{roll:junk}"), "{roll:junk}");
  });

  test("{choose:} and bare-pipe", () => {
    assert.equal(render("{choose:a|b|c}", { rng: [0] }), "a");
    assert.equal(render("{choose:a|b|c}", { rng: [0.99] }), "c");
    assert.equal(render("{a|b|c}", { rng: [0.5] }), "b");
  });

  test("{upper}/{lower}", () => {
    assert.equal(render("{upper:hi}"), "HI");
    assert.equal(render("{lower:HI}"), "hi");
  });

  test("{=math} with nesting", () => {
    assert.equal(render("{=10+5}"), "15");
    assert.equal(render("{=10+{roll:1d20}}", { rng: [0.95] }), "30"); // 1+floor(0.95*20)=20 -> 10+20
    assert.equal(render("{=1/0}"), "{=1/0}"); // Infinity -> not finite -> literal
    assert.equal(render("{=alert(1)}"), "{=alert(1)}"); // non-numeric chars rejected
  });
});

describe("command template — expansion bounds (DoS)", () => {
  test("a single loop is clamped to 200 passes", () => {
    const out = render('<loop:100000 sep="">x</loop>');
    assert.equal(out.length, 200);
  });

  test("nested loops terminate and stay bounded", () => {
    const out = render('<loop:200><loop:200 sep="">x</loop></loop>');
    assert.ok(out.length <= 6000, `output length ${out.length} should be bounded`);
  });

  test("substituted values cannot amplify (billion-laughs defense)", () => {
    // A caller arg that echoes the {args} token must NOT be re-interpreted as
    // template on later passes. It comes back as literal, bounded text.
    const out = render("{args}", { args: "{args}{args}{args}{args}" });
    assert.equal(out, "{args}{args}{args}{args}");
    assert.ok(out.length < 100);
  });

  test("a value that looks like a loop is not executed", () => {
    const out = render("{args}", { args: "<loop:999>x</loop>" });
    assert.equal(out, "<loop:999>x</loop>");
  });
});
