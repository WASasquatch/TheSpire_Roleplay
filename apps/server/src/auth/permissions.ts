/**
 * Granular permission resolver — Phase 1 of the role-permission system.
 *
 * Routes through every privileged action in the codebase: kicks, bans,
 * admin-tab visibility, scriptorium overrides, the whole catalog in
 * `packages/shared/src/permissions.ts`. The old hardcoded
 * `isAdminRole(role)` / `isMasterAdminRole(role)` checks now compose
 * via this resolver so the install can redistribute privileges through
 * the (Phase 2) Roles & Permissions matrix without a code change.
 *
 * Resolution precedence (highest wins):
 *
 *   1. **Masteradmin bypass** — masteradmin always returns `true`. The
 *      tier holds no row in the grants table and the matrix locks
 *      their row as "all-on, uneditable"; misclicking can't strand
 *      the install with no one able to grant permissions.
 *
 *   2. **User override** — `user_permission_overrides[userId][key]` has
 *      a row, `granted` decides. Lets an install give a specific user
 *      a privilege their role doesn't carry, or take one away from
 *      someone who'd otherwise inherit it from their role.
 *
 *   3. **Role grant** — `role_permission_grants[role][key]` exists →
 *      `true`. The matrix's "By role" sub-tab edits this layer.
 *
 *   4. **Default deny** — no row anywhere → `false`.
 *
 * **Defensive fallback (boot-time):** if `role_permission_grants` is
 * entirely empty (failed seed, accidental `DELETE`), the resolver
 * falls back to the legacy `isAdminRole(role)` / `isMasterAdminRole(role)`
 * checks for the catalog's keys so an admin can still reach the matrix
 * UI to repair the table. A `[permissions] fallback engaged` warning is
 * logged on boot — the breakage is loud, not silent.
 *
 * **Cache:** both grant tables fit in process memory (low hundreds of
 * rows max combined). We pin them on first lookup and invalidate on
 * any PATCH/DELETE via `invalidatePermissionsCache()`. Same pattern
 * `settings.getSettings()` uses. The deploy is single-instance per
 * `fly.toml: min_machines_running = 1` — if it ever scales out, swap
 * to a TTL refresh or socket.io adapter pub/sub for invalidations.
 */

import { type PermissionKey, type Role } from "@thekeep/shared";
import { rolePermissionGrants, userPermissionOverrides } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { db as defaultDb } from "../db/index.js";
import { resolveAgainst, type PermissionsCache } from "./permissionsCore.js";

// Re-export so existing call sites that imported these from
// `permissions.ts` (and `scripts/check-permissions.ts` going forward)
// keep working. The actual definitions live in `permissionsCore.ts`
// so the pure resolver stays free of DB / IO imports.
export { resolveAgainst, type PermissionsCache } from "./permissionsCore.js";

/**
 * Cached snapshot of the grants tables. `null` = not yet loaded; first
 * `hasPermission` call lazy-loads. After load, every subsequent check
 * is O(1) Set lookups. Invalidation drops both fields back to null so
 * the next check re-fetches.
 */

let cache: PermissionsCache | null = null;
let loadPromise: Promise<PermissionsCache> | null = null;

/**
 * Drop the cache. Called by the matrix PATCH/DELETE endpoints after
 * they commit a change so the next `hasPermission` call observes the
 * new state. Cheap — just nulls the pointer.
 */
export function invalidatePermissionsCache(): void {
  cache = null;
  loadPromise = null;
}

/**
 * Pin the grants tables into the in-memory cache. Idempotent and
 * coalesces concurrent loads via `loadPromise` so two parallel callers
 * don't race two `SELECT *` round-trips.
 */
async function loadCache(db: Db): Promise<PermissionsCache> {
  if (cache) return cache;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const [roleRows, overrideRows] = await Promise.all([
      db.select().from(rolePermissionGrants),
      db.select().from(userPermissionOverrides),
    ]);

    const roleGrants = new Map<Role, Set<PermissionKey>>();
    for (const r of roleRows) {
      const set = roleGrants.get(r.role as Role) ?? new Set<PermissionKey>();
      set.add(r.permissionKey as PermissionKey);
      roleGrants.set(r.role as Role, set);
    }

    const userOverrides = new Map<string, Map<PermissionKey, boolean>>();
    for (const o of overrideRows) {
      const m = userOverrides.get(o.userId) ?? new Map<PermissionKey, boolean>();
      m.set(o.permissionKey as PermissionKey, !!o.granted);
      userOverrides.set(o.userId, m);
    }

    const fallback = roleRows.length === 0;
    if (fallback) {
      // eslint-disable-next-line no-console
      console.warn(
        "[permissions] fallback engaged — role_permission_grants is empty. " +
        "hasPermission() is using legacy isAdminRole() checks until the table is repopulated. " +
        "If this isn't a fresh-install transient, restore 0179_permission_grants.sql's seed.",
      );
    }

    cache = { roleGrants, userOverrides, fallback };
    return cache;
  })().finally(() => {
    loadPromise = null;
  });
  return loadPromise;
}

/**
 * Force a reload of the cache from disk and return it. Used by the
 * admin diagnostics endpoint so the "Run integrity check" button
 * always sees the current DB state, not a stale snapshot pinned
 * before a recent matrix edit. Cheap (one SELECT * per table, both
 * are tiny).
 */
export async function reloadPermissionsSnapshot(
  db: Db = defaultDb,
): Promise<PermissionsCache> {
  invalidatePermissionsCache();
  return loadCache(db);
}

/**
 * Synchronous read against the in-memory cache. Throws if the cache
 * hasn't been warmed yet — callers should be in a path where
 * `ensurePermissionsReady` has run (route preHandlers, command
 * dispatcher entry). Most code paths use `hasPermission` (which
 * lazy-loads) instead; this exists for the rare hot-path that
 * genuinely can't await.
 */
export function hasPermissionSync(
  user: { id: string; role: Role },
  key: PermissionKey,
): boolean {
  if (!cache) {
    throw new Error("[permissions] hasPermissionSync called before cache warm. Use hasPermission().");
  }
  return resolveAgainst(cache, user, key);
}

/**
 * The canonical check. Lazy-loads the cache on first call, then
 * resolves the precedence chain. Pure async, safe to await from any
 * route / command handler.
 *
 * Pass `db` when you're inside a transaction or want to use a custom
 * connection; otherwise the default singleton handle is fine.
 */
export async function hasPermission(
  user: { id: string; role: Role },
  key: PermissionKey,
  db: Db = defaultDb,
): Promise<boolean> {
  const c = await loadCache(db);
  return resolveAgainst(c, user, key);
}

/**
 * Throwing variant for Fastify routes. Sends a 403 with a structured
 * body and returns `false`; callers should bail (`return`) when it
 * returns false. Mirrors the `getSessionUser` + reply pattern used
 * across the codebase.
 *
 * Usage:
 *   if (!(await requirePermission(reply, me, "kick_user"))) return;
 */
export async function requirePermission(
  reply: { code: (n: number) => unknown; send: (body: unknown) => unknown },
  user: { id: string; role: Role },
  key: PermissionKey,
  db: Db = defaultDb,
): Promise<boolean> {
  const ok = await hasPermission(user, key, db);
  if (!ok) {
    reply.code(403);
    reply.send({ error: "permission_denied", permission: key });
  }
  return ok;
}

/**
 * Resolved set of every permission this user effectively holds. Used
 * by the auth-payload mirror (`/auth/me` → `me.permissions: string[]`)
 * so the client can gate UI on the same list the server enforces.
 *
 * Order: catalog order (matches `PERMISSION_KEYS`). Stable so a diff
 * between two payloads reads naturally.
 */
export async function permissionsFor(
  user: { id: string; role: Role },
  db: Db = defaultDb,
): Promise<PermissionKey[]> {
  // Importing PERMISSION_KEYS inline to avoid a top-of-file shared
  // dependency cycle — `auth/permissions` is otherwise leaf-imported.
  const { PERMISSION_KEYS } = await import("@thekeep/shared");
  const c = await loadCache(db);
  return PERMISSION_KEYS.filter((k) => resolveAgainst(c, user, k));
}

// The pure resolver (`resolveAgainst`) and the masteradmin-only set
// now live in `permissionsCore.ts` so the testing script can import
// them without dragging better-sqlite3 into its module graph. They
// are re-exported from this file (see top) for any existing call
// sites that imported them from here.
