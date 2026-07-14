import "./helpers/env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isBetaVersion } from "@thekeep/shared";
import { betaBadgeActive } from "../src/lib/betaBadge.js";
import { ensureSiteSettings, updateSettings } from "../src/settings.js";
import { createUser, makeTestDb } from "./helpers/harness.js";

/**
 * Splash "Beta" badge (migration 0357). Three pinned behaviors:
 *
 *   1. The version gate is strict SemVer "< 1.0.0": every 0.x.y build
 *      qualifies, a 1.0.0 PRERELEASE qualifies (SemVer orders it before
 *      1.0.0), and anything at or past 1.0.0 does not. Unparseable input
 *      fails closed so a malformed version can't pin the badge on.
 *   2. The admin toggle defaults ON (the version gate is the off-switch)
 *      and round-trips through the settings layer the admin PUT calls.
 *   3. The /site payload boolean (betaBadgeActive) is the AND of both —
 *      it must never be true with the toggle off or on a released build.
 */

describe("beta badge", () => {
  test("version gate: SemVer < 1.0.0, prerelease-aware, fails closed", () => {
    // Every pre-1.0 release qualifies (the plain x.y.z forms bump.sh writes).
    assert.equal(isBetaVersion("0.0.1"), true);
    assert.equal(isBetaVersion("0.32.19"), true);
    assert.equal(isBetaVersion("0.999.999"), true);
    assert.equal(isBetaVersion("v0.5.0"), true);
    assert.equal(isBetaVersion(" 0.7.0 "), true);
    // 1.0.0 prereleases sort BEFORE 1.0.0 under SemVer, so they still show.
    assert.equal(isBetaVersion("1.0.0-rc.1"), true);
    assert.equal(isBetaVersion("1.0.0-beta"), true);
    assert.equal(isBetaVersion("1.0.0-alpha.2+build.5"), true);
    // At or past the 1.0.0 release the badge retires.
    assert.equal(isBetaVersion("1.0.0"), false);
    assert.equal(isBetaVersion("1.0.0+build.7"), false);
    assert.equal(isBetaVersion("1.0.1"), false);
    assert.equal(isBetaVersion("1.0.1-beta"), false);
    assert.equal(isBetaVersion("1.1.0"), false);
    assert.equal(isBetaVersion("2.0.0"), false);
    assert.equal(isBetaVersion("2.0.0-rc.1"), false);
    // Unparseable input fails CLOSED (no badge).
    assert.equal(isBetaVersion(""), false);
    assert.equal(isBetaVersion("1.0"), false);
    assert.equal(isBetaVersion("one.two.three"), false);
    assert.equal(isBetaVersion("0.32"), false);
  });

  test("setting defaults ON and round-trips through the settings layer", async () => {
    const { db } = makeTestDb();
    const admin = await createUser(db, { role: "masteradmin" });

    // Migration 0357 default: ON out of the box.
    let s = await ensureSiteSettings(db);
    assert.equal(s.betaBadgeEnabled, true, "default is on");

    // Toggle off (the same updateSettings path PUT /admin/settings calls).
    s = await updateSettings(db, { betaBadgeEnabled: false }, admin.id);
    assert.equal(s.betaBadgeEnabled, false);
    assert.equal((await ensureSiteSettings(db)).betaBadgeEnabled, false, "persisted, not just cached");

    // And back on.
    s = await updateSettings(db, { betaBadgeEnabled: true }, admin.id);
    assert.equal(s.betaBadgeEnabled, true);
  });

  test("/site flag is toggle AND version gate — never one alone", async () => {
    const { db } = makeTestDb();
    const admin = await createUser(db, { role: "masteradmin" });

    // Default (on) + pre-1.0 build → badge live.
    let s = await ensureSiteSettings(db);
    assert.equal(betaBadgeActive(s, "0.32.19"), true);
    // Same settings, released build → badge retired regardless of the toggle.
    assert.equal(betaBadgeActive(s, "1.0.0"), false);
    assert.equal(betaBadgeActive(s, "1.2.3"), false);
    // 1.0.0 prerelease still counts as pre-release.
    assert.equal(betaBadgeActive(s, "1.0.0-rc.1"), true);

    // Toggle off → badge dark even on a pre-1.0 build.
    s = await updateSettings(db, { betaBadgeEnabled: false }, admin.id);
    assert.equal(betaBadgeActive(s, "0.32.19"), false);
    assert.equal(betaBadgeActive(s, "1.0.0"), false);
  });
});
