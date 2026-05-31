/**
 * Pure resolver core for the granular permission system.
 *
 * Separated from `permissions.ts` (which owns the DB-backed cache and
 * the `hasPermission` IO wrapper) so that:
 *
 *   1. `scripts/check-permissions.ts` can exercise every precedence
 *      rule against hand-built fixture snapshots without pulling
 *      better-sqlite3 into the import graph.
 *   2. The pure logic and the IO layer are not entangled — easier to
 *      reason about, easier to test, easier to swap caches later.
 *
 * Everything here is sync + pure. No DB awareness, no global state.
 * If you find yourself reaching for `db` or `console`, the code
 * belongs in `permissions.ts`, not here.
 */

import { isAdminRole, isMasterAdminRole, type PermissionKey, type Role } from "@thekeep/shared";

/**
 * Snapshot of the two grants tables, normalized for O(1) lookup.
 *
 * `roleGrants`     — role → set of catalog keys the role holds.
 * `userOverrides`  — userId → (key → granted boolean). `true` = explicit
 *                    grant, `false` = explicit revoke. Absence of an
 *                    inner entry = "fall back to role grant."
 * `fallback`       — true iff `role_permission_grants` had zero rows
 *                    when the cache was loaded. Engages the legacy
 *                    `isAdminRole` fallback so an empty table can't
 *                    strand admins out of the matrix UI.
 */
export interface PermissionsCache {
  roleGrants: Map<Role, Set<PermissionKey>>;
  userOverrides: Map<string, Map<PermissionKey, boolean>>;
  fallback: boolean;
}

/**
 * Catalog keys whose seed default is masteradmin-only. Consulted ONLY
 * by the empty-table fallback path — once the table is seeded, the
 * grants themselves drive the answer. Kept in sync with the
 * masteradmin-only set called out in `drizzle/0179_permission_grants.sql`'s
 * seed block. If you change one, change the other.
 *
 * `scripts/check-permissions.ts` keeps its own copy of this set and
 * asserts both directions: the resolver behaves correctly under
 * fallback, AND the seed leaks none of these keys to a lower role.
 */
export const MASTERADMIN_ONLY_KEYS: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  "reset_user_password",
  "hard_delete_user",
  "edit_user_email",
  "disable_user",
  "enable_user",
  "view_admin_backups",
  "manage_backups",
  "view_admin_settings",
  "edit_site_settings",
  "view_admin_branding",
  "view_admin_rules",
  "upload_logo",
  "edit_earning_sensitive",
  "manage_permissions",
]);

/**
 * The canonical precedence chain. Pure: given a snapshot and a (user,
 * key) pair, returns whether the user holds that permission.
 *
 *   1. Masteradmin bypass — hardcoded, always true.
 *   2. User override layer — explicit grant or revoke wins over role.
 *   3. Empty-table fallback — only when `fallback === true`.
 *   4. Role grant.
 *   5. Default deny.
 */
export function resolveAgainst(
  c: PermissionsCache,
  user: { id: string; role: Role },
  key: PermissionKey,
): boolean {
  // 1. Masteradmin bypass — hardcoded.
  if (isMasterAdminRole(user.role)) return true;

  // 2. User override layer. Explicit grant or revoke takes precedence
  //    over the role grant — that's the whole point of an override.
  const overrides = c.userOverrides.get(user.id);
  if (overrides) {
    const explicit = overrides.get(key);
    if (explicit !== undefined) return explicit;
  }

  // 3. Defensive fallback when the grants table is empty. Mirrors the
  //    legacy isAdminRole / isMasterAdminRole defaults so the install
  //    stays operable until someone repopulates the table. The
  //    fallback intentionally undershoots the catalog (a few catalog
  //    keys were masteradmin-only by hardcoded rule even in the
  //    legacy world) — restoring the seed is the right fix.
  if (c.fallback) {
    if (MASTERADMIN_ONLY_KEYS.has(key)) {
      return false; // masteradmin already returned true above.
    }
    return isAdminRole(user.role);
  }

  // 4. Role grant.
  const grants = c.roleGrants.get(user.role);
  if (grants?.has(key)) return true;

  // 5. Default deny.
  return false;
}
