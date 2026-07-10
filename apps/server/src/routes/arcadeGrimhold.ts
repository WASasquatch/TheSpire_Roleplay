/**
 * Spire Arcade game #3 — the Grimhold cabinet (six small score-based
 * canvas games). Server-authoritative reward API, mirroring Urugal's
 * Descent (routes/arcadeUrugal.ts).
 *
 * The game is a vendored, UNTRUSTED static bundle
 * (apps/web/public/games/grimhold); it only ever *claims* a final score
 * per finished game. This route owns a short-lived run session, validates
 * each claim (sane per-game max, minimum play time, per-run + per-day
 * caps), and credits via the canonical earning primitive. Client scores
 * stay spoofable up to those bounds; the daily cap bounds the damage.
 *
 * Run sessions are kept in memory (not a DB table): they're ephemeral,
 * session-scoped, and best-effort, only the persistent earning ledger
 * (which drives the daily cap) needs to survive a restart. A run lost to
 * a restart just means that window's submissions are ignored until the
 * player reopens the cabinet.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Server as IoServer } from "socket.io";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type {
  ClientToServerEvents,
  GrimholdScoreResponse,
  ServerToClientEvents,
} from "@thekeep/shared";
import {
  FLAIR_GRIMHOLD,
  GRIMHOLD_DAILY_CURRENCY_CAP,
  GRIMHOLD_MIN_MS_BETWEEN_SCORES,
  GRIMHOLD_MIN_PLAY_MS,
  GRIMHOLD_RUN_STALE_MS,
  grimholdReward,
  isGrimholdGame,
  startOfUtcDayMs,
} from "@thekeep/shared";
import { characters } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { hasPermission } from "../auth/permissions.js";
import { creditPool } from "../earning/award.js";
import { clampToDailyCap, earnedTodayForCap } from "../earning/dailyCap.js";
import { resolveActiveServerId } from "../earning/pool.js";
import { ownsPurchase } from "../earning/purchases.js";
import { tFor } from "../i18n.js";
import { getSessionUser } from "./auth.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;
type Scope = "user" | "character";

interface GrimholdRun {
  scope: Scope;
  ownerId: string;
  userId: string;
  startedAt: number;
  lastScoreAt: number;
}
/** Live run sessions, keyed by runId. Pruned lazily on access. */
const RUNS = new Map<string, GrimholdRun>();

function pruneStaleRuns(nowMs: number): void {
  for (const [id, r] of RUNS) {
    if (nowMs - r.lastScoreAt > GRIMHOLD_RUN_STALE_MS) RUNS.delete(id);
  }
}

export async function registerGrimholdRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  /* ---- identity + gate ----
     Double-gated like the other arcade games: `use_arcade` + `use_grimhold`
     permissions (admin kill-switches), then a one-time `flair_grimhold`
     purchase per identity (402 = "permission OK, not yet unlocked"). */
  type Gate =
    | { ok: true; userId: string; role: import("@thekeep/shared").Role; scope: Scope; ownerId: string }
    | { ok: false; code: number; body: Record<string, unknown> };

  async function gate(req: FastifyRequest, characterId: string | null): Promise<Gate> {
    const me = await getSessionUser(req, db);
    if (!me) return { ok: false, code: 401, body: { error: "auth" } };
    if (!(await hasPermission(me, "use_arcade", db)) || !(await hasPermission(me, "use_grimhold", db))) {
      return { ok: false, code: 403, body: { error: tFor(me.locale, "errors:server.arcade.grimholdUnavailable") } };
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
    // Purchase gate checked GLOBALLY (no serverId filter) — the intentional
    // asymmetry vs the per-server Eidolon Tamer unlock.
    const owned = await ownsPurchase(db, { flairKey: FLAIR_GRIMHOLD, scope, ownerId });
    if (!owned) return { ok: false, code: 402, body: { error: "locked", needsUnlock: true } };
    return { ok: true, userId: me.id, role: me.role, scope, ownerId };
  }

  /* ---- GET /arcade/grimhold ---- access probe for the launcher. */
  app.get<{ Querystring: { characterId?: string } }>("/arcade/grimhold", async (req, reply) => {
    const g = await gate(req, req.query.characterId ?? null);
    if (!g.ok) { reply.code(g.code); return g.body; }
    return { ok: true };
  });

  /** Currency already earned from the cabinet today on `serverId` (for the
   *  daily-cap clamp). Per-server cap: count only rows credited on the SAME
   *  server the credit will land on, so a player active on two servers gets a
   *  full daily allowance on each (mirrors the presence cap in sweeps.ts). */
  function grimholdEarnedToday(serverId: string, scope: Scope, ownerId: string, nowMs: number): number {
    return earnedTodayForCap(db, {
      serverId,
      scope,
      ownerId,
      reason: { likePrefix: "grimhold" },
      sinceMs: startOfUtcDayMs(nowMs),
    }).currency;
  }

  /* ---- POST /arcade/grimhold/start ---- */
  const startBody = z.object({ characterId: z.string().nullable().optional() }).strict();
  app.post<{ Body: unknown }>("/arcade/grimhold/start", async (req, reply) => {
    let body: z.infer<typeof startBody>;
    try { body = startBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const g = await gate(req, body.characterId ?? null);
    if (!g.ok) { reply.code(g.code); return g.body; }

    const nowMs = Date.now();
    pruneStaleRuns(nowMs);
    const id = nanoid();
    RUNS.set(id, { scope: g.scope, ownerId: g.ownerId, userId: g.userId, startedAt: nowMs, lastScoreAt: 0 });
    return { runId: id };
  });

  /* ---- POST /arcade/grimhold/score ---- one finished game. */
  const scoreBody = z.object({
    runId: z.string(),
    game: z.string(),
    score: z.number().finite().min(0).max(100_000_000),
    elapsedMs: z.number().finite().min(0).max(24 * 60 * 60 * 1000),
    characterId: z.string().nullable().optional(),
    serverId: z.string().optional(),
  }).strict();
  app.post<{ Body: unknown }>("/arcade/grimhold/score", async (req, reply) => {
    let body: z.infer<typeof scoreBody>;
    try { body = scoreBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const g = await gate(req, body.characterId ?? null);
    if (!g.ok) { reply.code(g.code); return g.body; }
    // The active server the reward (and its daily-cap scan) lands on.
    const sid = await resolveActiveServerId(db, { id: g.userId, role: g.role }, body.serverId);

    const noPay: GrimholdScoreResponse = { ok: false, award: { currency: 0, xp: 0 }, capped: false, credited: false };

    const run = RUNS.get(body.runId);
    // Bind to a live session owned by this exact identity.
    if (!run || run.scope !== g.scope || run.ownerId !== g.ownerId) return noPay;
    if (!isGrimholdGame(body.game)) return noPay;

    const nowMs = Date.now();
    // Anti-spoof: a game can't have lasted longer than the session has
    // existed, must clear the minimum play time, and submissions are
    // rate-limited so a script can't spam game-overs.
    if (body.elapsedMs < GRIMHOLD_MIN_PLAY_MS) return noPay;
    if (body.elapsedMs > nowMs - run.startedAt + 2_000) return noPay;
    if (run.lastScoreAt && nowMs - run.lastScoreAt < GRIMHOLD_MIN_MS_BETWEEN_SCORES) return noPay;
    run.lastScoreAt = nowMs;

    const reward = grimholdReward(body.game, body.score);
    if (reward.currency <= 0 && reward.xp <= 0) {
      return { ok: true, award: { currency: 0, xp: 0 }, capped: false, credited: false } satisfies GrimholdScoreResponse;
    }

    // Clamp to the remaining daily headroom (hard ceiling across all six
    // games). Once exhausted, XP stops too.
    const earnedToday = grimholdEarnedToday(sid, g.scope, g.ownerId, nowMs);
    const remainingCap = Math.max(0, GRIMHOLD_DAILY_CURRENCY_CAP - earnedToday);
    const { currency: grantedCurrency, xp: grantedXp, capped } = clampToDailyCap(reward, remainingCap);

    let credited = false;
    if (grantedCurrency > 0 || grantedXp > 0) {
      await creditPool(db, io, {
        serverId: sid,
        scope: g.scope,
        ownerId: g.ownerId,
        xpDelta: grantedXp,
        currencyDelta: grantedCurrency,
        // `grimhold_<game>` keeps the daily-cap ledger scan (reason LIKE
        // 'grimhold_%') accurate and distinguishes per-game sources.
        reason: `grimhold_${body.game}`,
        metadata: { runId: body.runId, game: body.game, score: Math.floor(body.score) },
        notifyUserId: g.userId,
      });
      credited = true;
    }
    return {
      ok: true,
      award: { currency: grantedCurrency, xp: grantedXp },
      capped,
      credited,
    } satisfies GrimholdScoreResponse;
  });

  /* ---- POST /arcade/grimhold/end ---- retire the session (best-effort). */
  const endBody = z.object({ runId: z.string(), characterId: z.string().nullable().optional() }).strict();
  app.post<{ Body: unknown }>("/arcade/grimhold/end", async (req, reply) => {
    let body: z.infer<typeof endBody>;
    try { body = endBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    RUNS.delete(body.runId);
    return { ok: true };
  });
}
