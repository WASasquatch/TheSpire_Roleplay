/**
 * Spire Arcade routes. Game #1: the Eidolon Tamer.
 *
 * Every endpoint is double-gated server-side: the `use_eidolon_tamer`
 * permission (admin kill-switch) AND a one-time purchase of
 * `flair_eidolon_tamer` for the acting identity (the player's unlock).
 * State is per-identity; decay is reproduced from the persisted snapshot
 * on every call (see earning/eidolon.ts), so reads/actions all run a
 * catch-up first, apply their effect, then persist with lastSeenMs=now.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Server as IoServer } from "socket.io";
import { nanoid } from "nanoid";
import type { ClientToServerEvents, EidolonHallEntry, EidolonProfileSummary, EidolonSnapshot, ServerToClientEvents } from "@thekeep/shared";
import { EIDOLON_SPECIES_IDS, EIDOLON_MOOD_LABEL, EIDOLON_PAT_COOLDOWN_MS, EIDOLON_PAT_JOY_GAIN, FLAIR_EIDOLON_TAMER, effectiveTraits, eidolonCareXp, eidolonLevelFromXp, eidolonLineageBonusXp, eidolonPrimaryMood, eidolonSaleValueOf, reviveStats, rollTraitId, rollVariant, streakXpMultiplier } from "@thekeep/shared";
import { characterEarning, characters, earningLedger, eidolonHall, eidolonState, eidolonVisits, identityInventory, items, userEarning } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "./auth.js";
import { hasPermission } from "../auth/permissions.js";
import { creditPool } from "../earning/award.js";
import { DEFAULT_SERVER_ID } from "../earning/pool.js";
import { fetchDisplayInfo } from "../earning/rankings.js";
import {
  BASIC_HEAL_AMOUNT, BASIC_HEAL_COST, POTION_HEAL_AMOUNT,
  catchUp, currentSimHour, foodEffect, freshStats, rollCheckIn, rollName, serverDayKey, toyEffect, type EidolonProgress,
} from "../earning/eidolon.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;
type Scope = "user" | "character";
type Row = typeof eidolonState.$inferSelect;
const clamp = (n: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, n));
/** Total of the five wellbeing gauges — the "before vs after" measure that
 *  decides how much active-care XP a tend earns (see eidolonCareXp). */
const gaugeSum = (s: { satiety: number; joy: number; vigor: number; hygiene: number; health: number }): number =>
  s.satiety + s.joy + s.vigor + s.hygiene + s.health;

export async function registerArcadeRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  /* ---- identity + gate ---- */
  type Gate =
    | { ok: true; userId: string; role: import("@thekeep/shared").Role; scope: Scope; ownerId: string }
    | { ok: false; code: number; body: Record<string, unknown> };

  async function gate(req: FastifyRequest, characterId: string | null): Promise<Gate> {
    const me = await getSessionUser(req, db);
    if (!me) return { ok: false, code: 401, body: { error: "auth" } };
    // Two permission gates: the Arcade section, then this specific game.
    // Admins can revoke either via the matrix (kill-switch).
    if (!(await hasPermission(me, "use_arcade", db)) || !(await hasPermission(me, "use_eidolon_tamer", db))) {
      return { ok: false, code: 403, body: { error: "The Eidolon Tamer isn't available to you." } };
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
    // Purchase gate: the per-identity one-time unlock (a ledger row).
    const owned = (await db
      .select({ id: earningLedger.id })
      .from(earningLedger)
      .where(and(eq(earningLedger.scope, scope), eq(earningLedger.ownerId, ownerId), eq(earningLedger.reason, `purchase_${FLAIR_EIDOLON_TAMER}`)))
      .limit(1))[0];
    if (!owned) return { ok: false, code: 402, body: { error: "locked", needsUnlock: true } };
    return { ok: true, userId: me.id, role: me.role, scope, ownerId };
  }

  async function loadRow(scope: Scope, ownerId: string): Promise<Row | undefined> {
    return (await db.select().from(eidolonState)
      .where(and(eq(eidolonState.ownerScope, scope), eq(eidolonState.ownerId, ownerId))).limit(1))[0];
  }

  async function petIconFor(petItemKey: string | null): Promise<string | null> {
    if (!petItemKey) return null;
    const it = (await db.select({ iconUrl: items.iconUrl }).from(items).where(eq(items.key, petItemKey)).limit(1))[0];
    return it?.iconUrl ?? null;
  }

  function snapshotOf(row: Row, prog: EidolonProgress, petIconUrl: string | null, nowMs: number): EidolonSnapshot {
    return {
      stage: prog.dead ? "dormant" : "alive",
      kind: row.kind,
      speciesId: row.kind === "species" ? (row.speciesId as EidolonSnapshot["speciesId"]) : null,
      petItemKey: row.kind === "pet" ? row.petItemKey : null,
      petIconUrl,
      name: row.name,
      stats: prog.stats,
      sick: prog.sick,
      asleep: prog.asleep,
      ageHours: prog.ageHours,
      simHour: prog.simHour,
      messCount: prog.messCount,
      xp: prog.xp,
      level: eidolonLevelFromXp(prog.xp),
      saleValue: eidolonSaleValueOf(prog.xp, row.bonusXp, row.variant),
      streakCount: row.streakCount,
      bestStreak: row.bestStreak,
      checkedInToday: row.lastCheckInDayKey === serverDayKey(new Date(nowMs)),
      streakMultiplier: streakXpMultiplier(row.streakCount),
      nudgeOptin: row.nudgeOptin,
      trait: (row.trait as EidolonSnapshot["trait"]) ?? null,
      variant: (row.variant as EidolonSnapshot["variant"]) ?? null,
      serverNowMs: nowMs,
    };
  }

  /** Build a Hall memorial row for a departing familiar. `peakLevel` = the
   *  level at departure, which equals the lifetime peak (XP only ever accrues). */
  function hallValues(scope: Scope, ownerId: string, row: Row, prog: EidolonProgress, reason: "sold" | "released", nowMs: number): typeof eidolonHall.$inferInsert {
    return {
      id: nanoid(), ownerScope: scope, ownerId, name: row.name, kind: row.kind,
      speciesId: row.speciesId, trait: row.trait, variant: row.variant,
      peakLevel: eidolonLevelFromXp(prog.xp), ageHours: prog.ageHours,
      departReason: reason, departedAt: nowMs,
    };
  }

  /** Write the caught-up + effect-applied progress back. */
  async function persist(scope: Scope, ownerId: string, row: Row, prog: EidolonProgress, nowMs: number): Promise<void> {
    await db.update(eidolonState).set({
      // dead -> "dormant" (frozen, revivable); otherwise alive. A persisted row
      // is never "egg" (hatch writes "alive"), so a non-dead familiar is alive —
      // this is also what flips a just-revived familiar (prog.dead=false) back
      // to "alive" from its prior "dormant" row.stage.
      stage: prog.dead ? "dormant" : "alive",
      satiety: prog.stats.satiety, joy: prog.stats.joy, vigor: prog.stats.vigor,
      hygiene: prog.stats.hygiene, health: prog.stats.health,
      sick: prog.sick, asleep: prog.asleep, ageHours: prog.ageHours,
      simHour: prog.simHour, messCount: prog.messCount, xp: prog.xp,
      // Streak fields are mutated on the in-memory row by recordCheckIn() in
      // the tend handlers; on a GET read they're unchanged (no advancement).
      streakCount: row.streakCount, bestStreak: row.bestStreak, lastCheckInDayKey: row.lastCheckInDayKey,
      lastSeenMs: nowMs, updatedAt: new Date(),
    }).where(and(eq(eidolonState.ownerScope, scope), eq(eidolonState.ownerId, ownerId)));
  }

  /** Record a daily care-streak check-in. Mutates the in-memory row's streak
   *  fields (persist writes them) and grants the milestone currency reward the
   *  first time a streak reaches a milestone. Call ONLY from tend endpoints —
   *  never the polled GET read — so the streak advances on real care, once/day. */
  async function recordCheckIn(scope: Scope, ownerId: string, userId: string, row: Row, nowMs: number): Promise<void> {
    const todayKey = serverDayKey(new Date(nowMs));
    const where = and(eq(eidolonState.ownerScope, scope), eq(eidolonState.ownerId, ownerId));
    // Advance the streak ATOMICALLY under SQLite's write lock so two concurrent
    // tends on a milestone day can't both grant the reward: the first txn writes
    // lastCheckInDayKey=today, the second re-reads it and sees the day already
    // claimed (advanced=false). Re-reading inside the txn (not the stale loaded
    // row) is what makes the once-per-day guarantee hold under a double-fire.
    const res = db.transaction((tx) => {
      const cur = tx.select({ streakCount: eidolonState.streakCount, lastCheckInDayKey: eidolonState.lastCheckInDayKey, bestStreak: eidolonState.bestStreak })
        .from(eidolonState).where(where).limit(1).all()[0];
      if (!cur) return null;
      const roll = rollCheckIn({ streakCount: cur.streakCount, lastCheckInDayKey: cur.lastCheckInDayKey, bestStreak: cur.bestStreak }, todayKey);
      if (roll.advanced) {
        tx.update(eidolonState).set({ streakCount: roll.streakCount, bestStreak: roll.bestStreak, lastCheckInDayKey: roll.lastCheckInDayKey }).where(where).run();
      }
      return roll;
    });
    if (!res) return;
    // Sync the in-memory row so persist()/snapshotOf reflect the new streak.
    row.streakCount = res.streakCount;
    row.bestStreak = res.bestStreak;
    row.lastCheckInDayKey = res.lastCheckInDayKey;
    if (res.advanced && res.reward > 0) {
      // Best-effort (logs, never throws) — writes the ledger + emits earning:earned.
      await creditPool(db, io, {
        serverId: DEFAULT_SERVER_ID,
        scope, ownerId, xpDelta: 0, currencyDelta: res.reward,
        reason: "eidolon_streak", metadata: { streak: res.streakCount }, notifyUserId: userId,
      });
    }
  }

  /** Per-identity in-flight lock for ITEM-CONSUMING actions (feed / remedy /
   *  revive). Node is single-threaded, so this synchronous claim/release
   *  reliably rejects a second request that OVERLAPS the first for the same
   *  familiar — the concurrent double-fire that would otherwise consume two
   *  items for one intent. Sequential actions don't overlap, so legitimate
   *  repeated feeding still works. (Single-process; a duplicate from a real
   *  double-click reaches the same instance, which is the case that matters.) */
  const consuming = new Set<string>();
  const beginConsume = (scope: Scope, ownerId: string): boolean => {
    const k = `${scope}::${ownerId}`;
    if (consuming.has(k)) return false;
    consuming.add(k);
    return true;
  };
  const endConsume = (scope: Scope, ownerId: string): void => { consuming.delete(`${scope}::${ownerId}`); };

  /** Decrement one unit of an item from the identity's inventory (delete
   *  the row at 0) + ledger it. Returns false when they don't hold it. */
  function consumeOne(scope: Scope, ownerId: string, itemKey: string): boolean {
    return db.transaction((tx): boolean => {
      const ex = tx.select({ qty: identityInventory.quantity }).from(identityInventory)
        .where(and(eq(identityInventory.ownerScope, scope), eq(identityInventory.ownerId, ownerId), eq(identityInventory.itemKey, itemKey)))
        .limit(1).all()[0];
      if (!ex || ex.qty < 1) return false;
      const whereId = and(eq(identityInventory.ownerScope, scope), eq(identityInventory.ownerId, ownerId), eq(identityInventory.itemKey, itemKey));
      if (ex.qty <= 1) tx.delete(identityInventory).where(whereId).run();
      else tx.update(identityInventory).set({ quantity: ex.qty - 1, updatedAt: new Date() }).where(whereId).run();
      tx.insert(earningLedger).values({
        id: nanoid(), scope, ownerId, xpDelta: 0, currencyDelta: 0,
        reason: `item_use_${itemKey}`, metadataJson: JSON.stringify({ kind: "item_use", itemKey, via: "eidolon" }),
      }).run();
      return true;
    });
  }

  /** Debit currency from the identity's pool (balance-checked). */
  function debitCurrency(scope: Scope, userId: string, ownerId: string, amount: number, reason: string):
    | { ok: true; final: { xp: number; currency: number; rankKey: string | null; tier: number | null } }
    | { ok: false; balance: number } {
    return db.transaction((tx) => {
      if (scope === "character") {
        tx.insert(characterEarning).values({ characterId: ownerId }).onConflictDoNothing().run();
        const e = tx.select().from(characterEarning).where(eq(characterEarning.characterId, ownerId)).limit(1).all()[0];
        const bal = e?.currency ?? 0;
        if (bal < amount) return { ok: false as const, balance: bal };
        tx.update(characterEarning).set({ currency: bal - amount, updatedAt: new Date() }).where(eq(characterEarning.characterId, ownerId)).run();
        tx.insert(earningLedger).values({ id: nanoid(), scope, ownerId, xpDelta: 0, currencyDelta: -amount, reason, metadataJson: JSON.stringify({ kind: "eidolon_heal" }) }).run();
        return { ok: true as const, final: { xp: e?.xp ?? 0, currency: bal - amount, rankKey: e?.rankKey ?? null, tier: e?.tier ?? null } };
      }
      tx.insert(userEarning).values({ userId }).onConflictDoNothing().run();
      const e = tx.select().from(userEarning).where(eq(userEarning.userId, userId)).limit(1).all()[0];
      const bal = e?.currency ?? 0;
      if (bal < amount) return { ok: false as const, balance: bal };
      tx.update(userEarning).set({ currency: bal - amount, updatedAt: new Date() }).where(eq(userEarning.userId, userId)).run();
      tx.insert(earningLedger).values({ id: nanoid(), scope: "user", ownerId: userId, xpDelta: 0, currencyDelta: -amount, reason, metadataJson: JSON.stringify({ kind: "eidolon_heal" }) }).run();
      return { ok: true as const, final: { xp: e?.xp ?? 0, currency: bal - amount, rankKey: e?.rankKey ?? null, tier: e?.tier ?? null } };
    });
  }

  async function emitToUser(userId: string, ev: Parameters<Io["emit"]>[0], payload: unknown): Promise<void> {
    const sockets = await io.fetchSockets();
    for (const s of sockets) {
      if ((s.data as { userId?: string }).userId !== userId) continue;
      (s.emit as (e: string, p: unknown) => void)(ev as string, payload);
    }
  }

  /* ---- GET /arcade/eidolon ---- */
  app.get<{ Querystring: { characterId?: string } }>("/arcade/eidolon", async (req, reply) => {
    const g = await gate(req, req.query.characterId ?? null);
    if (!g.ok) { reply.code(g.code); return g.body; }
    const row = await loadRow(g.scope, g.ownerId);
    if (!row) return { eidolon: null };
    const nowMs = Date.now();
    const prog = catchUp(row, nowMs);
    await persist(g.scope, g.ownerId, row, prog, nowMs);
    return { eidolon: snapshotOf(row, prog, await petIconFor(row.petItemKey), nowMs) };
  });

  /* ---- GET /arcade/eidolon/summary ---- (public-view familiar summary for a
     profile card; any authed user may view any identity's familiar, like pets.
     Read-only, no persist, no purchase/permission gate — viewing, not playing.) */
  app.get<{ Querystring: { scope?: string; ownerId?: string } }>("/arcade/eidolon/summary", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const scope: Scope = req.query.scope === "character" ? "character" : "user";
    const ownerId = (req.query.ownerId ?? "").trim();
    if (!ownerId) { reply.code(400); return { error: "ownerId required" }; }
    const row = await loadRow(scope, ownerId);
    if (!row) return { eidolon: null };
    // Respect the target's privacy: fetchDisplayInfo drops hidden / private /
    // disabled / deleted identities (the same gate the leaderboards use), so a
    // private profile's familiar isn't leaked or enumerable here either.
    const visible = await fetchDisplayInfo(db, [{ scope, ownerId }]);
    if (!visible.get(`${scope}::${ownerId}`)) return { eidolon: null };
    const prog = catchUp(row, Date.now());
    const summary: EidolonProfileSummary = {
      kind: row.kind,
      speciesId: row.kind === "species" ? (row.speciesId as EidolonProfileSummary["speciesId"]) : null,
      petIconUrl: await petIconFor(row.petItemKey),
      name: row.name,
      level: eidolonLevelFromXp(prog.xp),
      ageHours: prog.ageHours,
      streakCount: row.streakCount,
      dead: prog.dead,
      sick: prog.sick,
      variant: (row.variant as EidolonProfileSummary["variant"]) ?? null,
      moodLabel: EIDOLON_MOOD_LABEL[eidolonPrimaryMood(prog.stats, { asleep: prog.asleep, sick: prog.sick, dead: prog.dead })],
    };
    return { eidolon: summary };
  });

  /* ---- POST /arcade/eidolon/visit ---- (pat another player's familiar: a small
     +joy social gesture, 24h cooldown per visitor-user per target, blocks
     patting any familiar you own). Requires use_arcade but NOT a purchase. */
  const visitBody = z.object({ scope: z.enum(["user", "character"]), ownerId: z.string() }).strict();
  app.post<{ Body: unknown }>("/arcade/eidolon/visit", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (!(await hasPermission(me, "use_arcade", db))) { reply.code(403); return { error: "The Arcade isn't available to you." }; }
    let body: z.infer<typeof visitBody>;
    try { body = visitBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const targetScope: Scope = body.scope;
    const targetOwnerId = body.ownerId.trim();
    if (!targetOwnerId) { reply.code(400); return { error: "target required" }; }

    // Resolve the target's owning user to block patting any of your own
    // identities' familiars (the gesture means "someone ELSE cares").
    const targetUserId = targetScope === "user"
      ? targetOwnerId
      : (await db.select({ userId: characters.userId }).from(characters).where(eq(characters.id, targetOwnerId)).limit(1))[0]?.userId;
    if (!targetUserId) { reply.code(404); return { error: "no such familiar" }; }
    if (targetUserId === me.id) { reply.code(409); return { error: "you can't pat your own familiar" }; }

    const row = await loadRow(targetScope, targetOwnerId);
    if (!row) { reply.code(404); return { error: "they have no familiar to pat" }; }
    const nowMs = Date.now();
    const prog = catchUp(row, nowMs);
    if (prog.dead) { reply.code(409); return { error: "that familiar lies dormant" }; }

    // Atomic cooldown claim: read last pat + write the new timestamp in one
    // transaction so a double-fire can't double-pat (the second sees the claim).
    const visitWhere = and(eq(eidolonVisits.visitorUserId, me.id), eq(eidolonVisits.targetOwnerScope, targetScope), eq(eidolonVisits.targetOwnerId, targetOwnerId));
    const claim = db.transaction((tx): { ok: boolean; retryAfterMs: number } => {
      const last = tx.select({ visitedAt: eidolonVisits.visitedAt }).from(eidolonVisits).where(visitWhere).limit(1).all()[0];
      const since = last ? nowMs - last.visitedAt : Infinity;
      if (since < EIDOLON_PAT_COOLDOWN_MS) return { ok: false, retryAfterMs: EIDOLON_PAT_COOLDOWN_MS - since };
      tx.insert(eidolonVisits).values({ visitorUserId: me.id, targetOwnerScope: targetScope, targetOwnerId, visitedAt: nowMs })
        .onConflictDoUpdate({ target: [eidolonVisits.visitorUserId, eidolonVisits.targetOwnerScope, eidolonVisits.targetOwnerId], set: { visitedAt: nowMs } }).run();
      return { ok: true, retryAfterMs: 0 };
    });
    if (!claim.ok) { reply.code(429); return { error: "you've already patted this familiar today", retryAfterMs: claim.retryAfterMs }; }

    // Apply the joy to the target's familiar. NOT a check-in for the owner
    // (their streak only advances when THEY tend it) — persist writes the
    // unchanged streak fields off the loaded row.
    prog.stats.joy = clamp(prog.stats.joy + EIDOLON_PAT_JOY_GAIN);
    await persist(targetScope, targetOwnerId, row, prog, nowMs);
    return { ok: true, joyDelta: EIDOLON_PAT_JOY_GAIN };
  });

  /* ---- POST /arcade/eidolon/hatch ---- (choose a species egg or hatch with a pet) */
  const hatchBody = z.object({
    characterId: z.string().nullable().optional(),
    kind: z.enum(["species", "pet"]),
    speciesId: z.string().optional(),
    petItemKey: z.string().optional(),
    name: z.string().trim().max(24).optional(),
  }).strict();
  app.post<{ Body: unknown }>("/arcade/eidolon/hatch", async (req, reply) => {
    let body: z.infer<typeof hatchBody>;
    try { body = hatchBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const g = await gate(req, body.characterId ?? null);
    if (!g.ok) { reply.code(g.code); return g.body; }
    // Refuse to hatch over an EXISTING familiar. The UI only shows egg-select
    // when there's none, so this guards the raw API: without it a hatch could
    // silently overwrite a living/dormant familiar (losing its Hall record +
    // the lineage it would feed) or be abused to reroll a trait/variant. Sell
    // and release are the only ways to clear the slot (both write the Hall row).
    if (await loadRow(g.scope, g.ownerId)) { reply.code(409); return { error: "you already have a familiar — sell, release, or revive it first" }; }

    let speciesId: string | null = null;
    let petItemKey: string | null = null;
    let name = (body.name ?? "").trim();
    if (body.kind === "species") {
      if (!body.speciesId || !(EIDOLON_SPECIES_IDS as readonly string[]).includes(body.speciesId)) {
        reply.code(400); return { error: "unknown species" };
      }
      speciesId = body.speciesId;
      if (!name) name = rollName();
    } else {
      if (!body.petItemKey) { reply.code(400); return { error: "pet required" }; }
      // The identity must own at least one of that pet item.
      const it = (await db.select({ key: items.key, name: items.name, category: items.category }).from(items).where(eq(items.key, body.petItemKey)).limit(1))[0];
      if (!it || it.category !== "pet") { reply.code(400); return { error: "not a pet" }; }
      const held = (await db.select({ qty: identityInventory.quantity }).from(identityInventory)
        .where(and(eq(identityInventory.ownerScope, g.scope), eq(identityInventory.ownerId, g.ownerId), eq(identityInventory.itemKey, body.petItemKey))).limit(1))[0];
      if (!held || held.qty < 1) { reply.code(403); return { error: "you don't own that pet" }; }
      petItemKey = body.petItemKey;
      if (!name) name = it.name;
    }

    const nowMs = Date.now();
    const fresh = freshStats();
    const simHour = currentSimHour();
    // Lineage: inherit from the most recent departed familiar this identity
    // raised — a non-sellable, level-scaled XP head-start (bonusXp) + that
    // predecessor's trait (the "bloodline"). No predecessor -> fresh roll, 0.
    const last = (await db.select({ peakLevel: eidolonHall.peakLevel, trait: eidolonHall.trait })
      .from(eidolonHall)
      .where(and(eq(eidolonHall.ownerScope, g.scope), eq(eidolonHall.ownerId, g.ownerId)))
      .orderBy(desc(eidolonHall.departedAt)).limit(1))[0];
    const bonusXp = last ? eidolonLineageBonusXp(last.peakLevel) : 0;
    const trait = (last?.trait as string | null) ?? rollTraitId(); // bloodline, else a fresh quirk
    // Rare egg: a small chance a SPECIES hatch is a prismatic variant (pets use
    // their own art). Visual prestige + a sale bump; a surprise at hatch.
    const variant = body.kind === "species" ? rollVariant() : null;
    const values = {
      ownerScope: g.scope, ownerId: g.ownerId, stage: "alive" as const, kind: body.kind,
      speciesId, petItemKey, name,
      satiety: fresh.satiety, joy: fresh.joy, vigor: fresh.vigor, hygiene: fresh.hygiene, health: fresh.health,
      sick: false, asleep: false, ageHours: 0, simHour, messCount: 0, xp: bonusXp, bonusXp, trait, variant, lastSeenMs: nowMs,
      hatchedAt: new Date(nowMs), updatedAt: new Date(nowMs),
    };
    await db.insert(eidolonState).values(values).onConflictDoUpdate({
      target: [eidolonState.ownerScope, eidolonState.ownerId],
      set: { stage: "alive", kind: body.kind, speciesId, petItemKey, name, ...fresh, sick: false, asleep: false, ageHours: 0, simHour, messCount: 0, xp: bonusXp, bonusXp, trait, variant, streakCount: 0, bestStreak: 0, lastCheckInDayKey: null, lastSeenMs: nowMs, hatchedAt: new Date(nowMs), updatedAt: new Date(nowMs) },
    });
    const row = (await loadRow(g.scope, g.ownerId))!;
    const prog = catchUp(row, nowMs);
    return { eidolon: snapshotOf(row, prog, await petIconFor(petItemKey), nowMs) };
  });

  /* ---- POST /arcade/eidolon/action ---- (free gestures: play / clean / rest) */
  const actionBody = z.object({
    characterId: z.string().nullable().optional(),
    kind: z.enum(["play", "clean", "rest"]),
  }).strict();
  app.post<{ Body: unknown }>("/arcade/eidolon/action", async (req, reply) => {
    let body: z.infer<typeof actionBody>;
    try { body = actionBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const g = await gate(req, body.characterId ?? null);
    if (!g.ok) { reply.code(g.code); return g.body; }
    const row = await loadRow(g.scope, g.ownerId);
    if (!row) { reply.code(404); return { error: "no familiar" }; }
    const nowMs = Date.now();
    const prog = catchUp(row, nowMs);
    if (prog.dead) { reply.code(409); return { error: "your familiar lies dormant — revive it with a magical item" }; }
    const jg = effectiveTraits(row.kind, row.speciesId, row.trait).joyGain;
    const before = gaugeSum(prog.stats);
    if (body.kind === "play") { prog.stats.joy = clamp(prog.stats.joy + 14 * jg); prog.stats.vigor = clamp(prog.stats.vigor - 2); }
    else if (body.kind === "clean") { prog.stats.hygiene = 100; prog.stats.joy = clamp(prog.stats.joy + 5 * jg); prog.messCount = 0; }
    else if (body.kind === "rest") { prog.asleep = !prog.asleep; }
    // Active-care XP: reward the net wellbeing this tend restored (0 if it was
    // already maxed, so no spam-farming). Mirrors feed/toy/remedy below.
    prog.xp += eidolonCareXp(gaugeSum(prog.stats) - before, row.streakCount);
    await recordCheckIn(g.scope, g.ownerId, g.userId, row, nowMs);
    await persist(g.scope, g.ownerId, row, prog, nowMs);
    return { eidolon: snapshotOf(row, prog, await petIconFor(row.petItemKey), nowMs) };
  });

  /* ---- POST /arcade/eidolon/feed ---- (consume a Food item) */
  const feedBody = z.object({ characterId: z.string().nullable().optional(), itemKey: z.string() }).strict();
  app.post<{ Body: unknown }>("/arcade/eidolon/feed", async (req, reply) => {
    let body: z.infer<typeof feedBody>;
    try { body = feedBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const g = await gate(req, body.characterId ?? null);
    if (!g.ok) { reply.code(g.code); return g.body; }
    // Reject a concurrent double-fire so one click can't consume two foods.
    if (!beginConsume(g.scope, g.ownerId)) { reply.code(429); return { error: "one moment — still tending your familiar" }; }
    try {
      const row = await loadRow(g.scope, g.ownerId);
      if (!row) { reply.code(404); return { error: "no familiar" }; }
      const item = (await db.select({ key: items.key, price: items.price, category: items.category }).from(items).where(eq(items.key, body.itemKey)).limit(1))[0];
      if (!item || item.category !== "food") { reply.code(400); return { error: "that isn't food" }; }
      if (!consumeOne(g.scope, g.ownerId, body.itemKey)) { reply.code(409); return { error: "you don't have that food" }; }
      await emitToUser(g.userId, "earning:inventory_changed", { scope: g.scope, ownerId: g.ownerId, itemKey: body.itemKey, delta: -1, reason: "eidolon_feed" });
      const nowMs = Date.now();
      const prog = catchUp(row, nowMs);
      const jg = effectiveTraits(row.kind, row.speciesId, row.trait).joyGain;
      // Multi-stat food: Satiety + the food's bonus (Spirit/Vigor/Hygiene), with
      // joy scaled by the joyGain trait, minus a tiny mess from eating.
      const before = gaugeSum(prog.stats);
      const eff = foodEffect(item);
      prog.stats.satiety = clamp(prog.stats.satiety + eff.satiety);
      prog.stats.joy = clamp(prog.stats.joy + eff.joy * jg);
      prog.stats.vigor = clamp(prog.stats.vigor + eff.vigor);
      prog.stats.hygiene = clamp(prog.stats.hygiene + eff.hygiene - 1);
      prog.xp += eidolonCareXp(gaugeSum(prog.stats) - before, row.streakCount);
      await recordCheckIn(g.scope, g.ownerId, g.userId, row, nowMs);
      await persist(g.scope, g.ownerId, row, prog, nowMs);
      return { eidolon: snapshotOf(row, prog, await petIconFor(row.petItemKey), nowMs) };
    } finally {
      endConsume(g.scope, g.ownerId);
    }
  });

  /* ---- POST /arcade/eidolon/toy ---- (play with a REUSABLE toy: a `category:'toy'`
     item the identity OWNS — NOT consumed — for a bigger, varied joy boost than the
     free Play gesture. Each toy has its own profile (see EIDOLON_TOY_EFFECT). Counts
     as a daily tend, like Play. Mirrors the play action's dormancy guard.) */
  const toyBody = z.object({ characterId: z.string().nullable().optional(), itemKey: z.string() }).strict();
  app.post<{ Body: unknown }>("/arcade/eidolon/toy", async (req, reply) => {
    let body: z.infer<typeof toyBody>;
    try { body = toyBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const g = await gate(req, body.characterId ?? null);
    if (!g.ok) { reply.code(g.code); return g.body; }
    const row = await loadRow(g.scope, g.ownerId);
    if (!row) { reply.code(404); return { error: "no familiar" }; }
    // Must be a toy-category item the identity holds (>=1). Reusable: NOT consumed,
    // so owning one grants unlimited play; buying more is pointless (and harmless).
    const item = (await db.select({ key: items.key, category: items.category }).from(items).where(eq(items.key, body.itemKey)).limit(1))[0];
    if (!item || item.category !== "toy") { reply.code(400); return { error: "that isn't a toy" }; }
    const held = (await db.select({ qty: identityInventory.quantity }).from(identityInventory)
      .where(and(eq(identityInventory.ownerScope, g.scope), eq(identityInventory.ownerId, g.ownerId), eq(identityInventory.itemKey, body.itemKey))).limit(1))[0];
    if (!held || held.qty < 1) { reply.code(403); return { error: "you don't own that toy" }; }
    const nowMs = Date.now();
    const prog = catchUp(row, nowMs);
    if (prog.dead) { reply.code(409); return { error: "your familiar lies dormant — revive it with a magical item" }; }
    const jg = effectiveTraits(row.kind, row.speciesId, row.trait).joyGain;
    const before = gaugeSum(prog.stats);
    const eff = toyEffect(body.itemKey);
    prog.stats.joy = clamp(prog.stats.joy + eff.joy * jg);
    prog.stats.vigor = clamp(prog.stats.vigor + eff.vigor);
    prog.stats.hygiene = clamp(prog.stats.hygiene + eff.hygiene);
    prog.xp += eidolonCareXp(gaugeSum(prog.stats) - before, row.streakCount);
    await recordCheckIn(g.scope, g.ownerId, g.userId, row, nowMs);
    await persist(g.scope, g.ownerId, row, prog, nowMs);
    return { eidolon: snapshotOf(row, prog, await petIconFor(row.petItemKey), nowMs) };
  });

  /* ---- POST /arcade/eidolon/remedy ---- (potion = full cure; else basic heal costs currency) */
  const remedyBody = z.object({ characterId: z.string().nullable().optional(), itemKey: z.string().optional() }).strict();
  app.post<{ Body: unknown }>("/arcade/eidolon/remedy", async (req, reply) => {
    let body: z.infer<typeof remedyBody>;
    try { body = remedyBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const g = await gate(req, body.characterId ?? null);
    if (!g.ok) { reply.code(g.code); return g.body; }
    // Reject a concurrent double-fire so one click can't consume two potions
    // (or double-charge the basic heal).
    if (!beginConsume(g.scope, g.ownerId)) { reply.code(429); return { error: "one moment — still tending your familiar" }; }
    try {
      const row = await loadRow(g.scope, g.ownerId);
      if (!row) { reply.code(404); return { error: "no familiar" }; }
      const nowMs = Date.now();
      const prog = catchUp(row, nowMs);
      if (prog.dead) { reply.code(409); return { error: "your familiar lies dormant — revive it with a magical item" }; }
      const before = gaugeSum(prog.stats);

      if (body.itemKey) {
        // Potion path: must be a magic-category consumable they hold.
        const item = (await db.select({ key: items.key, category: items.category }).from(items).where(eq(items.key, body.itemKey)).limit(1))[0];
        if (!item || item.category !== "magic") { reply.code(400); return { error: "that won't cure anything" }; }
        if (!consumeOne(g.scope, g.ownerId, body.itemKey)) { reply.code(409); return { error: "you don't have that item" }; }
        await emitToUser(g.userId, "earning:inventory_changed", { scope: g.scope, ownerId: g.ownerId, itemKey: body.itemKey, delta: -1, reason: "eidolon_remedy" });
        prog.sick = false;
        prog.stats.health = clamp(prog.stats.health + POTION_HEAL_AMOUNT);
      } else {
        // Basic heal: small currency cost, small heal, no cure.
        const debit = debitCurrency(g.scope, g.userId, g.ownerId, BASIC_HEAL_COST, "eidolon_basic_heal");
        if (!debit.ok) { reply.code(402); return { error: "not enough currency", required: BASIC_HEAL_COST, balance: debit.balance }; }
        await emitToUser(g.userId, "earning:earned", {
          scope: g.scope, ownerId: g.scope === "character" ? g.ownerId : g.userId,
          xpDelta: 0, currencyDelta: -BASIC_HEAL_COST, xpTotal: debit.final.xp, currencyTotal: debit.final.currency,
          rankKey: debit.final.rankKey, tier: debit.final.tier, reason: "eidolon_basic_heal",
        });
        prog.stats.health = clamp(prog.stats.health + BASIC_HEAL_AMOUNT);
      }
      prog.xp += eidolonCareXp(gaugeSum(prog.stats) - before, row.streakCount);
      await recordCheckIn(g.scope, g.ownerId, g.userId, row, nowMs);
      await persist(g.scope, g.ownerId, row, prog, nowMs);
      return { eidolon: snapshotOf(row, prog, await petIconFor(row.petItemKey), nowMs) };
    } finally {
      endConsume(g.scope, g.ownerId);
    }
  });

  /* ---- POST /arcade/eidolon/revive ---- (wake a DORMANT familiar with a Potion.
     The chosen death model is dormancy, not permadeath: a familiar whose health
     hits 0 freezes (no decay, no XP) and a magic Potion revives it to a fragile
     second life with its level / XP / streak intact. Refuses a living familiar.) */
  const reviveBody = z.object({ characterId: z.string().nullable().optional(), itemKey: z.string() }).strict();
  app.post<{ Body: unknown }>("/arcade/eidolon/revive", async (req, reply) => {
    let body: z.infer<typeof reviveBody>;
    try { body = reviveBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const g = await gate(req, body.characterId ?? null);
    if (!g.ok) { reply.code(g.code); return g.body; }
    // Reject a concurrent double-fire so one click can't consume two items. The
    // re-checked `!prog.dead` below also stops a SEQUENTIAL duplicate (the second
    // sees the familiar already awake).
    if (!beginConsume(g.scope, g.ownerId)) { reply.code(429); return { error: "one moment — still tending your familiar" }; }
    try {
      const row = await loadRow(g.scope, g.ownerId);
      if (!row) { reply.code(404); return { error: "no familiar" }; }
      const nowMs = Date.now();
      const prog = catchUp(row, nowMs);
      if (!prog.dead) { reply.code(409); return { error: "your familiar still lives" }; }
      // Only a magic-category consumable (a Potion) they hold can wake it.
      const item = (await db.select({ key: items.key, category: items.category }).from(items).where(eq(items.key, body.itemKey)).limit(1))[0];
      if (!item || item.category !== "magic") { reply.code(400); return { error: "only a magical item can wake it" }; }
      if (!consumeOne(g.scope, g.ownerId, body.itemKey)) { reply.code(409); return { error: "you don't have that item" }; }
      await emitToUser(g.userId, "earning:inventory_changed", { scope: g.scope, ownerId: g.ownerId, itemKey: body.itemKey, delta: -1, reason: "eidolon_revive" });
      // Wake to a fragile second life: clear the dormancy/sickness, restore health,
      // and lift the collapsed upkeep stats off the floor (reviveStats) so it
      // doesn't instantly re-dormant. NOT a daily check-in (reviving isn't tending)
      // — persist writes stage "alive" because prog.dead is now false.
      prog.dead = false;
      prog.sick = false;
      prog.asleep = false;
      prog.stats = reviveStats(prog.stats);
      await persist(g.scope, g.ownerId, row, prog, nowMs);
      return { eidolon: snapshotOf(row, prog, await petIconFor(row.petItemKey), nowMs) };
    } finally {
      endConsume(g.scope, g.ownerId);
    }
  });

  /* ---- POST /arcade/eidolon/release ---- (clear a DORMANT (or legacy-dead)
     familiar so the egg-select screen sticks — "Summon Anew", for a player who
     would rather start over than spend a Potion to revive. Refuses a living
     familiar so a player can't accidentally abandon one; re-hatching then
     starts fresh via the upsert. Without this, the periodic GET re-loads the
     dormant row and snaps the UI back out of egg-select.) */
  const releaseBody = z.object({ characterId: z.string().nullable().optional() }).strict();
  app.post<{ Body: unknown }>("/arcade/eidolon/release", async (req, reply) => {
    let body: z.infer<typeof releaseBody>;
    try { body = releaseBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const g = await gate(req, body.characterId ?? null);
    if (!g.ok) { reply.code(g.code); return g.body; }
    const row = await loadRow(g.scope, g.ownerId);
    if (!row) return { eidolon: null };
    const nowMs = Date.now();
    const prog = catchUp(row, nowMs);
    if (!prog.dead) { reply.code(409); return { error: "your familiar still lives" }; }
    const where = and(eq(eidolonState.ownerScope, g.scope), eq(eidolonState.ownerId, g.ownerId));
    // Record the departure to the Hall, then clear — atomically, so the memorial
    // (and the lineage head-start it feeds the next hatch) can't be lost to a race.
    db.transaction((tx) => {
      tx.insert(eidolonHall).values(hallValues(g.scope, g.ownerId, row, prog, "released", nowMs)).run();
      tx.delete(eidolonState).where(where).run();
    });
    return { eidolon: null };
  });

  /* ---- POST /arcade/eidolon/sell ---- (cash out a LIVING familiar for
     currency scaled by its level/XP, then clear it so the player can tame
     anew. A dead one has no worth — use release instead.) */
  const sellBody = z.object({ characterId: z.string().nullable().optional() }).strict();
  app.post<{ Body: unknown }>("/arcade/eidolon/sell", async (req, reply) => {
    let body: z.infer<typeof sellBody>;
    try { body = sellBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const g = await gate(req, body.characterId ?? null);
    if (!g.ok) { reply.code(g.code); return g.body; }
    const nowMs = Date.now();
    const where = and(eq(eidolonState.ownerScope, g.scope), eq(eidolonState.ownerId, g.ownerId));
    type Final = { xp: number; currency: number; rankKey: string | null; tier: number | null };
    type Outcome =
      | { kind: "none" }
      | { kind: "dead" }
      | { kind: "sold"; value: number; level: number; final: Final };
    // Atomic: read -> catch-up -> delete -> credit in a single transaction so
    // a double-fired sell can't double-credit (the second finds no row).
    const outcome: Outcome = db.transaction((tx): Outcome => {
      const row = tx.select().from(eidolonState).where(where).limit(1).all()[0];
      if (!row) return { kind: "none" };
      const prog = catchUp(row, nowMs);
      if (prog.dead) return { kind: "dead" };
      // Sale value: only EARNED xp sells (inherited bonusXp is subtracted), times
      // any rare-variant prestige bump.
      const value = eidolonSaleValueOf(prog.xp, row.bonusXp, row.variant);
      const level = eidolonLevelFromXp(prog.xp);
      // Memorialize before clearing (feeds the Hall + the next hatch's lineage).
      tx.insert(eidolonHall).values(hallValues(g.scope, g.ownerId, row, prog, "sold", nowMs)).run();
      tx.delete(eidolonState).where(where).run();
      let final: Final;
      if (g.scope === "character") {
        tx.insert(characterEarning).values({ characterId: g.ownerId }).onConflictDoNothing().run();
        const e = tx.select().from(characterEarning).where(eq(characterEarning.characterId, g.ownerId)).limit(1).all()[0];
        const bal = e?.currency ?? 0;
        tx.update(characterEarning).set({ currency: bal + value, updatedAt: new Date() }).where(eq(characterEarning.characterId, g.ownerId)).run();
        tx.insert(earningLedger).values({ id: nanoid(), scope: "character", ownerId: g.ownerId, xpDelta: 0, currencyDelta: value, reason: "eidolon_sale", metadataJson: JSON.stringify({ kind: "eidolon_sale", level }) }).run();
        final = { xp: e?.xp ?? 0, currency: bal + value, rankKey: e?.rankKey ?? null, tier: e?.tier ?? null };
      } else {
        tx.insert(userEarning).values({ userId: g.userId }).onConflictDoNothing().run();
        const e = tx.select().from(userEarning).where(eq(userEarning.userId, g.userId)).limit(1).all()[0];
        const bal = e?.currency ?? 0;
        tx.update(userEarning).set({ currency: bal + value, updatedAt: new Date() }).where(eq(userEarning.userId, g.userId)).run();
        tx.insert(earningLedger).values({ id: nanoid(), scope: "user", ownerId: g.userId, xpDelta: 0, currencyDelta: value, reason: "eidolon_sale", metadataJson: JSON.stringify({ kind: "eidolon_sale", level }) }).run();
        final = { xp: e?.xp ?? 0, currency: bal + value, rankKey: e?.rankKey ?? null, tier: e?.tier ?? null };
      }
      return { kind: "sold", value, level, final };
    });
    if (outcome.kind === "none") { reply.code(404); return { error: "no familiar" }; }
    if (outcome.kind === "dead") { reply.code(409); return { error: "a dormant familiar can't be sold — revive it first, or release it" }; }
    if (outcome.value > 0) {
      await emitToUser(g.userId, "earning:earned", {
        scope: g.scope, ownerId: g.scope === "character" ? g.ownerId : g.userId,
        xpDelta: 0, currencyDelta: outcome.value, xpTotal: outcome.final.xp, currencyTotal: outcome.final.currency,
        rankKey: outcome.final.rankKey, tier: outcome.final.tier, reason: "eidolon_sale",
      });
    }
    return { eidolon: null, sold: { value: outcome.value, level: outcome.level } };
  });

  /* ---- POST /arcade/eidolon/nudge-optin ---- (toggle opt-in "needs you" push nudges) */
  const nudgeBody = z.object({ characterId: z.string().nullable().optional(), on: z.boolean() }).strict();
  app.post<{ Body: unknown }>("/arcade/eidolon/nudge-optin", async (req, reply) => {
    let body: z.infer<typeof nudgeBody>;
    try { body = nudgeBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const g = await gate(req, body.characterId ?? null);
    if (!g.ok) { reply.code(g.code); return g.body; }
    const row = await loadRow(g.scope, g.ownerId);
    if (!row) { reply.code(404); return { error: "no familiar" }; }
    await db.update(eidolonState).set({ nudgeOptin: body.on, updatedAt: new Date() })
      .where(and(eq(eidolonState.ownerScope, g.scope), eq(eidolonState.ownerId, g.ownerId)));
    row.nudgeOptin = body.on;
    const nowMs = Date.now();
    const prog = catchUp(row, nowMs);
    return { eidolon: snapshotOf(row, prog, await petIconFor(row.petItemKey), nowMs) };
  });

  /* ---- GET /arcade/eidolon/hall ---- (The Hall: this identity's departed
     familiars, most recent first — a read-only memorial gallery. Same double
     gate as the rest: the player's own keepsake history.) */
  app.get<{ Querystring: { characterId?: string } }>("/arcade/eidolon/hall", async (req, reply) => {
    const g = await gate(req, req.query.characterId ?? null);
    if (!g.ok) { reply.code(g.code); return g.body; }
    const rows = await db.select().from(eidolonHall)
      .where(and(eq(eidolonHall.ownerScope, g.scope), eq(eidolonHall.ownerId, g.ownerId)))
      .orderBy(desc(eidolonHall.departedAt)).limit(50);
    const hall: EidolonHallEntry[] = rows.map((r) => ({
      id: r.id, name: r.name, kind: r.kind,
      speciesId: (r.speciesId as EidolonHallEntry["speciesId"]) ?? null,
      trait: (r.trait as EidolonHallEntry["trait"]) ?? null,
      variant: (r.variant as EidolonHallEntry["variant"]) ?? null,
      peakLevel: r.peakLevel, ageHours: r.ageHours,
      departReason: r.departReason as EidolonHallEntry["departReason"],
      departedAt: r.departedAt,
    }));
    return { hall };
  });
}
