/**
 * Per-server Earning admin (Multi-Server Lift — the "Admin Partition", §plan_ext F).
 *
 * The server-scoped twin of admin/earning.ts's OPS half. A server owner/mod
 * holding the granular `manage_earning` key tunes THIS server's economy
 * (faucet + sinks) and grants / revokes / claws back awards + cosmetics inside
 * the Server Admin console — never the platform-wide config, and never another
 * server's pools.
 *
 * WHAT MOVES vs WHAT STAYS GLOBAL
 *   - MOVES here (per-server OPS): the faucet/sink config, manual XP/Currency
 *     grants + revokes, rank overrides, cosmetic-ownership grants + claw-backs,
 *     and the per-user earning reset — all scoped to (serverId, scope, ownerId).
 *   - STAYS in the global Admin panel (admin/earning.ts): the shared CATALOGS
 *     (rank/tier definitions, name-style templates, item + border + cosmetic
 *     defs, and their PRICES). A single catalog edit still applies everywhere;
 *     this module NEVER touches catalog rows. It only reads them to VALIDATE a
 *     grant target (does this style/border/rank/item key exist?).
 *
 * PER-SERVER ECONOMY (§5.7). The pools `user_earning` / `character_earning`
 * and every ownership/inventory/cosmetic table are grained by `server_id`
 * (migrations 0283 et al.). Every read of a single pool routes through the
 * canonical {@link readPool} accessor; every write stamps `req.params.id` in
 * the WHERE / VALUES. Cross-server credit is FORBIDDEN — a grant on Server A
 * can only ever touch Server A's pools.
 *
 * CONFIG STORAGE. The per-server faucet/sink config lives on
 * `server_settings.earning_config_json` (TS `serverSettings.earningConfigJson`,
 * migration 0276); the per-server flash-sale toggle on
 * `server_settings.flash_sale_enabled`. NULL config = inherit the platform
 * default. The resolved/effective config is read via `getServerSettings`
 * (which merges the override over the platform base); the RAW override is read
 * straight off the row so the editor knows whether it's inheriting. Writes
 * upsert the row and `invalidateServerSettings(serverId)` so the next resolve
 * recomputes. The platform default is surfaced read-only so the editor can show
 * a "reset to inherit / reset to defaults" affordance without a second call.
 *
 * FLAG-OFF is byte-identical to today: every route 404s when
 * `areServersEnabled` is false, exactly like a feature that was never wired up.
 * Per-server gating runs through `serverAuthority`/`serverCan` (the one powers
 * resolver), imported inline because this module is standalone — registered
 * alongside routes/servers.ts from the same index.ts.
 *
 * Routes (all under /servers/:id/earning):
 *   GET    /servers/:id/earning/config         — raw override + resolved + defaults + flashSaleEnabled
 *   PUT    /servers/:id/earning/config          — set this server's faucet/sink config (+ flashSaleEnabled)
 *   DELETE /servers/:id/earning/config          — clear the override (inherit the platform default)
 *   POST   /servers/:id/earning/grant-xp        — direct XP credit / debit on this server's pool
 *   POST   /servers/:id/earning/grant-currency  — direct Currency credit / debit on this server's pool
 *   POST   /servers/:id/earning/set-rank        — rank/tier override on this server's pool (null clears)
 *   POST   /servers/:id/earning/grant-item      — deposit / revoke item units on this server
 *   POST   /servers/:id/earning/grant-border    — grant a rank border on this server (claw-back via revoke)
 *   POST   /servers/:id/earning/revoke-border   — remove a rank border on this server
 *   POST   /servers/:id/earning/grant-style     — grant a name style on this server
 *   POST   /servers/:id/earning/revoke-style    — remove a name style on this server
 *   POST   /servers/:id/earning/grant-freeform-border  — grant a free-form border on this server
 *   POST   /servers/:id/earning/revoke-freeform-border — remove a free-form border on this server
 *   GET    /servers/:id/earning/user-ownership  — a target user's owned cosmetics + inventory on THIS server
 *   POST   /servers/:id/earning/reset-user      — clean-slate a user's earning state on THIS server
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Server as IoServer } from "socket.io";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { type ClientToServerEvents, EIDOLON_ITEM_CATEGORIES, FLAIR_EIDOLON_TAMER, ROOM_TRANSITIONS, type ServerToClientEvents } from "@thekeep/shared";
import {
  auditLog,
  characterEarning,
  characterOwnedFreeformBorders,
  characters,
  cosmetics,
  flashSaleOverrides,
  freeformBorders,
  identityCollection,
  identityInventory,
  items,
  nameStyles,
  rankTiers,
  ranks,
  roomTransitions,
  earningLedger,
  userActiveCosmetics,
  userEarning,
  userOwnedBorders,
  userOwnedFreeformBorders,
  userOwnedNameStyles,
  users,
 serverSettings } from "../db/schema.js";
import { getSessionUser } from "../routes/auth.js";
import {
  areServersEnabled,
  getServerSettings,
  getSettings,
  invalidateServerSettings,
} from "../settings.js";
import {
  DEFAULT_EARNING_CONFIG,
  type EarningConfig,
  normalizeEarningConfig,
} from "../earning/config.js";
import { creditPool } from "../earning/award.js";
import { DEFAULT_SERVER_ID, readPool } from "../earning/pool.js";
import { mergeMaxEverHeld, resolveRankForXp } from "../earning/resolver.js";
import { emitToUser } from "../realtime/presence.js";
import type { Db } from "../db/index.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/* =========================================================
 *  Config validation
 *
 *  The faucet/sink config a server may tune is the SAME EarningConfig
 *  document shape the global Awards tab edits, minus the platform-only
 *  fields a server owner has no business setting:
 *    - `multiCharacterEarnDivisor` (platform anti-inflation knob)
 *    - `backfill` (one-time boot job, platform-owned)
 *    - `scriptorium` (the writing economy lives in the global panel, §9.6)
 *  We accept those keys if present (so a copied platform doc round-trips)
 *  but `normalizeEarningConfig` re-derives the persisted shape and the
 *  resolved read merges over the platform base, so a server can't smuggle
 *  a platform-only override through here.
 * ========================================================= */

const awardAmountSchema = z.object({
  xp: z.number().int().min(0).max(1_000_000),
  currency: z.number().int().min(0).max(1_000_000),
}).strict();

const sourceFlagsSchema = z.object({
  xp: z.boolean(),
  currency: z.boolean(),
}).strict();

const lengthBonusSchema = z.object({
  enabled: z.boolean(),
  floorChars: z.number().int().min(0).max(10_000),
  ceilChars: z.number().int().min(0).max(10_000),
  maxMultiplier: z.number().min(1).max(10),
}).strict();

const messageQualitySchema = z.object({
  lengthBonus: z.object({
    say: lengthBonusSchema,
    action: lengthBonusSchema,
    whisper: lengthBonusSchema,
  }).strict(),
  spam: z.object({
    enabled: z.boolean(),
    minLengthToCheck: z.number().int().min(0).max(10_000),
    uniqueCharRatioFloor: z.number().min(0).max(1),
    dominantTokenRatioCap: z.number().min(0).max(1),
    echoLookback: z.number().int().min(0).max(100),
  }).strict(),
}).strict();

/** The per-server faucet/sink document. Mirrors the global earningConfigSchema
 *  but lets the platform-only branches be optional (a server owner doesn't set
 *  them; `normalizeEarningConfig` fills them from the platform default). */
const serverEarningConfigSchema = z.object({
  enabled: z.boolean(),
  awards: z.object({
    message: z.object({
      say: awardAmountSchema,
      action: awardAmountSchema,
      whisper: awardAmountSchema,
    }).strict(),
    forum: z.object({
      topic: awardAmountSchema,
      reply: awardAmountSchema,
    }).strict(),
    presence: z.object({
      perBlock: awardAmountSchema,
    }).strict(),
  }).strict(),
  bodyFloorChars: z.number().int().min(0).max(1000),
  messageQuality: messageQualitySchema,
  presenceBlockMinutes: z.number().int().min(1).max(60),
  presenceDailyBlockCap: z.number().int().min(0).max(1000),
  enabledSources: z.object({
    message: sourceFlagsSchema,
    forum: sourceFlagsSchema,
    presence: sourceFlagsSchema,
  }).strict(),
  currencyTransfer: z.object({
    enabled: z.boolean(),
    dailySendCap: z.number().int().min(0).max(10_000_000),
    dailyReceiveCap: z.number().int().min(0).max(10_000_000),
    minSenderAccountAgeDays: z.number().int().min(0).max(3650),
    minRecipientAccountAgeDays: z.number().int().min(0).max(3650),
    minTransferAmount: z.number().int().min(0).max(10_000_000),
    maxTransferAmount: z.number().int().min(0).max(10_000_000),
  }).strict(),
}).strict();

/**
 * Per-server subsystem on/off toggles. Each lives on its own nullable
 * `server_settings` column (migration 0293): NULL = inherit (the subsystem is
 * available, the platform has no per-subsystem master switch so inherit means
 * "on"); true/false = this server's explicit override. The editor sends a
 * tri-state per key — `null` to clear back to inherit, a boolean to pin.
 */
const subsystemToggleSchema = z.object({
  shop: z.boolean().nullable().optional(),
  ranks: z.boolean().nullable().optional(),
  nameStyles: z.boolean().nullable().optional(),
  borders: z.boolean().nullable().optional(),
  roomTransitions: z.boolean().nullable().optional(),
  cosmetics: z.boolean().nullable().optional(),
}).strict();

const putConfigBody = z.object({
  config: serverEarningConfigSchema,
  /** Per-server flash-sale toggle (server-only, no platform analog). */
  flashSaleEnabled: z.boolean().optional(),
  /** Per-server subsystem on/off toggles (each null = inherit). */
  subsystems: subsystemToggleSchema.optional(),
}).strict();

/* =========================================================
 *  Grant/revoke body shapes (mirror admin/earning.ts)
 * ========================================================= */

const grantAmountBody = z.object({
  username: z.string().min(1).max(80),
  amount: z.number().int(),
}).strict();

const setRankBody = z.object({
  username: z.string().min(1).max(80),
  rankKey: z.string().nullable(),
  tier: z.number().int().min(1).max(20).nullable(),
}).strict();

const grantBorderBody = z.object({
  username: z.string().min(1).max(80),
  rankKey: z.string().min(1).max(64),
}).strict();

const grantStyleBody = z.object({
  username: z.string().min(1).max(80),
  styleKey: z.string().min(1).max(64),
}).strict();

const grantFreeformBorderBody = z.object({
  username: z.string().min(1).max(80),
  borderKey: z.string().min(1).max(64),
  characterId: z.string().nullable().optional(),
}).strict();

const grantItemBody = z.object({
  username: z.string().min(1).max(80),
  characterId: z.string().min(1).max(80).nullable().optional(),
  itemKey: z.string().min(1).max(64),
  quantity: z.number().int().min(-999).max(999).refine((n) => n !== 0, {
    message: "quantity must be non-zero",
  }),
}).strict();

const resetUserBody = z.object({ username: z.string().min(1).max(80) }).strict();

export async function registerServerEarningRoutes(
  app: FastifyInstance,
  db: Db,
  io: Io,
  uploadsRoot: string,
): Promise<void> {
  /**
   * Gate shared by every route: flag → auth → server authority → manage_earning.
   * Returns the resolved authority + caller on success, or null after writing
   * the reply code (the caller just `return`s). Keeps the long preamble in one
   * place instead of repeating it at every handler.
   */
  async function gate(req: FastifyRequest, reply: FastifyReply) {
    if (!areServersEnabled(await getSettings(db))) { reply.code(404); return null; }
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return null; }
    const serverId = (req.params as { id: string }).id;
    const { serverAuthority, serverCan } = await import("../servers/authority.js");
    const a = await serverAuthority(db, me, serverId);
    if (!a.server) { reply.code(404); return null; }
    if (!serverCan(a, "manage_earning")) { reply.code(403); return null; }
    return { me, serverId, a };
  }

  /** Best-effort server-scoped audit row (mirrors auditServer in servers.ts). A
   *  logging failure never fails the action it records. */
  async function audit(serverId: string, actorUserId: string, action: string, metadata: Record<string, unknown>): Promise<void> {
    try {
      await db.insert(auditLog).values({
        id: nanoid(),
        serverId,
        actorUserId,
        action,
        metadataJson: JSON.stringify(metadata),
      });
    } catch {
      /* swallow — best-effort, exactly like recordAudit */
    }
  }

  /** Resolve a grant target by username (case-insensitive). Returns the user
   *  row, or null when not found. */
  async function resolveTargetUser(username: string) {
    const trimmed = username.trim();
    if (!trimmed) return null;
    return (await db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = ${trimmed.toLowerCase()}`)
      .limit(1))[0] ?? null;
  }

  /* =========================================================
   *  Config: get / set / clear this server's faucet + sinks
   * ========================================================= */

  /**
   * GET /servers/:id/earning/config
   * Returns the RAW override (null = inheriting), the RESOLVED effective config
   * the engine actually reads on this server, the platform DEFAULT (for the
   * editor's "reset" affordance), the inheriting flag, and the per-server
   * flash-sale toggle.
   */
  app.get<{ Params: { id: string } }>("/servers/:id/earning/config", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    const row = (await db.select().from(serverSettings)
      .where(eq(serverSettings.serverId, g.serverId)).limit(1))[0];
    const resolved = await getServerSettings(db, g.serverId);
    const rawOverride = row?.earningConfigJson
      ? normalizeEarningConfig(JSON.parse(row.earningConfigJson))
      : null;
    return {
      // null = this server inherits the platform default (no override set yet).
      override: rawOverride,
      // What the earning engine actually uses on this server right now.
      config: resolved.earningConfig,
      // The platform default, so the editor can offer "reset to inherit".
      defaults: DEFAULT_EARNING_CONFIG,
      inheriting: !row?.earningConfigJson,
      flashSaleEnabled: resolved.flashSaleEnabled,
      // Tri-state subsystem switches (raw off the row): null = inherit (on),
      // true/false = this server's explicit override. The reader paths
      // (routes/earning.ts) coalesce null → available.
      subsystems: {
        shop: row?.shopEnabled ?? null,
        ranks: row?.ranksEnabled ?? null,
        nameStyles: row?.nameStylesEnabled ?? null,
        borders: row?.bordersEnabled ?? null,
        roomTransitions: row?.roomTransitionsEnabled ?? null,
        cosmetics: row?.cosmeticsEnabled ?? null,
      },
    };
  });

  /**
   * PUT /servers/:id/earning/config
   * Replace this server's faucet/sink override wholesale (the editor always
   * submits a full document). Normalizes against the platform default so any
   * platform-only branch we don't expose is filled in deterministically, then
   * persists to `server_settings.earning_config_json` + the flash-sale toggle
   * and invalidates the resolved-settings cache so the change takes effect on
   * the next credit. Cross-server economy is untouched — this only writes THIS
   * server's row.
   */
  app.put<{ Params: { id: string }; Body: unknown }>("/servers/:id/earning/config", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof putConfigBody>;
    try { body = putConfigBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }

    // Normalize so the stored JSON is a full, engine-trustable document. The
    // platform-only branches (multiCharacterEarnDivisor, backfill, scriptorium)
    // are filled from the platform default — a server can't set them here.
    const normalized: EarningConfig = normalizeEarningConfig(body.config);

    const update: Partial<typeof serverSettings.$inferInsert> = {
      updatedAt: new Date(),
      updatedById: g.me.id,
      earningConfigJson: JSON.stringify(normalized),
    };
    if (body.flashSaleEnabled !== undefined) update.flashSaleEnabled = body.flashSaleEnabled;
    // Subsystem toggles: only the keys the editor sends are written, so a
    // partial save can't silently clear an untouched switch. A `null` value
    // is a deliberate "reset to inherit" and writes NULL to the column.
    if (body.subsystems) {
      const s = body.subsystems;
      if (s.shop !== undefined) update.shopEnabled = s.shop;
      if (s.ranks !== undefined) update.ranksEnabled = s.ranks;
      if (s.nameStyles !== undefined) update.nameStylesEnabled = s.nameStyles;
      if (s.borders !== undefined) update.bordersEnabled = s.borders;
      if (s.roomTransitions !== undefined) update.roomTransitionsEnabled = s.roomTransitions;
      if (s.cosmetics !== undefined) update.cosmeticsEnabled = s.cosmetics;
    }

    await db.insert(serverSettings)
      .values({ serverId: g.serverId, ...update })
      .onConflictDoUpdate({ target: serverSettings.serverId, set: update });
    invalidateServerSettings(g.serverId);
    await audit(g.serverId, g.me.id, "server_earning_config_update", {
      flashSaleEnabled: body.flashSaleEnabled,
      subsystems: body.subsystems ?? null,
    });
    return { ok: true, config: normalized };
  });

  /**
   * DELETE /servers/:id/earning/config
   * Clear the override so this server inherits the platform default again
   * (sets the column to NULL). Leaves the flash-sale toggle alone.
   */
  app.delete<{ Params: { id: string } }>("/servers/:id/earning/config", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    const row = (await db.select().from(serverSettings)
      .where(eq(serverSettings.serverId, g.serverId)).limit(1))[0];
    if (row) {
      await db.update(serverSettings)
        .set({ earningConfigJson: null, updatedAt: new Date(), updatedById: g.me.id })
        .where(eq(serverSettings.serverId, g.serverId));
      invalidateServerSettings(g.serverId);
    }
    await audit(g.serverId, g.me.id, "server_earning_config_clear", {});
    return { ok: true, inheriting: true };
  });

  /* =========================================================
   *  Grants / revokes — all scoped to THIS server's pools
   * ========================================================= */

  /**
   * POST /servers/:id/earning/grant-xp
   * Direct XP credit (positive) or debit (negative) onto the target user's
   * pool ON THIS SERVER. Routes through `creditPool` with `serverId` pinned to
   * the route param, so rank/tier recompute + the live `earning:earned` socket
   * fire exactly as on the global path — but only ever for this server's pool.
   */
  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/earning/grant-xp", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof grantAmountBody>;
    try { body = grantAmountBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "user not found" }; }
    await creditPool(db, io, {
      serverId: g.serverId,
      scope: "user",
      ownerId: target.id,
      xpDelta: body.amount,
      currencyDelta: 0,
      reason: body.amount >= 0 ? "admin_grant" : "admin_revoke",
      metadata: { kind: "xp", actor: g.me.id, amount: body.amount, serverId: g.serverId },
      notifyUserId: target.id,
    });
    await audit(g.serverId, g.me.id, body.amount >= 0 ? "server_earning_grant" : "server_earning_revoke",
      { kind: "xp", targetUserId: target.id, amount: body.amount });
    return { ok: true };
  });

  /**
   * POST /servers/:id/earning/grant-currency
   * Currency twin of grant-xp; same per-server pinning.
   */
  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/earning/grant-currency", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof grantAmountBody>;
    try { body = grantAmountBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "user not found" }; }
    await creditPool(db, io, {
      serverId: g.serverId,
      scope: "user",
      ownerId: target.id,
      xpDelta: 0,
      currencyDelta: body.amount,
      reason: body.amount >= 0 ? "admin_grant" : "admin_revoke",
      metadata: { kind: "currency", actor: g.me.id, amount: body.amount, serverId: g.serverId },
      notifyUserId: target.id,
    });
    await audit(g.serverId, g.me.id, body.amount >= 0 ? "server_earning_grant" : "server_earning_revoke",
      { kind: "currency", targetUserId: target.id, amount: body.amount });
    return { ok: true };
  });

  /**
   * POST /servers/:id/earning/set-rank
   * Rank/tier override on this server's user pool. Pass rankKey=null + tier=null
   * to clear the override and re-place by XP. Mirrors the global set-rank but
   * every pool read/write is keyed on `g.serverId` (via readPool + a scoped
   * update). The (rank, tier) tuple is validated against the GLOBAL catalog
   * (ranks/tiers are platform-shared) — we only validate, never edit it.
   */
  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/earning/set-rank", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof setRankBody>;
    try { body = setRankBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "user not found" }; }

    // Lazy-create the pool row on THIS server before writing.
    await db.insert(userEarning).values({ serverId: g.serverId, userId: target.id }).onConflictDoNothing();

    if (body.rankKey === null || body.tier === null) {
      const cur = await readPool(db, g.serverId, "user", target.id);
      const placed = await resolveRankForXp(db, cur && "xp" in cur ? cur.xp : 0, g.serverId);
      await db.update(userEarning).set({
        rankKey: placed.rankKey,
        tier: placed.tier,
        updatedAt: new Date(),
      }).where(and(eq(userEarning.serverId, g.serverId), eq(userEarning.userId, target.id)));
      await audit(g.serverId, g.me.id, "server_earning_rank_assign", { targetUserId: target.id, cleared: true });
      return { ok: true, cleared: true };
    }

    const tierRow = (await db
      .select()
      .from(rankTiers)
      .where(and(eq(rankTiers.serverId, g.serverId), eq(rankTiers.rankKey, body.rankKey), eq(rankTiers.tier, body.tier)))
      .limit(1))[0];
    if (!tierRow) { reply.code(404); return { error: "rank/tier not found" }; }

    const prior = await readPool(db, g.serverId, "user", target.id);
    const priorXp = prior && "xp" in prior ? prior.xp : 0;
    const peak = await mergeMaxEverHeld(db, {
      maxRankKeyEverHeld: prior?.maxRankKeyEverHeld ?? null,
      maxTierEverHeld: prior?.maxTierEverHeld ?? null,
    }, { rankKey: body.rankKey, tier: body.tier }, g.serverId);
    const newXp = Math.max(priorXp, tierRow.xpThreshold);
    await db.update(userEarning).set({
      xp: newXp,
      rankKey: body.rankKey,
      tier: body.tier,
      maxRankKeyEverHeld: peak.maxRankKeyEverHeld,
      maxTierEverHeld: peak.maxTierEverHeld,
      updatedAt: new Date(),
    }).where(and(eq(userEarning.serverId, g.serverId), eq(userEarning.userId, target.id)));

    await db.insert(earningLedger).values({
      id: nanoid(),
      serverId: g.serverId,
      scope: "user",
      ownerId: target.id,
      xpDelta: 0,
      currencyDelta: 0,
      reason: "admin_rank_assign",
      metadataJson: JSON.stringify({
        actor: g.me.id,
        rankKey: body.rankKey,
        tier: body.tier,
        priorRankKey: prior?.rankKey ?? null,
        priorTier: prior?.tier ?? null,
      }),
    });
    await audit(g.serverId, g.me.id, "server_earning_rank_assign",
      { targetUserId: target.id, rankKey: body.rankKey, tier: body.tier });
    return { ok: true };
  });

  /**
   * POST /servers/:id/earning/grant-item
   * Deposit (positive) or revoke (negative) item units into / from a target
   * identity's inventory ON THIS SERVER. Mirrors the global grant-item but
   * every inventory row is keyed on `g.serverId`. A characterId scopes the
   * grant to that character's pocket (the character MUST belong to the target
   * user). Negative deltas clip at zero. Item key is validated against the
   * GLOBAL catalog (items are platform-shared). Fires the per-server inventory
   * live-update socket to the recipient's sockets.
   */
  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/earning/grant-item", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof grantItemBody>;
    try { body = grantItemBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "user not found" }; }
    const item = (await db.select().from(items).where(and(eq(items.serverId, g.serverId), eq(items.key, body.itemKey))).limit(1))[0];
    if (!item) { reply.code(404); return { error: "item not found" }; }

    const characterId = body.characterId ?? null;
    if (characterId) {
      const c = (await db
        .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
        .from(characters)
        .where(eq(characters.id, characterId))
        .limit(1))[0];
      if (!c || c.userId !== target.id || c.deletedAt) {
        reply.code(403);
        return { error: "character does not belong to target user" };
      }
    }
    const ownerScope: "user" | "character" = characterId ? "character" : "user";
    const ownerId = characterId ?? target.id;

    const existing = (await db.select({ qty: identityInventory.quantity })
      .from(identityInventory)
      .where(and(
        eq(identityInventory.serverId, g.serverId),
        eq(identityInventory.ownerScope, ownerScope),
        eq(identityInventory.ownerId, ownerId),
        eq(identityInventory.itemKey, body.itemKey),
      ))
      .limit(1))[0];
    const have = existing?.qty ?? 0;
    const desired = have + body.quantity;

    if (desired <= 0) {
      if (existing) {
        await db.delete(identityInventory).where(and(
          eq(identityInventory.serverId, g.serverId),
          eq(identityInventory.ownerScope, ownerScope),
          eq(identityInventory.ownerId, ownerId),
          eq(identityInventory.itemKey, body.itemKey),
        ));
        await db.delete(identityCollection).where(and(
          eq(identityCollection.serverId, g.serverId),
          eq(identityCollection.ownerScope, ownerScope),
          eq(identityCollection.ownerId, ownerId),
          eq(identityCollection.itemKey, body.itemKey),
        ));
      }
    } else if (existing) {
      await db.update(identityInventory)
        .set({ quantity: desired, updatedAt: new Date() })
        .where(and(
          eq(identityInventory.serverId, g.serverId),
          eq(identityInventory.ownerScope, ownerScope),
          eq(identityInventory.ownerId, ownerId),
          eq(identityInventory.itemKey, body.itemKey),
        ));
    } else {
      await db.insert(identityInventory).values({
        serverId: g.serverId,
        ownerScope,
        ownerId,
        itemKey: body.itemKey,
        quantity: desired,
      });
    }

    await db.insert(earningLedger).values({
      id: nanoid(),
      serverId: g.serverId,
      scope: ownerScope,
      ownerId,
      xpDelta: 0,
      currencyDelta: 0,
      reason: body.quantity >= 0 ? "admin_grant" : "admin_revoke",
      metadataJson: JSON.stringify({
        actor: g.me.id,
        kind: "item",
        itemKey: body.itemKey,
        quantity: body.quantity,
        priorQuantity: have,
        characterId,
      }),
    });
    await emitToUser(io, target.id, "earning:inventory_changed", {
      scope: ownerScope,
      ownerId,
      itemKey: body.itemKey,
      delta: body.quantity,
      reason: "admin_grant",
    });
    await audit(g.serverId, g.me.id, body.quantity >= 0 ? "server_earning_grant" : "server_earning_revoke",
      { kind: "item", targetUserId: target.id, itemKey: body.itemKey, quantity: body.quantity, characterId });
    return { ok: true, newQuantity: Math.max(0, desired) };
  });

  /**
   * POST /servers/:id/earning/grant-border
   * Grant ownership of a rank's border to the target user ON THIS SERVER,
   * bypassing the Tier-IV eligibility gate. Idempotent. The rank key is
   * validated against the GLOBAL catalog.
   */
  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/earning/grant-border", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof grantBorderBody>;
    try { body = grantBorderBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "user not found" }; }
    const rank = (await db.select().from(ranks).where(and(eq(ranks.serverId, g.serverId), eq(ranks.key, body.rankKey))).limit(1))[0];
    if (!rank) { reply.code(404); return { error: "rank not found" }; }
    await db.insert(userOwnedBorders).values({
      serverId: g.serverId,
      userId: target.id,
      rankKey: body.rankKey,
    }).onConflictDoNothing();
    await db.insert(earningLedger).values({
      id: nanoid(),
      serverId: g.serverId,
      scope: "user",
      ownerId: target.id,
      xpDelta: 0,
      currencyDelta: 0,
      reason: "admin_grant",
      metadataJson: JSON.stringify({ actor: g.me.id, kind: "border", rankKey: body.rankKey }),
    });
    await audit(g.serverId, g.me.id, "server_earning_grant", { kind: "border", targetUserId: target.id, rankKey: body.rankKey });
    return { ok: true };
  });

  /**
   * POST /servers/:id/earning/revoke-border
   * Claw back a rank border on this server. Clears the equipped slot if it
   * pointed at the revoked border. Idempotent.
   */
  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/earning/revoke-border", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof grantBorderBody>;
    try { body = grantBorderBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "user not found" }; }
    await db.delete(userOwnedBorders).where(and(
      eq(userOwnedBorders.serverId, g.serverId),
      eq(userOwnedBorders.userId, target.id),
      eq(userOwnedBorders.rankKey, body.rankKey),
    ));
    await db.update(userEarning)
      .set({ selectedBorderRankKey: null, updatedAt: new Date() })
      .where(and(
        eq(userEarning.serverId, g.serverId),
        eq(userEarning.userId, target.id),
        eq(userEarning.selectedBorderRankKey, body.rankKey),
      ));
    await db.insert(earningLedger).values({
      id: nanoid(),
      serverId: g.serverId,
      scope: "user",
      ownerId: target.id,
      xpDelta: 0,
      currencyDelta: 0,
      reason: "admin_revoke",
      metadataJson: JSON.stringify({ actor: g.me.id, kind: "border", rankKey: body.rankKey }),
    });
    await audit(g.serverId, g.me.id, "server_earning_revoke", { kind: "border", targetUserId: target.id, rankKey: body.rankKey });
    return { ok: true };
  });

  /**
   * POST /servers/:id/earning/grant-style
   * Grant ownership of a name style to the target user ON THIS SERVER,
   * bypassing the Currency purchase. Idempotent. Style key validated against
   * the GLOBAL catalog.
   */
  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/earning/grant-style", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof grantStyleBody>;
    try { body = grantStyleBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "user not found" }; }
    const style = (await db.select().from(nameStyles).where(and(eq(nameStyles.serverId, g.serverId), eq(nameStyles.key, body.styleKey))).limit(1))[0];
    if (!style) { reply.code(404); return { error: "style not found" }; }
    await db.insert(userOwnedNameStyles).values({
      serverId: g.serverId,
      userId: target.id,
      styleKey: body.styleKey,
      configJson: null,
    }).onConflictDoNothing();
    await db.insert(earningLedger).values({
      id: nanoid(),
      serverId: g.serverId,
      scope: "user",
      ownerId: target.id,
      xpDelta: 0,
      currencyDelta: 0,
      reason: "admin_grant",
      metadataJson: JSON.stringify({ actor: g.me.id, kind: "name_style", styleKey: body.styleKey }),
    });
    await audit(g.serverId, g.me.id, "server_earning_grant", { kind: "name_style", targetUserId: target.id, styleKey: body.styleKey });
    return { ok: true };
  });

  /**
   * POST /servers/:id/earning/revoke-style
   * Claw back a name style on this server. Clears the equipped slot too.
   * Idempotent.
   */
  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/earning/revoke-style", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof grantStyleBody>;
    try { body = grantStyleBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "user not found" }; }
    await db.delete(userOwnedNameStyles).where(and(
      eq(userOwnedNameStyles.serverId, g.serverId),
      eq(userOwnedNameStyles.userId, target.id),
      eq(userOwnedNameStyles.styleKey, body.styleKey),
    ));
    await db.update(userActiveCosmetics)
      .set({ activeNameStyleKey: null, updatedAt: new Date() })
      .where(and(
        eq(userActiveCosmetics.serverId, g.serverId),
        eq(userActiveCosmetics.userId, target.id),
        eq(userActiveCosmetics.activeNameStyleKey, body.styleKey),
      ));
    await db.insert(earningLedger).values({
      id: nanoid(),
      serverId: g.serverId,
      scope: "user",
      ownerId: target.id,
      xpDelta: 0,
      currencyDelta: 0,
      reason: "admin_revoke",
      metadataJson: JSON.stringify({ actor: g.me.id, kind: "name_style", styleKey: body.styleKey }),
    });
    await audit(g.serverId, g.me.id, "server_earning_revoke", { kind: "name_style", targetUserId: target.id, styleKey: body.styleKey });
    return { ok: true };
  });

  /**
   * POST /servers/:id/earning/grant-freeform-border
   * Grant a free-form border on this server with per-identity routing. A
   * characterId scopes the grant to that character (must belong to the target).
   * Auto-equips on first acquisition. Idempotent. Border key validated against
   * the GLOBAL catalog.
   */
  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/earning/grant-freeform-border", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof grantFreeformBorderBody>;
    try { body = grantFreeformBorderBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "user not found" }; }
    const border = (await db.select().from(freeformBorders).where(and(eq(freeformBorders.serverId, g.serverId), eq(freeformBorders.key, body.borderKey))).limit(1))[0];
    if (!border) { reply.code(404); return { error: "freeform border not found" }; }
    const characterId = body.characterId ?? null;
    if (characterId) {
      const c = (await db
        .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
        .from(characters)
        .where(eq(characters.id, characterId))
        .limit(1))[0];
      if (!c || c.userId !== target.id || c.deletedAt) {
        reply.code(404);
        return { error: "no such character on this user" };
      }
    }

    if (characterId) {
      await db.insert(characterOwnedFreeformBorders).values({
        serverId: g.serverId,
        characterId,
        borderKey: body.borderKey,
      }).onConflictDoNothing();
      await db.insert(characterEarning).values({ serverId: g.serverId, characterId }).onConflictDoNothing();
      const cur = (await db.select({ selected: characterEarning.selectedFreeformBorderKey })
        .from(characterEarning).where(and(eq(characterEarning.serverId, g.serverId), eq(characterEarning.characterId, characterId))).limit(1))[0];
      if (!cur?.selected) {
        await db.update(characterEarning)
          .set({ selectedFreeformBorderKey: body.borderKey, updatedAt: new Date() })
          .where(and(eq(characterEarning.serverId, g.serverId), eq(characterEarning.characterId, characterId)));
      }
    } else {
      await db.insert(userOwnedFreeformBorders).values({
        serverId: g.serverId,
        userId: target.id,
        borderKey: body.borderKey,
      }).onConflictDoNothing();
      await db.insert(userEarning).values({ serverId: g.serverId, userId: target.id }).onConflictDoNothing();
      const cur = (await db.select({ selected: userEarning.selectedFreeformBorderKey })
        .from(userEarning).where(and(eq(userEarning.serverId, g.serverId), eq(userEarning.userId, target.id))).limit(1))[0];
      if (!cur?.selected) {
        await db.update(userEarning)
          .set({ selectedFreeformBorderKey: body.borderKey, updatedAt: new Date() })
          .where(and(eq(userEarning.serverId, g.serverId), eq(userEarning.userId, target.id)));
      }
    }
    await db.insert(earningLedger).values({
      id: nanoid(),
      serverId: g.serverId,
      scope: characterId ? "character" : "user",
      ownerId: characterId ?? target.id,
      xpDelta: 0,
      currencyDelta: 0,
      reason: "admin_grant",
      metadataJson: JSON.stringify({ actor: g.me.id, kind: "freeform_border", borderKey: body.borderKey, characterId }),
    });
    await audit(g.serverId, g.me.id, "server_earning_grant", { kind: "freeform_border", targetUserId: target.id, borderKey: body.borderKey, characterId });
    return { ok: true };
  });

  /**
   * POST /servers/:id/earning/revoke-freeform-border
   * Claw back a free-form border on this server (per-identity). Clears the
   * equip slot if it pointed at the revoked border. Idempotent.
   */
  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/earning/revoke-freeform-border", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof grantFreeformBorderBody>;
    try { body = grantFreeformBorderBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "user not found" }; }
    const characterId = body.characterId ?? null;
    if (characterId) {
      const c = (await db
        .select({ id: characters.id, userId: characters.userId })
        .from(characters)
        .where(eq(characters.id, characterId))
        .limit(1))[0];
      if (!c || c.userId !== target.id) {
        reply.code(404);
        return { error: "no such character on this user" };
      }
      await db.delete(characterOwnedFreeformBorders).where(and(
        eq(characterOwnedFreeformBorders.serverId, g.serverId),
        eq(characterOwnedFreeformBorders.characterId, characterId),
        eq(characterOwnedFreeformBorders.borderKey, body.borderKey),
      ));
      await db.update(characterEarning)
        .set({ selectedFreeformBorderKey: null, updatedAt: new Date() })
        .where(and(
          eq(characterEarning.serverId, g.serverId),
          eq(characterEarning.characterId, characterId),
          eq(characterEarning.selectedFreeformBorderKey, body.borderKey),
        ));
    } else {
      await db.delete(userOwnedFreeformBorders).where(and(
        eq(userOwnedFreeformBorders.serverId, g.serverId),
        eq(userOwnedFreeformBorders.userId, target.id),
        eq(userOwnedFreeformBorders.borderKey, body.borderKey),
      ));
      await db.update(userEarning)
        .set({ selectedFreeformBorderKey: null, updatedAt: new Date() })
        .where(and(
          eq(userEarning.serverId, g.serverId),
          eq(userEarning.userId, target.id),
          eq(userEarning.selectedFreeformBorderKey, body.borderKey),
        ));
    }
    await db.insert(earningLedger).values({
      id: nanoid(),
      serverId: g.serverId,
      scope: characterId ? "character" : "user",
      ownerId: characterId ?? target.id,
      xpDelta: 0,
      currencyDelta: 0,
      reason: "admin_revoke",
      metadataJson: JSON.stringify({ actor: g.me.id, kind: "freeform_border", borderKey: body.borderKey, characterId }),
    });
    await audit(g.serverId, g.me.id, "server_earning_revoke", { kind: "freeform_border", targetUserId: target.id, borderKey: body.borderKey, characterId });
    return { ok: true };
  });

  /**
   * GET /servers/:id/earning/user-ownership?username=…
   * Surface a target user's owned styles + borders + per-identity inventory ON
   * THIS SERVER, so the editor can render an accurate claw-back list. Every read
   * is scoped to `g.serverId` so the list matches exactly what the grant/revoke
   * routes act on.
   */
  app.get<{ Params: { id: string }; Querystring: { username?: string } }>(
    "/servers/:id/earning/user-ownership",
    async (req, reply) => {
      const g = await gate(req, reply); if (!g) return { error: "forbidden" };
      const username = (req.query.username ?? "").trim();
      if (!username) { reply.code(400); return { error: "username required" }; }
      const target = await resolveTargetUser(username);
      if (!target) { reply.code(404); return { error: "user not found" }; }

      const ownedStyles = await db
        .select({ styleKey: userOwnedNameStyles.styleKey })
        .from(userOwnedNameStyles)
        .where(and(eq(userOwnedNameStyles.serverId, g.serverId), eq(userOwnedNameStyles.userId, target.id)));
      const ownedBorders = await db
        .select({ rankKey: userOwnedBorders.rankKey })
        .from(userOwnedBorders)
        .where(and(eq(userOwnedBorders.serverId, g.serverId), eq(userOwnedBorders.userId, target.id)));
      const ownedFreeformBorders = await db
        .select({ borderKey: userOwnedFreeformBorders.borderKey })
        .from(userOwnedFreeformBorders)
        .where(and(eq(userOwnedFreeformBorders.serverId, g.serverId), eq(userOwnedFreeformBorders.userId, target.id)));

      const targetCharRows = await db
        .select({ id: characters.id, name: characters.name })
        .from(characters)
        .where(and(eq(characters.userId, target.id), sql`${characters.deletedAt} IS NULL`));
      const targetCharIds = targetCharRows.map((c) => c.id);
      const inventoryRows = await db
        .select({
          ownerScope: identityInventory.ownerScope,
          ownerId: identityInventory.ownerId,
          itemKey: identityInventory.itemKey,
          quantity: identityInventory.quantity,
        })
        .from(identityInventory)
        .where(sql`${identityInventory.serverId} = ${g.serverId} AND ((${identityInventory.ownerScope} = 'user' AND ${identityInventory.ownerId} = ${target.id})
          OR (${identityInventory.ownerScope} = 'character' AND ${identityInventory.ownerId} IN (${
          targetCharIds.length > 0
            ? sql.join(targetCharIds.map((id) => sql`${id}`), sql`, `)
            : sql`''`
        })))`);
      const inventory: { itemKey: string; quantity: number }[] = [];
      const inventoryByCharacter: Record<string, { itemKey: string; quantity: number }[]> = {};
      for (const r of inventoryRows) {
        const e = { itemKey: r.itemKey, quantity: r.quantity };
        if (r.ownerScope === "user") inventory.push(e);
        else (inventoryByCharacter[r.ownerId] ??= []).push(e);
      }

      // Resolved pool snapshot (xp/currency/rank) on THIS server for the header.
      const pool = await readPool(db, g.serverId, "user", target.id);
      return {
        userId: target.id,
        username: target.username,
        pool: pool
          ? {
              xp: "xp" in pool ? pool.xp : 0,
              currency: "currency" in pool ? pool.currency : 0,
              rankKey: pool.rankKey ?? null,
              tier: pool.tier ?? null,
            }
          : null,
        ownedStyles: ownedStyles.map((s) => s.styleKey),
        ownedBorders: ownedBorders.map((b) => b.rankKey),
        ownedFreeformBorders: ownedFreeformBorders.map((b) => b.borderKey),
        inventory,
        inventoryByCharacter,
        characters: targetCharRows,
      };
    },
  );

  /**
   * POST /servers/:id/earning/reset-user
   * Hard-reset a single user's earning state ON THIS SERVER (a clean slate for
   * testing / moderation): zero the user pool + every owned character pool,
   * drop all ownership rows, clear equipped cosmetics — all keyed on
   * `g.serverId`. Other servers' pools for the same user are UNTOUCHED. Audits
   * via the ledger.
   */
  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/earning/reset-user", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof resetUserBody>;
    try { body = resetUserBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "user not found" }; }

    await db.insert(userEarning).values({ serverId: g.serverId, userId: target.id }).onConflictDoNothing();
    await db.update(userEarning).set({
      xp: 0,
      currency: 0,
      rankKey: null,
      tier: null,
      maxRankKeyEverHeld: null,
      maxTierEverHeld: null,
      selectedBorderRankKey: null,
      selectedFreeformBorderKey: null,
      typingPhrase: null,
      updatedAt: new Date(),
    }).where(and(eq(userEarning.serverId, g.serverId), eq(userEarning.userId, target.id)));

    const ownedCharIds = (await db
      .select({ id: characters.id })
      .from(characters)
      .where(eq(characters.userId, target.id)))
      .map((c) => c.id);
    if (ownedCharIds.length > 0) {
      await db.update(characterEarning).set({
        xp: 0,
        currency: 0,
        rankKey: null,
        tier: null,
        maxRankKeyEverHeld: null,
        maxTierEverHeld: null,
        selectedBorderRankKey: null,
        selectedFreeformBorderKey: null,
        profileBannerUrl: null,
        typingPhrase: null,
        lurkingMasterEnabled: false,
        inlineAvatarEnabled: false,
        updatedAt: new Date(),
      }).where(and(eq(characterEarning.serverId, g.serverId), inArray(characterEarning.characterId, ownedCharIds)));
    }

    await db.delete(userOwnedBorders).where(and(eq(userOwnedBorders.serverId, g.serverId), eq(userOwnedBorders.userId, target.id)));
    await db.delete(userOwnedNameStyles).where(and(eq(userOwnedNameStyles.serverId, g.serverId), eq(userOwnedNameStyles.userId, target.id)));
    await db.delete(userOwnedFreeformBorders).where(and(eq(userOwnedFreeformBorders.serverId, g.serverId), eq(userOwnedFreeformBorders.userId, target.id)));
    if (ownedCharIds.length > 0) {
      await db.delete(characterOwnedFreeformBorders)
        .where(and(eq(characterOwnedFreeformBorders.serverId, g.serverId), inArray(characterOwnedFreeformBorders.characterId, ownedCharIds)));
    }
    await db.delete(userActiveCosmetics).where(and(eq(userActiveCosmetics.serverId, g.serverId), eq(userActiveCosmetics.userId, target.id)));

    await db.insert(earningLedger).values({
      id: nanoid(),
      serverId: g.serverId,
      scope: "user",
      ownerId: target.id,
      xpDelta: 0,
      currencyDelta: 0,
      reason: "admin_reset",
      metadataJson: JSON.stringify({ actor: g.me.id, characters: ownedCharIds.length }),
    });
    await audit(g.serverId, g.me.id, "server_earning_reset", { targetUserId: target.id, characters: ownedCharIds.length });
    return { ok: true };
  });

  /* =========================================================
   *  PER-SERVER CATALOGS (the "Catalog Partition")
   *
   *  The catalogs (`ranks`, `rank_tiers`, `name_styles`,
   *  `freeform_borders`, `cosmetics`, `items`, `room_transitions`,
   *  flash sales) were partitioned per server (migrations 0295-0299):
   *  every row carries `server_id` in its PK. A server OWNER defines
   *  THEIR ladder / styles / borders / shop entirely independently of
   *  the platform catalog (which Lane 3 now scopes to the system
   *  server). The endpoints below MIRROR the global editors in
   *  admin/earning.ts but scope EVERY query by the route's `:id`.
   *
   *  All gated on `manage_earning` via the same `gate()` preamble the
   *  grant/revoke routes use (flag → auth → authority → permission).
   *
   *  NOTE on rank backfill: the global editor calls
   *  `backfillAllRankPlacements(db)` after a threshold change, but that
   *  helper is NOT server-scoped (Lane 3 owns the resolver). Calling it
   *  here would re-place every server's pool against a cross-server tier
   *  set, so the per-server editor persists the catalog change WITHOUT
   *  the immediate backfill — placements settle on the next earn. See
   *  the cross-lane note in the return summary.
   * ========================================================= */

  /* ---------- Import Spire built-ins ----------
   *
   *  A freshly-created sub-server starts with an EMPTY catalog (intended): a
   *  server owner either BUILDS their own ladder / styles / shop, or seeds it
   *  from the Spire built-ins with one click. This endpoint copies the SYSTEM
   *  server's (DEFAULT_SERVER_ID) catalog rows into THIS server.
   *
   *  WHAT COUNTS AS A BUILT-IN
   *    - `items` / `name_styles` / `freeform_borders` carry an `isBuiltin`
   *      flag — only those rows are copied.
   *    - `ranks` / `rank_tiers` / `cosmetics` / `room_transitions` have NO
   *      such flag, so EVERY system-server row is treated as a built-in.
   *
   *  SKIP-EXISTING (never overwrite an owner's edit). Every insert is
   *  onConflictDoNothing on the destination PK (for rank_tiers: a fresh id +
   *  a manual "already have this (rankKey, tier)?" skip), so re-running the
   *  import — or importing after the owner has hand-tuned a row — leaves their
   *  rows untouched and only fills the gaps. Returns { imported, skipped } per
   *  catalog so the UI can report exactly what landed.
   *
   *  ARCADE scope is a TARGETED subset: the Eidolon Tamer needs its `items`
   *  (categories EIDOLON_ITEM_CATEGORIES = pet/food/toy/magic) + the
   *  `FLAIR_EIDOLON_TAMER` unlock (a `cosmetics` row) to function. The arcade
   *  import copies exactly those — NOT the whole item/cosmetic catalog — so a
   *  server can enable the Arcade without inheriting the rest of the shop.
   *
   *  Like the catalog editors, this does NOT run a rank backfill (Lane 3 owns
   *  the resolver); placements settle on the next earn.
   * ========================================================= */

  const importBuiltinsBody = z.object({
    scope: z.enum([
      "all", "arcade", "ranks", "name-styles", "freeform-borders",
      "items", "cosmetics", "room-transitions",
    ]),
  }).strict();

  type ImportCount = { imported: number; skipped: number };

  /** Copy this server's RANK catalog from the system server (all rows are
   *  built-in) — each rank AND its tiers (a rank with no tiers is useless).
   *  Skips any rank key / (rankKey, tier) the target already has. */
  async function importRanks(targetServerId: string): Promise<{ ranks: ImportCount; tiers: ImportCount }> {
    const ranksResult: ImportCount = { imported: 0, skipped: 0 };
    const tiersResult: ImportCount = { imported: 0, skipped: 0 };
    if (targetServerId === DEFAULT_SERVER_ID) return { ranks: ranksResult, tiers: tiersResult };

    const sourceRanks = await db.select().from(ranks).where(eq(ranks.serverId, DEFAULT_SERVER_ID));
    const existingRankKeys = new Set(
      (await db.select({ key: ranks.key }).from(ranks).where(eq(ranks.serverId, targetServerId))).map((r) => r.key),
    );
    for (const r of sourceRanks) {
      if (existingRankKeys.has(r.key)) { ranksResult.skipped++; continue; }
      await db.insert(ranks).values({
        serverId: targetServerId, key: r.key, name: r.name, order: r.order, enabled: r.enabled,
      }).onConflictDoNothing();
      ranksResult.imported++;
    }

    const sourceTiers = await db.select().from(rankTiers).where(eq(rankTiers.serverId, DEFAULT_SERVER_ID));
    const existingTierKeys = new Set(
      (await db.select({ rankKey: rankTiers.rankKey, tier: rankTiers.tier }).from(rankTiers).where(eq(rankTiers.serverId, targetServerId)))
        .map((t) => `${t.rankKey}::${t.tier}`),
    );
    for (const t of sourceTiers) {
      // Only attach tiers to a rank that now exists on the target (one we just
      // imported or one already there) — the composite FK demands the parent.
      if (!existingRankKeys.has(t.rankKey) && !sourceRanks.some((r) => r.key === t.rankKey)) { tiersResult.skipped++; continue; }
      if (existingTierKeys.has(`${t.rankKey}::${t.tier}`)) { tiersResult.skipped++; continue; }
      await db.insert(rankTiers).values({
        id: nanoid(), serverId: targetServerId, rankKey: t.rankKey, tier: t.tier, label: t.label,
        xpThreshold: t.xpThreshold, sigilImageUrl: t.sigilImageUrl,
        borderImageUrl: t.borderImageUrl, borderCost: t.borderCost, enabled: t.enabled,
      }).onConflictDoNothing();
      existingTierKeys.add(`${t.rankKey}::${t.tier}`);
      tiersResult.imported++;
    }
    return { ranks: ranksResult, tiers: tiersResult };
  }

  /** Copy built-in NAME STYLES (isBuiltin = true) from the system server. */
  async function importNameStyles(targetServerId: string): Promise<ImportCount> {
    const result: ImportCount = { imported: 0, skipped: 0 };
    if (targetServerId === DEFAULT_SERVER_ID) return result;
    const source = await db.select().from(nameStyles)
      .where(and(eq(nameStyles.serverId, DEFAULT_SERVER_ID), eq(nameStyles.isBuiltin, true)));
    const existing = new Set(
      (await db.select({ key: nameStyles.key }).from(nameStyles).where(eq(nameStyles.serverId, targetServerId))).map((r) => r.key),
    );
    for (const s of source) {
      if (existing.has(s.key)) { result.skipped++; continue; }
      await db.insert(nameStyles).values({
        serverId: targetServerId, key: s.key, name: s.name, description: s.description,
        template: s.template, styleCss: s.styleCss, cost: s.cost, enabled: s.enabled,
        isBuiltin: s.isBuiltin, order: s.order,
      }).onConflictDoNothing();
      result.imported++;
    }
    return result;
  }

  /** Copy built-in FREE-FORM BORDERS (isBuiltin = true) from the system server. */
  async function importFreeformBorders(targetServerId: string): Promise<ImportCount> {
    const result: ImportCount = { imported: 0, skipped: 0 };
    if (targetServerId === DEFAULT_SERVER_ID) return result;
    const source = await db.select().from(freeformBorders)
      .where(and(eq(freeformBorders.serverId, DEFAULT_SERVER_ID), eq(freeformBorders.isBuiltin, true)));
    const existing = new Set(
      (await db.select({ key: freeformBorders.key }).from(freeformBorders).where(eq(freeformBorders.serverId, targetServerId))).map((r) => r.key),
    );
    for (const b of source) {
      if (existing.has(b.key)) { result.skipped++; continue; }
      await db.insert(freeformBorders).values({
        serverId: targetServerId, key: b.key, name: b.name, description: b.description,
        imageUrl: b.imageUrl, template: b.template, styleCss: b.styleCss, rarity: b.rarity,
        cost: b.cost, enabled: b.enabled, isBuiltin: b.isBuiltin, order: b.order,
      }).onConflictDoNothing();
      result.imported++;
    }
    return result;
  }

  /** Copy ITEMS from the system server. Built-in (isBuiltin = true) rows only.
   *  When `categories` is given (the arcade slice) the copy is further filtered
   *  to those `items.category` values; otherwise the full built-in item set. */
  async function importItems(targetServerId: string, categories?: readonly string[]): Promise<ImportCount> {
    const result: ImportCount = { imported: 0, skipped: 0 };
    if (targetServerId === DEFAULT_SERVER_ID) return result;
    const source = (await db.select().from(items)
      .where(and(eq(items.serverId, DEFAULT_SERVER_ID), eq(items.isBuiltin, true))))
      .filter((it) => !categories || categories.includes(it.category));
    const existing = new Set(
      (await db.select({ key: items.key }).from(items).where(eq(items.serverId, targetServerId))).map((r) => r.key),
    );
    for (const it of source) {
      if (existing.has(it.key)) { result.skipped++; continue; }
      await db.insert(items).values({
        serverId: targetServerId, key: it.key, name: it.name, namePlural: it.namePlural,
        description: it.description, iconUrl: it.iconUrl, price: it.price, stackLimit: it.stackLimit,
        giveMessagesJson: it.giveMessagesJson, throwMessagesJson: it.throwMessagesJson,
        dropMessagesJson: it.dropMessagesJson, aliasesJson: it.aliasesJson, category: it.category,
        enabled: it.enabled, forSale: it.forSale, saleStartsAt: it.saleStartsAt, saleEndsAt: it.saleEndsAt,
        order: it.order, isBuiltin: it.isBuiltin,
      }).onConflictDoNothing();
      result.imported++;
    }
    return result;
  }

  /** Copy COSMETICS from the system server (no isBuiltin flag — all system
   *  rows are built-in). When `onlyKeys` is given (the arcade unlock) the copy
   *  is filtered to those keys; otherwise the full cosmetic catalog. */
  async function importCosmetics(targetServerId: string, onlyKeys?: readonly string[]): Promise<ImportCount> {
    const result: ImportCount = { imported: 0, skipped: 0 };
    if (targetServerId === DEFAULT_SERVER_ID) return result;
    const source = (await db.select().from(cosmetics).where(eq(cosmetics.serverId, DEFAULT_SERVER_ID)))
      .filter((c) => !onlyKeys || onlyKeys.includes(c.key));
    const existing = new Set(
      (await db.select({ key: cosmetics.key }).from(cosmetics).where(eq(cosmetics.serverId, targetServerId))).map((r) => r.key),
    );
    for (const c of source) {
      if (existing.has(c.key)) { result.skipped++; continue; }
      await db.insert(cosmetics).values({
        serverId: targetServerId, key: c.key, name: c.name, description: c.description,
        cost: c.cost, enabled: c.enabled, configJson: c.configJson,
      }).onConflictDoNothing();
      result.imported++;
    }
    return result;
  }

  /** Copy ROOM TRANSITIONS from the system server (no isBuiltin flag — all
   *  system rows are built-in). The catalog is fixed by the shared const, so
   *  this just seeds the per-server price/enabled/order rows. */
  async function importRoomTransitions(targetServerId: string): Promise<ImportCount> {
    const result: ImportCount = { imported: 0, skipped: 0 };
    if (targetServerId === DEFAULT_SERVER_ID) return result;
    const source = await db.select().from(roomTransitions).where(eq(roomTransitions.serverId, DEFAULT_SERVER_ID));
    const existing = new Set(
      (await db.select({ key: roomTransitions.key }).from(roomTransitions).where(eq(roomTransitions.serverId, targetServerId))).map((r) => r.key),
    );
    for (const t of source) {
      if (existing.has(t.key)) { result.skipped++; continue; }
      await db.insert(roomTransitions).values({
        serverId: targetServerId, key: t.key, cost: t.cost, enabled: t.enabled, sortOrder: t.sortOrder,
      }).onConflictDoNothing();
      result.imported++;
    }
    return result;
  }

  /**
   * POST /servers/:id/earning/import-builtins
   * Seed THIS server's catalog from the Spire built-ins (the system server's
   * rows). Body `{ scope }` chooses which catalog(s):
   *   - "all"              — every built-in catalog (ranks+tiers, name styles,
   *                          free-form borders, items, cosmetics, room transitions)
   *   - "arcade"           — only the Eidolon Tamer's items (EIDOLON_ITEM_CATEGORIES)
   *                          + the FLAIR_EIDOLON_TAMER unlock cosmetic
   *   - one catalog name   — just that catalog
   * Skips any key the target already has (never overwrites an owner's edit).
   * Returns per-catalog { imported, skipped } counts.
   */
  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/earning/import-builtins", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof importBuiltinsBody>;
    try { body = importBuiltinsBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }

    // Importing INTO the system server is a no-op (it IS the source). Guard so a
    // misfire can't duplicate the source catalog onto itself.
    if (g.serverId === DEFAULT_SERVER_ID) {
      reply.code(400);
      return { error: "the system server is the source of the built-ins; nothing to import" };
    }

    const counts: Record<string, ImportCount> = {};
    const want = (s: string) => body.scope === "all" || body.scope === s;

    if (want("ranks")) {
      const { ranks: rc, tiers: tc } = await importRanks(g.serverId);
      counts.ranks = rc;
      counts.rankTiers = tc;
    }
    if (want("name-styles")) counts.nameStyles = await importNameStyles(g.serverId);
    if (want("freeform-borders")) counts.freeformBorders = await importFreeformBorders(g.serverId);
    if (want("items")) counts.items = await importItems(g.serverId);
    if (want("cosmetics")) counts.cosmetics = await importCosmetics(g.serverId);
    if (want("room-transitions")) counts.roomTransitions = await importRoomTransitions(g.serverId);

    if (body.scope === "arcade") {
      // Targeted: exactly the eidolon's items + its unlock flair (a cosmetic),
      // so a server can run the Arcade without inheriting the whole shop.
      counts.items = await importItems(g.serverId, EIDOLON_ITEM_CATEGORIES);
      counts.cosmetics = await importCosmetics(g.serverId, [FLAIR_EIDOLON_TAMER]);
    }

    const totals = Object.values(counts).reduce(
      (acc, c) => ({ imported: acc.imported + c.imported, skipped: acc.skipped + c.skipped }),
      { imported: 0, skipped: 0 },
    );
    await audit(g.serverId, g.me.id, "server_earning_catalog_edit", {
      kind: "import_builtins", scope: body.scope, imported: totals.imported, skipped: totals.skipped,
    });
    return { ok: true, scope: body.scope, counts, totals };
  });

  /* ---------- Ranks + tiers ---------- */

  const createRankBody = z.object({
    key: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
    name: z.string().min(1).max(80),
    order: z.number().int().optional(),
    enabled: z.boolean().optional(),
  }).strict();
  const patchRankBody = z.object({
    name: z.string().min(1).max(80).optional(),
    order: z.number().int().optional(),
    enabled: z.boolean().optional(),
  }).strict();
  const createTierBody = z.object({
    tier: z.number().int().min(1).max(20),
    label: z.string().min(1).max(80),
    xpThreshold: z.number().int().min(0),
    sigilImageUrl: z.string().max(1024).optional(),
    borderImageUrl: z.string().max(1024).optional(),
    borderCost: z.number().int().min(0).optional(),
    enabled: z.boolean().optional(),
  }).strict();
  const patchTierBody = z.object({
    label: z.string().min(1).max(80).optional(),
    xpThreshold: z.number().int().min(0).optional(),
    sigilImageUrl: z.string().max(1024).optional(),
    borderImageUrl: z.string().max(1024).nullable().optional(),
    borderCost: z.number().int().min(0).nullable().optional(),
    enabled: z.boolean().optional(),
  }).strict();

  /**
   * GET /servers/:id/earning/ranks
   * This server's full rank ladder + tiers + per-rank usage counts on
   * THIS server's pools (drives the delete-protected UI).
   */
  app.get<{ Params: { id: string } }>("/servers/:id/earning/ranks", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    const rankRows = await db.select().from(ranks)
      .where(eq(ranks.serverId, g.serverId)).orderBy(asc(ranks.order), asc(ranks.name));
    const tierRows = await db.select().from(rankTiers)
      .where(eq(rankTiers.serverId, g.serverId)).orderBy(asc(rankTiers.rankKey), asc(rankTiers.tier));
    const userCounts = await db.all<{ rankKey: string; n: number }>(sql`
      SELECT rank_key AS rankKey, COUNT(*) AS n FROM user_earning
      WHERE server_id = ${g.serverId} AND rank_key IS NOT NULL GROUP BY rank_key`);
    const charCounts = await db.all<{ rankKey: string; n: number }>(sql`
      SELECT rank_key AS rankKey, COUNT(*) AS n FROM character_earning
      WHERE server_id = ${g.serverId} AND rank_key IS NOT NULL GROUP BY rank_key`);
    const usageByRank = new Map<string, { users: number; characters: number }>();
    for (const r of userCounts) usageByRank.set(r.rankKey, { users: r.n, characters: 0 });
    for (const r of charCounts) {
      const cur = usageByRank.get(r.rankKey);
      if (cur) cur.characters = r.n; else usageByRank.set(r.rankKey, { users: 0, characters: r.n });
    }
    return {
      ranks: rankRows.map((r) => ({
        key: r.key, name: r.name, order: r.order, enabled: !!r.enabled,
        users: usageByRank.get(r.key)?.users ?? 0,
        characters: usageByRank.get(r.key)?.characters ?? 0,
      })),
      tiers: tierRows.map((t) => ({
        id: t.id, rankKey: t.rankKey, tier: t.tier, label: t.label,
        xpThreshold: t.xpThreshold, sigilImageUrl: t.sigilImageUrl,
        borderImageUrl: t.borderImageUrl, borderCost: t.borderCost, enabled: !!t.enabled,
      })),
    };
  });

  /** POST /servers/:id/earning/ranks — create a rank + seed 4 tiers. */
  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/earning/ranks", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof createRankBody>;
    try { body = createRankBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const existing = (await db.select().from(ranks).where(and(eq(ranks.serverId, g.serverId), eq(ranks.key, body.key))).limit(1))[0];
    if (existing) { reply.code(409); return { error: "rank key already exists" }; }
    const maxOrderRow = (await db.select({ m: sql<number>`MAX("order")` }).from(ranks).where(eq(ranks.serverId, g.serverId)))[0];
    const order = body.order ?? ((maxOrderRow?.m ?? 0) + 1);
    await db.insert(ranks).values({ serverId: g.serverId, key: body.key, name: body.name, order, enabled: body.enabled ?? true });
    for (const t of [1, 2, 3, 4]) {
      await db.insert(rankTiers).values({
        id: nanoid(), serverId: g.serverId, rankKey: body.key, tier: t,
        label: t === 4 ? "IV: Verified" : ["I", "II", "III"][t - 1]!,
        xpThreshold: 0, sigilImageUrl: "", enabled: true,
      });
    }
    await audit(g.serverId, g.me.id, "server_earning_catalog_edit", { kind: "rank_create", rankKey: body.key });
    return { ok: true, key: body.key };
  });

  /** PATCH /servers/:id/earning/ranks/:key — rename / reorder / toggle. */
  app.patch<{ Params: { id: string; key: string }; Body: unknown }>("/servers/:id/earning/ranks/:key", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof patchRankBody>;
    try { body = patchRankBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const existing = (await db.select().from(ranks).where(and(eq(ranks.serverId, g.serverId), eq(ranks.key, req.params.key))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "rank not found" }; }
    const update: Partial<typeof ranks.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) update.name = body.name;
    if (body.order !== undefined) update.order = body.order;
    if (body.enabled !== undefined) update.enabled = body.enabled;
    await db.update(ranks).set(update).where(and(eq(ranks.serverId, g.serverId), eq(ranks.key, req.params.key)));
    await audit(g.serverId, g.me.id, "server_earning_catalog_edit", { kind: "rank_patch", rankKey: req.params.key });
    return { ok: true };
  });

  /** DELETE /servers/:id/earning/ranks/:key — only when nobody on this server holds it. */
  app.delete<{ Params: { id: string; key: string } }>("/servers/:id/earning/ranks/:key", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    const userCount = (await db.select({ n: sql<number>`COUNT(*)` }).from(userEarning)
      .where(and(eq(userEarning.serverId, g.serverId), eq(userEarning.rankKey, req.params.key))))[0];
    const charCount = (await db.select({ n: sql<number>`COUNT(*)` }).from(characterEarning)
      .where(and(eq(characterEarning.serverId, g.serverId), eq(characterEarning.rankKey, req.params.key))))[0];
    if ((userCount?.n ?? 0) + (charCount?.n ?? 0) > 0) {
      reply.code(409);
      return { error: "rank is in use", message: "Disable the rank instead, existing rank-holders should not be displaced." };
    }
    await db.delete(ranks).where(and(eq(ranks.serverId, g.serverId), eq(ranks.key, req.params.key)));
    await audit(g.serverId, g.me.id, "server_earning_catalog_edit", { kind: "rank_delete", rankKey: req.params.key });
    return { ok: true };
  });

  /** POST /servers/:id/earning/ranks/:key/tiers — add a tier to a rank. */
  app.post<{ Params: { id: string; key: string }; Body: unknown }>("/servers/:id/earning/ranks/:key/tiers", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof createTierBody>;
    try { body = createTierBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const rank = (await db.select().from(ranks).where(and(eq(ranks.serverId, g.serverId), eq(ranks.key, req.params.key))).limit(1))[0];
    if (!rank) { reply.code(404); return { error: "rank not found" }; }
    const dup = (await db.select().from(rankTiers)
      .where(and(eq(rankTiers.serverId, g.serverId), eq(rankTiers.rankKey, req.params.key), eq(rankTiers.tier, body.tier))).limit(1))[0];
    if (dup) { reply.code(409); return { error: "tier already exists for this rank" }; }
    const id = nanoid();
    await db.insert(rankTiers).values({
      id, serverId: g.serverId, rankKey: req.params.key, tier: body.tier, label: body.label,
      xpThreshold: body.xpThreshold, sigilImageUrl: body.sigilImageUrl ?? "",
      borderImageUrl: body.borderImageUrl ?? null, borderCost: body.borderCost ?? null, enabled: body.enabled ?? true,
    });
    await audit(g.serverId, g.me.id, "server_earning_catalog_edit", { kind: "tier_create", rankKey: req.params.key, tier: body.tier });
    return { ok: true, id };
  });

  /** PATCH /servers/:id/earning/rank-tiers/:tierId — edit a single tier row. */
  app.patch<{ Params: { id: string; tierId: string }; Body: unknown }>("/servers/:id/earning/rank-tiers/:tierId", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof patchTierBody>;
    try { body = patchTierBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const existing = (await db.select().from(rankTiers)
      .where(and(eq(rankTiers.serverId, g.serverId), eq(rankTiers.id, req.params.tierId))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "tier not found" }; }
    const update: Partial<typeof rankTiers.$inferInsert> = { updatedAt: new Date() };
    if (body.label !== undefined) update.label = body.label;
    if (body.xpThreshold !== undefined) update.xpThreshold = body.xpThreshold;
    if (body.sigilImageUrl !== undefined) update.sigilImageUrl = body.sigilImageUrl;
    if (body.borderImageUrl !== undefined) update.borderImageUrl = body.borderImageUrl;
    if (body.borderCost !== undefined) update.borderCost = body.borderCost;
    if (body.enabled !== undefined) update.enabled = body.enabled;
    await db.update(rankTiers).set(update).where(and(eq(rankTiers.serverId, g.serverId), eq(rankTiers.id, req.params.tierId)));
    await audit(g.serverId, g.me.id, "server_earning_catalog_edit", { kind: "tier_patch", tierId: req.params.tierId });
    return { ok: true };
  });

  /** DELETE /servers/:id/earning/rank-tiers/:tierId — only when nobody on this server sits on it. */
  app.delete<{ Params: { id: string; tierId: string } }>("/servers/:id/earning/rank-tiers/:tierId", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    const existing = (await db.select().from(rankTiers)
      .where(and(eq(rankTiers.serverId, g.serverId), eq(rankTiers.id, req.params.tierId))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "tier not found" }; }
    const userCount = (await db.select({ n: sql<number>`COUNT(*)` }).from(userEarning)
      .where(and(eq(userEarning.serverId, g.serverId), eq(userEarning.rankKey, existing.rankKey), eq(userEarning.tier, existing.tier))))[0];
    const charCount = (await db.select({ n: sql<number>`COUNT(*)` }).from(characterEarning)
      .where(and(eq(characterEarning.serverId, g.serverId), eq(characterEarning.rankKey, existing.rankKey), eq(characterEarning.tier, existing.tier))))[0];
    if ((userCount?.n ?? 0) + (charCount?.n ?? 0) > 0) {
      reply.code(409);
      return { error: "tier is in use", message: "Disable the tier or change the threshold so users move out before deleting." };
    }
    await db.delete(rankTiers).where(and(eq(rankTiers.serverId, g.serverId), eq(rankTiers.id, req.params.tierId)));
    await audit(g.serverId, g.me.id, "server_earning_catalog_edit", { kind: "tier_delete", tierId: req.params.tierId });
    return { ok: true };
  });

  /**
   * POST /servers/:id/earning/ranks/assets/upload
   * Accepts a base64 PNG data URL, magic-byte sniffs it, caps at 256KB,
   * content-hashes the bytes, and writes to
   * `<uploadsRoot>/ranks/<serverId>/<hash>.png` — the per-server namespacing
   * mirrors the server-image pipeline so two servers' uploads never collide.
   * Returns the public URL the caller stores into a tier's sigil/border field
   * via PATCH /servers/:id/earning/rank-tiers/:tierId.
   */
  const uploadAssetBody = z.object({ dataUrl: z.string().min(8) }).strict();
  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/earning/ranks/assets/upload", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof uploadAssetBody>;
    try { body = uploadAssetBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(body.dataUrl.trim());
    if (!m) { reply.code(400); return { error: "expected a base64 data URL" }; }
    let bytes: Buffer;
    try { bytes = Buffer.from(m[2]!, "base64"); }
    catch { reply.code(400); return { error: "invalid base64 payload" }; }
    // PNG-only (transparency is load-bearing for sigil/border overlays).
    const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    let isPng = bytes.length >= PNG_MAGIC.length;
    for (let i = 0; isPng && i < PNG_MAGIC.length; i++) if (bytes[i] !== PNG_MAGIC[i]) isPng = false;
    if (!isPng) { reply.code(415); return { error: "rank assets must be PNG (transparency is load-bearing for sigil overlays)" }; }
    // Smaller cap than the platform's 1MB — server-owner uploads are sigils,
    // not full art, and per-server quotas keep the shared disk honest.
    if (bytes.length > 256_000) { reply.code(413); return { error: "rank assets capped at 256KB" }; }
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    // Per-server namespacing: /uploads/ranks/<serverId>/<hash>.png.
    const dir = join(uploadsRoot, "ranks", g.serverId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${hash}.png`), bytes);
    return { ok: true, url: `/uploads/ranks/${encodeURIComponent(g.serverId)}/${hash}.png` };
  });

  /* ---------- Name styles ---------- */

  const createStyleBody = z.object({
    key: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    template: z.string().min(1).max(4000),
    styleCss: z.string().max(64000).optional(),
    cost: z.number().int().min(0).max(1_000_000).optional(),
    enabled: z.boolean().optional(),
    order: z.number().int().optional(),
  }).strict();
  const patchStyleBody = z.object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    template: z.string().min(1).max(4000).optional(),
    styleCss: z.string().max(64000).optional(),
    cost: z.number().int().min(0).max(1_000_000).optional(),
    enabled: z.boolean().optional(),
    order: z.number().int().optional(),
  }).strict();

  app.get<{ Params: { id: string } }>("/servers/:id/earning/name-styles", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    const rows = await db.select().from(nameStyles).where(eq(nameStyles.serverId, g.serverId)).orderBy(asc(nameStyles.order));
    const ownerRows = await db.all<{ styleKey: string; n: number }>(sql`
      SELECT style_key AS styleKey, COUNT(*) AS n FROM user_owned_name_styles
      WHERE server_id = ${g.serverId} GROUP BY style_key`);
    const ownedByKey = new Map(ownerRows.map((r) => [r.styleKey, r.n]));
    return {
      styles: rows.map((r) => ({
        key: r.key, name: r.name, description: r.description, template: r.template, styleCss: r.styleCss,
        cost: r.cost, enabled: !!r.enabled, isBuiltin: !!r.isBuiltin, order: r.order,
        owners: ownedByKey.get(r.key) ?? 0,
      })),
    };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/earning/name-styles", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof createStyleBody>;
    try { body = createStyleBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const dup = (await db.select().from(nameStyles).where(and(eq(nameStyles.serverId, g.serverId), eq(nameStyles.key, body.key))).limit(1))[0];
    if (dup) { reply.code(409); return { error: "style key already exists" }; }
    const maxOrderRow = (await db.select({ m: sql<number>`MAX("order")` }).from(nameStyles).where(eq(nameStyles.serverId, g.serverId)))[0];
    const order = body.order ?? ((maxOrderRow?.m ?? 0) + 1);
    await db.insert(nameStyles).values({
      serverId: g.serverId, key: body.key, name: body.name, description: body.description ?? "",
      template: body.template, styleCss: body.styleCss ?? "", cost: body.cost ?? 0,
      enabled: body.enabled ?? true, isBuiltin: false, order,
    });
    await audit(g.serverId, g.me.id, "server_earning_catalog_edit", { kind: "name_style_create", styleKey: body.key });
    return { ok: true, key: body.key };
  });

  app.patch<{ Params: { id: string; key: string }; Body: unknown }>("/servers/:id/earning/name-styles/:key", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof patchStyleBody>;
    try { body = patchStyleBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const existing = (await db.select().from(nameStyles).where(and(eq(nameStyles.serverId, g.serverId), eq(nameStyles.key, req.params.key))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "style not found" }; }
    const update: Partial<typeof nameStyles.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) update.name = body.name;
    if (body.description !== undefined) update.description = body.description;
    if (body.template !== undefined) update.template = body.template;
    if (body.styleCss !== undefined) update.styleCss = body.styleCss;
    if (body.cost !== undefined) update.cost = body.cost;
    if (body.enabled !== undefined) update.enabled = body.enabled;
    if (body.order !== undefined) update.order = body.order;
    await db.update(nameStyles).set(update).where(and(eq(nameStyles.serverId, g.serverId), eq(nameStyles.key, req.params.key)));
    await audit(g.serverId, g.me.id, "server_earning_catalog_edit", { kind: "name_style_patch", styleKey: req.params.key });
    return { ok: true };
  });

  app.delete<{ Params: { id: string; key: string } }>("/servers/:id/earning/name-styles/:key", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    const existing = (await db.select().from(nameStyles).where(and(eq(nameStyles.serverId, g.serverId), eq(nameStyles.key, req.params.key))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "style not found" }; }
    if (existing.isBuiltin) {
      reply.code(409);
      return { error: "built-in styles cannot be deleted", message: "Disable it instead, the seed row backs anyone who owns it." };
    }
    await db.delete(nameStyles).where(and(eq(nameStyles.serverId, g.serverId), eq(nameStyles.key, req.params.key)));
    await audit(g.serverId, g.me.id, "server_earning_catalog_edit", { kind: "name_style_delete", styleKey: req.params.key });
    return { ok: true };
  });

  /* ---------- Free-form borders ---------- */

  function validateFreeformBorderShape(opts: { imageUrl?: string | null; template?: string | null }): string | null {
    const hasImage = !!opts.imageUrl, hasTemplate = !!opts.template;
    if (hasImage && hasTemplate) return "border must ship in EITHER image-url mode OR template mode, not both";
    if (!hasImage && !hasTemplate) return "border must ship with EITHER image-url OR template + style-css";
    return null;
  }
  const createFreeformBorderBody = z.object({
    key: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/),
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    imageUrl: z.string().min(1).max(2000).nullable().optional(),
    template: z.string().min(1).max(8000).nullable().optional(),
    styleCss: z.string().max(64000).nullable().optional(),
    rarity: z.string().min(1).max(40).optional(),
    cost: z.number().int().min(0).max(1_000_000).optional(),
    enabled: z.boolean().optional(),
    order: z.number().int().optional(),
  }).strict();
  const patchFreeformBorderBody = z.object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    imageUrl: z.string().min(1).max(2000).nullable().optional(),
    template: z.string().min(1).max(8000).nullable().optional(),
    styleCss: z.string().max(64000).nullable().optional(),
    rarity: z.string().min(1).max(40).optional(),
    cost: z.number().int().min(0).max(1_000_000).optional(),
    enabled: z.boolean().optional(),
    order: z.number().int().optional(),
  }).strict();

  app.get<{ Params: { id: string } }>("/servers/:id/earning/freeform-borders", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    const rows = await db.select().from(freeformBorders).where(eq(freeformBorders.serverId, g.serverId)).orderBy(asc(freeformBorders.order));
    const userOwnerRows = await db.all<{ borderKey: string; n: number }>(sql`
      SELECT border_key AS borderKey, COUNT(*) AS n FROM user_owned_freeform_borders WHERE server_id = ${g.serverId} GROUP BY border_key`);
    const charOwnerRows = await db.all<{ borderKey: string; n: number }>(sql`
      SELECT border_key AS borderKey, COUNT(*) AS n FROM character_owned_freeform_borders WHERE server_id = ${g.serverId} GROUP BY border_key`);
    const ownersByKey = new Map<string, number>();
    for (const r of userOwnerRows) ownersByKey.set(r.borderKey, (ownersByKey.get(r.borderKey) ?? 0) + r.n);
    for (const r of charOwnerRows) ownersByKey.set(r.borderKey, (ownersByKey.get(r.borderKey) ?? 0) + r.n);
    return {
      borders: rows.map((r) => ({
        key: r.key, name: r.name, description: r.description, imageUrl: r.imageUrl, template: r.template,
        styleCss: r.styleCss, rarity: r.rarity, cost: r.cost, enabled: !!r.enabled, isBuiltin: !!r.isBuiltin,
        order: r.order, owners: ownersByKey.get(r.key) ?? 0,
      })),
    };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/earning/freeform-borders", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof createFreeformBorderBody>;
    try { body = createFreeformBorderBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const shapeError = validateFreeformBorderShape({ imageUrl: body.imageUrl ?? null, template: body.template ?? null });
    if (shapeError) { reply.code(400); return { error: shapeError }; }
    const dup = (await db.select().from(freeformBorders).where(and(eq(freeformBorders.serverId, g.serverId), eq(freeformBorders.key, body.key))).limit(1))[0];
    if (dup) { reply.code(409); return { error: "border key already exists" }; }
    const maxOrderRow = (await db.select({ m: sql<number>`MAX("order")` }).from(freeformBorders).where(eq(freeformBorders.serverId, g.serverId)))[0];
    const order = body.order ?? ((maxOrderRow?.m ?? 0) + 1);
    await db.insert(freeformBorders).values({
      serverId: g.serverId, key: body.key, name: body.name, description: body.description ?? "",
      imageUrl: body.imageUrl ?? null, template: body.template ?? null, styleCss: body.styleCss ?? null,
      rarity: body.rarity ?? "common", cost: body.cost ?? 0, enabled: body.enabled ?? true, isBuiltin: false, order,
    });
    await audit(g.serverId, g.me.id, "server_earning_catalog_edit", { kind: "freeform_border_create", borderKey: body.key });
    return { ok: true, key: body.key };
  });

  app.patch<{ Params: { id: string; key: string }; Body: unknown }>("/servers/:id/earning/freeform-borders/:key", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof patchFreeformBorderBody>;
    try { body = patchFreeformBorderBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const existing = (await db.select().from(freeformBorders).where(and(eq(freeformBorders.serverId, g.serverId), eq(freeformBorders.key, req.params.key))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "border not found" }; }
    const resolvedImage = body.imageUrl === undefined ? existing.imageUrl : body.imageUrl;
    const resolvedTemplate = body.template === undefined ? existing.template : body.template;
    const shapeError = validateFreeformBorderShape({ imageUrl: resolvedImage, template: resolvedTemplate });
    if (shapeError) { reply.code(400); return { error: shapeError }; }
    const update: Partial<typeof freeformBorders.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) update.name = body.name;
    if (body.description !== undefined) update.description = body.description;
    if (body.imageUrl !== undefined) update.imageUrl = body.imageUrl;
    if (body.template !== undefined) update.template = body.template;
    if (body.styleCss !== undefined) update.styleCss = body.styleCss;
    if (body.rarity !== undefined) update.rarity = body.rarity;
    if (body.cost !== undefined) update.cost = body.cost;
    if (body.enabled !== undefined) update.enabled = body.enabled;
    if (body.order !== undefined) update.order = body.order;
    await db.update(freeformBorders).set(update).where(and(eq(freeformBorders.serverId, g.serverId), eq(freeformBorders.key, req.params.key)));
    await audit(g.serverId, g.me.id, "server_earning_catalog_edit", { kind: "freeform_border_patch", borderKey: req.params.key });
    return { ok: true };
  });

  app.delete<{ Params: { id: string; key: string } }>("/servers/:id/earning/freeform-borders/:key", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    const existing = (await db.select().from(freeformBorders).where(and(eq(freeformBorders.serverId, g.serverId), eq(freeformBorders.key, req.params.key))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "border not found" }; }
    if (existing.isBuiltin) {
      reply.code(409);
      return { error: "built-in borders cannot be deleted", message: "Disable it instead, the seed row backs anyone who owns it." };
    }
    await db.delete(freeformBorders).where(and(eq(freeformBorders.serverId, g.serverId), eq(freeformBorders.key, req.params.key)));
    await audit(g.serverId, g.me.id, "server_earning_catalog_edit", { kind: "freeform_border_delete", borderKey: req.params.key });
    return { ok: true };
  });

  /* ---------- Cosmetics (price / enabled only; rows are seed-defined) ---------- */

  const patchCosmeticBody = z.object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    cost: z.number().int().min(0).max(1_000_000).optional(),
    enabled: z.boolean().optional(),
    configJson: z.string().max(4000).nullable().optional(),
  }).strict();

  app.get<{ Params: { id: string } }>("/servers/:id/earning/cosmetics", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    const rows = await db.select().from(cosmetics).where(eq(cosmetics.serverId, g.serverId));
    return {
      cosmetics: rows.map((r) => ({
        key: r.key, name: r.name, description: r.description, cost: r.cost, enabled: !!r.enabled, configJson: r.configJson,
      })),
    };
  });

  app.patch<{ Params: { id: string; key: string }; Body: unknown }>("/servers/:id/earning/cosmetics/:key", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof patchCosmeticBody>;
    try { body = patchCosmeticBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const existing = (await db.select().from(cosmetics).where(and(eq(cosmetics.serverId, g.serverId), eq(cosmetics.key, req.params.key))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "cosmetic not found" }; }
    const update: Partial<typeof cosmetics.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) update.name = body.name;
    if (body.description !== undefined) update.description = body.description;
    if (body.cost !== undefined) update.cost = body.cost;
    if (body.enabled !== undefined) update.enabled = body.enabled;
    if (body.configJson !== undefined) update.configJson = body.configJson;
    await db.update(cosmetics).set(update).where(and(eq(cosmetics.serverId, g.serverId), eq(cosmetics.key, req.params.key)));
    await audit(g.serverId, g.me.id, "server_earning_catalog_edit", { kind: "cosmetic_patch", cosmeticKey: req.params.key });
    return { ok: true };
  });

  /* ---------- Items ---------- */

  const messageTemplateArray = z.array(z.string().min(1).max(800)).max(50);
  const aliasesArray = z.array(z.string().min(1).max(40)).max(30);
  const itemCategory = z.enum(["food", "drink", "joke", "tool", "weapon", "armor", "magic", "treasure", "building", "gift", "toy", "pet", "misc"]);
  const itemCreateBody = z.object({
    key: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
    name: z.string().min(1).max(80),
    namePlural: z.string().min(1).max(80).nullable().optional(),
    description: z.string().max(800).optional(),
    iconUrl: z.string().max(1000).nullable().optional(),
    price: z.number().int().min(0).max(1_000_000).optional(),
    stackLimit: z.number().int().min(1).max(9999).optional(),
    giveMessages: messageTemplateArray.optional(),
    throwMessages: messageTemplateArray.optional(),
    dropMessages: messageTemplateArray.optional(),
    aliases: aliasesArray.optional(),
    category: itemCategory.optional(),
    enabled: z.boolean().optional(),
    forSale: z.boolean().optional(),
    saleStartsAt: z.number().int().nullable().optional(),
    saleEndsAt: z.number().int().nullable().optional(),
    order: z.number().int().optional(),
  }).strict();
  const itemPatchBody = z.object({
    name: z.string().min(1).max(80).optional(),
    namePlural: z.string().min(1).max(80).nullable().optional(),
    description: z.string().max(800).optional(),
    iconUrl: z.string().max(1000).nullable().optional(),
    price: z.number().int().min(0).max(1_000_000).optional(),
    stackLimit: z.number().int().min(1).max(9999).optional(),
    giveMessages: messageTemplateArray.optional(),
    throwMessages: messageTemplateArray.optional(),
    dropMessages: messageTemplateArray.optional(),
    aliases: aliasesArray.optional(),
    category: itemCategory.optional(),
    enabled: z.boolean().optional(),
    forSale: z.boolean().optional(),
    saleStartsAt: z.number().int().nullable().optional(),
    saleEndsAt: z.number().int().nullable().optional(),
    order: z.number().int().optional(),
  }).strict();

  app.get<{ Params: { id: string } }>("/servers/:id/earning/items", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    const rows = await db.select().from(items).where(eq(items.serverId, g.serverId)).orderBy(asc(items.order));
    const ownerRows = await db.all<{ itemKey: string; n: number }>(sql`
      SELECT item_key AS itemKey, COUNT(*) AS n FROM identity_inventory
      WHERE server_id = ${g.serverId} AND quantity > 0 GROUP BY item_key`);
    const ownersByKey = new Map(ownerRows.map((r) => [r.itemKey, r.n]));
    const parseArr = (raw: string): string[] => { try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []; } catch { return []; } };
    return {
      items: rows.map((r) => ({
        key: r.key, name: r.name, namePlural: r.namePlural, description: r.description, iconUrl: r.iconUrl,
        price: r.price, stackLimit: r.stackLimit,
        giveMessages: parseArr(r.giveMessagesJson), throwMessages: parseArr(r.throwMessagesJson), dropMessages: parseArr(r.dropMessagesJson),
        aliases: parseArr(r.aliasesJson), category: r.category, enabled: !!r.enabled, forSale: !!r.forSale,
        saleStartsAt: r.saleStartsAt ? +r.saleStartsAt : null, saleEndsAt: r.saleEndsAt ? +r.saleEndsAt : null,
        order: r.order, isBuiltin: !!r.isBuiltin, owners: ownersByKey.get(r.key) ?? 0,
      })),
    };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/earning/items", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof itemCreateBody>;
    try { body = itemCreateBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const dup = (await db.select().from(items).where(and(eq(items.serverId, g.serverId), eq(items.key, body.key))).limit(1))[0];
    if (dup) { reply.code(409); return { error: "item key already exists" }; }
    const maxOrderRow = (await db.select({ m: sql<number>`MAX("order")` }).from(items).where(eq(items.serverId, g.serverId)))[0];
    const order = body.order ?? ((maxOrderRow?.m ?? 0) + 1);
    await db.insert(items).values({
      serverId: g.serverId, key: body.key, name: body.name, namePlural: body.namePlural ?? null,
      description: body.description ?? "", iconUrl: body.iconUrl ?? null, price: body.price ?? 0, stackLimit: body.stackLimit ?? 99,
      giveMessagesJson: JSON.stringify(body.giveMessages ?? []), throwMessagesJson: JSON.stringify(body.throwMessages ?? []),
      dropMessagesJson: JSON.stringify(body.dropMessages ?? []), aliasesJson: JSON.stringify(body.aliases ?? []),
      category: body.category ?? "misc", enabled: body.enabled ?? true, forSale: body.forSale ?? true,
      saleStartsAt: body.saleStartsAt != null ? new Date(body.saleStartsAt) : null,
      saleEndsAt: body.saleEndsAt != null ? new Date(body.saleEndsAt) : null, isBuiltin: false, order,
    });
    await audit(g.serverId, g.me.id, "server_earning_catalog_edit", { kind: "item_create", itemKey: body.key });
    return { ok: true, key: body.key };
  });

  app.patch<{ Params: { id: string; key: string }; Body: unknown }>("/servers/:id/earning/items/:key", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof itemPatchBody>;
    try { body = itemPatchBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const existing = (await db.select().from(items).where(and(eq(items.serverId, g.serverId), eq(items.key, req.params.key))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "item not found" }; }
    const update: Partial<typeof items.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) update.name = body.name;
    if (body.namePlural !== undefined) update.namePlural = body.namePlural;
    if (body.description !== undefined) update.description = body.description;
    if (body.iconUrl !== undefined) update.iconUrl = body.iconUrl;
    if (body.price !== undefined) update.price = body.price;
    if (body.stackLimit !== undefined) update.stackLimit = body.stackLimit;
    if (body.giveMessages !== undefined) update.giveMessagesJson = JSON.stringify(body.giveMessages);
    if (body.throwMessages !== undefined) update.throwMessagesJson = JSON.stringify(body.throwMessages);
    if (body.dropMessages !== undefined) update.dropMessagesJson = JSON.stringify(body.dropMessages);
    if (body.aliases !== undefined) update.aliasesJson = JSON.stringify(body.aliases);
    if (body.category !== undefined) update.category = body.category;
    if (body.enabled !== undefined) update.enabled = body.enabled;
    if (body.forSale !== undefined) update.forSale = body.forSale;
    if (body.saleStartsAt !== undefined) update.saleStartsAt = body.saleStartsAt != null ? new Date(body.saleStartsAt) : null;
    if (body.saleEndsAt !== undefined) update.saleEndsAt = body.saleEndsAt != null ? new Date(body.saleEndsAt) : null;
    if (body.order !== undefined) update.order = body.order;
    await db.update(items).set(update).where(and(eq(items.serverId, g.serverId), eq(items.key, req.params.key)));
    await audit(g.serverId, g.me.id, "server_earning_catalog_edit", { kind: "item_patch", itemKey: req.params.key });
    return { ok: true };
  });

  app.delete<{ Params: { id: string; key: string } }>("/servers/:id/earning/items/:key", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    const existing = (await db.select().from(items).where(and(eq(items.serverId, g.serverId), eq(items.key, req.params.key))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "item not found" }; }
    if (existing.isBuiltin) {
      reply.code(409);
      return { error: "built-in items cannot be deleted", message: "Disable it instead, the seed row backs anyone who owns it." };
    }
    await db.delete(items).where(and(eq(items.serverId, g.serverId), eq(items.key, req.params.key)));
    await audit(g.serverId, g.me.id, "server_earning_catalog_edit", { kind: "item_delete", itemKey: req.params.key });
    return { ok: true };
  });

  /* ---------- Room transitions (price / enabled / order only) ----------
   *  The KEY SET is FIXED by the shared ROOM_TRANSITIONS const (impls are
   *  client-side); label + description always come from the const. The
   *  per-server `room_transitions` row only carries cost / enabled / sortOrder.
   *  An unseeded transition COALESCEs to the const default (price ROOM_TRANSITION_PRICE,
   *  enabled, const order) so the editor always shows the full catalog. */

  const patchRoomTransitionBody = z.object({
    cost: z.number().int().min(0).max(1_000_000).optional(),
    enabled: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  }).strict();

  app.get<{ Params: { id: string } }>("/servers/:id/earning/room-transitions", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    const rows = await db.select().from(roomTransitions).where(eq(roomTransitions.serverId, g.serverId));
    const byKey = new Map(rows.map((r) => [r.key, r]));
    // Catalog = the const, with the per-server row merged over each entry.
    return {
      transitions: ROOM_TRANSITIONS.map((t, i) => {
        const row = byKey.get(t.key);
        return {
          key: t.key,
          label: t.label,
          description: t.description,
          cost: row?.cost ?? t.cost,
          enabled: row ? !!row.enabled : true,
          sortOrder: row?.sortOrder ?? i,
        };
      }),
    };
  });

  app.patch<{ Params: { id: string; key: string }; Body: unknown }>("/servers/:id/earning/room-transitions/:key", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    // Key must be one of the FIXED catalog keys — no creating new transitions.
    const fromConst = ROOM_TRANSITIONS.find((t) => t.key === req.params.key);
    if (!fromConst) { reply.code(404); return { error: "unknown room transition key" }; }
    let body: z.infer<typeof patchRoomTransitionBody>;
    try { body = patchRoomTransitionBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const existing = (await db.select().from(roomTransitions)
      .where(and(eq(roomTransitions.serverId, g.serverId), eq(roomTransitions.key, req.params.key))).limit(1))[0];
    const defaultOrder = ROOM_TRANSITIONS.findIndex((t) => t.key === req.params.key);
    if (existing) {
      const update: Partial<typeof roomTransitions.$inferInsert> = { updatedAt: new Date() };
      if (body.cost !== undefined) update.cost = body.cost;
      if (body.enabled !== undefined) update.enabled = body.enabled;
      if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
      await db.update(roomTransitions).set(update).where(and(eq(roomTransitions.serverId, g.serverId), eq(roomTransitions.key, req.params.key)));
    } else {
      // Lazily materialize the row from the const, applying the patch over the
      // const defaults so the unseeded "inherit" state becomes an explicit row.
      await db.insert(roomTransitions).values({
        serverId: g.serverId, key: req.params.key,
        cost: body.cost ?? fromConst.cost,
        enabled: body.enabled ?? true,
        sortOrder: body.sortOrder ?? defaultOrder,
      });
    }
    await audit(g.serverId, g.me.id, "server_earning_catalog_edit", { kind: "room_transition_patch", transitionKey: req.params.key });
    return { ok: true };
  });

  /* ---------- Flash-sale scheduler (per-server) ----------
   *  Queue a specific SKU pick for a future date on THIS server's
   *  `flash_sale_overrides` partition. The picked key is validated against
   *  THIS server's catalog so a typo can't materialize a NULL pick. Same
   *  one-pick-per-(category, date) invariant as the global scheduler, now
   *  scoped by server_id in the PK (migration 0299). */

  const flashSaleOverrideBody = z.object({
    category: z.enum(["name_style", "item", "cosmetic", "freeform_border"]),
    forDate: z.string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((s) => {
        const d = new Date(s + "T00:00:00Z");
        return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
      }, { message: "invalid calendar date" }),
    /** Catalog key, or null to REMOVE an existing queue for this slot. */
    targetKey: z.string().min(1).nullable(),
    discountPct: z.number().int().min(1).max(99).nullable().optional(),
  }).strict();

  app.get<{ Params: { id: string } }>("/servers/:id/earning/flash-sale", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    const { dateOffsetUtc } = await import("../earning/flashSale.js");
    const tomorrow = dateOffsetUtc(1);
    const resolved = await getServerSettings(db, g.serverId);
    const rows = await db.select().from(flashSaleOverrides)
      .where(and(eq(flashSaleOverrides.serverId, g.serverId), sql`${flashSaleOverrides.forDate} >= ${tomorrow}`))
      .orderBy(asc(flashSaleOverrides.forDate), asc(flashSaleOverrides.category));
    const overrides = rows.map((r) => ({ category: r.category, forDate: r.forDate, targetKey: r.targetKey, discountPct: r.discountPct }));
    return { tomorrow, flashSaleEnabled: resolved.flashSaleEnabled, overrides };
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/servers/:id/earning/flash-sale/overrides", async (req, reply) => {
    const g = await gate(req, reply); if (!g) return { error: "forbidden" };
    let body: z.infer<typeof flashSaleOverrideBody>;
    try { body = flashSaleOverrideBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const { todayUtc } = await import("../earning/flashSale.js");
    const today = todayUtc();
    if (body.forDate <= today) { reply.code(400); return { error: `forDate must be strictly after today (${today})` }; }
    if (body.targetKey === null) {
      await db.delete(flashSaleOverrides).where(and(
        eq(flashSaleOverrides.serverId, g.serverId),
        eq(flashSaleOverrides.category, body.category),
        eq(flashSaleOverrides.forDate, body.forDate),
      ));
      await audit(g.serverId, g.me.id, "server_earning_catalog_edit", { kind: "flash_sale_clear", category: body.category, forDate: body.forDate });
      return { ok: true, removed: true };
    }
    // Validate the pick against THIS server's catalog.
    const exists = body.category === "name_style"
      ? (await db.select({ k: nameStyles.key }).from(nameStyles).where(and(eq(nameStyles.serverId, g.serverId), eq(nameStyles.key, body.targetKey))).limit(1))[0]
      : body.category === "item"
        ? (await db.select({ k: items.key }).from(items).where(and(eq(items.serverId, g.serverId), eq(items.key, body.targetKey))).limit(1))[0]
        : body.category === "cosmetic"
          ? (await db.select({ k: cosmetics.key }).from(cosmetics).where(and(eq(cosmetics.serverId, g.serverId), eq(cosmetics.key, body.targetKey))).limit(1))[0]
          : (await db.select({ k: freeformBorders.key }).from(freeformBorders).where(and(eq(freeformBorders.serverId, g.serverId), eq(freeformBorders.key, body.targetKey))).limit(1))[0];
    if (!exists) { reply.code(404); return { error: `no ${body.category} with key '${body.targetKey}' on this server` }; }
    // Upsert by (server_id, category, for_date) — the per-server PK.
    await db.insert(flashSaleOverrides)
      .values({ serverId: g.serverId, category: body.category, forDate: body.forDate, targetKey: body.targetKey, discountPct: body.discountPct ?? null })
      .onConflictDoUpdate({
        target: [flashSaleOverrides.serverId, flashSaleOverrides.category, flashSaleOverrides.forDate],
        set: { targetKey: body.targetKey, discountPct: body.discountPct ?? null },
      });
    await audit(g.serverId, g.me.id, "server_earning_catalog_edit", { kind: "flash_sale_queue", category: body.category, forDate: body.forDate, targetKey: body.targetKey });
    return { ok: true };
  });
}
