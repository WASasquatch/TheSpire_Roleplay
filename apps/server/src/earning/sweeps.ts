/**
 * Periodic presence sweep.
 *
 * Every `presenceBlockMinutes` (default 5) we iterate live sockets in
 * non-archived rooms and credit each socket's identity for one
 * presence block, IC sockets credit their character pool, OOC
 * sockets credit the master pool.
 *
 * Cap: each pool earns at most `presenceDailyBlockCap` blocks per
 * rolling 24-hour window. Past the cap the credit is skipped; the
 * activity still counts toward the user's session lifecycle, just
 * not the earning economy.
 *
 * Sockets, not memberships, drive the sweep. A user who closed
 * their browser but still has a `roomMembers` row earns nothing;
 * a user with two tabs voicing two characters in the same room
 * earns once per (userId, characterId) tuple, matching the
 * occupant-de-dup rule in `broadcast.ts`.
 */

import { and, eq, gte, inArray } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import type { Db } from "../db/index.js";
import { rooms, earningLedger, users } from "../db/schema.js";
import { getSettings } from "../settings.js";
import type { EarningConfig } from "./config.js";
import { awardForPresence } from "./award.js";
import { DEFAULT_SERVER_ID } from "./pool.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

interface IdentitySnapshot {
  userId: string;
  characterId: string | null;
  roomId: string;
  /** Server the occupied room belongs to (default server when the room's
   *  serverId is null). Drives the per-server pool + cap partitioning. */
  serverId: string;
}

/**
 * Snapshot every distinct (userId, characterId, roomId) tuple
 * currently sitting in a non-archived room. Mirrors the per-tab
 * character resolution that `currentOccupants` uses in broadcast.ts
 * so the earning economy agrees with the visible occupant list.
 */
async function snapshotActiveIdentities(db: Db, io: Io): Promise<IdentitySnapshot[]> {
  const sockets = await io.fetchSockets();
  // Pre-filter to sockets in any room and pluck identity bits in one pass.
  type Raw = { userId: string; tabCharId: string | null | undefined; roomId: string };
  const raws: Raw[] = [];
  for (const s of sockets) {
    const data = s.data as { userId?: string; tabCharId?: string | null; roomId?: string };
    if (!data.userId || !data.roomId) continue;
    raws.push({ userId: data.userId, tabCharId: data.tabCharId, roomId: data.roomId });
  }
  if (raws.length === 0) return [];

  // Drop sockets sitting in archived rooms (an "active" socket pointed
  // at an archived room won't get a fresh broadcast anyway; treating it
  // as absent prevents zombie presence credits).
  const roomIds = [...new Set(raws.map((r) => r.roomId))];
  const roomRows = await db
    .select({ id: rooms.id, archivedAt: rooms.archivedAt, serverId: rooms.serverId })
    .from(rooms)
    .where(inArray(rooms.id, roomIds));
  const liveRoomIds = new Set(roomRows.filter((r) => !r.archivedAt).map((r) => r.id));
  // Per-server economy: map each room to its owning server (default server
  // when serverId is null) so presence credits + caps partition per server.
  const serverIdByRoom = new Map(roomRows.map((r) => [r.id, r.serverId ?? DEFAULT_SERVER_ID]));

  // Resolve users' default active character so sockets without a per-tab
  // override use the same fallback as the broadcast layer.
  const userIds = [...new Set(raws.map((r) => r.userId))];
  const userRows = await db
    .select({ id: users.id, activeCharacterId: users.activeCharacterId })
    .from(users)
    .where(inArray(users.id, userIds));
  const defaultByUser = new Map(userRows.map((u) => [u.id, u.activeCharacterId ?? null]));

  const seen = new Set<string>();
  const out: IdentitySnapshot[] = [];
  for (const raw of raws) {
    if (!liveRoomIds.has(raw.roomId)) continue;
    const characterId = raw.tabCharId !== undefined ? raw.tabCharId : (defaultByUser.get(raw.userId) ?? null);
    const key = `${raw.userId}::${characterId ?? ""}::${raw.roomId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      userId: raw.userId,
      characterId,
      roomId: raw.roomId,
      serverId: serverIdByRoom.get(raw.roomId) ?? DEFAULT_SERVER_ID,
    });
  }
  return out;
}

/**
 * Has this pool already earned its daily cap of presence blocks?
 * Counts ledger rows with reason='presence_ic' / 'presence_ooc' in
 * the past 24 hours. Cheap; one indexed query per pool per sweep.
 */
async function isPresenceCapHit(
  db: Db,
  serverId: string,
  scope: "user" | "character",
  ownerId: string,
  cap: number,
): Promise<boolean> {
  if (cap <= 0) return true;
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const reason = scope === "character" ? "presence_ic" : "presence_ooc";
  // Per-server cap: only count blocks earned on THIS server's pool, so a
  // user active on two servers gets a full block allowance on each.
  const rows = await db
    .select({ id: earningLedger.id })
    .from(earningLedger)
    .where(and(
      eq(earningLedger.serverId, serverId),
      eq(earningLedger.scope, scope),
      eq(earningLedger.ownerId, ownerId),
      eq(earningLedger.reason, reason),
      gte(earningLedger.createdAt, cutoff),
    ))
    .limit(cap);
  return rows.length >= cap;
}

/**
 * One sweep tick. Idempotent on its own, each call awards at most
 * one block per active identity, and the cap check stops repeat
 * awards from rolling past the daily limit if the interval drifts.
 *
 * Exposed for direct invocation from `startJanitor` (which schedules
 * it on the configured `presenceBlockMinutes` cadence) and from any
 * future debug/admin route that wants to force-run a sweep.
 */
export async function sweepPresenceOnce(db: Db, io: Io): Promise<{ awarded: number; skipped: number }> {
  let cfg: EarningConfig;
  try {
    cfg = (await getSettings(db)).earningConfig;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[earning] presence sweep: settings read failed", { err });
    return { awarded: 0, skipped: 0 };
  }
  if (!cfg.enabled) return { awarded: 0, skipped: 0 };
  const presenceFlags = cfg.enabledSources.presence;
  if (!presenceFlags.xp && !presenceFlags.currency) return { awarded: 0, skipped: 0 };

  const identities = await snapshotActiveIdentities(db, io);
  let awarded = 0;
  let skipped = 0;
  for (const ident of identities) {
    const scope = ident.characterId ? "character" : "user";
    const ownerId = ident.characterId ?? ident.userId;
    const cap = cfg.presenceDailyBlockCap;
    if (await isPresenceCapHit(db, ident.serverId, scope, ownerId, cap)) {
      skipped += 1;
      continue;
    }
    await awardForPresence({
      db,
      io,
      cfg,
      scope,
      ownerId,
      notifyUserId: ident.userId,
      roomId: ident.roomId,
    });
    awarded += 1;
  }
  return { awarded, skipped };
}

/**
 * Schedule the presence sweep alongside the existing janitor sweeps.
 * Returns a cancel function so `startJanitor` can include the cleanup
 * in its composite cancel callback.
 *
 * Cadence reads from settings on first scheduling; if an admin later
 * edits `presenceBlockMinutes` the change takes effect at the next
 * server reboot (we keep the interval const so a misconfigured 0.1
 * minute can't accidentally hammer the DB).
 */
export async function schedulePresenceSweep(db: Db, io: Io, log: {
  info: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
}): Promise<() => void> {
  let cfg: EarningConfig;
  try {
    cfg = (await getSettings(db)).earningConfig;
  } catch {
    cfg = (await import("./config.js")).DEFAULT_EARNING_CONFIG;
  }
  const minutes = Math.max(1, Math.round(cfg.presenceBlockMinutes));
  const periodMs = minutes * 60 * 1000;

  const tick = async () => {
    try {
      const result = await sweepPresenceOnce(db, io);
      if (result.awarded > 0) {
        log.info(`[earning] presence sweep awarded ${result.awarded}, skipped ${result.skipped} (capped)`);
      }
    } catch (err) {
      log.error({ err }, "[earning] presence sweep failed");
    }
  };

  // Don't fire on boot, wait one full block so a server restart
  // doesn't double-pay a user who just received a presence award
  // immediately before the restart.
  const id = setInterval(() => void tick(), periodMs);
  return () => clearInterval(id);
}
