import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { ts } from "./_helpers.js";
import { users } from "./users.js";

/* ---------- role_permission_grants ----------
 * Phase 1 of the granular permission system (migration 0179). One row per
 * (role, permission_key) pair. Holds which permissions each role tier has
 * by default. Masteradmin has no row here, its bypass is hardcoded in
 * `apps/server/src/auth/permissions.ts`. See plan.md for the catalog +
 * resolution precedence (masteradmin > user override > role grant > deny).
 */
export const rolePermissionGrants = sqliteTable(
  "role_permission_grants",
  {
    role: text("role").notNull(),
    permissionKey: text("permission_key").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.role, t.permissionKey] }),
    roleIdx: index("role_permission_grants_role_idx").on(t.role),
  }),
);

/* ---------- user_permission_overrides ----------
 * Per-user grants/revokes that layer on top of the role grants. Lets the
 * install give a specific user a single extra power (or take one away)
 * without minting a new role tier. Starts empty after migration 0179; the
 * Phase-2 matrix UI's "By user" sub-tab fills it.
 *
 * `granted = 1` → explicit grant (the user has this permission even if
 *                 their role doesn't);
 * `granted = 0` → explicit revoke (the user does NOT have this permission
 *                 even if their role grants it).
 * Absence of a row → fall back to the role grant.
 */
export const userPermissionOverrides = sqliteTable(
  "user_permission_overrides",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key").notNull(),
    granted: integer("granted", { mode: "boolean" }).notNull(),
    setByUserId: text("set_by_user_id")
      .notNull()
      .references(() => users.id),
    setAt: ts("set_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.permissionKey] }),
    userIdx: index("user_permission_overrides_user_idx").on(t.userId),
  }),
);

export type DbRolePermissionGrant = typeof rolePermissionGrants.$inferSelect;
export type DbUserPermissionOverride = typeof userPermissionOverrides.$inferSelect;
