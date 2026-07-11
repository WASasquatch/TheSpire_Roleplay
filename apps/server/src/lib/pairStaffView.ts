/**
 * Staff oversight for 18+ channel pairs — the "see both channels" lane.
 *
 * A room's 18+ channel is a separate room feed; ordinary members only ever
 * see the side they're standing in. GLOBAL staff (site mod/admin/
 * masteradmin) and SERVER staff (owner/admin/mod in server_members) get the
 * pair's two feeds MERGED while standing in either side, so nothing slips
 * past moderation by happening "in the other tab". Read-side only: sending
 * still goes to the side the staffer is standing in.
 *
 * This module is the single audit point for that rule:
 *   - who qualifies (canSeePairFeeds): ADULT + (site staff OR server
 *     staff). Room owners/room mods deliberately do NOT qualify — they can
 *     already toggle sides, and the merged view is an oversight tool.
 *   - which rooms pair (findPairSibling): LIVE pairs only; a parked
 *     (archived) channel has no live feed to merge.
 *   - live mirroring (emitToPairStaff): fan an event out to the qualifying
 *     staff sockets standing in the pair's OTHER side. Callers must never
 *     mirror whispers or targeted rows (participant-scoped privacy).
 *
 * SAFETY: every lane requires `isAdult`. A minor staff account (possible
 * for server staff) sees only the side they can enter — and minors can't
 * enter the annex at all.
 */

import { eq, isNull, and, or, inArray } from "drizzle-orm";
import { isModeratorRole, type Role } from "@thekeep/shared";
import { rooms, serverMembers } from "../db/schema.js";
import { DEFAULT_SERVER_ID } from "../earning/pool.js";
import { isIsolatedBetween, type IsolationSubject } from "../auth/ageIsolation.js";
import type { Db } from "../db/index.js";

export interface PairSibling {
  /** The pair's OTHER room (relative to the room you asked about). */
  siblingId: string;
  /** The pair's 18+ side (the annex), whichever side you asked from. */
  annexId: string;
  /** The pair's server (NULL rows resolve to the default server). */
  serverId: string;
}

/**
 * Resolve the LIVE pair sibling of `roomId` (either direction), or null
 * when the room isn't part of a live pair.
 */
export async function findPairSibling(db: Db, roomId: string): Promise<PairSibling | null> {
  // One query pulls the room itself plus any annex pointing at it.
  const rows = await db
    .select({
      id: rooms.id,
      linkedRoomId: rooms.linkedRoomId,
      archivedAt: rooms.archivedAt,
      serverId: rooms.serverId,
    })
    .from(rooms)
    .where(or(eq(rooms.id, roomId), eq(rooms.linkedRoomId, roomId)));
  const self = rows.find((r) => r.id === roomId);
  if (!self || self.archivedAt) return null;
  if (self.linkedRoomId) {
    // `roomId` IS the annex; its base is a separate fetch (the OR above
    // can't match it — bases don't point back).
    const base = (await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(and(eq(rooms.id, self.linkedRoomId), isNull(rooms.archivedAt)))
      .limit(1))[0];
    if (!base) return null;
    return { siblingId: base.id, annexId: self.id, serverId: self.serverId ?? DEFAULT_SERVER_ID };
  }
  const annex = rows.find((r) => r.linkedRoomId === roomId && !r.archivedAt);
  if (!annex) return null;
  return { siblingId: annex.id, annexId: annex.id, serverId: self.serverId ?? DEFAULT_SERVER_ID };
}

/** True when the user holds a staff role (owner/admin/mod) on the server. */
export async function isServerStaff(db: Db, userId: string, serverId: string): Promise<boolean> {
  const row = (await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .limit(1))[0];
  return !!row && row.role !== "member";
}

/** The qualification rule. See the module header for who and why. */
export async function canSeePairFeeds(
  db: Db,
  viewer: { id: string; role: Role; isAdult: boolean },
  pairServerId: string,
): Promise<boolean> {
  if (!viewer.isAdult) return false;
  if (isModeratorRole(viewer.role)) return true;
  return isServerStaff(db, viewer.id, pairServerId);
}

/**
 * Compute + cache this socket's merged-view eligibility for THIS room on
 * socket.data, where the hot summary paths (summaryFor / sendRoomStateTo)
 * read it without queries. Called on every join AND on the relocate
 * landings (kick/ban/boot re-sends room state without a joinRoom pass),
 * so the stamp always describes the room the socket actually stands in.
 */
export async function stampPairStaffView(
  db: Db,
  socket: { data: unknown },
  user: { id: string; role: Role; isAdult?: boolean },
  roomId: string,
): Promise<void> {
  try {
    const pair = await findPairSibling(db, roomId);
    (socket.data as { pairStaffView?: boolean }).pairStaffView =
      !!pair && await canSeePairFeeds(db, { id: user.id, role: user.role, isAdult: !!user.isAdult }, pair.serverId);
  } catch {
    (socket.data as { pairStaffView?: boolean }).pairStaffView = false;
  }
}

/** The minimal socket shape the mirror fan-out needs. */
interface MirrorSocket {
  data: unknown;
  emit(event: string, ...args: unknown[]): unknown;
}
interface MirrorIo {
  in(room: string): { fetchSockets(): Promise<MirrorSocket[]> };
}

/**
 * Fan a live event out to the qualifying staff sockets standing in the
 * pair SIBLING of `originRoomId`. No-op for unpaired rooms. `hideUserIds`
 * carries the sender's ignore/block hide-set so the mirror honors the same
 * per-viewer filters as the origin room's delivery loop; `sender` (the
 * author's session snapshot) additionally applies the Phase-5 minor-
 * isolation filter — WITHOUT it, an isolated minor's line would mirror to
 * an adult SERVER staffer (site role "user", so NOT isolation-exempt) whom
 * the origin loop and the merged backlog both correctly hide it from.
 *
 * Callers MUST NOT mirror whispers or targeted rows — this helper is for
 * public room lines (and their edits/deletes) only.
 */
export async function emitToPairStaff(
  io: MirrorIo,
  db: Db,
  originRoomId: string,
  emitFn: (socket: MirrorSocket) => void,
  hideUserIds?: ReadonlySet<string>,
  sender?: IsolationSubject,
): Promise<void> {
  const pair = await findPairSibling(db, originRoomId);
  if (!pair) return;
  const sockets = await io.in(`room:${pair.siblingId}`).fetchSockets();
  if (sockets.length === 0) return;
  // Split eligibility: site staff resolve from the in-memory session
  // snapshot; everyone else adult needs a server_members lookup, batched
  // into ONE query for all candidates.
  const eligible: MirrorSocket[] = [];
  const needServerCheck: { socket: MirrorSocket; userId: string }[] = [];
  for (const s of sockets) {
    const su = (s.data as { user?: ({ id: string; role: Role; isAdult?: boolean } & IsolationSubject) }).user;
    if (!su?.isAdult) continue;
    if (hideUserIds?.has(su.id)) continue;
    if (sender && su.id !== (sender as { id?: string }).id && isIsolatedBetween(sender, su)) continue;
    if (isModeratorRole(su.role)) eligible.push(s);
    else needServerCheck.push({ socket: s, userId: su.id });
  }
  if (needServerCheck.length > 0) {
    const staffIds = new Set(
      (await db
        .select({ userId: serverMembers.userId })
        .from(serverMembers)
        .where(and(
          eq(serverMembers.serverId, pair.serverId),
          inArray(serverMembers.userId, needServerCheck.map((c) => c.userId)),
          inArray(serverMembers.role, ["owner", "admin", "mod"]),
        ))).map((r) => r.userId),
    );
    for (const c of needServerCheck) {
      if (staffIds.has(c.userId)) eligible.push(c.socket);
    }
  }
  for (const s of eligible) emitFn(s);
}
