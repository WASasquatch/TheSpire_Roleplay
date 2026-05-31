/**
 * Admin — Roles & Permissions matrix endpoints.
 *
 * Wired from inside `registerAdminRoutes` so the coarse `view_admin_*`
 * gate already covers these routes. Each handler then enforces the
 * specific permission needed: `view_admin_permissions` to read the
 * matrix, `manage_permissions` to mutate it. Both default to
 * masteradmin-only via the migration seed.
 *
 * Endpoint shapes:
 *
 *   GET    /admin/permissions             → matrix snapshot:
 *                                            { roles: Record<Role, PermissionKey[]>,
 *                                              userOverrides: Array<{ userId, username, role, overrides: { granted: PermissionKey[], revoked: PermissionKey[] } }> }
 *                                            The catalog itself is shipped in
 *                                            `@thekeep/shared` so the matrix
 *                                            doesn't need to bundle it on the
 *                                            wire.
 *
 *   PATCH  /admin/permissions/roles       → flip one (role, permissionKey) row
 *                                            on/off. Body: { role, permissionKey, granted }.
 *
 *   PATCH  /admin/permissions/users       → upsert / clear one user override.
 *                                            Body: { userId, permissionKey, granted: true | false | null }.
 *                                            `null` clears the row (falls back
 *                                            to role grant).
 *
 *   GET    /admin/permissions/users/search?q=… → typeahead lookup for the
 *                                            By-user sub-tab.
 *
 * Hardcoded refusals (NOT matrix-toggleable):
 *  - masteradmin role row — every key is implicit, no rows in the table.
 *    The PATCH endpoint refuses `role === "masteradmin"`.
 *  - self-edit — actor can't change their own user_id's overrides.
 *    Mirrors the `users.ts:/admin/users/:id` self-edit guard.
 *  - non-catalog keys — the body is validated against `PERMISSION_KEYS`
 *    so an unknown string can't sneak into the table.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  PERMISSION_DESCRIPTIONS,
  PERMISSION_GROUPS,
  PERMISSION_KEYS,
  PRIVACY_SENSITIVE_KEYS,
  isPermissionKey,
  type PermissionKey,
  type Role,
} from "@thekeep/shared";
import { rolePermissionGrants, userPermissionOverrides, users } from "../db/schema.js";
import { invalidatePermissionsCache, reloadPermissionsSnapshot } from "../auth/permissions.js";
import { runPermissionsDiagnostics } from "../auth/permissionsDiagnostics.js";
import { requireSessionPermission } from "../auth/requireSessionPermission.js";
import { recordAudit } from "../audit.js";
import type { Db } from "../db/index.js";

/** Roles the matrix can edit. Masteradmin is intentionally excluded —
 *  the tier has no grants table row and the bypass is hardcoded; a
 *  PATCH attempting to set its row is refused with a 400 so an admin
 *  who's confused about the contract gets a clear error rather than
 *  a silent write that doesn't take effect. */
const EDITABLE_ROLES: readonly Role[] = ["user", "trusted", "mod", "admin"] as const;

function isEditableRole(role: string): role is Role {
  return (EDITABLE_ROLES as readonly string[]).includes(role);
}

const rolePatchBody = z.object({
  role: z.string().min(1).max(40),
  permissionKey: z.string().min(1).max(80),
  granted: z.boolean(),
}).strict();

const userPatchBody = z.object({
  userId: z.string().min(1).max(80),
  permissionKey: z.string().min(1).max(80),
  /** null clears the row — the user falls back to their role grant. */
  granted: z.boolean().nullable(),
}).strict();

/**
 * Mount the matrix endpoints. The caller (`admin/routes.ts`) has
 * already attached the admin-tab `preHandler` gate, so handlers can
 * assume `req.sessionUser` is set.
 */
export function registerAdminPermissionRoutes(
  app: FastifyInstance,
  deps: { db: Db },
): void {
  const { db } = deps;

  /** Thin closure over the shared `requireSessionPermission` helper
   *  so call sites in this file don't have to thread `db` through
   *  every call. */
  const requireMatrixPermission = (
    req: FastifyRequest,
    reply: FastifyReply,
    key: PermissionKey,
  ) => requireSessionPermission(req, reply, key, db);

  /* ---------- GET /admin/permissions ----------
   * Matrix snapshot. Per-role grants are flat arrays so the client can
   * intersect against `PERMISSION_KEYS` for checkbox state without a
   * server round-trip per cell. Per-user overrides come pre-resolved
   * + paginated to the active set; an admin who wants to grant a NEW
   * user a privilege uses the search endpoint below to find them.
   */
  app.get("/admin/permissions", async (req, reply) => {
    if (!(await requireMatrixPermission(req, reply, "view_admin_permissions"))) return;

    const roleRows = await db.select().from(rolePermissionGrants);
    const overrideRows = await db
      .select({
        userId: userPermissionOverrides.userId,
        permissionKey: userPermissionOverrides.permissionKey,
        granted: userPermissionOverrides.granted,
        setByUserId: userPermissionOverrides.setByUserId,
        setAt: userPermissionOverrides.setAt,
        username: users.username,
        role: users.role,
      })
      .from(userPermissionOverrides)
      .innerJoin(users, eq(users.id, userPermissionOverrides.userId))
      .orderBy(asc(users.username), asc(userPermissionOverrides.permissionKey));

    // Per-role bucket. Pre-create entries for every editable role so
    // the matrix UI doesn't have to handle "missing role" specially
    // (it can iterate over `EDITABLE_ROLES` and trust the lookup).
    const roleGrants: Record<string, PermissionKey[]> = {};
    for (const r of EDITABLE_ROLES) roleGrants[r] = [];
    for (const r of roleRows) {
      if (isEditableRole(r.role) && isPermissionKey(r.permissionKey)) {
        roleGrants[r.role]!.push(r.permissionKey);
      }
    }
    // Stable order per role so a row-diff between two snapshots is
    // small. Catalog order matches `PERMISSION_KEYS` to keep parity
    // with the matrix UI's column order.
    const catalogOrder = new Map<PermissionKey, number>();
    PERMISSION_KEYS.forEach((k, i) => catalogOrder.set(k, i));
    for (const role of Object.keys(roleGrants)) {
      roleGrants[role]!.sort(
        (a, b) => (catalogOrder.get(a) ?? 0) - (catalogOrder.get(b) ?? 0),
      );
    }

    // Per-user bucket. Group by userId so each row in the UI is a
    // single "user has overrides X granted + Y revoked" summary.
    interface UserOverrideSummary {
      userId: string;
      username: string;
      role: Role;
      granted: PermissionKey[];
      revoked: PermissionKey[];
    }
    const userByKey = new Map<string, UserOverrideSummary>();
    for (const o of overrideRows) {
      if (!isPermissionKey(o.permissionKey)) continue;
      const existing = userByKey.get(o.userId) ?? {
        userId: o.userId,
        username: o.username,
        role: o.role as Role,
        granted: [] as PermissionKey[],
        revoked: [] as PermissionKey[],
      };
      if (o.granted) existing.granted.push(o.permissionKey);
      else existing.revoked.push(o.permissionKey);
      userByKey.set(o.userId, existing);
    }

    return {
      roles: roleGrants,
      userOverrides: Array.from(userByKey.values()),
    };
  });

  /* ---------- GET /admin/permissions/diagnostics ----------
   * Run the granular-permission self-check against the LIVE cache.
   * Same engine as the `scripts/check-permissions.ts` CLI, but fed by
   * the running install's `role_permission_grants` +
   * `user_permission_overrides` so the report reflects the actual
   * state of the database, not a synthesized seed snapshot.
   *
   * Gated on `view_admin_permissions` (you can already see the matrix,
   * so you can see its diagnostics). No mutation, so no audit-log
   * entry — pure read.
   *
   * Returns the full `DiagnosticsResult` shape from the diagnostics
   * module so the client can render the per-group rollup and any
   * failure list directly without re-bucketing.
   */
  app.get("/admin/permissions/diagnostics", async (req, reply) => {
    if (!(await requireMatrixPermission(req, reply, "view_admin_permissions"))) return;

    // Force-reload the cache so a check run immediately after a
    // matrix edit observes the post-edit state. The invalidation
    // hooks inside the PATCH handlers already do this, but the
    // belt-and-braces reload here means a diagnostics run is always
    // authoritative even if some future code path forgets to
    // invalidate.
    const cache = await reloadPermissionsSnapshot(db);

    // The orphan-user check needs the set of real user ids. One small
    // query (id-only) keeps the diagnostics endpoint cheap.
    const allUserIdRows = await db.select({ id: users.id }).from(users);
    const knownUserIds = new Set(allUserIdRows.map((r) => r.id));

    const result = runPermissionsDiagnostics({ cache, knownUserIds });
    return result;
  });

  /* ---------- GET /admin/permissions/sensitive-grants ----------
   * Advisory catalog: lists who currently holds the privacy-sensitive
   * and high-impact permission keys. NOT pass/fail — purely
   * informational. The point is to give a masteradmin a "yep, that's
   * still who I want holding these" eyeball check, without the
   * diagnostics suite treating any of the holders as a failure (since
   * a masteradmin extending these keys is a legitimate matrix edit,
   * not drift).
   *
   * Two categories:
   *   - "privacy"     — keys that expose other users' private content
   *                     (journals, deleted bodies, secure user
   *                     directory, scriptorium drafts). Mirrors the
   *                     `PRIVACY_SENSITIVE_KEYS` set from shared.
   *   - "high-impact" — destructive / account-affecting actions
   *                     (delete user, reset password, edit email,
   *                     disable/enable, manage backups, manage the
   *                     matrix itself, …).
   *
   * For each key the response includes:
   *   - The key, its group, and the catalog description.
   *   - Roles currently holding it (from role_permission_grants).
   *   - Users with an explicit `granted=true` override on this key
   *     (with username + role for readable rendering). Revokes are
   *     omitted — a revoke makes the holder set smaller, not bigger.
   */
  app.get("/admin/permissions/sensitive-grants", async (req, reply) => {
    if (!(await requireMatrixPermission(req, reply, "view_admin_permissions"))) return;

    // Curated list. Kept here (not in shared) because it's a UX choice
    // for the admin panel, not a runtime invariant — adding a key
    // here only changes what shows in the advisory, never resolver
    // behavior.
    const privacyKeys: readonly PermissionKey[] = Array.from(PRIVACY_SENSITIVE_KEYS) as PermissionKey[];
    const highImpactKeys: readonly PermissionKey[] = [
      "hard_delete_user",
      "reset_user_password",
      "edit_user_email",
      "disable_user",
      "enable_user",
      "ban_user",
      "delete_room",
      "delete_others_world",
      "admin_delete_story",
      "manage_backups",
      "edit_site_settings",
      "edit_earning_sensitive",
      "manage_permissions",
    ];

    const allKeys = [...privacyKeys, ...highImpactKeys];
    const keySet = new Set(allKeys);

    // One query per table; the result sets are small (sensitive list
    // ~17 keys × at most a handful of roles / overrides each).
    const roleRows = await db
      .select()
      .from(rolePermissionGrants)
      .where(sql`${rolePermissionGrants.permissionKey} IN (${sql.join(
        allKeys.map((k) => sql`${k}`), sql`, `,
      )})`);
    const overrideRows = await db
      .select({
        permissionKey: userPermissionOverrides.permissionKey,
        granted: userPermissionOverrides.granted,
        userId: userPermissionOverrides.userId,
        username: users.username,
        role: users.role,
      })
      .from(userPermissionOverrides)
      .innerJoin(users, eq(users.id, userPermissionOverrides.userId))
      .where(sql`${userPermissionOverrides.permissionKey} IN (${sql.join(
        allKeys.map((k) => sql`${k}`), sql`, `,
      )})`);

    // Bucket by key for the response shape.
    const rolesByKey = new Map<PermissionKey, Role[]>();
    for (const r of roleRows) {
      if (!isPermissionKey(r.permissionKey)) continue;
      if (!keySet.has(r.permissionKey)) continue;
      const arr = rolesByKey.get(r.permissionKey) ?? [];
      arr.push(r.role as Role);
      rolesByKey.set(r.permissionKey, arr);
    }
    const usersByKey = new Map<PermissionKey, Array<{ userId: string; username: string; role: Role }>>();
    for (const o of overrideRows) {
      if (!isPermissionKey(o.permissionKey)) continue;
      if (!keySet.has(o.permissionKey)) continue;
      if (!o.granted) continue; // revokes are not "holders"
      const arr = usersByKey.get(o.permissionKey) ?? [];
      arr.push({ userId: o.userId, username: o.username, role: o.role as Role });
      usersByKey.set(o.permissionKey, arr);
    }

    function entryFor(key: PermissionKey, category: "privacy" | "high-impact") {
      return {
        key,
        category,
        group: PERMISSION_GROUPS[key],
        description: PERMISSION_DESCRIPTIONS[key],
        roles: (rolesByKey.get(key) ?? []).sort(),
        users: (usersByKey.get(key) ?? []).sort((a, b) => a.username.localeCompare(b.username)),
      };
    }

    return {
      keys: [
        ...privacyKeys.map((k) => entryFor(k, "privacy")),
        ...highImpactKeys.map((k) => entryFor(k, "high-impact")),
      ],
    };
  });

  /* ---------- GET /admin/permissions/users/search ----------
   * Typeahead for the By-user sub-tab. Returns up to 20 users matching
   * the prefix on username, with their role + a flag for "already has
   * overrides." Same shape `view_user_directory_secure` uses elsewhere
   * but scoped to the matrix's use case (no email / IP / last-login).
   */
  app.get<{ Querystring: { q?: string } }>(
    "/admin/permissions/users/search",
    async (req, reply) => {
      if (!(await requireMatrixPermission(req, reply, "view_admin_permissions"))) return;
      const q = (req.query.q ?? "").trim();
      if (q.length === 0) return { users: [] };
      const rows = await db
        .select({
          id: users.id,
          username: users.username,
          role: users.role,
        })
        .from(users)
        .where(and(
          ne(users.username, "system"),
          sql`lower(${users.username}) LIKE ${`${q.toLowerCase()}%`}`,
        ))
        .orderBy(asc(users.username))
        .limit(20);
      // Pull the override-presence flag in one batched query so the
      // UI can render a "has overrides" badge without an N+1 lookup.
      const overrideUserIds = rows.length > 0
        ? new Set(
            (await db
              .select({ userId: userPermissionOverrides.userId })
              .from(userPermissionOverrides)
              .where(sql`${userPermissionOverrides.userId} IN (${sql.join(rows.map((r) => sql`${r.id}`), sql`, `)})`))
              .map((r) => r.userId),
          )
        : new Set<string>();
      return {
        users: rows.map((r) => ({
          userId: r.id,
          username: r.username,
          role: r.role as Role,
          hasOverrides: overrideUserIds.has(r.id),
        })),
      };
    },
  );

  /* ---------- GET /admin/permissions/users/:id ----------
   * Per-user override detail for the By-user sub-tab. Returns the
   * user's role plus their current grants and revokes so the matrix
   * can render the three-state checkboxes ("from role" / "granted"
   * / "revoked") without intersecting against a global resolve.
   */
  app.get<{ Params: { id: string } }>(
    "/admin/permissions/users/:id",
    async (req, reply) => {
      if (!(await requireMatrixPermission(req, reply, "view_admin_permissions"))) return;
      const target = (await db
        .select({ id: users.id, username: users.username, role: users.role })
        .from(users)
        .where(eq(users.id, req.params.id))
        .limit(1))[0];
      if (!target) { reply.code(404); return { error: "user not found" }; }

      const rows = await db
        .select({
          permissionKey: userPermissionOverrides.permissionKey,
          granted: userPermissionOverrides.granted,
        })
        .from(userPermissionOverrides)
        .where(eq(userPermissionOverrides.userId, target.id));

      const granted: PermissionKey[] = [];
      const revoked: PermissionKey[] = [];
      for (const r of rows) {
        if (!isPermissionKey(r.permissionKey)) continue;
        if (r.granted) granted.push(r.permissionKey);
        else revoked.push(r.permissionKey);
      }
      return {
        userId: target.id,
        username: target.username,
        role: target.role as Role,
        granted,
        revoked,
      };
    },
  );

  /* ---------- PATCH /admin/permissions/roles ---------- */
  app.patch<{ Body: unknown }>("/admin/permissions/roles", async (req, reply) => {
    const me = await requireMatrixPermission(req, reply, "manage_permissions");
    if (!me) return;
    let body: z.infer<typeof rolePatchBody>;
    try { body = rolePatchBody.parse(req.body); }
    catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : "invalid body" };
    }
    if (!isPermissionKey(body.permissionKey)) {
      reply.code(400);
      return { error: "unknown permission key" };
    }
    if (body.role === "masteradmin") {
      reply.code(400);
      return { error: "masteradmin tier holds every permission by definition; the row is uneditable." };
    }
    if (!isEditableRole(body.role)) {
      reply.code(400);
      return { error: `unknown role "${body.role}"` };
    }

    if (body.granted) {
      // Idempotent insert — re-granting an already-granted row is a
      // no-op rather than a 409 so the UI doesn't have to handle a
      // double-click race against another admin's edit.
      await db
        .insert(rolePermissionGrants)
        .values({ role: body.role, permissionKey: body.permissionKey })
        .onConflictDoNothing({
          target: [rolePermissionGrants.role, rolePermissionGrants.permissionKey],
        });
    } else {
      await db
        .delete(rolePermissionGrants)
        .where(and(
          eq(rolePermissionGrants.role, body.role),
          eq(rolePermissionGrants.permissionKey, body.permissionKey),
        ));
    }

    invalidatePermissionsCache();
    await recordAudit(db, {
      actorUserId: me.id,
      action: body.granted ? "role_permission_grant" : "role_permission_revoke",
      metadata: { role: body.role, permissionKey: body.permissionKey, granted: body.granted },
    });
    return { ok: true };
  });

  /* ---------- PATCH /admin/permissions/users ---------- */
  app.patch<{ Body: unknown }>("/admin/permissions/users", async (req, reply) => {
    const me = await requireMatrixPermission(req, reply, "manage_permissions");
    if (!me) return;
    let body: z.infer<typeof userPatchBody>;
    try { body = userPatchBody.parse(req.body); }
    catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : "invalid body" };
    }
    if (!isPermissionKey(body.permissionKey)) {
      reply.code(400);
      return { error: "unknown permission key" };
    }
    // Self-edit guard — mirrors `users.ts:/admin/users/:id`. Without
    // it, a masteradmin could grant themselves a privilege their role
    // doesn't have via the matrix, or (worse) revoke their own access
    // to `manage_permissions` and lock themselves out.
    if (body.userId === me.id) {
      reply.code(403);
      return { error: "you cannot edit your own overrides — use a separate masteradmin account" };
    }
    const target = (await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, body.userId))
      .limit(1))[0];
    if (!target) { reply.code(404); return { error: "user not found" }; }

    if (body.granted === null) {
      // Clear path — delete the override row; user falls back to their
      // role grant. Idempotent.
      await db
        .delete(userPermissionOverrides)
        .where(and(
          eq(userPermissionOverrides.userId, body.userId),
          eq(userPermissionOverrides.permissionKey, body.permissionKey),
        ));
      invalidatePermissionsCache();
      await recordAudit(db, {
        actorUserId: me.id,
        action: "user_permission_override_clear",
        targetUserId: body.userId,
        metadata: { permissionKey: body.permissionKey },
      });
      return { ok: true, cleared: true };
    }

    // Upsert path — explicit grant or revoke. The (user_id,
    // permission_key) PK + onConflict swap makes this a single
    // round-trip; we capture `setByUserId` + `setAt` for the audit
    // trail so a future "who gave Bob ban_user?" query has a row to
    // join against.
    await db
      .insert(userPermissionOverrides)
      .values({
        userId: body.userId,
        permissionKey: body.permissionKey,
        granted: body.granted,
        setByUserId: me.id,
      })
      .onConflictDoUpdate({
        target: [userPermissionOverrides.userId, userPermissionOverrides.permissionKey],
        set: { granted: body.granted, setByUserId: me.id, setAt: new Date() },
      });

    invalidatePermissionsCache();
    await recordAudit(db, {
      actorUserId: me.id,
      action: "user_permission_override_set",
      targetUserId: body.userId,
      metadata: { permissionKey: body.permissionKey, granted: body.granted },
    });
    return { ok: true };
  });

  /* ---------- recent activity ----------
   * Audit-feed slice scoped to permission events. Used by the matrix
   * UI's "Active overrides" + "Recent changes" panels. Re-uses the
   * shared audit log table so a permission grant shows up in both
   * places — here for the matrix's context, and in /admin/audit for
   * the global review queue.
   */
  app.get<{
    Querystring: {
      limit?: string;
      /** Filter to entries whose metadata.permissionKey matches. Used by the
       *  matrix's "show history for this key" affordance — e.g. answer
       *  "who granted kick_user to mod, when?" in one call. */
      permissionKey?: string;
      /** Filter to entries that touched a specific role. Matches in two
       *  ways: the role row was edited directly (`role_permission_*`
       *  with metadata.role === X), OR a user with role X had an
       *  override changed (`user_permission_override_*` whose target's
       *  current role is X). Without the second branch, "show all
       *  changes affecting the admin role" would silently drop user-
       *  override edits on admin-tier users — which is the more
       *  common moderation question. */
      role?: string;
      /** Filter to entries that touched a specific user. Joins on the
       *  audit row's targetUserId so per-user override history surfaces. */
      userId?: string;
    };
  }>(
    "/admin/permissions/audit",
    async (req, reply) => {
      if (!(await requireMatrixPermission(req, reply, "view_admin_permissions"))) return;
      const { auditLog } = await import("../db/schema.js");
      const limit = Math.min(100, parseInt(req.query.limit ?? "30", 10) || 30);

      // Filter expressions composed against the action filter so the
      // SELECT only scans rows in the permission-actions subset.
      const filters = [sql`${auditLog.action} IN (
        'role_permission_grant',
        'role_permission_revoke',
        'user_permission_override_set',
        'user_permission_override_clear'
      )`];
      if (req.query.permissionKey) {
        // Metadata is JSON-encoded; SQLite's json_extract reads the
        // permissionKey field directly. Falls back to a LIKE match if
        // metadata happens to be malformed (legacy rows).
        filters.push(sql`(
          json_extract(${auditLog.metadataJson}, '$.permissionKey') = ${req.query.permissionKey}
          OR ${auditLog.metadataJson} LIKE ${`%"permissionKey":"${req.query.permissionKey}"%`}
        )`);
      }
      if (req.query.role) {
        // Two-branch match: role row edits (metadata.role) OR user
        // override edits whose target's current role is X. The
        // subquery resolves the target's role from the users table
        // at query time, so a user whose role changed AFTER an
        // override was recorded surfaces under their CURRENT role
        // (which matches what the matrix UI shows for them).
        filters.push(sql`(
          json_extract(${auditLog.metadataJson}, '$.role') = ${req.query.role}
          OR ${auditLog.targetUserId} IN (
            SELECT ${users.id} FROM ${users} WHERE ${users.role} = ${req.query.role}
          )
        )`);
      }
      if (req.query.userId) {
        filters.push(eq(auditLog.targetUserId, req.query.userId));
      }

      const rows = await db
        .select()
        .from(auditLog)
        .where(and(...filters))
        .orderBy(desc(auditLog.createdAt))
        .limit(limit);
      // Hydrate actor + target usernames in two batched lookups so
      // the matrix UI doesn't have to fire N round-trips per row.
      const userIds = new Set<string>();
      for (const r of rows) {
        userIds.add(r.actorUserId);
        if (r.targetUserId) userIds.add(r.targetUserId);
      }
      const userRows = userIds.size > 0
        ? await db
            .select({ id: users.id, username: users.username })
            .from(users)
            .where(sql`${users.id} IN (${sql.join([...userIds].map((u) => sql`${u}`), sql`, `)})`)
        : [];
      const usernameById = new Map(userRows.map((r) => [r.id, r.username]));
      return {
        entries: rows.map((r) => {
          let metadata: Record<string, unknown> | null = null;
          if (r.metadataJson) {
            try { metadata = JSON.parse(r.metadataJson) as Record<string, unknown>; }
            catch { metadata = null; }
          }
          return {
            id: r.id,
            action: r.action,
            actorUsername: usernameById.get(r.actorUserId) ?? "(deleted user)",
            actorUserId: r.actorUserId,
            targetUsername: r.targetUserId ? (usernameById.get(r.targetUserId) ?? "(deleted user)") : null,
            targetUserId: r.targetUserId,
            metadata,
            createdAt: +r.createdAt,
          };
        }),
      };
    },
  );
}
