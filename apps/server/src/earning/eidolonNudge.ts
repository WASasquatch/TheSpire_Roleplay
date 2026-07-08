/**
 * Opt-in "your familiar needs you" push nudges — the daily-return driver for
 * the Eidolon Tamer. An hourly sweep finds living, opted-in familiars that
 * haven't been tended today and pushes their owner a (deliberately generic)
 * reminder, at most once per day per user. Online users are skipped (they'll
 * see it in-app). Mirrors earning/sweeps.ts + seed.ts's janitor wiring; reuses
 * push.ts (pushToUser) and realtime/broadcast.ts (userIsOnline).
 */
import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import type { Db } from "../db/index.js";
import { characters, eidolonState } from "../db/schema.js";
import { pushToUser } from "../push.js";
import { onlineUserIds } from "../realtime/broadcast.js";
import { serverDayKey } from "./eidolon.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;
type Log = { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly; the per-day-key guard bounds sends to once/day

/** One nudge pass. Best-effort; never throws out to the scheduler. */
export async function sweepEidolonNudgesOnce(db: Db, io: Io): Promise<void> {
  const today = serverDayKey();
  const rows = await db
    .select({
      serverId: eidolonState.serverId,
      ownerScope: eidolonState.ownerScope,
      ownerId: eidolonState.ownerId,
      lastCheckInDayKey: eidolonState.lastCheckInDayKey,
      lastNudgeDayKey: eidolonState.lastNudgeDayKey,
    })
    .from(eidolonState)
    // Living, opted-in familiars only — a dormant/dead one needs a Potion-revive,
    // not a "you haven't tended it today" nudge.
    .where(and(notInArray(eidolonState.stage, ["dead", "dormant"]), eq(eidolonState.nudgeOptin, true)));

  // Not tended today, and not already nudged today — both day-keys live PER
  // FAMILIAR (per server row), so a familiar on server A and the same person's
  // familiar on server B each get their own "needs you today" pass.
  const due = rows.filter((r) => r.lastCheckInDayKey !== today && r.lastNudgeDayKey !== today);
  if (due.length === 0) return;

  // Batch-resolve character -> owning user in ONE query (avoids an N+1).
  const charIds = [...new Set(due.filter((r) => r.ownerScope === "character").map((r) => r.ownerId))];
  const charToUser = new Map<string, string>();
  if (charIds.length > 0) {
    const cs = await db.select({ id: characters.id, userId: characters.userId }).from(characters).where(inArray(characters.id, charIds));
    for (const c of cs) charToUser.set(c.id, c.userId);
  }
  const userIdOf = (r: { ownerScope: "user" | "character"; ownerId: string }): string | null =>
    r.ownerScope === "user" ? r.ownerId : charToUser.get(r.ownerId) ?? null;

  // Snapshot the online set ONCE for the whole pass (not once per familiar).
  const online = await onlineUserIds(io);

  // Group due familiars by owning user (push subscriptions are per-user, so we
  // nudge a user once and mark all their due familiars). Each entry carries the
  // familiar's serverId so the per-server row is the one marked.
  const byUser = new Map<string, Array<{ serverId: string; ownerScope: "user" | "character"; ownerId: string }>>();
  for (const r of due) {
    const uid = userIdOf(r);
    if (!uid) continue;
    (byUser.get(uid) ?? byUser.set(uid, []).get(uid)!).push({ serverId: r.serverId, ownerScope: r.ownerScope, ownerId: r.ownerId });
  }

  // Nudge each OFFLINE user once + mark all their due familiars. Online users
  // are left unmarked on purpose, so they're caught on a later sweep once
  // they go offline (they can see the state in-app while online). Parallel.
  // The day-key write keys on (serverId, ownerScope, ownerId) so the dedup is
  // PER FAMILIAR (per server) — marking one server's familiar doesn't suppress
  // a still-due familiar of the same identity on another server.
  await Promise.all([...byUser.entries()].map(async ([userId, fams]) => {
    if (online.has(userId)) return;
    await pushToUser(db, userId, {
      title: "Your familiar stirs",
      body: "It hasn't been tended today.",
      tag: "eidolon-nudge",
      url: "/?arcade=eidolon",
    });
    await Promise.all(fams.map((f) =>
      db.update(eidolonState).set({ lastNudgeDayKey: today })
        .where(and(eq(eidolonState.serverId, f.serverId), eq(eidolonState.ownerScope, f.ownerScope), eq(eidolonState.ownerId, f.ownerId)))));
  }));
}

/** Schedule the hourly nudge sweep. Returns a cancel fn (mirrors schedulePresenceSweep). */
export async function scheduleEidolonNudgeSweep(db: Db, io: Io, log: Log): Promise<() => void> {
  const id = setInterval(() => {
    void sweepEidolonNudgesOnce(db, io).catch((err) => log.error({ err }, "[eidolon] nudge sweep failed"));
  }, SWEEP_INTERVAL_MS);
  log.info("[eidolon] nudge sweep scheduled");
  return () => clearInterval(id);
}
