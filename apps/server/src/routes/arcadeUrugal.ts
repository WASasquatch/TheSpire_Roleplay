/**
 * Spire Arcade routes. Game #2: Urugal's Descent.
 *
 * The game is a vendored, UNTRUSTED client bundle served as a static
 * file (apps/web/public/games/urugal); it only ever *claims* progress.
 * These routes own a server-authoritative run session so those claims
 * can be paid safely:
 *
 *   POST /arcade/urugal/start  → issues a runId (a `urugal_run` row)
 *   POST /arcade/urugal/event  → scores one milestone (floor | boss)
 *   POST /arcade/urugal/end    → marks the run ended (no payout)
 *
 * Every `event` is validated against the run row: floors must advance
 * monotonically within a capped jump, be paced plausibly (min
 * wall-clock per floor from the server-recorded start), and each floor
 * / boss is paid at most once per run. The intended award is clamped to
 * the per-UTC-day cap. See packages/shared/src/urugal.ts for the curve.
 *
 * PHASE 3: validation + dedup + cap are live, but rewards are NOT yet
 * credited — the intended award is logged only. Switching on crediting
 * (creditPool) + the purchase/permission unlock gate is the next phase;
 * the seams (ledger-scan cap query, `userId` for notifyUserId) are
 * already in place so that flip is small.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { nanoid } from "nanoid";
import type { Server as IoServer } from "socket.io";
import {
  type ClientToServerEvents,
  type ServerToClientEvents,
  FLAIR_URUGAL_DESCENT,
  URUGAL_DAILY_CURRENCY_CAP,
  URUGAL_MAX_FLOOR_JUMP,
  URUGAL_MIN_MS_PER_FLOOR,
  urugalBossReward,
  urugalFloorReward,
  startOfUtcDayMs,
  type UrugalEventResponse,
} from "@thekeep/shared";
import { characters, urugalRun } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { hasPermission } from "../auth/permissions.js";
import { creditPool } from "../earning/award.js";
import { clampToDailyCap, earnedTodayForCap } from "../earning/dailyCap.js";
import { resolveActiveServerId } from "../earning/pool.js";
import { ownsPurchase } from "../earning/purchases.js";
import { getSessionUser } from "./auth.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;
type Scope = "user" | "character";

export async function registerUrugalRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  /* ---- identity + gate ----
     Double-gated like the Eidolon Tamer (see routes/arcade.ts): the
     `use_arcade` + `use_urugal_descent` permissions (admin kill-switches),
     then a one-time `flair_urugal_descent` purchase per identity (402 =
     "permission OK, not yet unlocked"). */
  type Gate =
    | { ok: true; userId: string; role: import("@thekeep/shared").Role; scope: Scope; ownerId: string }
    | { ok: false; code: number; body: Record<string, unknown> };

  async function gate(req: FastifyRequest, characterId: string | null): Promise<Gate> {
    const me = await getSessionUser(req, db);
    if (!me) return { ok: false, code: 401, body: { error: "auth" } };
    if (!(await hasPermission(me, "use_arcade", db)) || !(await hasPermission(me, "use_urugal_descent", db))) {
      return { ok: false, code: 403, body: { error: "Urugal's Descent isn't available to you." } };
    }
    let scope: Scope = "user";
    let ownerId = me.id;
    if (characterId) {
      const c = (await db
        .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
        .from(characters).where(eq(characters.id, characterId)).limit(1))[0];
      if (!c || c.userId !== me.id || c.deletedAt) return { ok: false, code: 403, body: { error: "not your character" } };
      scope = "character"; ownerId = characterId;
    }
    // Purchase gate: the per-identity one-time unlock (a ledger row). Checked
    // GLOBALLY (no serverId filter) — the intentional asymmetry vs Eidolon.
    const owned = await ownsPurchase(db, { flairKey: FLAIR_URUGAL_DESCENT, scope, ownerId });
    if (!owned) return { ok: false, code: 402, body: { error: "locked", needsUnlock: true } };
    return { ok: true, userId: me.id, role: me.role, scope, ownerId };
  }

  /* ---- GET /arcade/urugal ---- access probe for the launcher: 200 when
     playable, else the gate's 401 / 402 (locked, needs unlock) / 403. */
  app.get<{ Querystring: { characterId?: string } }>("/arcade/urugal", async (req, reply) => {
    const g = await gate(req, req.query.characterId ?? null);
    if (!g.ok) { reply.code(g.code); return g.body; }
    return { ok: true };
  });

  /** Currency already earned from this game today on `serverId` (for the
   *  daily-cap clamp). Per-server cap: count only rows credited on the SAME
   *  server the credit will land on, so a player active on two servers gets a
   *  full daily allowance on each (mirrors the presence cap in sweeps.ts). */
  function urugalEarnedTodayMs(serverId: string, scope: Scope, ownerId: string, nowMs: number): number {
    return earnedTodayForCap(db, {
      serverId,
      scope,
      ownerId,
      reason: { likePrefix: "urugal" },
      sinceMs: startOfUtcDayMs(nowMs),
    }).currency;
  }

  /* ---- POST /arcade/urugal/start ---- */
  const startBody = z.object({ characterId: z.string().nullable().optional() }).strict();
  app.post<{ Body: unknown }>("/arcade/urugal/start", async (req, reply) => {
    let body: z.infer<typeof startBody>;
    try { body = startBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const g = await gate(req, body.characterId ?? null);
    if (!g.ok) { reply.code(g.code); return g.body; }

    const nowMs = Date.now();
    const id = nanoid();
    db.transaction((tx) => {
      // One active run per identity: retire any still-open runs first so a
      // stale session can't keep accepting events alongside the new one.
      tx.update(urugalRun)
        .set({ status: "ended", endedAt: nowMs })
        .where(and(
          eq(urugalRun.ownerScope, g.scope),
          eq(urugalRun.ownerId, g.ownerId),
          eq(urugalRun.status, "active"),
        )).run();
      tx.insert(urugalRun).values({
        id, ownerScope: g.scope, ownerId: g.ownerId, userId: g.userId,
        startedAt: nowMs, lastEventAt: nowMs, maxFloor: 1, bossesJson: "[]", status: "active",
      }).run();
    });
    return { runId: id };
  });

  /* ---- POST /arcade/urugal/event ---- */
  const eventBody = z.object({
    runId: z.string(),
    type: z.enum(["floor", "boss"]),
    floor: z.number().int().min(1).max(9999),
    characterId: z.string().nullable().optional(),
    serverId: z.string().optional(),
  }).strict();
  app.post<{ Body: unknown }>("/arcade/urugal/event", async (req, reply) => {
    let body: z.infer<typeof eventBody>;
    try { body = eventBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const g = await gate(req, body.characterId ?? null);
    if (!g.ok) { reply.code(g.code); return g.body; }
    // The active server the reward (and its daily-cap scan) lands on.
    const sid = await resolveActiveServerId(db, { id: g.userId, role: g.role }, body.serverId);

    const nowMs = Date.now();
    const earnedToday = urugalEarnedTodayMs(sid, g.scope, g.ownerId, nowMs);
    const remainingCap = Math.max(0, URUGAL_DAILY_CURRENCY_CAP - earnedToday);

    // Validate + dedup + reserve the milestone in one write so two racing
    // events for the same run can't both be paid.
    type Reserved = { ok: true; maxFloor: number; award: { currency: number; xp: number }; capped: boolean };
    const result = db.transaction((tx): Reserved | { reject: string; maxFloor: number } => {
      const run = tx.select().from(urugalRun).where(eq(urugalRun.id, body.runId)).limit(1).all()[0];
      if (!run || run.ownerScope !== g.scope || run.ownerId !== g.ownerId) return { reject: "no such run", maxFloor: 0 };
      if (run.status !== "active") return { reject: "run ended", maxFloor: run.maxFloor };

      // Pacing: floor N is only reachable after N * MIN_MS_PER_FLOOR from start.
      const paced = (nowMs - run.startedAt) >= body.floor * URUGAL_MIN_MS_PER_FLOOR;

      let award = { currency: 0, xp: 0 };
      let nextMaxFloor = run.maxFloor;
      let nextBosses = run.bossesJson;

      if (body.type === "floor") {
        const ok = body.floor > run.maxFloor
          && body.floor - run.maxFloor <= URUGAL_MAX_FLOOR_JUMP
          && paced;
        if (!ok) return { reject: "implausible floor", maxFloor: run.maxFloor };
        award = urugalFloorReward(body.floor);
        nextMaxFloor = body.floor;
      } else {
        // boss: a multiple of 5, reached this run, paid once, paced.
        const bosses: number[] = JSON.parse(run.bossesJson || "[]");
        const ok = body.floor % 5 === 0
          && body.floor >= 5
          && body.floor <= run.maxFloor
          && !bosses.includes(body.floor)
          && paced;
        if (!ok) return { reject: "implausible boss", maxFloor: run.maxFloor };
        award = urugalBossReward(body.floor);
        bosses.push(body.floor);
        nextBosses = JSON.stringify(bosses);
      }

      // The per-UTC-day cap is a hard ceiling on ALL game earning: clamp
      // currency to the remaining headroom, and once the day is exhausted
      // stop paying XP too. Mark the milestone paid either way so a
      // capped-out player doesn't keep retrying it.
      const { currency: grantedCurrency, xp: grantedXp, capped } = clampToDailyCap(award, remainingCap);

      tx.update(urugalRun)
        .set({ maxFloor: nextMaxFloor, bossesJson: nextBosses, lastEventAt: nowMs })
        .where(eq(urugalRun.id, run.id)).run();

      return { ok: true, maxFloor: nextMaxFloor, award: { currency: grantedCurrency, xp: grantedXp }, capped };
    });

    if ("reject" in result) {
      // Not an error — a benign duplicate / out-of-order / implausible claim.
      // The client simply ignores it.
      return { ok: false, maxFloor: result.maxFloor, award: { currency: 0, xp: 0 }, capped: false, credited: false } satisfies UrugalEventResponse;
    }

    // Credit the award through the canonical earning primitive (ledger row +
    // rank recompute + `earning:earned` socket emit). Reason distinguishes
    // the two sources and keeps the daily-cap ledger scan (reason LIKE
    // 'urugal_%') accurate. creditPool is best-effort and no-ops on a
    // zero/zero award, so the cap-exhausted case is a clean skip.
    let credited = false;
    if (result.award.currency > 0 || result.award.xp > 0) {
      await creditPool(db, io, {
        serverId: sid,
        scope: g.scope,
        ownerId: g.ownerId,
        xpDelta: result.award.xp,
        currencyDelta: result.award.currency,
        reason: body.type === "boss" ? "urugal_boss" : "urugal_floor",
        metadata: { runId: body.runId, floor: body.floor },
        notifyUserId: g.userId,
      });
      credited = true;
    }
    return { ok: true, maxFloor: result.maxFloor, award: result.award, capped: result.capped, credited } satisfies UrugalEventResponse;
  });

  /* ---- POST /arcade/urugal/end ---- */
  const endBody = z.object({ runId: z.string(), characterId: z.string().nullable().optional() }).strict();
  app.post<{ Body: unknown }>("/arcade/urugal/end", async (req, reply) => {
    let body: z.infer<typeof endBody>;
    try { body = endBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const g = await gate(req, body.characterId ?? null);
    if (!g.ok) { reply.code(g.code); return g.body; }

    const nowMs = Date.now();
    db.update(urugalRun)
      .set({ status: "ended", endedAt: nowMs })
      .where(and(
        eq(urugalRun.id, body.runId),
        eq(urugalRun.ownerScope, g.scope),
        eq(urugalRun.ownerId, g.ownerId),
      )).run();
    return { ok: true };
  });
}
