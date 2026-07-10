/**
 * Minor isolation mode ("opt out of adults") — the single source of truth
 * every isolation gate consults (age-restriction plan, Phase 5; mirrors
 * auth/blocks.ts and auth/ageGate.ts as the one helper module surfaces
 * import instead of re-deriving).
 *
 * One rule: an opted-in minor (`users.isolate_from_adults`, migration 0334)
 * and every adult NON-SITE-STAFF account behave as if MUTUALLY BLOCKED —
 * chat lines, presence/userlists, typing, whispers, DMs, friends, profiles,
 * searches, forum content, notifications. Site staff (mod/admin/masteradmin)
 * are exempt in BOTH directions so moderation and help stay reachable, and
 * the system sentinel user (role admin) is exempt with them, so server-
 * authored lines always deliver.
 *
 * Unlike blocks — a bounded per-user row set that materializes into a Set —
 * isolation is unbounded on one side ("all adults"), so enforcement is a
 * per-candidate predicate (`isIsolatedBetween`) evaluated against data the
 * call site already holds, plus a SQL fragment for list queries. The
 * predicate embeds `isMinor`, so the mode goes INERT by computation on the
 * 18th birthday: adult accounts reappear with no write anywhere.
 *
 * Authority is not visibility: none of these helpers gate moderation
 * actions. An adult room owner's kick/mute still binds an isolated minor.
 */
import { inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { isModeratorRole, type Role } from "@thekeep/shared";
import { users } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { isAdultUser, isMinor, type AgeSubject } from "./ageGate.js";

/**
 * The minimal slice of a users row (or session projection) the isolation
 * helpers need. Structural, so DB rows, `SessionUser`, and `getSessionUser`
 * projections all satisfy it without adapters.
 */
export interface IsolationSubject extends AgeSubject {
  /** Account role; `mod`/`admin`/`masteradmin` are exempt site staff. */
  role: string;
  /** The minor-only opt-out flag (users.isolate_from_adults). */
  isolateFromAdults: boolean;
}

/** Site staff = the same tier blocks treat as un-blockable. */
function isSiteStaff(u: { role: string }): boolean {
  return isModeratorRole(u.role as Role);
}

/**
 * Is isolation LIVE for this account? Requires the flag AND still being a
 * minor — the flag is retained but inert from the 18th birthday (UTC), and
 * for adult rows generally (an admin could set it via the directory editor;
 * it must never isolate an adult).
 */
export function isolationActiveFor(u: IsolationSubject, now: Date = new Date()): boolean {
  return u.isolateFromAdults && isMinor(u, now);
}

/**
 * The mutual pair predicate: true when `a` and `b` must not see each other
 * because one side is an actively-isolated minor and the other is an adult.
 * Symmetric by construction. Site staff on EITHER side dissolves the pair —
 * staff can always see isolated minors (moderation) and isolated minors can
 * always see staff (help).
 */
export function isIsolatedBetween(a: IsolationSubject, b: IsolationSubject, now: Date = new Date()): boolean {
  if (isSiteStaff(a) || isSiteStaff(b)) return false;
  return (
    (isolationActiveFor(a, now) && isAdultUser(b, now))
    || (isolationActiveFor(b, now) && isAdultUser(a, now))
  );
}

/**
 * Which side of the isolation fence does this viewer stand on?
 *   - "isolated-minor": hides adult non-staff accounts from them
 *   - "adult": hides actively-isolated minors from them
 *   - "none": no isolation filtering at all — anonymous viewers (mirroring
 *     blocks, which can't exist without an account), site staff, and plain
 *     (non-isolated) minors, who can see isolated minors AND adults.
 */
function viewerIsolationClass(
  viewer: IsolationSubject | null | undefined,
  now: Date = new Date(),
): "none" | "isolated-minor" | "adult" {
  if (!viewer || isSiteStaff(viewer)) return "none";
  if (isolationActiveFor(viewer, now)) return "isolated-minor";
  if (isAdultUser(viewer, now)) return "adult";
  return "none";
}

/**
 * The plan's SQL shape for "this users row is a minor", inlined against an
 * aliased users row. Date-only UTC like ageUtc: someone born ON the boundary
 * date is 18 today (adult), so strictly-greater means minor. SQLite's
 * date('now') is UTC. (A malformed non-null birthdate compares lexically
 * greater than any ISO date when it starts with a letter — minor, matching
 * the JS fail-closed posture; both signup paths validate, so real rows are
 * well-formed.)
 */
const ISO_SQL_STAFF_ROLES = "('mod','admin','masteradmin')";

/**
 * SQL condition asserting that the account referenced by `userIdExpr`
 * (a column such as `messages.user_id`, or any SQL expression yielding a
 * users.id) is VISIBLE to `viewer` under isolation. Returns `undefined`
 * when the viewer's class needs no filtering, so call sites can spread it
 * into an `and(...)` exactly like the optional NSFW clauses.
 *
 * Evaluated as a correlated NOT EXISTS against `users` so it works on
 * queries that don't join users (message backlogs, searches, topic lists);
 * where the caller already holds joined user rows, prefer the in-memory
 * `isIsolatedBetween` instead.
 */
export function isolationVisibleSql(
  viewer: IsolationSubject | null | undefined,
  userIdExpr: SQLWrapper,
  now: Date = new Date(),
): SQL | undefined {
  const cls = viewerIsolationClass(viewer, now);
  if (cls === "none") return undefined;
  if (cls === "isolated-minor") {
    // Hide adult non-staff authors: the row is visible unless its author
    // exists AND is an adult (NULL birthdate = legacy adult) AND not staff.
    return sql`NOT EXISTS (
      SELECT 1 FROM users iso_u
      WHERE iso_u.id = ${userIdExpr}
        AND NOT (iso_u.birthdate IS NOT NULL AND iso_u.birthdate > date('now','-18 years'))
        AND iso_u.role NOT IN ${sql.raw(ISO_SQL_STAFF_ROLES)}
    )`;
  }
  // Adult non-staff viewer: hide actively-isolated minors.
  return sql`NOT EXISTS (
    SELECT 1 FROM users iso_u
    WHERE iso_u.id = ${userIdExpr}
      AND iso_u.isolate_from_adults = 1
      AND iso_u.birthdate IS NOT NULL AND iso_u.birthdate > date('now','-18 years')
      AND iso_u.role NOT IN ${sql.raw(ISO_SQL_STAFF_ROLES)}
  )`;
}

/**
 * Batched per-candidate check for list surfaces that only hold userIds
 * (occupant lists, DM inbox rows, friend rows, autocomplete hits): which of
 * `candidateUserIds` are isolation-hidden from `viewer`? One bounded
 * `IN (...)` read of the candidates' age columns; empty Set on the common
 * no-filtering classes without touching the DB. Self-pairs are inherently
 * false in the predicate, so the viewer's own id passing through is safe.
 */
export async function isolationHiddenSetFor(
  db: Db,
  viewer: IsolationSubject | null | undefined,
  candidateUserIds: Iterable<string>,
  now: Date = new Date(),
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!viewer || viewerIsolationClass(viewer, now) === "none") return out;
  const ids = [...new Set(candidateUserIds)];
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: users.id,
      role: users.role,
      birthdate: users.birthdate,
      isolateFromAdults: users.isolateFromAdults,
    })
    .from(users)
    .where(inArray(users.id, ids));
  for (const r of rows) {
    if (isIsolatedBetween(viewer, r, now)) out.add(r.id);
  }
  return out;
}

/**
 * `isolationHiddenSetFor` for call sites that hold only the viewer's id
 * (the titles service, relocate paths). One extra single-row read to
 * hydrate the viewer's age columns, then the same batched candidate check.
 */
export async function isolationHiddenSetForViewerId(
  db: Db,
  viewerUserId: string,
  candidateUserIds: Iterable<string>,
  now: Date = new Date(),
): Promise<Set<string>> {
  const viewer = (await db
    .select({ role: users.role, birthdate: users.birthdate, isolateFromAdults: users.isolateFromAdults })
    .from(users)
    .where(sql`${users.id} = ${viewerUserId}`)
    .limit(1))[0];
  if (!viewer) return new Set<string>();
  return isolationHiddenSetFor(db, viewer, candidateUserIds, now);
}

/**
 * Pair check by ids, for sites that hold neither row (the notification
 * engine, profile resolver, friend-request send). One two-row read; false
 * when either row is missing (a dangling id can't need isolating).
 */
export async function isIsolatedBetweenIds(
  db: Db,
  aUserId: string,
  bUserId: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (aUserId === bUserId) return false;
  const rows = await db
    .select({
      id: users.id,
      role: users.role,
      birthdate: users.birthdate,
      isolateFromAdults: users.isolateFromAdults,
    })
    .from(users)
    .where(inArray(users.id, [aUserId, bUserId]));
  const a = rows.find((r) => r.id === aUserId);
  const b = rows.find((r) => r.id === bUserId);
  if (!a || !b) return false;
  return isIsolatedBetween(a, b, now);
}

/**
 * Batched isolation graph among a set of userIds — the exact Map shape of
 * `blocksAmong` so the presence/typing fan-outs can UNION the two graphs
 * and keep their `.size === 0` room-wide-emit fast path. Empty map unless
 * at least one candidate is an actively-isolated minor (the overwhelmingly
 * common case pays one bounded IN read and no linking work).
 */
export async function isolationAmong(db: Db, userIds: string[], now: Date = new Date()): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const ids = [...new Set(userIds)];
  if (ids.length < 2) return out;
  const rows = await db
    .select({
      id: users.id,
      role: users.role,
      birthdate: users.birthdate,
      isolateFromAdults: users.isolateFromAdults,
    })
    .from(users)
    .where(inArray(users.id, ids));
  const isolated = rows.filter((r) => !isSiteStaff(r) && isolationActiveFor(r, now));
  if (isolated.length === 0) return out;
  const adults = rows.filter((r) => !isSiteStaff(r) && isAdultUser(r, now));
  if (adults.length === 0) return out;
  const link = (x: string, y: string) => {
    const s = out.get(x) ?? new Set<string>();
    s.add(y);
    out.set(x, s);
  };
  for (const m of isolated) {
    for (const a of adults) {
      link(m.id, a.id);
      link(a.id, m.id);
    }
  }
  return out;
}

/**
 * Union helper for the graph consumers: merge the isolation graph INTO a
 * block graph (mutating and returning the target) so downstream per-viewer
 * filters (`occupantsForViewer`, the typing visibility loop) stay a single
 * `graph.get(viewer)` lookup.
 */
export function unionGraphInto(
  target: Map<string, Set<string>>,
  extra: Map<string, Set<string>>,
): Map<string, Set<string>> {
  for (const [k, set] of extra) {
    const existing = target.get(k);
    if (existing) for (const v of set) existing.add(v);
    else target.set(k, new Set(set));
  }
  return target;
}
