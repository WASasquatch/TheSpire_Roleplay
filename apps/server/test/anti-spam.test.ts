import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ANTI_SPAM_CONFIG,
  freshSpamState,
  stepAntiSpam,
  type AntiSpamConfig,
  type SpamState,
  type SpamVerdict,
} from "../src/realtime/antiSpam.js";

/**
 * The anti-spam ladder auto-mutes real users, so its escalation is covered by
 * tests rather than trusted to read right. All cases drive the PURE core
 * (`stepAntiSpam`) with explicit `now` values - no timers, no flakiness.
 *
 * The thresholds are config-relative on purpose (every case reads `CFG.*`), so
 * this suite stays meaningful if the burst ceiling is retuned. The burst ceiling
 * deliberately sits ABOVE the base `dispatch.ts` rate cap (12 / 10s) so a legal
 * fast chatter is never warned; these tests exercise the escalation the ladder
 * runs ONCE that ceiling is crossed - i.e. a flood beyond the base cap.
 */

const CFG = DEFAULT_ANTI_SPAM_CONFIG;

// Space burst messages so `burstMax + 1` of them still land inside the window
// (the window is many multiples of this gap), keeping each burst a single strike.
const BURST_GAP_MS = 100;

/**
 * Fire `burstMax + 1` rapid messages starting at `startNow` (assumes not
 * currently blocked). Returns the strike verdict + the clock after the burst.
 */
function burst(state: SpamState, startNow: number, cfg: AntiSpamConfig = CFG): { verdict: SpamVerdict; now: number } {
  let now = startNow;
  let verdict: SpamVerdict = { action: "allow" };
  for (let i = 0; i <= cfg.burstMax; i++) {
    verdict = stepAntiSpam(state, now, cfg);
    now += BURST_GAP_MS; // whole burst stays well inside burstWindowMs
  }
  return { verdict, now };
}

describe("anti-spam ladder", () => {
  test("allows a normal burst up to the limit", () => {
    const s = freshSpamState();
    for (let i = 0; i < CFG.burstMax; i++) {
      assert.deepEqual(stepAntiSpam(s, i * 200, CFG), { action: "allow" }, `message ${i + 1} should pass`);
    }
  });

  test("the message past the burst limit is the first warning", () => {
    const s = freshSpamState();
    const { verdict } = burst(s, 0);
    assert.equal(verdict.action, "warn");
    if (verdict.action === "warn") {
      assert.equal(verdict.warning, 1);
      assert.equal(verdict.limit, CFG.warningsBeforeMute);
      assert.equal(verdict.blockMs, CFG.blockBaseMs);
    }
  });

  test("messages sent during the cooldown block are rejected without counting", () => {
    const s = freshSpamState();
    const { now } = burst(s, 0); // now blocked for blockBaseMs
    const v = stepAntiSpam(s, now + 100, CFG);
    assert.equal(v.action, "blocked");
    if (v.action === "blocked") assert.ok(v.retryMs > 0 && v.retryMs <= CFG.blockBaseMs);
  });

  test("the cooldown block grows with each strike (10s, 20s, 40s)", () => {
    const s = freshSpamState();
    let now = 0;
    const expected = [CFG.blockBaseMs, CFG.blockBaseMs * 2, CFG.blockBaseMs * 4];
    for (let strike = 0; strike < CFG.warningsBeforeMute; strike++) {
      const r = burst(s, now);
      assert.equal(r.verdict.action, "warn", `strike ${strike + 1} should warn`);
      if (r.verdict.action === "warn") assert.equal(r.verdict.blockMs, expected[strike]);
      // Skip past this block before the next burst.
      now = r.now + expected[strike]! + 1;
    }
  });

  test("the strike after the warning quota is an auto-mute for the base duration", () => {
    const s = freshSpamState();
    let now = 0;
    for (let strike = 0; strike < CFG.warningsBeforeMute; strike++) {
      const r = burst(s, now);
      assert.equal(r.verdict.action, "warn");
      const blockMs = r.verdict.action === "warn" ? r.verdict.blockMs : 0;
      now = r.now + blockMs + 1;
    }
    const r = burst(s, now);
    assert.equal(r.verdict.action, "mute");
    if (r.verdict.action === "mute") assert.equal(r.verdict.muteMs, CFG.muteBaseMs);
  });

  test("repeat mutes grow (5m then 10m) and cap out", () => {
    // Seed a state that's one strike away from its SECOND mute.
    const s: SpamState = { ...freshSpamState(), warnings: CFG.warningsBeforeMute, muteCount: 1 };
    const { verdict } = burst(s, 0);
    assert.equal(verdict.action, "mute");
    if (verdict.action === "mute") assert.equal(verdict.muteMs, CFG.muteBaseMs * 2);

    // Far enough up the ladder that the doubling would exceed the cap.
    const capped: SpamState = { ...freshSpamState(), warnings: CFG.warningsBeforeMute, muteCount: 20 };
    const r2 = burst(capped, 0);
    assert.equal(r2.verdict.action, "mute");
    if (r2.verdict.action === "mute") assert.equal(r2.verdict.muteMs, CFG.muteMaxMs);
  });

  test("a calm stretch resets the warning ladder", () => {
    const s = freshSpamState();
    const first = burst(s, 0);
    assert.equal(first.verdict.action, "warn");
    if (first.verdict.action === "warn") assert.equal(first.verdict.warning, 1);

    // Go quiet past the reset window, then burst again. The decay at the start
    // of the next message zeroes the accrued warning, so this is warning ONE
    // again - not two (which is what an un-decayed second burst would give).
    const again = burst(s, first.now + CFG.resetMs + 1);
    assert.equal(again.verdict.action, "warn");
    if (again.verdict.action === "warn") assert.equal(again.verdict.warning, 1);
  });

  test("a gap longer than the window starts a fresh burst count", () => {
    const s = freshSpamState();
    // Five messages, then a long gap, then five more: never crosses the limit.
    for (let i = 0; i < CFG.burstMax; i++) {
      assert.equal(stepAntiSpam(s, i * 200, CFG).action, "allow");
    }
    const later = CFG.burstWindowMs + 5_000;
    for (let i = 0; i < CFG.burstMax; i++) {
      assert.equal(stepAntiSpam(s, later + i * 200, CFG).action, "allow", `post-gap message ${i + 1}`);
    }
  });
});
