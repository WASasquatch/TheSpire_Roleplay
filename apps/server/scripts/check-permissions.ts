/**
 * Granular-permission system self-check (CLI).
 *
 * Thin wrapper around `runPermissionsDiagnostics` in
 * `src/auth/permissionsDiagnostics.ts`. The same engine powers the
 * admin Permissions tab's "Run integrity check" button, keeping the
 * two callers in lockstep means a check that passes in CI cannot
 * mysteriously fail in production (or vice versa).
 *
 * What's different from the admin endpoint:
 *
 *   - We don't have a live DB; we synthesize a `PermissionsCache` by
 *     parsing the seed SQL in `drizzle/0179_permission_grants.sql`.
 *     The cache built this way matches what a fresh-install resolver
 *     would see right after migration.
 *   - We additionally cover the "fresh-install with empty grants
 *     table" case by running a separate pass with `fallback: true`,
 *     the admin endpoint observes whatever the live cache is, but the
 *     CLI proves the fallback path itself is sound (sensitive keys
 *     stay locked, admins still see the moderation surface).
 *
 * Run:
 *   pnpm --filter @thekeep/server run permissions:check
 *
 * Exit code:
 *   0 = all green
 *   1 = at least one failure
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PERMISSION_GROUPS,
  PERMISSION_KEYS,
  type PermissionGroup,
  type PermissionKey,
  type Role,
} from "@thekeep/shared";

import {
  MASTERADMIN_ONLY_KEYS,
  resolveAgainst,
  type PermissionsCache,
} from "../src/auth/permissionsCore.js";
import {
  runPermissionsDiagnostics,
  type DiagnosticFailure,
  type DiagnosticGroup,
} from "../src/auth/permissionsDiagnostics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_SQL_PATH = resolve(__dirname, "../drizzle/0179_permission_grants.sql");

const ALL_ROLES: readonly Role[] = ["user", "trusted", "mod", "admin", "masteradmin"] as const;

// ===== Seed loader =====

/**
 * Parse the `INSERT INTO role_permission_grants` block out of the
 * Phase-1 migration. The CLI uses this to synthesize a cache that
 * matches what the live install will see post-migration.
 */
function loadSeed(): Map<Role, Set<PermissionKey>> {
  if (!existsSync(SEED_SQL_PATH)) {
    throw new Error(`Seed SQL not found at ${SEED_SQL_PATH}`);
  }
  const sql = readFileSync(SEED_SQL_PATH, "utf8");
  const insertMatch = sql.match(/INSERT\s+INTO\s+`role_permission_grants`[^;]*;/i);
  if (!insertMatch) {
    throw new Error("Could not find INSERT INTO `role_permission_grants` in 0179 migration");
  }
  const tupleRe = /\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g;
  const grants = new Map<Role, Set<PermissionKey>>();
  let m: RegExpExecArray | null;
  while ((m = tupleRe.exec(insertMatch[0])) !== null) {
    const role = m[1] as Role;
    const key = m[2] as PermissionKey;
    if (!PERMISSION_KEYS.includes(key)) {
      throw new Error(`Seed references unknown permission key: ${key}`);
    }
    const set = grants.get(role) ?? new Set<PermissionKey>();
    set.add(key);
    grants.set(role, set);
  }
  if (grants.size === 0) {
    throw new Error("Seed parser found zero (role, key) tuples, check regex");
  }
  return grants;
}

// ===== Extra CLI-only checks =====

/**
 * Seed baseline: each (role, key) pair must match what the migration
 * declares. Catches a future seed edit that doesn't update the
 * fallback set, or a rename mismatch between catalog and SQL. The
 * admin endpoint can't run this, live grants legitimately drift from
 * the seed once admins start using the matrix UI.
 */
function checkSeedBaseline(seed: PermissionsCache): DiagnosticFailure[] {
  const failures: DiagnosticFailure[] = [];
  const nonMaster = ALL_ROLES.filter((r) => r !== "masteradmin");
  for (const role of nonMaster) {
    const grantsForRole = seed.roleGrants.get(role) ?? new Set<PermissionKey>();
    for (const key of PERMISSION_KEYS) {
      const expected = grantsForRole.has(key);
      const actual = resolveAgainst(seed, { id: `U-${role}`, role }, key);
      if (actual !== expected) {
        failures.push({
          group: PERMISSION_GROUPS[key],
          rule: `${role} seed baseline`,
          role, key, expected, actual,
        });
      }
    }
  }
  return failures;
}

/**
 * Empty-table fallback proof: with no role grants and fallback=true,
 * the resolver must replicate legacy `isAdminRole` exactly (sensitive
 * keys locked to masteradmin, others available to admin only). The
 * admin endpoint only sees whatever the live cache happens to be; the
 * CLI proves the path itself works.
 */
function checkFallback(): DiagnosticFailure[] {
  const empty: PermissionsCache = {
    roleGrants: new Map(),
    userOverrides: new Map(),
    fallback: true,
  };
  const failures: DiagnosticFailure[] = [];
  for (const role of ALL_ROLES) {
    for (const key of PERMISSION_KEYS) {
      let expected: boolean;
      if (role === "masteradmin") expected = true;
      else if (MASTERADMIN_ONLY_KEYS.has(key)) expected = false;
      else if (role === "admin") expected = true;
      else expected = false;
      const actual = resolveAgainst(empty, { id: `x-${role}`, role }, key);
      if (actual !== expected) {
        failures.push({
          group: PERMISSION_GROUPS[key],
          rule: `fallback ${role}`,
          role, key, expected, actual,
        });
      }
    }
  }
  return failures;
}

/**
 * Meta: seed must not grant a masteradmin-only key to a lower role.
 * Live data has the same check inside `runPermissionsDiagnostics`,
 * but proving the SEED is clean is a CI-grade concern.
 */
function checkSeedDoesNotLeakMasteradminKeys(seed: PermissionsCache): DiagnosticFailure[] {
  const failures: DiagnosticFailure[] = [];
  const nonMaster = ALL_ROLES.filter((r) => r !== "masteradmin");
  for (const role of nonMaster) {
    const grants = seed.roleGrants.get(role) ?? new Set<PermissionKey>();
    for (const key of MASTERADMIN_ONLY_KEYS) {
      if (grants.has(key)) {
        failures.push({
          group: "meta",
          rule: "seed must not grant masteradmin-only key to lower role",
          role, key, expected: false, actual: true,
        });
      }
    }
  }
  return failures;
}

// ===== Pretty reporter =====

const GROUP_LABEL: Record<DiagnosticGroup, string> = {
  chat_moderation: "Chat moderation",
  room_admin: "Room administration",
  arcade: "Spire Arcade",
  user_admin: "User administration",
  site_admin: "Site administration",
  content_admin: "Content moderation",
  audit_view: "Audit & reports (read)",
  admin_panel_tabs: "Admin panel tabs",
  earning_admin: "Earning system",
  backups: "Backups",
  permission_admin: "Permissions matrix",
  "live-state": "Live state integrity",
  meta: "Meta (seed integrity)",
};

function colorize(s: string, code: number): string {
  if (!process.stdout.isTTY) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}
const green = (s: string) => colorize(s, 32);
const red = (s: string) => colorize(s, 31);
const dim = (s: string) => colorize(s, 90);
const bold = (s: string) => colorize(s, 1);

function report(
  rollup: Array<{ group: DiagnosticGroup; run: number; failed: number }>,
  failures: DiagnosticFailure[],
): void {
  console.log(bold("\nGranular permission system, self-check\n"));

  let totalRun = 0;
  let totalFailed = 0;
  for (const row of rollup) {
    totalRun += row.run;
    totalFailed += row.failed;
    const passed = row.run - row.failed;
    const status = row.failed === 0 ? green("PASS") : red(`FAIL (${row.failed})`);
    console.log(`  ${status}  ${(GROUP_LABEL[row.group] ?? row.group).padEnd(28)} ${dim(`${passed}/${row.run} checks`)}`);
  }

  if (failures.length > 0) {
    console.log(bold(red(`\nFailures (${failures.length}):\n`)));
    for (const f of failures.slice(0, 50)) {
      const where = [f.role, f.key, f.userId].filter(Boolean).join(" × ") || "-";
      const exp = f.expected === undefined ? "" : ` expected=${f.expected}`;
      const act = f.actual === undefined ? "" : ` actual=${f.actual}`;
      console.log(`  ${red("✗")} [${f.group}] ${f.rule}: ${where}${exp}${act}${f.note ? `, ${f.note}` : ""}`);
    }
    if (failures.length > 50) {
      console.log(dim(`  …and ${failures.length - 50} more`));
    }
  }

  console.log(
    bold(
      `\n${totalFailed === 0 ? green("ALL GREEN") : red(`${totalFailed} FAILED`)}, ${totalRun - totalFailed}/${totalRun} checks passed\n`,
    ),
  );
}

// ===== Main =====

function main(): void {
  const seedGrants = loadSeed();
  const seed: PermissionsCache = {
    roleGrants: seedGrants,
    userOverrides: new Map(),
    fallback: false,
  };

  // Run the shared diagnostics engine first, same checks the admin
  // endpoint runs against the live cache.
  const shared = runPermissionsDiagnostics({ cache: seed });

  // Then layer on CLI-only checks (seed baseline, empty-table
  // fallback, seed-leak meta). Merge their failures into one report.
  const seedBaseline = checkSeedBaseline(seed);
  const fallback = checkFallback();
  const meta = checkSeedDoesNotLeakMasteradminKeys(seed);

  // Compose the per-group rollup from shared + each CLI-only suite.
  // Start with the shared engine's rollup, then add the CLI-only
  // suites' check counts and failure counts by group.
  const cliCounts = new Map<DiagnosticGroup, { run: number; failed: number }>();
  for (const row of shared.byGroup) cliCounts.set(row.group, { run: row.run, failed: row.failed });

  function bump(group: DiagnosticGroup, run: number, failed: number): void {
    const cur = cliCounts.get(group) ?? { run: 0, failed: 0 };
    cur.run += run;
    cur.failed += failed;
    cliCounts.set(group, cur);
  }

  // Seed baseline: 4 non-master roles × every catalog key.
  for (const key of PERMISSION_KEYS) bump(PERMISSION_GROUPS[key], 4, 0);
  for (const f of seedBaseline) bump(f.group, 0, 1);

  // Fallback: 5 roles × every catalog key.
  for (const key of PERMISSION_KEYS) bump(PERMISSION_GROUPS[key], 5, 0);
  for (const f of fallback) bump(f.group, 0, 1);

  // Meta: 4 non-master roles × MASTERADMIN_ONLY_KEYS.size.
  bump("meta", 4 * MASTERADMIN_ONLY_KEYS.size, meta.length);

  // Rebuild ordered rollup.
  const groupOrder: DiagnosticGroup[] = [];
  const seen = new Set<DiagnosticGroup>();
  for (const key of PERMISSION_KEYS) {
    const g = PERMISSION_GROUPS[key];
    if (!seen.has(g)) { seen.add(g); groupOrder.push(g); }
  }
  groupOrder.push("live-state", "meta");
  const orderedRollup: Array<{ group: DiagnosticGroup; run: number; failed: number }> = [];
  for (const g of groupOrder) {
    const c = cliCounts.get(g);
    if (c && c.run > 0) orderedRollup.push({ group: g, run: c.run, failed: c.failed });
  }

  const allFailures = [...shared.failures, ...seedBaseline, ...fallback, ...meta];
  report(orderedRollup, allFailures);

  process.exit(allFailures.length === 0 ? 0 : 1);
}

main();
