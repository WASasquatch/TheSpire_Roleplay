import "./helpers/env.js"; // MUST be first - sets SQLITE_PATH before the db singleton loads
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { auditLog, sessions, userPermissionOverrides, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { invalidatePermissionsCache } from "../src/auth/permissions.js";
import { auth, buildUsersApp, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Admin age surface (age plan Phase 4, §F "Admin" row): the directory's
 * birthdate + derived bracket, the `state=minor` filter, the `dob` /
 * `isolateFromAdults` fields on PATCH /admin/users/:id behind
 * `edit_user_dob`, the `user_dob_update` / `user_isolation_update` audit
 * rows, and the adult→minor downgrade force-logout. These are exactly the
 * gates a permission-seed refactor or a careless field addition could
 * silently break.
 */

/**
 * ISO date `years` back from today (UTC date-only). `extraDays` nudges the
 * fixture 30 days off the exact anniversary so a midnight-UTC rollover
 * mid-suite can never flip a fixture across the adult/minor boundary
 * (boundary math itself is covered by the ageGate unit tests).
 */
function isoYearsAgo(years: number, extraDays = 30): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - extraDays);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

const MINOR_DOB = isoYearsAgo(15);
const ADULT_DOB = isoYearsAgo(30);

interface DirectoryRow {
  userId: string;
  username: string;
  birthdate: string | null;
  ageBracket: "adult" | "minor" | "legacy";
  isolateFromAdults: boolean;
}

describe("admin user age fields", () => {
  let db: Db;
  let raw: ReturnType<typeof makeTestDb>["raw"];
  let app: FastifyInstance;

  before(async () => {
    ({ db, raw } = makeTestDb());
    app = await buildUsersApp(db);
  });
  after(async () => {
    await app.close();
    raw.close();
  });

  async function patchUser(token: string, targetId: string, body: unknown) {
    return app.inject({
      method: "PATCH",
      url: `/admin/users/${targetId}`,
      headers: { ...auth(token), "content-type": "application/json" },
      payload: body as object,
    });
  }
  async function listUsers(token: string, qs = "") {
    return app.inject({ method: "GET", url: `/admin/users${qs}`, headers: auth(token) });
  }
  async function directoryRow(token: string, target: { id: string; username: string }): Promise<DirectoryRow | undefined> {
    const res = await listUsers(token, `?q=${encodeURIComponent(target.username)}`);
    assert.equal(res.statusCode, 200);
    const body = res.json() as { users: DirectoryRow[] };
    return body.users.find((u) => u.userId === target.id);
  }
  async function userRow(id: string) {
    return (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]!;
  }
  async function auditRowsFor(targetId: string, action: string) {
    return db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetUserId, targetId), eq(auditLog.action, action)));
  }

  test("directory returns birthdate + derived bracket (adult / minor / legacy)", async () => {
    const admin = await createUser(db, { role: "admin" });
    const adminTok = await tokenFor(db, admin.id);
    const legacy = await createUser(db); // no birthdate = pre-feature account
    const adult = await createUser(db, { birthdate: ADULT_DOB });
    const minor = await createUser(db, { birthdate: MINOR_DOB });

    const legacyRow = await directoryRow(adminTok, legacy);
    assert.ok(legacyRow, "legacy account listed");
    assert.equal(legacyRow!.birthdate, null);
    assert.equal(legacyRow!.ageBracket, "legacy");

    const adultRow = await directoryRow(adminTok, adult);
    assert.equal(adultRow!.birthdate, ADULT_DOB);
    assert.equal(adultRow!.ageBracket, "adult");

    const minorRow = await directoryRow(adminTok, minor);
    assert.equal(minorRow!.birthdate, MINOR_DOB);
    assert.equal(minorRow!.ageBracket, "minor");
    assert.equal(minorRow!.isolateFromAdults, false);
  });

  test("state=minor filters the directory server-side", async () => {
    const admin = await createUser(db, { role: "admin" });
    const adminTok = await tokenFor(db, admin.id);
    const minor = await createUser(db, { birthdate: MINOR_DOB });
    const adult = await createUser(db, { birthdate: ADULT_DOB });

    const res = await listUsers(adminTok, "?state=minor");
    assert.equal(res.statusCode, 200);
    const body = res.json() as { users: DirectoryRow[] };
    assert.ok(body.users.some((u) => u.userId === minor.id), "minor account included");
    assert.ok(!body.users.some((u) => u.userId === adult.id), "adult account excluded");
    assert.ok(body.users.every((u) => u.ageBracket === "minor"), "every returned row is a minor");
  });

  test("an admin holding edit_user_dob can correct a DOB; the edit is audited with prior/next", async () => {
    const admin = await createUser(db, { role: "admin" });
    const adminTok = await tokenFor(db, admin.id);
    const target = await createUser(db, { birthdate: ADULT_DOB });

    const nextDob = isoYearsAgo(25);
    const res = await patchUser(adminTok, target.id, { dob: nextDob });
    assert.equal(res.statusCode, 200);
    assert.equal((await userRow(target.id)).birthdate, nextDob);

    const audits = await auditRowsFor(target.id, "user_dob_update");
    assert.equal(audits.length, 1, "one audit row");
    assert.equal(audits[0]!.actorUserId, admin.id);
    const meta = JSON.parse(audits[0]!.metadataJson!) as {
      priorBirthdate: string | null; nextBirthdate: string; forcedLogout: boolean;
    };
    assert.equal(meta.priorBirthdate, ADULT_DOB);
    assert.equal(meta.nextBirthdate, nextDob);
    assert.equal(meta.forcedLogout, false, "adult→adult correction does not log out");
  });

  test("re-submitting the same DOB writes no audit row (no-op edit)", async () => {
    const admin = await createUser(db, { role: "admin" });
    const adminTok = await tokenFor(db, admin.id);
    const target = await createUser(db, { birthdate: ADULT_DOB });

    const res = await patchUser(adminTok, target.id, { dob: ADULT_DOB });
    assert.equal(res.statusCode, 200);
    assert.equal((await auditRowsFor(target.id, "user_dob_update")).length, 0);
  });

  test("without edit_user_dob the dob and isolation fields are refused before ANY write", async () => {
    // Admins hold edit_user_dob via the 0337 seed; revoke it with a
    // per-user override (override precedence beats the role grant) so we
    // exercise the per-field gate rather than the route's baseline gate.
    const admin = await createUser(db, { role: "admin" });
    const adminTok = await tokenFor(db, admin.id);
    const target = await createUser(db, { birthdate: ADULT_DOB });
    await db.insert(userPermissionOverrides).values({
      userId: admin.id,
      permissionKey: "edit_user_dob",
      granted: false,
      setByUserId: admin.id,
      setAt: new Date(),
    });
    invalidatePermissionsCache();
    try {
      // Bundling a username change proves reject-before-write: the 403
      // must leave EVERY field untouched, not half-apply the patch.
      const res = await patchUser(adminTok, target.id, { dob: MINOR_DOB, username: "half_applied" });
      assert.equal(res.statusCode, 403);
      const row = await userRow(target.id);
      assert.equal(row.birthdate, ADULT_DOB, "dob untouched");
      assert.equal(row.username, target.username, "username untouched (reject-before-write)");

      const iso = await patchUser(adminTok, target.id, { isolateFromAdults: false });
      assert.equal(iso.statusCode, 403, "isolation rides the same permission key");
    } finally {
      await db.delete(userPermissionOverrides).where(eq(userPermissionOverrides.userId, admin.id));
      invalidatePermissionsCache();
    }
  });

  test("malformed, impossible, future, and ancient DOBs are rejected", async () => {
    const admin = await createUser(db, { role: "admin" });
    const adminTok = await tokenFor(db, admin.id);
    const target = await createUser(db, { birthdate: ADULT_DOB });

    const future = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
    for (const dob of ["15/06/1990", "2007-02-31", future, "1850-01-01", null]) {
      const res = await patchUser(adminTok, target.id, { dob });
      assert.equal(res.statusCode, 400, `rejected: ${String(dob)}`);
    }
    assert.equal((await userRow(target.id)).birthdate, ADULT_DOB, "nothing written");
  });

  test("an adult→minor correction revokes every session (force logout); minor→adult keeps them", async () => {
    const admin = await createUser(db, { role: "admin" });
    const adminTok = await tokenFor(db, admin.id);

    // Downgrade: adult with a live session loses it, so stale adult
    // sockets/sessions can't keep passing age gates.
    const down = await createUser(db, { birthdate: ADULT_DOB });
    await tokenFor(db, down.id);
    const downRes = await patchUser(adminTok, down.id, { dob: MINOR_DOB });
    assert.equal(downRes.statusCode, 200);
    const downSessions = await db.select().from(sessions).where(eq(sessions.userId, down.id));
    assert.equal(downSessions.length, 0, "sessions revoked on adult→minor");
    const meta = JSON.parse((await auditRowsFor(down.id, "user_dob_update"))[0]!.metadataJson!) as { forcedLogout: boolean };
    assert.equal(meta.forcedLogout, true);

    // Legacy (NULL birthdate = adult by attestation) downgrades the same way.
    const legacy = await createUser(db);
    await tokenFor(db, legacy.id);
    const legacyRes = await patchUser(adminTok, legacy.id, { dob: MINOR_DOB });
    assert.equal(legacyRes.statusCode, 200);
    assert.equal((await db.select().from(sessions).where(eq(sessions.userId, legacy.id))).length, 0);

    // Upgrade: minor→adult only loosens gates; staying gated until the
    // next login fails closed, so sessions survive.
    const up = await createUser(db, { birthdate: MINOR_DOB });
    await tokenFor(db, up.id);
    const upRes = await patchUser(adminTok, up.id, { dob: ADULT_DOB });
    assert.equal(upRes.statusCode, 200);
    assert.equal((await db.select().from(sessions).where(eq(sessions.userId, up.id))).length, 1, "sessions kept on minor→adult");
  });

  test("isolation: set on a minor (audited), refused for adults, clear always allowed", async () => {
    const admin = await createUser(db, { role: "admin" });
    const adminTok = await tokenFor(db, admin.id);

    // Set on a minor.
    const minor = await createUser(db, { birthdate: MINOR_DOB });
    const setRes = await patchUser(adminTok, minor.id, { isolateFromAdults: true });
    assert.equal(setRes.statusCode, 200);
    assert.equal((await userRow(minor.id)).isolateFromAdults, true);
    const audits = await auditRowsFor(minor.id, "user_isolation_update");
    assert.equal(audits.length, 1);
    assert.equal((JSON.parse(audits[0]!.metadataJson!) as { enabled: boolean }).enabled, true);

    // Refused for adults (the mode is minor-only).
    const adult = await createUser(db, { birthdate: ADULT_DOB });
    const adultRes = await patchUser(adminTok, adult.id, { isolateFromAdults: true });
    assert.equal(adultRes.statusCode, 400);
    assert.equal((await userRow(adult.id)).isolateFromAdults, false);

    // Clearing a stale flag on an account that aged out with it set is
    // plain housekeeping and always allowed.
    const agedOut = await createUser(db, { birthdate: ADULT_DOB });
    await db.update(users).set({ isolateFromAdults: true }).where(eq(users.id, agedOut.id));
    const clearRes = await patchUser(adminTok, agedOut.id, { isolateFromAdults: false });
    assert.equal(clearRes.statusCode, 200);
    assert.equal((await userRow(agedOut.id)).isolateFromAdults, false);

    // No audit row for a no-op (already-false stays false).
    const noop = await createUser(db, { birthdate: MINOR_DOB });
    const noopRes = await patchUser(adminTok, noop.id, { isolateFromAdults: false });
    assert.equal(noopRes.statusCode, 200);
    assert.equal((await auditRowsFor(noop.id, "user_isolation_update")).length, 0);
  });

  test("a dob correction and isolation may land in one patch (validated against the NEW date)", async () => {
    // The support case: "the date was wrong, fix it AND isolate them."
    // Isolation must validate against the date being written, not the
    // stale adult one, or the combined patch would 400.
    const admin = await createUser(db, { role: "admin" });
    const adminTok = await tokenFor(db, admin.id);
    const target = await createUser(db, { birthdate: ADULT_DOB });

    const res = await patchUser(adminTok, target.id, { dob: MINOR_DOB, isolateFromAdults: true });
    assert.equal(res.statusCode, 200);
    const row = await userRow(target.id);
    assert.equal(row.birthdate, MINOR_DOB);
    assert.equal(row.isolateFromAdults, true);
  });
});
