/**
 * Permission-system diagnostics — pure check engine.
 *
 * Walks a `PermissionsCache` snapshot (plus optional "live state" hints
 * like the set of known user ids) through every safety invariant the
 * granular-permission system relies on, and returns a structured
 * pass/fail report. Pure: no DB, no IO. Callers (the admin endpoint
 * and the `scripts/check-permissions.ts` CLI) feed in the data and
 * render the report however they like.
 *
 * **Why pure?** The same checks need to run in three places:
 *
 *   1. CI / dev — against the *seed* SQL parsed off disk. No live DB.
 *   2. Production admin button — against the *live* cache loaded from
 *      `role_permission_grants` + `user_permission_overrides`.
 *   3. Future: against a *prospective* edit before commit (preview
 *      "if I toggle this, does it leak a masteradmin-only key?").
 *
 * All three want the same logic; keeping it pure avoids three drifting
 * copies.
 *
 * Check taxonomy (returned `group` field):
 *
 *   - "resolver"    — invariants the pure resolver should always
 *                     uphold (masteradmin bypass, override
 *                     precedence). Sanity smoke test; if any fails the
 *                     codebase is broken, not the install.
 *   - "live-state"  — catches drift in the live tables: orphan rows
 *                     (key removed from catalog, user deleted),
 *                     masteradmin-only key leaked to a lower role,
 *                     fallback unexpectedly engaged.
 *   - "meta"        — the diagnostics suite itself catches its own
 *                     drift (e.g., catalog coverage in the shared
 *                     PERMISSION_GROUPS table).
 */

import {
  PERMISSION_GROUPS,
  PERMISSION_KEYS,
  type PermissionGroup,
  type PermissionKey,
  type Role,
} from "@thekeep/shared";
import { resolveAgainst, type PermissionsCache } from "./permissionsCore.js";

const NON_MASTERADMIN_ROLES: readonly Role[] = ["user", "trusted", "mod", "admin"] as const;

/** Categorization shown in the admin UI's per-group rollup. The
 *  resolver smoke-tests are tagged with the actual permission group
 *  of the key they exercise (chat_moderation, user_admin, …) so a
 *  regression in one feature area is visible at a glance. */
export type DiagnosticGroup = PermissionGroup | "live-state" | "meta";

export interface DiagnosticFailure {
  /** Where in the report this failure shows up. */
  group: DiagnosticGroup;
  /** One-line rule the failure violated, e.g. "masteradmin bypass",
   *  "override revoke beats role", "live: orphan catalog key". */
  rule: string;
  /** Role under test, when applicable. */
  role?: Role | string;
  /** Permission key under test, when applicable. */
  key?: string;
  /** Userid under test, when applicable. */
  userId?: string;
  /** Expected resolver answer. */
  expected?: boolean;
  /** Actual resolver answer. */
  actual?: boolean;
  /** Free-form context (e.g., "user no longer exists"). */
  note?: string;
}

export interface DiagnosticsResult {
  /** Total checks executed. */
  checksRun: number;
  /** Failure entries. Empty array = all green. */
  failures: DiagnosticFailure[];
  /** Convenience: derived from `failures.length === 0`. */
  ok: boolean;
  /** Per-group rollup: how many checks ran, how many failed. The UI
   *  uses this to render the green/red row per permission area. */
  byGroup: Array<{ group: DiagnosticGroup; run: number; failed: number }>;
}

/**
 * Inputs the diagnostics suite needs that go beyond the `PermissionsCache`
 * itself. `knownUserIds` is optional — when omitted the
 * orphan-override-user check is skipped (so CI can run pure-resolver
 * checks without faking the users table).
 */
export interface DiagnosticsInputs {
  /** Live cache snapshot. Required. */
  cache: PermissionsCache;
  /** Set of user ids that exist in the `users` table. When provided,
   *  the suite checks that every userOverride row references a real
   *  user. Skip the check if absent. */
  knownUserIds?: ReadonlySet<string>;
}

/**
 * Run every check appropriate to the given inputs. Returns a structured
 * report — caller renders it (CLI → ANSI summary, admin UI → React).
 */
export function runPermissionsDiagnostics(input: DiagnosticsInputs): DiagnosticsResult {
  const failures: DiagnosticFailure[] = [];
  const counts = new Map<DiagnosticGroup, { run: number; failed: number }>();

  function record(group: DiagnosticGroup): void {
    const cur = counts.get(group) ?? { run: 0, failed: 0 };
    cur.run += 1;
    counts.set(group, cur);
  }
  function fail(f: DiagnosticFailure): void {
    failures.push(f);
    const cur = counts.get(f.group) ?? { run: 0, failed: 0 };
    cur.failed += 1;
    counts.set(f.group, cur);
  }
  function groupFor(key: PermissionKey): PermissionGroup {
    return PERMISSION_GROUPS[key];
  }
  function withOverride(
    base: PermissionsCache,
    userId: string,
    key: PermissionKey,
    granted: boolean,
  ): PermissionsCache {
    const overrides = new Map(base.userOverrides);
    const inner = new Map(overrides.get(userId) ?? []);
    inner.set(key, granted);
    overrides.set(userId, inner);
    return { ...base, userOverrides: overrides };
  }

  const { cache, knownUserIds } = input;

  /* =====================================================================
   * Meta: catalog coverage
   * Compile-time enforced via `Record<PermissionKey, PermissionGroup>` in
   * shared/permissions.ts but a runtime check surfaces issues earlier.
   * ===================================================================== */
  for (const key of PERMISSION_KEYS) {
    record("meta");
    if (!PERMISSION_GROUPS[key]) {
      fail({ group: "meta", rule: "catalog key missing from PERMISSION_GROUPS", key, note: "no group" });
    }
  }

  /* =====================================================================
   * Resolver: masteradmin bypass
   * For every catalog key, masteradmin must resolve true regardless of
   * grants, overrides, or fallback. The root of trust.
   * ===================================================================== */
  for (const key of PERMISSION_KEYS) {
    const g = groupFor(key);
    record(g);
    const actual = resolveAgainst(cache, { id: "M_diag", role: "masteradmin" }, key);
    if (!actual) {
      fail({ group: g, rule: "masteradmin bypass", role: "masteradmin", key, expected: true, actual });
    }
  }

  /* =====================================================================
   * Resolver: user override grant beats role
   * Picking a user id that doesn't appear in `cache.userOverrides` so
   * we test against a clean slate per check. (`__diag_grant` is a
   * sentinel — no real user has it.)
   * ===================================================================== */
  for (const role of NON_MASTERADMIN_ROLES) {
    for (const key of PERMISSION_KEYS) {
      const g = groupFor(key);
      record(g);
      const probe = withOverride(cache, "__diag_grant", key, true);
      const actual = resolveAgainst(probe, { id: "__diag_grant", role }, key);
      if (!actual) {
        fail({ group: g, rule: "override grant beats role", role, key, expected: true, actual });
      }
    }
  }

  /* =====================================================================
   * Resolver: user override revoke beats role
   * Same idea, opposite direction.
   * ===================================================================== */
  for (const role of NON_MASTERADMIN_ROLES) {
    for (const key of PERMISSION_KEYS) {
      const g = groupFor(key);
      record(g);
      const probe = withOverride(cache, "__diag_revoke", key, false);
      const actual = resolveAgainst(probe, { id: "__diag_revoke", role }, key);
      if (actual) {
        fail({ group: g, rule: "override revoke beats role", role, key, expected: false, actual });
      }
    }
  }

  /* =====================================================================
   * Resolver: masteradmin ignores override revoke
   * Bypass wins over the override layer — you can't strand the install
   * by toggling your own row off.
   * ===================================================================== */
  for (const key of PERMISSION_KEYS) {
    const g = groupFor(key);
    record(g);
    const probe = withOverride(cache, "__diag_master_revoke", key, false);
    const actual = resolveAgainst(probe, { id: "__diag_master_revoke", role: "masteradmin" }, key);
    if (!actual) {
      fail({ group: g, rule: "masteradmin ignores revoke override", role: "masteradmin", key, expected: true, actual });
    }
  }

  /* =====================================================================
   * Live state: fallback engaged
   * If `cache.fallback === true` the table is empty — the install is
   * running on legacy `isAdminRole` defaults. Loud single failure so
   * an admin can repair the seed.
   * ===================================================================== */
  record("live-state");
  if (cache.fallback) {
    fail({
      group: "live-state",
      rule: "fallback engaged",
      note: "role_permission_grants is empty; resolver is using legacy isAdminRole defaults. " +
        "Re-apply 0179_permission_grants.sql's seed.",
    });
  }

  /* =====================================================================
   * Live state: orphan permission keys in role grants
   * A key in the live cache that's no longer in the catalog. Possible
   * after a permission is renamed/removed; the row should be cleaned
   * up to keep the matrix accurate.
   * ===================================================================== */
  const validKeys = new Set<PermissionKey>(PERMISSION_KEYS);
  for (const [role, keys] of cache.roleGrants.entries()) {
    for (const key of keys) {
      record("live-state");
      if (!validKeys.has(key)) {
        fail({
          group: "live-state",
          rule: "orphan catalog key in role grants",
          role,
          key,
          note: "Key no longer exists in PERMISSION_KEYS. DELETE the row or rename it.",
        });
      }
    }
  }

  /* =====================================================================
   * Live state: orphan permission keys in user overrides
   * Same idea, override side.
   * ===================================================================== */
  for (const [userId, inner] of cache.userOverrides.entries()) {
    for (const [key] of inner.entries()) {
      record("live-state");
      if (!validKeys.has(key)) {
        fail({
          group: "live-state",
          rule: "orphan catalog key in user overrides",
          userId,
          key,
          note: "Key no longer exists in PERMISSION_KEYS. DELETE the row.",
        });
      }
    }
  }

  /* =====================================================================
   * Live state: orphan override users
   * Override row references a user that no longer exists. Foreign-key
   * cascade should prevent this, but the check is cheap and would
   * catch a manual DB edit.
   * ===================================================================== */
  if (knownUserIds) {
    for (const userId of cache.userOverrides.keys()) {
      record("live-state");
      if (!knownUserIds.has(userId)) {
        fail({
          group: "live-state",
          rule: "override row references missing user",
          userId,
          note: "user_permission_overrides points to a userId no longer in users table.",
        });
      }
    }
  }

  /* =====================================================================
   * NOTE: there is intentionally NO check here for "masteradmin-only
   * key granted to a lower role / user." The `MASTERADMIN_ONLY_KEYS`
   * set in `permissionsCore.ts` is the FALLBACK DEFAULT (consulted
   * only when the role_permission_grants table is empty), not an
   * enforcement boundary. The whole point of the matrix is that a
   * masteradmin can extend any non-masteradmin-bypass key to whichever
   * role or user they trust. Flagging those grants as failures would
   * defeat the system. The `SensitiveGrantsAdvisory` panel in the UI
   * surfaces who currently holds privacy-sensitive + high-impact keys
   * as an informational catalog instead.
   * ===================================================================== */

  /* =====================================================================
   * Live state: every role with grants is in the editable role set
   * The seed only writes rows for "user / trusted / mod / admin". A
   * row for any other role is a corruption (or a future feature that
   * forgot to update this check).
   * ===================================================================== */
  const editableRoles = new Set<string>(NON_MASTERADMIN_ROLES);
  for (const role of cache.roleGrants.keys()) {
    record("live-state");
    if (!editableRoles.has(role)) {
      fail({
        group: "live-state",
        rule: "role grants reference unknown role",
        role,
        note: `Role '${role}' is not in the editable role set (${[...editableRoles].join(", ")}).`,
      });
    }
  }

  // Build sorted rollup for the UI. Order: permission groups in catalog
  // order, then live-state, then meta.
  const groupOrder: DiagnosticGroup[] = [];
  const seenInGroups = new Set<DiagnosticGroup>();
  for (const key of PERMISSION_KEYS) {
    const g = PERMISSION_GROUPS[key];
    if (!seenInGroups.has(g)) {
      seenInGroups.add(g);
      groupOrder.push(g);
    }
  }
  groupOrder.push("live-state", "meta");

  const byGroup: Array<{ group: DiagnosticGroup; run: number; failed: number }> = [];
  for (const g of groupOrder) {
    const c = counts.get(g);
    if (c) byGroup.push({ group: g, run: c.run, failed: c.failed });
  }

  const checksRun = Array.from(counts.values()).reduce((n, c) => n + c.run, 0);

  return {
    checksRun,
    failures,
    ok: failures.length === 0,
    byGroup,
  };
}
