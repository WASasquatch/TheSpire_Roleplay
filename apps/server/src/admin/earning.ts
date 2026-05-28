/**
 * Admin — Earning > Awards endpoints.
 *
 * Wired from inside `registerAdminRoutes` so the admin auth + role
 * gate already covers these routes (both `admin` and `masteradmin`
 * can read; the body of PUT validates per-field whether the caller
 * has the right tier to change the masteradmin-only fields:
 * `multiCharacterEarnDivisor` and `backfill.xpPerHistoricalMessage`).
 *
 * Future phases will add Ranks / Name Styles / Cosmetics admin
 * endpoints to this file. Phase 1 ships the Awards tab only.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import { nanoid } from "nanoid";
import { isMasterAdminRole, type ClientToServerEvents, type Role, type ServerToClientEvents } from "@thekeep/shared";
import { z } from "zod";
import type { Db } from "../db/index.js";
import {
  characterEarning,
  characterOwnedFreeformBorders,
  characters,
  cosmetics,
  emoticonSheets,
  identityCollection,
  identityInventory,
  items,
  nameStyles,
  rankTiers,
  ranks,
  earningLedger,
  userActiveCosmetics,
  userOwnedBorders,
  userOwnedFreeformBorders,
  userOwnedNameStyles,
  userEarning,
  users,
  freeformBorders,
  flashSaleOverrides,
  flashSales,
  siteSettings,
} from "../db/schema.js";
import { getSettings, updateSettings } from "../settings.js";
import {
  DEFAULT_EARNING_CONFIG,
  type EarningConfig,
  normalizeEarningConfig,
} from "../earning/config.js";
import { backfillAllRankPlacements, mergeMaxEverHeld, resolveRankForXp } from "../earning/resolver.js";
import { creditPool } from "../earning/award.js";
import { clearEchoCacheFor } from "../earning/messageQuality.js";
import { recordAudit } from "../audit.js";
import {
  dateOffsetUtc,
  resolveTodayFlashSale,
  todayUtc,
} from "../earning/flashSale.js";
import {
  exportCatalog,
  importCatalog,
  type EarningCatalogKind,
} from "./earningTransfer.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

const awardAmountSchema = z.object({
  xp: z.number().int().min(0).max(1_000_000),
  currency: z.number().int().min(0).max(1_000_000),
}).strict();

const sourceFlagsSchema = z.object({
  xp: z.boolean(),
  currency: z.boolean(),
}).strict();

const earningConfigSchema = z.object({
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
  presenceBlockMinutes: z.number().int().min(1).max(60),
  presenceDailyBlockCap: z.number().int().min(0).max(1000),
  enabledSources: z.object({
    message: sourceFlagsSchema,
    forum: sourceFlagsSchema,
    presence: sourceFlagsSchema,
  }).strict(),
  multiCharacterEarnDivisor: z.number().min(0).max(10),
  currencyTransfer: z.object({
    enabled: z.boolean(),
    dailySendCap: z.number().int().min(0).max(10_000_000),
    dailyReceiveCap: z.number().int().min(0).max(10_000_000),
    minSenderAccountAgeDays: z.number().int().min(0).max(3650),
    minRecipientAccountAgeDays: z.number().int().min(0).max(3650),
    minTransferAmount: z.number().int().min(0).max(10_000_000),
    maxTransferAmount: z.number().int().min(0).max(10_000_000),
  }).strict(),
  backfill: z.object({
    xpPerHistoricalMessage: z.number().min(0).max(1000),
    completedAt: z.number().nullable(),
  }).strict(),
}).strict();

interface SessionUserCtx { id: string; role: Role }

/** Body shape for new-rank creation. */
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

const patchTierBody = z.object({
  label: z.string().min(1).max(80).optional(),
  xpThreshold: z.number().int().min(0).optional(),
  sigilImageUrl: z.string().max(1024).optional(),
  borderImageUrl: z.string().max(1024).nullable().optional(),
  borderCost: z.number().int().min(0).nullable().optional(),
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

const uploadAssetBody = z.object({
  /** Base64 data URL with mime prefix, same shape the logo upload accepts. */
  dataUrl: z.string().min(8),
}).strict();

/**
 * Register the Earning admin endpoints. The caller (admin/routes.ts)
 * has already attached the admin-only preHandler gate, so handlers
 * can assume the request is from at least an `admin` tier.
 *
 * `uploadsRoot` is the absolute filesystem path the existing logo /
 * uploads pipeline writes into. Same disk volume; we use the
 * `ranks/` subdirectory for rank/tier assets.
 */
export function registerAdminEarningRoutes(
  app: FastifyInstance,
  deps: {
    db: Db;
    io: Io;
    uploadsRoot: string;
    getSessionUser: (req: FastifyRequest) => Promise<SessionUserCtx | null>;
  },
): void {
  const { db, io, uploadsRoot, getSessionUser } = deps;

  /**
   * GET /admin/earning/awards
   * Returns the current EarningConfig + the defaults so the admin
   * editor can render a "reset to defaults" affordance without a
   * separate roundtrip. Same shape both tiers can read.
   */
  app.get("/admin/earning/awards", async () => {
    const settings = await getSettings(db);
    return {
      config: settings.earningConfig,
      defaults: DEFAULT_EARNING_CONFIG,
    };
  });

  /**
   * PUT /admin/earning/awards
   *
   * Replaces the EarningConfig wholesale (the editor always submits a
   * full document). Validates against the zod schema, then walks the
   * `priorVsNew` diff to enforce the masteradmin-only field policy:
   * a plain `admin` cannot change `multiCharacterEarnDivisor` or
   * `backfill.xpPerHistoricalMessage`. Other fields are open to both
   * tiers.
   *
   * `backfill.completedAt` is preserved from the prior config — the
   * admin editor never touches it (set automatically by the backfill
   * job).
   */
  app.put<{ Body: unknown }>("/admin/earning/awards", async (req, reply) => {
    const me = await getSessionUser(req);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let next: EarningConfig;
    try {
      next = earningConfigSchema.parse(req.body) as EarningConfig;
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : "invalid body" };
    }
    const settings = await getSettings(db);
    const prior = settings.earningConfig;
    const isMaster = isMasterAdminRole(me.role);

    // Masteradmin-only field policy. Compare each gated field; if
    // changed and the caller is not masteradmin, 403 the request and
    // tell them which field tripped the gate so the form can flag it.
    const gatedChanges: string[] = [];
    if (!isMaster) {
      if (next.multiCharacterEarnDivisor !== prior.multiCharacterEarnDivisor) {
        gatedChanges.push("multiCharacterEarnDivisor");
      }
      if (next.backfill.xpPerHistoricalMessage !== prior.backfill.xpPerHistoricalMessage) {
        gatedChanges.push("backfill.xpPerHistoricalMessage");
      }
    }
    if (gatedChanges.length > 0) {
      reply.code(403);
      return { error: "master admin only", fields: gatedChanges };
    }

    // Never let the editor overwrite the backfill completedAt
    // timestamp (it's set by the backfill job itself; admin edits
    // would either re-trigger the backfill or accidentally suppress
    // it on next boot).
    const merged: EarningConfig = {
      ...next,
      backfill: {
        ...next.backfill,
        completedAt: prior.backfill.completedAt,
      },
    };

    const updated = await updateSettings(
      db,
      { earningConfig: normalizeEarningConfig(merged) },
      me.id,
    );
    return { config: updated.earningConfig };
  });

  /* =========================================================
   *  Ranks tab — rank + tier CRUD + asset upload
   * ========================================================= */

  /**
   * GET /admin/earning/ranks
   * Returns every rank + tier row (regardless of enabled flag — admins
   * see the full ladder) plus the per-rank usage counts so the UI can
   * gate destructive actions (can't delete a rank that has users on it).
   */
  app.get("/admin/earning/ranks", async () => {
    const rankRows = await db.select().from(ranks).orderBy(asc(ranks.order), asc(ranks.name));
    const tierRows = await db.select().from(rankTiers).orderBy(asc(rankTiers.rankKey), asc(rankTiers.tier));

    // Usage counts: how many user / character earning rows currently
    // sit on each rank. Drives the delete-protected UI affordance.
    const userCounts = await db.all<{ rankKey: string; n: number }>(sql`
      SELECT rank_key AS rankKey, COUNT(*) AS n FROM user_earning WHERE rank_key IS NOT NULL GROUP BY rank_key
    `);
    const charCounts = await db.all<{ rankKey: string; n: number }>(sql`
      SELECT rank_key AS rankKey, COUNT(*) AS n FROM character_earning WHERE rank_key IS NOT NULL GROUP BY rank_key
    `);
    const usageByRank = new Map<string, { users: number; characters: number }>();
    for (const r of userCounts) usageByRank.set(r.rankKey, { users: r.n, characters: 0 });
    for (const r of charCounts) {
      const cur = usageByRank.get(r.rankKey);
      if (cur) cur.characters = r.n;
      else usageByRank.set(r.rankKey, { users: 0, characters: r.n });
    }
    return {
      ranks: rankRows.map((r) => ({
        key: r.key,
        name: r.name,
        order: r.order,
        enabled: !!r.enabled,
        users: usageByRank.get(r.key)?.users ?? 0,
        characters: usageByRank.get(r.key)?.characters ?? 0,
      })),
      tiers: tierRows.map((t) => ({
        id: t.id,
        rankKey: t.rankKey,
        tier: t.tier,
        label: t.label,
        xpThreshold: t.xpThreshold,
        sigilImageUrl: t.sigilImageUrl,
        borderImageUrl: t.borderImageUrl,
        borderCost: t.borderCost,
        enabled: !!t.enabled,
      })),
    };
  });

  /**
   * POST /admin/earning/ranks
   * Create a new rank. Auto-seeds 4 default tiers ("I", "II", "III",
   * "IV: Verified") with zero thresholds + empty asset URLs so the
   * row is editable from the table immediately.
   */
  app.post<{ Body: unknown }>("/admin/earning/ranks", async (req, reply) => {
    let body: z.infer<typeof createRankBody>;
    try { body = createRankBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const existing = (await db.select().from(ranks).where(eq(ranks.key, body.key)).limit(1))[0];
    if (existing) { reply.code(409); return { error: "rank key already exists" }; }
    const maxOrderRow = (await db.select({ m: sql<number>`MAX("order")` }).from(ranks))[0];
    const order = body.order ?? ((maxOrderRow?.m ?? 0) + 1);
    await db.insert(ranks).values({
      key: body.key,
      name: body.name,
      order,
      enabled: body.enabled ?? true,
    });
    // Seed 4 default tiers so the rank is usable from the UI without
    // a follow-up call. Threshold defaults to 0 — admin sets the real
    // value via the tier-edit form.
    for (const t of [1, 2, 3, 4]) {
      await db.insert(rankTiers).values({
        id: nanoid(),
        rankKey: body.key,
        tier: t,
        label: t === 4 ? "IV: Verified" : ["I", "II", "III"][t - 1]!,
        xpThreshold: 0,
        sigilImageUrl: "",
        enabled: true,
      });
    }
    return { ok: true, key: body.key };
  });

  /**
   * PATCH /admin/earning/ranks/:key
   * Rename, reorder, or enable/disable. Per the soft-close rule
   * (plan.md), flipping `enabled = false` does NOT migrate existing
   * rank-holders; the XP resolver just skips disabled rows when
   * placing new earners.
   */
  app.patch<{ Params: { key: string }; Body: unknown }>("/admin/earning/ranks/:key", async (req, reply) => {
    let body: z.infer<typeof patchRankBody>;
    try { body = patchRankBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const existing = (await db.select().from(ranks).where(eq(ranks.key, req.params.key)).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "rank not found" }; }
    const update: Partial<typeof ranks.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) update.name = body.name;
    if (body.order !== undefined) update.order = body.order;
    if (body.enabled !== undefined) update.enabled = body.enabled;
    await db.update(ranks).set(update).where(eq(ranks.key, req.params.key));
    return { ok: true };
  });

  /**
   * DELETE /admin/earning/ranks/:key
   * Only allowed when no users / characters currently sit on this rank.
   * The user-facing message tells the admin to disable instead when the
   * rank is in use, so existing rank-holders aren't disturbed.
   */
  app.delete<{ Params: { key: string } }>("/admin/earning/ranks/:key", async (req, reply) => {
    const userCount = (await db.select({ n: sql<number>`COUNT(*)` }).from(userEarning).where(eq(userEarning.rankKey, req.params.key)))[0];
    const charCount = (await db.select({ n: sql<number>`COUNT(*)` }).from(characterEarning).where(eq(characterEarning.rankKey, req.params.key)))[0];
    if ((userCount?.n ?? 0) + (charCount?.n ?? 0) > 0) {
      reply.code(409);
      return {
        error: "rank is in use",
        message: "Disable the rank instead — existing rank-holders should not be displaced.",
      };
    }
    await db.delete(ranks).where(eq(ranks.key, req.params.key));
    return { ok: true };
  });

  /**
   * PATCH /admin/earning/rank-tiers/:id
   * Edit a single tier row. When the XP threshold changes, kicks the
   * full earning-row backfill so denormalized rankKey/tier stays in
   * sync with the new placement (no need to wait for every user to
   * post a message to see the change).
   */
  app.patch<{ Params: { id: string }; Body: unknown }>("/admin/earning/rank-tiers/:id", async (req, reply) => {
    let body: z.infer<typeof patchTierBody>;
    try { body = patchTierBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const existing = (await db.select().from(rankTiers).where(eq(rankTiers.id, req.params.id)).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "tier not found" }; }
    const update: Partial<typeof rankTiers.$inferInsert> = { updatedAt: new Date() };
    if (body.label !== undefined) update.label = body.label;
    if (body.xpThreshold !== undefined) update.xpThreshold = body.xpThreshold;
    if (body.sigilImageUrl !== undefined) update.sigilImageUrl = body.sigilImageUrl;
    if (body.borderImageUrl !== undefined) update.borderImageUrl = body.borderImageUrl;
    if (body.borderCost !== undefined) update.borderCost = body.borderCost;
    if (body.enabled !== undefined) update.enabled = body.enabled;
    await db.update(rankTiers).set(update).where(eq(rankTiers.id, req.params.id));
    // Threshold-driven backfill. Cheap at chat scale (a few thousand
    // earning rows); future scale-out can move this to a job queue.
    if (body.xpThreshold !== undefined || body.enabled !== undefined) {
      await backfillAllRankPlacements(db);
    }
    return { ok: true };
  });

  /**
   * POST /admin/earning/ranks/:key/tiers
   * Add a tier to an existing rank. Used when an admin wants to extend
   * a rank past the 4 default tiers, or when a custom rank needs a
   * fresh tier added.
   */
  app.post<{ Params: { key: string }; Body: unknown }>("/admin/earning/ranks/:key/tiers", async (req, reply) => {
    let body: z.infer<typeof createTierBody>;
    try { body = createTierBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const rank = (await db.select().from(ranks).where(eq(ranks.key, req.params.key)).limit(1))[0];
    if (!rank) { reply.code(404); return { error: "rank not found" }; }
    const dup = (await db.select().from(rankTiers).where(and(eq(rankTiers.rankKey, req.params.key), eq(rankTiers.tier, body.tier))).limit(1))[0];
    if (dup) { reply.code(409); return { error: "tier already exists for this rank" }; }
    const id = nanoid();
    await db.insert(rankTiers).values({
      id,
      rankKey: req.params.key,
      tier: body.tier,
      label: body.label,
      xpThreshold: body.xpThreshold,
      sigilImageUrl: body.sigilImageUrl ?? "",
      borderImageUrl: body.borderImageUrl ?? null,
      borderCost: body.borderCost ?? null,
      enabled: body.enabled ?? true,
    });
    await backfillAllRankPlacements(db);
    return { ok: true, id };
  });

  /**
   * DELETE /admin/earning/rank-tiers/:id
   * Only allowed when no users / characters currently sit on this tier.
   */
  app.delete<{ Params: { id: string } }>("/admin/earning/rank-tiers/:id", async (req, reply) => {
    const existing = (await db.select().from(rankTiers).where(eq(rankTiers.id, req.params.id)).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "tier not found" }; }
    const userCount = (await db.select({ n: sql<number>`COUNT(*)` })
      .from(userEarning)
      .where(and(eq(userEarning.rankKey, existing.rankKey), eq(userEarning.tier, existing.tier))))[0];
    const charCount = (await db.select({ n: sql<number>`COUNT(*)` })
      .from(characterEarning)
      .where(and(eq(characterEarning.rankKey, existing.rankKey), eq(characterEarning.tier, existing.tier))))[0];
    if ((userCount?.n ?? 0) + (charCount?.n ?? 0) > 0) {
      reply.code(409);
      return {
        error: "tier is in use",
        message: "Disable the tier or change the threshold so users move out before deleting.",
      };
    }
    await db.delete(rankTiers).where(eq(rankTiers.id, req.params.id));
    await backfillAllRankPlacements(db);
    return { ok: true };
  });

  /**
   * POST /admin/earning/assets/upload
   * Accepts a base64 data URL (same shape as /admin/upload/logo),
   * writes the image to `apps/server/uploads/ranks/<contenthash>.png`,
   * and returns the public URL the caller wires into a sigil/border
   * field via PATCH /admin/earning/rank-tiers/:id.
   */
  app.post<{ Body: unknown }>("/admin/earning/assets/upload", async (req, reply) => {
    let body: z.infer<typeof uploadAssetBody>;
    try { body = uploadAssetBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(body.dataUrl.trim());
    if (!m) { reply.code(400); return { error: "expected a base64 data URL" }; }
    let bytes: Buffer;
    try { bytes = Buffer.from(m[2]!, "base64"); }
    catch { reply.code(400); return { error: "invalid base64 payload" }; }

    // PNG-only for ranks: the bundled assets are PNG with transparency,
    // and the renderer overlays them via absolute positioning so a JPEG
    // background would look wrong sitting over a different bg color.
    // Accept PNG via magic byte sniff.
    const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    let isPng = true;
    for (let i = 0; i < PNG_MAGIC.length; i++) {
      if (bytes[i] !== PNG_MAGIC[i]) { isPng = false; break; }
    }
    if (!isPng) {
      reply.code(415);
      return { error: "rank assets must be PNG (transparency is load-bearing for sigil overlays)" };
    }
    // Hard size cap so a runaway upload can't fill the disk. 1 MB is
    // generous for a sigil PNG; admin can always resize before upload.
    if (bytes.length > 1_000_000) {
      reply.code(413);
      return { error: "rank assets capped at 1 MB" };
    }

    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const filename = `${hash}.png`;
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = join(uploadsRoot, "ranks");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), bytes);
    return { ok: true, url: `/uploads/ranks/${filename}` };
  });

  /* =========================================================
   *  Name Styles tab — CRUD on the template catalog
   *
   *  Templates are HTML + CSS only (per the no-JS decision in
   *  plan.md). Server stores them verbatim; the client renders the
   *  HTML into the chat / userlist surfaces and scopes the CSS via
   *  a unique wrapper class per style key. Built-in styles
   *  (`isBuiltin = 1`) are protected from delete but fully
   *  editable — admins can rewrite the seeded templates as long as
   *  they want; we just don't let them remove the catalog row a
   *  user might still have equipped.
   * ========================================================= */

  // CSS cap is generous (64KB) because animated styles can require
  // many keyframe blocks, per-letter timing offsets, and theme-scoped
  // overrides. Template stays modest — it's HTML scaffolding, not CSS.
  const styleBody = z.object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    template: z.string().min(1).max(4000).optional(),
    styleCss: z.string().max(64000).optional(),
    cost: z.number().int().min(0).max(1_000_000).optional(),
    enabled: z.boolean().optional(),
    order: z.number().int().optional(),
  }).strict();

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

  /**
   * GET /admin/earning/name-styles
   * Returns every style row regardless of enabled flag plus the
   * per-style owned + equipped counts so the editor can warn before
   * a destructive change (delete / disable).
   */
  app.get("/admin/earning/name-styles", async () => {
    const rows = await db.select().from(nameStyles).orderBy(asc(nameStyles.order));
    const ownerRows = await db.all<{ styleKey: string; n: number }>(sql`
      SELECT style_key AS styleKey, COUNT(*) AS n FROM user_owned_name_styles GROUP BY style_key
    `);
    const equippedRows = await db.all<{ activeNameStyleKey: string | null; n: number }>(sql`
      SELECT active_name_style_key AS activeNameStyleKey, COUNT(*) AS n FROM user_active_cosmetics
      WHERE active_name_style_key IS NOT NULL GROUP BY active_name_style_key
    `);
    const ownedByKey = new Map(ownerRows.map((r) => [r.styleKey, r.n]));
    const equippedByKey = new Map(
      equippedRows
        .filter((r): r is { activeNameStyleKey: string; n: number } => r.activeNameStyleKey !== null)
        .map((r) => [r.activeNameStyleKey, r.n]),
    );
    return {
      styles: rows.map((r) => ({
        key: r.key,
        name: r.name,
        description: r.description,
        template: r.template,
        styleCss: r.styleCss,
        cost: r.cost,
        enabled: !!r.enabled,
        isBuiltin: !!r.isBuiltin,
        order: r.order,
        owners: ownedByKey.get(r.key) ?? 0,
        equipped: equippedByKey.get(r.key) ?? 0,
      })),
    };
  });

  app.post<{ Body: unknown }>("/admin/earning/name-styles", async (req, reply) => {
    let body: z.infer<typeof createStyleBody>;
    try { body = createStyleBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const dup = (await db.select().from(nameStyles).where(eq(nameStyles.key, body.key)).limit(1))[0];
    if (dup) { reply.code(409); return { error: "style key already exists" }; }
    // Order defaults to "after the current max" so new rows render at
    // the bottom of the editor list and the buy list. Admin can
    // reorder via the order field.
    const maxOrderRow = (await db.select({ m: sql<number>`MAX("order")` }).from(nameStyles))[0];
    const order = body.order ?? ((maxOrderRow?.m ?? 0) + 1);
    await db.insert(nameStyles).values({
      key: body.key,
      name: body.name,
      description: body.description ?? "",
      template: body.template,
      styleCss: body.styleCss ?? "",
      cost: body.cost ?? 0,
      enabled: body.enabled ?? true,
      isBuiltin: false,
      order,
    });
    return { ok: true, key: body.key };
  });

  app.patch<{ Params: { key: string }; Body: unknown }>(
    "/admin/earning/name-styles/:key",
    async (req, reply) => {
      let body: z.infer<typeof styleBody>;
      try { body = styleBody.parse(req.body); }
      catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
      const existing = (await db.select().from(nameStyles).where(eq(nameStyles.key, req.params.key)).limit(1))[0];
      if (!existing) { reply.code(404); return { error: "style not found" }; }
      const update: Partial<typeof nameStyles.$inferInsert> = { updatedAt: new Date() };
      if (body.name !== undefined) update.name = body.name;
      if (body.description !== undefined) update.description = body.description;
      if (body.template !== undefined) update.template = body.template;
      if (body.styleCss !== undefined) update.styleCss = body.styleCss;
      if (body.cost !== undefined) update.cost = body.cost;
      if (body.enabled !== undefined) update.enabled = body.enabled;
      if (body.order !== undefined) update.order = body.order;
      await db.update(nameStyles).set(update).where(eq(nameStyles.key, req.params.key));
      return { ok: true };
    },
  );

  /**
   * DELETE /admin/earning/name-styles/:key
   *
   * Soft policy:
   *   - Built-in styles cannot be deleted (the seed row exists so
   *     admins can rewrite the template; removing it would orphan
   *     anyone who owns it).
   *   - Custom styles can be deleted; the FK on user_owned_name_styles
   *     + user_active_cosmetics cascades the ownership row and clears
   *     the active key. We surface the affected-user count for the
   *     confirmation prompt.
   */
  app.delete<{ Params: { key: string } }>("/admin/earning/name-styles/:key", async (req, reply) => {
    const existing = (await db.select().from(nameStyles).where(eq(nameStyles.key, req.params.key)).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "style not found" }; }
    if (existing.isBuiltin) {
      reply.code(409);
      return { error: "built-in styles cannot be deleted", message: "Disable it instead — the seed row backs anyone who owns it." };
    }
    await db.delete(nameStyles).where(eq(nameStyles.key, req.params.key));
    return { ok: true };
  });

  /* =========================================================
   *  Free-form borders — full CRUD on the parallel `freeform_borders`
   *  catalog introduced in migration 0149. Two render paths share one
   *  table; the body validators enforce the XOR (either `imageUrl` OR
   *  `template`+`styleCss`, never both, never neither) so the
   *  BorderedAvatar renderer always has exactly one path to take.
   *
   *  Rarity is an OPEN string by design — admins introduce new tiers
   *  without a schema migration; the client falls back to the
   *  'common' palette for unknown values, so a brand-new rarity that
   *  ships before the BordersTab knows about it still renders sanely.
   * ========================================================= */

  /** Shared validation: each row must travel either the image path
   *  OR the template path, never both. Server enforces here so the
   *  rest of the codebase (renderer, /earning/me, BordersTab) can
   *  trust the catalog invariant. */
  function validateFreeformBorderShape(opts: {
    imageUrl?: string | null;
    template?: string | null;
    styleCss?: string | null;
  }): string | null {
    const hasImage = !!opts.imageUrl;
    const hasTemplate = !!opts.template;
    if (hasImage && hasTemplate) {
      return "border must ship in EITHER image-url mode OR template mode, not both";
    }
    if (!hasImage && !hasTemplate) {
      return "border must ship with EITHER image-url OR template + style-css";
    }
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

  app.get("/admin/earning/freeform-borders", async () => {
    const rows = await db.select().from(freeformBorders).orderBy(asc(freeformBorders.order));
    // Owner / equipped counts for the destructive-action confirmation
    // prompts. Mirrors the name-style endpoint shape — admins lean on
    // this to know whether disabling a row will yank cosmetics from
    // live users.
    const userOwnerRows = await db.all<{ borderKey: string; n: number }>(sql`
      SELECT border_key AS borderKey, COUNT(*) AS n FROM user_owned_freeform_borders GROUP BY border_key
    `);
    const charOwnerRows = await db.all<{ borderKey: string; n: number }>(sql`
      SELECT border_key AS borderKey, COUNT(*) AS n FROM character_owned_freeform_borders GROUP BY border_key
    `);
    const userEquippedRows = await db.all<{ borderKey: string | null; n: number }>(sql`
      SELECT selected_freeform_border_key AS borderKey, COUNT(*) AS n FROM user_earning
      WHERE selected_freeform_border_key IS NOT NULL GROUP BY selected_freeform_border_key
    `);
    const charEquippedRows = await db.all<{ borderKey: string | null; n: number }>(sql`
      SELECT selected_freeform_border_key AS borderKey, COUNT(*) AS n FROM character_earning
      WHERE selected_freeform_border_key IS NOT NULL GROUP BY selected_freeform_border_key
    `);
    const ownersByKey = new Map<string, number>();
    for (const r of userOwnerRows) ownersByKey.set(r.borderKey, (ownersByKey.get(r.borderKey) ?? 0) + r.n);
    for (const r of charOwnerRows) ownersByKey.set(r.borderKey, (ownersByKey.get(r.borderKey) ?? 0) + r.n);
    const equippedByKey = new Map<string, number>();
    for (const r of userEquippedRows) {
      if (r.borderKey) equippedByKey.set(r.borderKey, (equippedByKey.get(r.borderKey) ?? 0) + r.n);
    }
    for (const r of charEquippedRows) {
      if (r.borderKey) equippedByKey.set(r.borderKey, (equippedByKey.get(r.borderKey) ?? 0) + r.n);
    }
    return {
      borders: rows.map((r) => ({
        key: r.key,
        name: r.name,
        description: r.description,
        imageUrl: r.imageUrl,
        template: r.template,
        styleCss: r.styleCss,
        rarity: r.rarity,
        cost: r.cost,
        enabled: !!r.enabled,
        isBuiltin: !!r.isBuiltin,
        order: r.order,
        owners: ownersByKey.get(r.key) ?? 0,
        equipped: equippedByKey.get(r.key) ?? 0,
      })),
    };
  });

  app.post<{ Body: unknown }>("/admin/earning/freeform-borders", async (req, reply) => {
    let body: z.infer<typeof createFreeformBorderBody>;
    try { body = createFreeformBorderBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const shapeError = validateFreeformBorderShape({
      imageUrl: body.imageUrl ?? null,
      template: body.template ?? null,
      styleCss: body.styleCss ?? null,
    });
    if (shapeError) { reply.code(400); return { error: shapeError }; }
    const dup = (await db.select().from(freeformBorders).where(eq(freeformBorders.key, body.key)).limit(1))[0];
    if (dup) { reply.code(409); return { error: "border key already exists" }; }
    const maxOrderRow = (await db.select({ m: sql<number>`MAX("order")` }).from(freeformBorders))[0];
    const order = body.order ?? ((maxOrderRow?.m ?? 0) + 1);
    await db.insert(freeformBorders).values({
      key: body.key,
      name: body.name,
      description: body.description ?? "",
      imageUrl: body.imageUrl ?? null,
      template: body.template ?? null,
      styleCss: body.styleCss ?? null,
      rarity: body.rarity ?? "common",
      cost: body.cost ?? 0,
      enabled: body.enabled ?? true,
      isBuiltin: false,
      order,
    });
    return { ok: true, key: body.key };
  });

  app.patch<{ Params: { key: string }; Body: unknown }>(
    "/admin/earning/freeform-borders/:key",
    async (req, reply) => {
      let body: z.infer<typeof patchFreeformBorderBody>;
      try { body = patchFreeformBorderBody.parse(req.body); }
      catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
      const existing = (await db.select().from(freeformBorders).where(eq(freeformBorders.key, req.params.key)).limit(1))[0];
      if (!existing) { reply.code(404); return { error: "border not found" }; }
      // Re-validate the XOR against the resolved post-patch shape so
      // a partial PATCH can't break the invariant by clearing the
      // wrong field. Pull the post-patch value for each path: body
      // value when present, existing row's value otherwise.
      const resolvedImage = body.imageUrl === undefined ? existing.imageUrl : body.imageUrl;
      const resolvedTemplate = body.template === undefined ? existing.template : body.template;
      const resolvedStyleCss = body.styleCss === undefined ? existing.styleCss : body.styleCss;
      const shapeError = validateFreeformBorderShape({
        imageUrl: resolvedImage,
        template: resolvedTemplate,
        styleCss: resolvedStyleCss,
      });
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
      await db.update(freeformBorders).set(update).where(eq(freeformBorders.key, req.params.key));
      return { ok: true };
    },
  );

  /**
   * DELETE /admin/earning/freeform-borders/:key
   *
   * Built-in rows protected, mirroring the name-style policy. Custom
   * rows can be deleted; FK cascades clear ownership rows and the
   * SET NULL on the equip slots clears the active equip on every
   * affected identity (migration 0149).
   */
  app.delete<{ Params: { key: string } }>(
    "/admin/earning/freeform-borders/:key",
    async (req, reply) => {
      const existing = (await db.select().from(freeformBorders).where(eq(freeformBorders.key, req.params.key)).limit(1))[0];
      if (!existing) { reply.code(404); return { error: "border not found" }; }
      if (existing.isBuiltin) {
        reply.code(409);
        return {
          error: "built-in borders cannot be deleted",
          message: "Disable it instead — the seed row backs anyone who owns it.",
        };
      }
      // Ownership rows cascade via ON DELETE CASCADE on
      // user/character_owned_freeform_borders; equip slots clear via
      // ON DELETE SET NULL (migration 0149). No manual cleanup
      // needed.
      await db.delete(freeformBorders).where(eq(freeformBorders.key, req.params.key));
      return { ok: true };
    },
  );

  /* =========================================================
   *  Cosmetics tab — minimal CRUD for the inline_avatar row
   *  (the only buyable cosmetic that ships in Phase 4). Rank
   *  border prices live on rank_tiers.borderCost via the Ranks
   *  tab; this endpoint covers everything else in the
   *  `cosmetics` table.
   *
   *  Future cosmetics rows (animated avatar frames, audio cues,
   *  etc.) flow through the same pair of endpoints — the seed
   *  row stays as a single source of truth and admins toggle
   *  `enabled` to launch / retract.
   * ========================================================= */

  const patchCosmeticBody = z.object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    cost: z.number().int().min(0).max(1_000_000).optional(),
    enabled: z.boolean().optional(),
    configJson: z.string().max(4000).nullable().optional(),
  }).strict();

  app.get("/admin/earning/cosmetics", async () => {
    const rows = await db.select().from(cosmetics);
    return {
      cosmetics: rows.map((r) => ({
        key: r.key,
        name: r.name,
        description: r.description,
        cost: r.cost,
        enabled: !!r.enabled,
        configJson: r.configJson,
      })),
    };
  });

  app.patch<{ Params: { key: string }; Body: unknown }>(
    "/admin/earning/cosmetics/:key",
    async (req, reply) => {
      let body: z.infer<typeof patchCosmeticBody>;
      try { body = patchCosmeticBody.parse(req.body); }
      catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
      const existing = (await db.select().from(cosmetics).where(eq(cosmetics.key, req.params.key)).limit(1))[0];
      if (!existing) { reply.code(404); return { error: "cosmetic not found" }; }
      const update: Partial<typeof cosmetics.$inferInsert> = { updatedAt: new Date() };
      if (body.name !== undefined) update.name = body.name;
      if (body.description !== undefined) update.description = body.description;
      if (body.cost !== undefined) update.cost = body.cost;
      if (body.enabled !== undefined) update.enabled = body.enabled;
      if (body.configJson !== undefined) update.configJson = body.configJson;
      await db.update(cosmetics).set(update).where(eq(cosmetics.key, req.params.key));
      return { ok: true };
    },
  );

  /* =========================================================
   *  Items tab — full CRUD on the catalog + sale-window scheduler.
   *
   *  Built-in seed rows (migration 0094) carry isBuiltin=1 and are
   *  protected from DELETE; every other field on them is editable so
   *  admins can rewrite seeded names, descriptions, messages, prices
   *  freely. New items created via POST default isBuiltin=0 and are
   *  fully deletable.
   *
   *  Sale window semantics:
   *    enabled        — master existence; 0 hides everywhere and
   *                     rejects commands, but inventory rows persist
   *    forSale        — independent of enabled; gates shop only
   *    saleStartsAt   — optional lower bound (unix ms); null = unbound
   *    saleEndsAt     — optional upper bound (unix ms); null = unbound
   *  Server derives `purchasable = enabled && forSale && now ∈ window`
   *  in the /earning/me payload so the client doesn't reimplement it.
   *
   *  Per-command message arrays (give / throw / drop) are validated as
   *  JSON arrays of strings. Empty array = command disabled for that
   *  item.
   * ========================================================= */

  /** JSON-array-of-strings — the server stores the stringified JSON so
   *  the same column can be read back, but admins POST/PATCH a real
   *  array and we validate + stringify on the server side. */
  const messageTemplateArray = z.array(z.string().min(1).max(800)).max(50);

  /** Aliases array — each entry capped at 40 chars (long enough for
   *  multi-word natural-language synonyms like "gold piece"), 30
   *  total max so an admin can't pad a row with hundreds of names
   *  and balloon the json_each cost on lookup. */
  const aliasesArray = z.array(z.string().min(1).max(40)).max(30);

  /** Item category enum. Mirrors the seed-time set documented in
   *  migration 0103. Adding a new category here is a code change
   *  shared by client + server + migration; intentional friction so
   *  category drift stays bounded. */
  const itemCategory = z.enum([
    "food", "drink", "joke", "tool", "weapon", "armor",
    "magic", "treasure", "building", "gift", "pet", "misc",
  ]);

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

  /**
   * GET /admin/earning/items
   * Returns every item row regardless of enabled / forSale, plus the
   * per-item owner count (distinct identities holding ≥1 of the item)
   * so the editor can warn before a destructive change.
   */
  app.get("/admin/earning/items", async () => {
    const rows = await db.select().from(items).orderBy(asc(items.order));
    const ownerRows = await db.all<{ itemKey: string; n: number }>(sql`
      SELECT item_key AS itemKey, COUNT(*) AS n
      FROM identity_inventory
      WHERE quantity > 0
      GROUP BY item_key
    `);
    const ownersByKey = new Map(ownerRows.map((r) => [r.itemKey, r.n]));
    return {
      items: rows.map((r) => ({
        key: r.key,
        name: r.name,
        namePlural: r.namePlural,
        description: r.description,
        iconUrl: r.iconUrl,
        price: r.price,
        stackLimit: r.stackLimit,
        giveMessages: (() => {
          try { const v = JSON.parse(r.giveMessagesJson); return Array.isArray(v) ? v : []; } catch { return []; }
        })(),
        throwMessages: (() => {
          try { const v = JSON.parse(r.throwMessagesJson); return Array.isArray(v) ? v : []; } catch { return []; }
        })(),
        dropMessages: (() => {
          try { const v = JSON.parse(r.dropMessagesJson); return Array.isArray(v) ? v : []; } catch { return []; }
        })(),
        aliases: (() => {
          try { const v = JSON.parse(r.aliasesJson); return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []; } catch { return []; }
        })(),
        category: r.category,
        enabled: !!r.enabled,
        forSale: !!r.forSale,
        saleStartsAt: r.saleStartsAt ? +r.saleStartsAt : null,
        saleEndsAt: r.saleEndsAt ? +r.saleEndsAt : null,
        order: r.order,
        isBuiltin: !!r.isBuiltin,
        owners: ownersByKey.get(r.key) ?? 0,
      })),
    };
  });

  app.post<{ Body: unknown }>("/admin/earning/items", async (req, reply) => {
    let body: z.infer<typeof itemCreateBody>;
    try { body = itemCreateBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const dup = (await db.select().from(items).where(eq(items.key, body.key)).limit(1))[0];
    if (dup) { reply.code(409); return { error: "item key already exists" }; }
    // Default the order to "after the current max" so new rows render
    // at the bottom of the editor list and the shop. Admin can reorder.
    const maxOrderRow = (await db.select({ m: sql<number>`MAX("order")` }).from(items))[0];
    const order = body.order ?? ((maxOrderRow?.m ?? 0) + 1);
    await db.insert(items).values({
      key: body.key,
      name: body.name,
      namePlural: body.namePlural ?? null,
      description: body.description ?? "",
      iconUrl: body.iconUrl ?? null,
      price: body.price ?? 0,
      stackLimit: body.stackLimit ?? 99,
      giveMessagesJson: JSON.stringify(body.giveMessages ?? []),
      throwMessagesJson: JSON.stringify(body.throwMessages ?? []),
      dropMessagesJson: JSON.stringify(body.dropMessages ?? []),
      aliasesJson: JSON.stringify(body.aliases ?? []),
      category: body.category ?? "misc",
      enabled: body.enabled ?? true,
      forSale: body.forSale ?? true,
      saleStartsAt: body.saleStartsAt != null ? new Date(body.saleStartsAt) : null,
      saleEndsAt: body.saleEndsAt != null ? new Date(body.saleEndsAt) : null,
      isBuiltin: false,
      order,
    });
    return { ok: true, key: body.key };
  });

  app.patch<{ Params: { key: string }; Body: unknown }>(
    "/admin/earning/items/:key",
    async (req, reply) => {
      let body: z.infer<typeof itemPatchBody>;
      try { body = itemPatchBody.parse(req.body); }
      catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
      const existing = (await db.select().from(items).where(eq(items.key, req.params.key)).limit(1))[0];
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
      if (body.saleStartsAt !== undefined) {
        update.saleStartsAt = body.saleStartsAt != null ? new Date(body.saleStartsAt) : null;
      }
      if (body.saleEndsAt !== undefined) {
        update.saleEndsAt = body.saleEndsAt != null ? new Date(body.saleEndsAt) : null;
      }
      if (body.order !== undefined) update.order = body.order;
      await db.update(items).set(update).where(eq(items.key, req.params.key));
      return { ok: true };
    },
  );

  /**
   * DELETE /admin/earning/items/:key
   * Built-in items are delete-protected — admins should disable
   * (enabled=0) or pull from sale (forSale=0) instead. Deleting a
   * custom item cascades the FK on identity_inventory so all
   * outstanding inventory rows for it are dropped. The admin UI
   * surfaces the owner count for the confirm prompt.
   */
  app.delete<{ Params: { key: string } }>("/admin/earning/items/:key", async (req, reply) => {
    const existing = (await db.select().from(items).where(eq(items.key, req.params.key)).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "item not found" }; }
    if (existing.isBuiltin) {
      reply.code(409);
      return {
        error: "built-in items cannot be deleted",
        message: "Disable it instead — the seed row backs anyone who owns it.",
      };
    }
    await db.delete(items).where(eq(items.key, req.params.key));
    return { ok: true };
  });

  /* =========================================================
   *  Test grants — masteradmin-only direct grants for testing.
   *
   *  These bypass the normal earn / purchase paths so admins
   *  can see how a sigil / border / styled name looks without
   *  grinding XP or buying with Currency. Every grant writes
   *  through the ledger so the audit row is preserved.
   *
   *  Target is resolved by username (master account) — the
   *  caller doesn't need to look up an internal id.
   *
   *  All endpoints require masteradmin (mirrors plan.md's
   *  "manual XP / Currency grants and rank-tier overrides
   *  for masteradmin only").
   * ========================================================= */

  async function resolveTargetUser(username: string) {
    const trimmed = username.trim();
    if (!trimmed) return null;
    return (await db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = ${trimmed.toLowerCase()}`)
      .limit(1))[0] ?? null;
  }

  function masterAdminGate(req: FastifyRequest, reply: FastifyReply): SessionUserCtx | null {
    const me = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser;
    if (!me || !isMasterAdminRole(me.role)) {
      reply.code(403);
      reply.send({ error: "master admin only" });
      return null;
    }
    return me;
  }

  const grantXpBody = z.object({
    username: z.string().min(1).max(80),
    amount: z.number().int(),
  }).strict();

  const grantCurrencyBody = z.object({
    username: z.string().min(1).max(80),
    amount: z.number().int(),
  }).strict();

  const setRankBody = z.object({
    username: z.string().min(1).max(80),
    /** Pass null to clear the override and let XP drive rank. */
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

  /** Free-form border grant/revoke (Phase 1 catalog). Same shape as
   *  the rank-tier border grant but `characterId` adds per-identity
   *  routing — master pool grants to user_owned_freeform_borders;
   *  character grants to character_owned_freeform_borders. */
  const grantFreeformBorderBody = z.object({
    username: z.string().min(1).max(80),
    borderKey: z.string().min(1).max(64),
    /** Per-identity scope. Null/omitted = master/OOC pool;
     *  character id = that character's ownership ledger. */
    characterId: z.string().nullable().optional(),
  }).strict();

  const grantItemBody = z.object({
    username: z.string().min(1).max(80),
    /** Optional character scope. Omit / null deposits into the OOC
     *  master's inventory; otherwise the character must belong to
     *  the target user (NOT the admin). Server validates ownership
     *  before granting. */
    characterId: z.string().min(1).max(80).nullable().optional(),
    itemKey: z.string().min(1).max(64),
    /** Negative quantities are allowed — revoking from an inventory
     *  shares the same endpoint. Clamped to 999 in either direction
     *  so a slip of the keyboard can't wipe a huge stack. */
    quantity: z.number().int().min(-999).max(999).refine((n) => n !== 0, {
      message: "quantity must be non-zero",
    }),
  }).strict();

  /**
   * POST /admin/earning/grant-xp
   * Direct XP credit (positive or negative) to the user's master
   * pool. Recomputes rank/tier via the resolver + persists the new
   * peak. Fires the earning:earned socket event so the recipient's
   * dashboard wallet updates live.
   */
  app.post<{ Body: unknown }>("/admin/earning/grant-xp", async (req, reply) => {
    const me = masterAdminGate(req, reply); if (!me) return;
    let body: z.infer<typeof grantXpBody>;
    try { body = grantXpBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "user not found" }; }
    await creditPool(db, io, {
      scope: "user",
      ownerId: target.id,
      xpDelta: body.amount,
      currencyDelta: 0,
      reason: body.amount >= 0 ? "admin_grant" : "admin_revoke",
      metadata: { kind: "xp", actor: me.id, amount: body.amount },
      notifyUserId: target.id,
    });
    return { ok: true };
  });

  app.post<{ Body: unknown }>("/admin/earning/grant-currency", async (req, reply) => {
    const me = masterAdminGate(req, reply); if (!me) return;
    let body: z.infer<typeof grantCurrencyBody>;
    try { body = grantCurrencyBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "user not found" }; }
    await creditPool(db, io, {
      scope: "user",
      ownerId: target.id,
      xpDelta: 0,
      currencyDelta: body.amount,
      reason: body.amount >= 0 ? "admin_grant" : "admin_revoke",
      metadata: { kind: "currency", actor: me.id, amount: body.amount },
      notifyUserId: target.id,
    });
    return { ok: true };
  });

  /**
   * POST /admin/earning/set-rank
   * Direct rank/tier override. Sets the user's master-pool
   * rankKey + tier AND bumps `maxRankKeyEverHeld` / `maxTierEverHeld`
   * (only ever up — the merge helper is monotonic). Also sets XP
   * to that tier's threshold so the resolver stays consistent on
   * the next earn.
   *
   * Pass rankKey=null + tier=null to clear the override and let
   * XP drive again (XP is left untouched — admin can use grant-xp
   * to re-tune).
   */
  app.post<{ Body: unknown }>("/admin/earning/set-rank", async (req, reply) => {
    const me = masterAdminGate(req, reply); if (!me) return;
    let body: z.infer<typeof setRankBody>;
    try { body = setRankBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "user not found" }; }

    // Lazy-create the earning row before write.
    await db.insert(userEarning).values({ userId: target.id }).onConflictDoNothing();

    if (body.rankKey === null || body.tier === null) {
      // Clear path: reset to the XP-driven placement.
      const cur = (await db
        .select()
        .from(userEarning)
        .where(eq(userEarning.userId, target.id))
        .limit(1))[0];
      const placed = await resolveRankForXp(db, cur?.xp ?? 0);
      await db.update(userEarning).set({
        rankKey: placed.rankKey,
        tier: placed.tier,
        updatedAt: new Date(),
      }).where(eq(userEarning.userId, target.id));
      return { ok: true, cleared: true };
    }

    // Set path: validate the (rank, tier) tuple exists.
    const tierRow = (await db
      .select()
      .from(rankTiers)
      .where(and(eq(rankTiers.rankKey, body.rankKey), eq(rankTiers.tier, body.tier)))
      .limit(1))[0];
    if (!tierRow) { reply.code(404); return { error: "rank/tier not found" }; }

    const prior = (await db
      .select()
      .from(userEarning)
      .where(eq(userEarning.userId, target.id))
      .limit(1))[0];
    const peak = await mergeMaxEverHeld(db, {
      maxRankKeyEverHeld: prior?.maxRankKeyEverHeld ?? null,
      maxTierEverHeld: prior?.maxTierEverHeld ?? null,
    }, { rankKey: body.rankKey, tier: body.tier });
    // Set XP to the threshold so the next earn doesn't immediately
    // drop the user back. We don't decrease XP if it's already above
    // the threshold — that would feel punitive even on a test grant.
    const newXp = Math.max(prior?.xp ?? 0, tierRow.xpThreshold);
    await db.update(userEarning).set({
      xp: newXp,
      rankKey: body.rankKey,
      tier: body.tier,
      maxRankKeyEverHeld: peak.maxRankKeyEverHeld,
      maxTierEverHeld: peak.maxTierEverHeld,
      updatedAt: new Date(),
    }).where(eq(userEarning.userId, target.id));

    // Audit row through the ledger so the timeline shows the grant.
    // Direct insert — we're using a small ledger entry without going
    // through creditPool because there's no XP/Currency delta; this
    // is purely a rank-override audit row.
    await db.insert(earningLedger).values({
      id: nanoid(),
      scope: "user",
      ownerId: target.id,
      xpDelta: 0,
      currencyDelta: 0,
      reason: "admin_rank_assign",
      metadataJson: JSON.stringify({
        actor: me.id,
        rankKey: body.rankKey,
        tier: body.tier,
        priorRankKey: prior?.rankKey ?? null,
        priorTier: prior?.tier ?? null,
      }),
    });

    return { ok: true };
  });

  /**
   * POST /admin/earning/grant-border
   * Insert ownership for any rank's border on the target user,
   * bypassing the normal Tier IV eligibility gate. Lets admins
   * see what each border looks like without crossing every rank.
   * Idempotent — re-granting an owned border is a no-op.
   */
  app.post<{ Body: unknown }>("/admin/earning/grant-border", async (req, reply) => {
    const me = masterAdminGate(req, reply); if (!me) return;
    let body: z.infer<typeof grantBorderBody>;
    try { body = grantBorderBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "user not found" }; }
    const rank = (await db.select().from(ranks).where(eq(ranks.key, body.rankKey)).limit(1))[0];
    if (!rank) { reply.code(404); return { error: "rank not found" }; }
    await db.insert(userOwnedBorders).values({
      userId: target.id,
      rankKey: body.rankKey,
    }).onConflictDoNothing();
    await db.insert(earningLedger).values({
      id: nanoid(),
      scope: "user",
      ownerId: target.id,
      xpDelta: 0,
      currencyDelta: 0,
      reason: "admin_grant",
      metadataJson: JSON.stringify({
        actor: me.id,
        kind: "border",
        rankKey: body.rankKey,
      }),
    });
    return { ok: true };
  });

  /**
   * POST /admin/earning/grant-style
   * Insert ownership for a name style on the target user,
   * bypassing the normal Currency purchase. Idempotent.
   */
  app.post<{ Body: unknown }>("/admin/earning/grant-style", async (req, reply) => {
    const me = masterAdminGate(req, reply); if (!me) return;
    let body: z.infer<typeof grantStyleBody>;
    try { body = grantStyleBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "user not found" }; }
    const style = (await db.select().from(nameStyles).where(eq(nameStyles.key, body.styleKey)).limit(1))[0];
    if (!style) { reply.code(404); return { error: "style not found" }; }
    await db.insert(userOwnedNameStyles).values({
      userId: target.id,
      styleKey: body.styleKey,
      configJson: null,
    }).onConflictDoNothing();
    await db.insert(earningLedger).values({
      id: nanoid(),
      scope: "user",
      ownerId: target.id,
      xpDelta: 0,
      currencyDelta: 0,
      reason: "admin_grant",
      metadataJson: JSON.stringify({
        actor: me.id,
        kind: "name_style",
        styleKey: body.styleKey,
      }),
    });
    return { ok: true };
  });

  /**
   * POST /admin/earning/grant-item
   * Deposit (positive quantity) or revoke (negative) units of an
   * item into / from a target identity's inventory. Bypasses the
   * shop's enabled / forSale / sale-window checks so admins can seed
   * testers' pockets with items that aren't yet on sale.
   *
   * Partitioning: characterId selects the identity. Omit / null =
   * the target user's OOC master (scope='user'). A character id =
   * that character's inventory; the character MUST belong to the
   * target user (validated server-side; admins can't accidentally
   * stuff items into a character of a different user).
   *
   * Negative quantities revoke up to (but not below) the current
   * stack; "remove 999 cookies" from a 5-cookie stack leaves it at
   * 0 (and deletes the row) rather than going negative. Positive
   * quantities clamp at `stack_limit` and reject overflow with a
   * 409 so the admin gets a clear error.
   *
   * Audit: writes an `admin_grant` (positive) or `admin_revoke`
   * (negative) row to `earning_ledger` capturing the actor, target,
   * scope, item, and delta. No currency moves — grants are free.
   */
  app.post<{ Body: unknown }>("/admin/earning/grant-item", async (req, reply) => {
    const me = masterAdminGate(req, reply); if (!me) return;
    let body: z.infer<typeof grantItemBody>;
    try { body = grantItemBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "user not found" }; }
    const item = (await db.select().from(items).where(eq(items.key, body.itemKey)).limit(1))[0];
    if (!item) { reply.code(404); return { error: "item not found" }; }

    const characterId = body.characterId ?? null;
    if (characterId) {
      const c = (await db
        .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
        .from(characters)
        .where(eq(characters.id, characterId))
        .limit(1))[0];
      // Ownership against the TARGET, not the admin — the admin is
      // depositing into another user's character pocket.
      if (!c || c.userId !== target.id || c.deletedAt) {
        reply.code(403);
        return { error: "character does not belong to target user" };
      }
    }
    const ownerScope: "user" | "character" = characterId ? "character" : "user";
    const ownerId = characterId ?? target.id;

    // Read current quantity (0 when no row yet).
    const existing = (await db.select({ qty: identityInventory.quantity })
      .from(identityInventory)
      .where(and(
        eq(identityInventory.ownerScope, ownerScope),
        eq(identityInventory.ownerId, ownerId),
        eq(identityInventory.itemKey, body.itemKey),
      ))
      .limit(1))[0];
    const have = existing?.qty ?? 0;
    const desired = have + body.quantity;

    if (body.quantity > 0 && desired > item.stackLimit) {
      reply.code(409);
      return {
        error: `would exceed stack limit (${item.stackLimit})`,
        haveBefore: have,
        stackLimit: item.stackLimit,
      };
    }

    if (desired <= 0) {
      // Net zero or revoke-through-zero: delete the row entirely so
      // the inventory map doesn't carry phantom zero-quantity entries.
      // Also prune any Collection pin on this identity that points at
      // the now-removed item — the showcase shouldn't render an item
      // the identity no longer holds.
      if (existing) {
        await db.delete(identityInventory).where(and(
          eq(identityInventory.ownerScope, ownerScope),
          eq(identityInventory.ownerId, ownerId),
          eq(identityInventory.itemKey, body.itemKey),
        ));
        await db.delete(identityCollection).where(and(
          eq(identityCollection.ownerScope, ownerScope),
          eq(identityCollection.ownerId, ownerId),
          eq(identityCollection.itemKey, body.itemKey),
        ));
      }
    } else if (existing) {
      await db.update(identityInventory)
        .set({ quantity: desired, updatedAt: new Date() })
        .where(and(
          eq(identityInventory.ownerScope, ownerScope),
          eq(identityInventory.ownerId, ownerId),
          eq(identityInventory.itemKey, body.itemKey),
        ));
    } else {
      await db.insert(identityInventory).values({
        ownerScope,
        ownerId,
        itemKey: body.itemKey,
        quantity: desired,
      });
    }

    await db.insert(earningLedger).values({
      id: nanoid(),
      scope: ownerScope,
      ownerId,
      xpDelta: 0,
      currencyDelta: 0,
      reason: body.quantity >= 0 ? "admin_grant" : "admin_revoke",
      metadataJson: JSON.stringify({
        actor: me.id,
        kind: "item",
        itemKey: body.itemKey,
        quantity: body.quantity,
        priorQuantity: have,
        characterId,
      }),
    });
    // Inventory live-update so the recipient's dashboard refreshes
    // its Items tab without a manual reopen. The admin grant
    // bypasses every gate so the inventory delta might be the only
    // signal the receiving user gets that something landed.
    const recipientSockets = await io.fetchSockets();
    for (const s of recipientSockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (uid !== target.id) continue;
      s.emit("earning:inventory_changed", {
        scope: ownerScope,
        ownerId,
        itemKey: body.itemKey,
        delta: body.quantity,
        reason: "admin_grant",
      });
    }
    return { ok: true, newQuantity: Math.max(0, desired) };
  });

  /**
   * POST /admin/earning/revoke-border
   * Remove ownership of a rank's border from the target user. If
   * that border was currently equipped, the equipped state clears
   * too. Idempotent — revoking an unowned border is a no-op.
   */
  app.post<{ Body: unknown }>("/admin/earning/revoke-border", async (req, reply) => {
    const me = masterAdminGate(req, reply); if (!me) return;
    let body: z.infer<typeof grantBorderBody>;
    try { body = grantBorderBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "user not found" }; }
    await db.delete(userOwnedBorders).where(and(
      eq(userOwnedBorders.userId, target.id),
      eq(userOwnedBorders.rankKey, body.rankKey),
    ));
    // Clear the equipped slot if it pointed at the revoked border.
    await db.update(userEarning)
      .set({ selectedBorderRankKey: null, updatedAt: new Date() })
      .where(and(
        eq(userEarning.userId, target.id),
        eq(userEarning.selectedBorderRankKey, body.rankKey),
      ));
    await db.insert(earningLedger).values({
      id: nanoid(),
      scope: "user",
      ownerId: target.id,
      xpDelta: 0,
      currencyDelta: 0,
      reason: "admin_revoke",
      metadataJson: JSON.stringify({
        actor: me.id,
        kind: "border",
        rankKey: body.rankKey,
      }),
    });
    return { ok: true };
  });

  /**
   * POST /admin/earning/revoke-style
   * Remove a name-style ownership row. If that style was currently
   * equipped via user_active_cosmetics.active_name_style_key, the
   * equipped state clears too. Idempotent.
   */
  app.post<{ Body: unknown }>("/admin/earning/revoke-style", async (req, reply) => {
    const me = masterAdminGate(req, reply); if (!me) return;
    let body: z.infer<typeof grantStyleBody>;
    try { body = grantStyleBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "user not found" }; }
    await db.delete(userOwnedNameStyles).where(and(
      eq(userOwnedNameStyles.userId, target.id),
      eq(userOwnedNameStyles.styleKey, body.styleKey),
    ));
    await db.update(userActiveCosmetics)
      .set({ activeNameStyleKey: null, updatedAt: new Date() })
      .where(and(
        eq(userActiveCosmetics.userId, target.id),
        eq(userActiveCosmetics.activeNameStyleKey, body.styleKey),
      ));
    await db.insert(earningLedger).values({
      id: nanoid(),
      scope: "user",
      ownerId: target.id,
      xpDelta: 0,
      currencyDelta: 0,
      reason: "admin_revoke",
      metadataJson: JSON.stringify({
        actor: me.id,
        kind: "name_style",
        styleKey: body.styleKey,
      }),
    });
    return { ok: true };
  });

  /**
   * POST /admin/earning/grant-freeform-border
   * Insert ownership of a free-form border on the target identity,
   * bypassing the Currency cost. Mirrors the rank-tier border grant
   * but with per-identity routing — passing a characterId scopes
   * the grant to that character's pool (the character must belong
   * to the target user). Idempotent.
   *
   * Auto-equip on first grant: matches the user-facing purchase
   * flow — if the identity has no freeform border equipped yet,
   * we set this one as the equipped key.
   */
  app.post<{ Body: unknown }>("/admin/earning/grant-freeform-border", async (req, reply) => {
    const me = masterAdminGate(req, reply); if (!me) return;
    let body: z.infer<typeof grantFreeformBorderBody>;
    try { body = grantFreeformBorderBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "user not found" }; }
    const border = (await db.select().from(freeformBorders).where(eq(freeformBorders.key, body.borderKey)).limit(1))[0];
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
        characterId,
        borderKey: body.borderKey,
      }).onConflictDoNothing();
      // Auto-equip on first acquisition (matches the purchase flow's
      // behavior so admin grants land visible immediately).
      await db.insert(characterEarning).values({ characterId }).onConflictDoNothing();
      const cur = (await db.select({ selected: characterEarning.selectedFreeformBorderKey })
        .from(characterEarning).where(eq(characterEarning.characterId, characterId)).limit(1))[0];
      if (!cur?.selected) {
        await db.update(characterEarning)
          .set({ selectedFreeformBorderKey: body.borderKey, updatedAt: new Date() })
          .where(eq(characterEarning.characterId, characterId));
      }
    } else {
      await db.insert(userOwnedFreeformBorders).values({
        userId: target.id,
        borderKey: body.borderKey,
      }).onConflictDoNothing();
      await db.insert(userEarning).values({ userId: target.id }).onConflictDoNothing();
      const cur = (await db.select({ selected: userEarning.selectedFreeformBorderKey })
        .from(userEarning).where(eq(userEarning.userId, target.id)).limit(1))[0];
      if (!cur?.selected) {
        await db.update(userEarning)
          .set({ selectedFreeformBorderKey: body.borderKey, updatedAt: new Date() })
          .where(eq(userEarning.userId, target.id));
      }
    }
    await db.insert(earningLedger).values({
      id: nanoid(),
      scope: characterId ? "character" : "user",
      ownerId: characterId ?? target.id,
      xpDelta: 0,
      currencyDelta: 0,
      reason: "admin_grant",
      metadataJson: JSON.stringify({
        actor: me.id,
        kind: "freeform_border",
        borderKey: body.borderKey,
        characterId,
      }),
    });
    return { ok: true };
  });

  /**
   * POST /admin/earning/revoke-freeform-border
   * Remove a free-form border from the target identity. If the
   * equip slot pointed at this border it clears too. Idempotent.
   */
  app.post<{ Body: unknown }>("/admin/earning/revoke-freeform-border", async (req, reply) => {
    const me = masterAdminGate(req, reply); if (!me) return;
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
        eq(characterOwnedFreeformBorders.characterId, characterId),
        eq(characterOwnedFreeformBorders.borderKey, body.borderKey),
      ));
      await db.update(characterEarning)
        .set({ selectedFreeformBorderKey: null, updatedAt: new Date() })
        .where(and(
          eq(characterEarning.characterId, characterId),
          eq(characterEarning.selectedFreeformBorderKey, body.borderKey),
        ));
    } else {
      await db.delete(userOwnedFreeformBorders).where(and(
        eq(userOwnedFreeformBorders.userId, target.id),
        eq(userOwnedFreeformBorders.borderKey, body.borderKey),
      ));
      await db.update(userEarning)
        .set({ selectedFreeformBorderKey: null, updatedAt: new Date() })
        .where(and(
          eq(userEarning.userId, target.id),
          eq(userEarning.selectedFreeformBorderKey, body.borderKey),
        ));
    }
    await db.insert(earningLedger).values({
      id: nanoid(),
      scope: characterId ? "character" : "user",
      ownerId: characterId ?? target.id,
      xpDelta: 0,
      currencyDelta: 0,
      reason: "admin_revoke",
      metadataJson: JSON.stringify({
        actor: me.id,
        kind: "freeform_border",
        borderKey: body.borderKey,
        characterId,
      }),
    });
    return { ok: true };
  });

  /**
   * GET /admin/earning/user-ownership?username=…
   * Surface a target user's owned styles + borders so the admin UI
   * can render a revoke list. Master-only; same role gate as the
   * grant/revoke routes.
   */
  app.get<{ Querystring: { username?: string } }>("/admin/earning/user-ownership", async (req, reply) => {
    const me = masterAdminGate(req, reply); if (!me) return;
    const username = (req.query.username ?? "").trim();
    if (!username) { reply.code(400); return { error: "username required" }; }
    const target = await resolveTargetUser(username);
    if (!target) { reply.code(404); return { error: "user not found" }; }
    const ownedStyles = await db
      .select({ styleKey: userOwnedNameStyles.styleKey })
      .from(userOwnedNameStyles)
      .where(eq(userOwnedNameStyles.userId, target.id));
    const ownedBorders = await db
      .select({ rankKey: userOwnedBorders.rankKey })
      .from(userOwnedBorders)
      .where(eq(userOwnedBorders.userId, target.id));
    // Free-form border ownership. Master scope here; per-character
    // ownership lookup ships in the per-character section below
    // alongside character_owned_borders if a future admin UI needs
    // it. For now the master list is enough for revoke targeting.
    const ownedFreeformBorders = await db
      .select({ borderKey: userOwnedFreeformBorders.borderKey })
      .from(userOwnedFreeformBorders)
      .where(eq(userOwnedFreeformBorders.userId, target.id));
    // Per-identity inventory: master rows + per-character rows. The
    // admin UI uses the master list to surface "what does this user
    // currently hold on their OOC pool?" before granting; characters
    // are returned in a keyed map so the grant tool can pivot to a
    // specific character's pocket.
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
      .where(sql`(${identityInventory.ownerScope} = 'user' AND ${identityInventory.ownerId} = ${target.id})
        OR (${identityInventory.ownerScope} = 'character' AND ${identityInventory.ownerId} IN (${
        targetCharIds.length > 0
          ? sql.join(targetCharIds.map((id) => sql`${id}`), sql`, `)
          : sql`''`
      }))`);
    const inventory: { itemKey: string; quantity: number }[] = [];
    const inventoryByCharacter: Record<string, { itemKey: string; quantity: number }[]> = {};
    for (const r of inventoryRows) {
      const e = { itemKey: r.itemKey, quantity: r.quantity };
      if (r.ownerScope === "user") inventory.push(e);
      else (inventoryByCharacter[r.ownerId] ??= []).push(e);
    }
    return {
      userId: target.id,
      ownedStyles: ownedStyles.map((s) => s.styleKey),
      ownedBorders: ownedBorders.map((b) => b.rankKey),
      ownedFreeformBorders: ownedFreeformBorders.map((b) => b.borderKey),
      inventory,
      inventoryByCharacter,
      characters: targetCharRows,
    };
  });

  /**
   * POST /admin/earning/reset-user
   * Hard-reset a single user's earning state for testing:
   *   - user_earning row: zero out xp/currency/rank/tier + clear peak
   *   - character_earning rows: zero out xp/currency/rank/tier + clear peak
   *   - user_owned_borders rows: deleted
   *   - user_owned_name_styles rows: deleted
   *   - user_active_cosmetics row: deleted (so nothing's equipped)
   * Audits via the ledger so the reset is recoverable in the timeline.
   * Masteradmin-only.
   */
  app.post<{ Body: unknown }>("/admin/earning/reset-user", async (req, reply) => {
    const me = masterAdminGate(req, reply); if (!me) return;
    const resetBody = z.object({ username: z.string().min(1).max(40) });
    let body: z.infer<typeof resetBody>;
    try { body = resetBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "user not found" }; }

    // Zero out the master earning row (lazy-create first so the row
    // exists to update — keeps the post-reset state consistent).
    // Includes every cosmetic equip slot + free-form text field
    // added across migrations 0148-0151 so a reset is genuinely a
    // clean slate (a leftover `typing_phrase` on a reset account
    // would surprise QA tracing a Flair regression).
    await db.insert(userEarning).values({ userId: target.id }).onConflictDoNothing();
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
    }).where(eq(userEarning.userId, target.id));

    // Zero out every character pool tied to this user. Same set of
    // columns; character_earning carries the per-character cosmetic
    // slots from migrations 0148-0151 too.
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
      }).where(inArray(characterEarning.characterId, ownedCharIds));
    }

    // Wipe ownership rows. Deleting (rather than soft-marking) is
    // intentional — the whole point is a clean slate for testing.
    // Free-form border ownership is partitioned the same way as the
    // rank-tier set; both master + character pools need their rows
    // dropped.
    await db.delete(userOwnedBorders).where(eq(userOwnedBorders.userId, target.id));
    await db.delete(userOwnedNameStyles).where(eq(userOwnedNameStyles.userId, target.id));
    await db.delete(userOwnedFreeformBorders).where(eq(userOwnedFreeformBorders.userId, target.id));
    if (ownedCharIds.length > 0) {
      await db.delete(characterOwnedFreeformBorders)
        .where(inArray(characterOwnedFreeformBorders.characterId, ownedCharIds));
    }
    await db.delete(userActiveCosmetics).where(eq(userActiveCosmetics.userId, target.id));

    // Phase 3 reaction submissions. Pending rows hold paid Currency
    // — but a reset is destructive by design (used by QA / dev),
    // and the same operator that zeroes wallets is OK losing the
    // amounts here too. The image files on disk get orphaned but a
    // janitor sweep / manual cleanup handles that; the rows
    // themselves vanish so the user's `3 pending` cap resets too.
    // Approved submissions stay live (they're admin-curated content
    // now, decoupled from the originating account).
    const submissionPoolIds = [target.id, ...ownedCharIds];
    if (submissionPoolIds.length > 0) {
      await db.delete(emoticonSheets).where(and(
        sql`${emoticonSheets.status} IN ('pending', 'rejected')`,
        inArray(emoticonSheets.submitterPoolId, submissionPoolIds),
      ));
    }

    // In-memory anti-spam echo cache (Phase 6 messageQuality).
    // Clearing here ensures a reset user doesn't carry old echoes
    // through into testing scenarios where they're meant to repeat
    // canned messages.
    clearEchoCacheFor(target.id);

    // Ledger audit. Single row; the metadata captures what was wiped.
    await db.insert(earningLedger).values({
      id: nanoid(),
      scope: "user",
      ownerId: target.id,
      xpDelta: 0,
      currencyDelta: 0,
      reason: "admin_reset",
      metadataJson: JSON.stringify({
        actor: me.id,
        characters: ownedCharIds.length,
      }),
    });

    return { ok: true };
  });

  /* =========================================================
   *  Flash Sales — admin
   *
   *  Reads:
   *    GET /admin/earning/flash-sale → settings + today's picks +
   *      every queued future override.
   *
   *  Writes:
   *    PATCH /admin/earning/flash-sale/settings  → toggle per-
   *      category enable, change default discount %.
   *    PUT   /admin/earning/flash-sale/overrides → queue (or
   *      replace) tomorrow's pick for one category. Pass null
   *      `targetKey` to remove an existing queue.
   *
   *  Today's row is resolver-owned (it's already been picked); the
   *  admin can ONLY override future dates. The UI passes the date
   *  explicitly so an admin can also queue "two days out" without
   *  the server having to model "tomorrow" specially.
   * ========================================================= */

  app.get("/admin/earning/flash-sale", async () => {
    const today = await resolveTodayFlashSale(db);
    // Future overrides — anything for_date >= tomorrow. Today's
    // overrides have been consumed into `flash_sales` already; we
    // surface them on the today object so admins can see what
    // chose vs random.
    const tomorrow = dateOffsetUtc(1);
    const overrides = await db
      .select()
      .from(flashSaleOverrides)
      .where(sql`${flashSaleOverrides.forDate} >= ${tomorrow}`)
      .orderBy(asc(flashSaleOverrides.forDate), asc(flashSaleOverrides.category));
    const settings = (await db.select().from(siteSettings).limit(1))[0];
    return {
      today,
      tomorrow,
      overrides: overrides.map((r) => ({
        category: r.category,
        forDate: r.forDate,
        targetKey: r.targetKey,
        discountPct: r.discountPct,
      })),
      settings: {
        defaultDiscountPct: settings?.flashSaleDefaultDiscountPct ?? 25,
        stylesEnabled: settings?.flashSaleStylesEnabled ?? true,
        itemsEnabled: settings?.flashSaleItemsEnabled ?? true,
        cosmeticsEnabled: settings?.flashSaleCosmeticsEnabled ?? true,
        freeformBordersEnabled: settings?.flashSaleFreeformBordersEnabled ?? true,
      },
    };
  });

  const flashSaleSettingsBody = z.object({
    defaultDiscountPct: z.number().int().min(1).max(99).optional(),
    stylesEnabled: z.boolean().optional(),
    itemsEnabled: z.boolean().optional(),
    cosmeticsEnabled: z.boolean().optional(),
    freeformBordersEnabled: z.boolean().optional(),
  }).strict();

  app.patch<{ Body: unknown }>("/admin/earning/flash-sale/settings", async (req, reply) => {
    let body: z.infer<typeof flashSaleSettingsBody>;
    try { body = flashSaleSettingsBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const me = (req as FastifyRequest & { sessionUser?: { id: string } }).sessionUser;
    const patch: Record<string, unknown> = {};
    if (body.defaultDiscountPct !== undefined) patch.flashSaleDefaultDiscountPct = body.defaultDiscountPct;
    if (body.stylesEnabled !== undefined) patch.flashSaleStylesEnabled = body.stylesEnabled;
    if (body.itemsEnabled !== undefined) patch.flashSaleItemsEnabled = body.itemsEnabled;
    if (body.cosmeticsEnabled !== undefined) patch.flashSaleCosmeticsEnabled = body.cosmeticsEnabled;
    if (body.freeformBordersEnabled !== undefined) patch.flashSaleFreeformBordersEnabled = body.freeformBordersEnabled;
    if (Object.keys(patch).length === 0) return { ok: true, noop: true };
    await db
      .update(siteSettings)
      .set({ ...patch, updatedAt: new Date(), updatedById: me?.id ?? null })
      .where(eq(siteSettings.id, "singleton"));
    return { ok: true };
  });

  const flashSaleOverrideBody = z.object({
    /** 'name_style' | 'item' | 'cosmetic' | 'freeform_border'. */
    category: z.enum(["name_style", "item", "cosmetic", "freeform_border"]),
    /**
     * ISO 'YYYY-MM-DD' UTC. Must be strictly in the future — today
     * has already been resolved by the time the admin sees it. The
     * shape regex catches typos; the `refine` catches values that
     * SHAPE like a date but aren't valid (e.g. "2026-99-99"), which
     * would otherwise pass through and never match any real `for_date`
     * the resolver writes.
     */
    forDate: z.string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((s) => {
        const d = new Date(s + "T00:00:00Z");
        return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
      }, { message: "invalid calendar date" }),
    /** Catalog row key, or null to REMOVE an existing queue for this slot. */
    targetKey: z.string().min(1).nullable(),
    /** Optional per-pick discount; null/undefined = inherit default. */
    discountPct: z.number().int().min(1).max(99).nullable().optional(),
  }).strict();

  /* =========================================================
   *  Per-catalog export / import (ZIP)
   *
   *  Four catalogs are bundle-able: name-styles, items, borders,
   *  ranks. Each ships rows + any /uploads/* image assets referenced
   *  by those rows so the round-trip is lossless even when admins
   *  uploaded custom art. Import is UPSERT BY KEY — admin-managed
   *  catalogs survive a partial import without losing rows that
   *  weren't in the file.
   *
   *  Wire encoding: export returns the raw zip bytes with
   *  `Content-Type: application/zip` + `Content-Disposition: attachment`
   *  so the browser auto-saves the file. Import accepts the zip
   *  base64-encoded inside a JSON body to dodge the multipart
   *  plugin dep — same pattern the existing logo upload uses.
   * ========================================================= */

  function parseKind(raw: string): EarningCatalogKind | null {
    switch (raw) {
      case "name-styles":
      case "items":
      case "borders":
      case "ranks":
        return raw;
      default:
        return null;
    }
  }

  app.get<{ Params: { kind: string } }>(
    "/admin/earning/transfer/:kind/export",
    async (req, reply) => {
      const kind = parseKind(req.params.kind);
      if (!kind) { reply.code(404); return { error: "unknown catalog kind" }; }
      const result = await exportCatalog(db, kind, uploadsRoot);
      reply.header("Content-Type", "application/zip");
      reply.header("Content-Disposition", `attachment; filename="${result.filename}"`);
      reply.header("Content-Length", String(result.zip.byteLength));
      return reply.send(result.zip);
    },
  );

  const importZipBody = z.object({
    /** Base64-encoded ZIP. Cap mirrors the logo upload (8MB) so a
     *  fat-fingered binary upload can't blow the JSON body limit. */
    zipBase64: z.string().min(32).max(16 * 1024 * 1024),
  }).strict();

  app.post<{ Params: { kind: string }; Body: unknown }>(
    "/admin/earning/transfer/:kind/import",
    async (req, reply) => {
      const kind = parseKind(req.params.kind);
      if (!kind) { reply.code(404); return { error: "unknown catalog kind" }; }
      let body: z.infer<typeof importZipBody>;
      try { body = importZipBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }
      let bytes: Buffer;
      try { bytes = Buffer.from(body.zipBase64, "base64"); }
      catch { reply.code(400); return { error: "invalid base64 payload" }; }
      try {
        const result = await importCatalog(db, bytes, uploadsRoot, kind);
        return { ok: true, ...result };
      } catch (err) {
        reply.code(400);
        return { error: err instanceof Error ? err.message : "import failed" };
      }
    },
  );

  app.put<{ Body: unknown }>("/admin/earning/flash-sale/overrides", async (req, reply) => {
    let body: z.infer<typeof flashSaleOverrideBody>;
    try { body = flashSaleOverrideBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const today = todayUtc();
    if (body.forDate <= today) {
      reply.code(400);
      return { error: `forDate must be strictly after today (${today})` };
    }
    if (body.targetKey === null) {
      // Remove queue for this slot — leaves the day random again.
      await db
        .delete(flashSaleOverrides)
        .where(and(
          eq(flashSaleOverrides.category, body.category),
          eq(flashSaleOverrides.forDate, body.forDate),
        ));
      return { ok: true, removed: true };
    }
    // Validate the target key against the relevant catalog so a
    // typo doesn't materialize as a NULL pick on resolution day.
    const exists = body.category === "name_style"
      ? (await db.select({ k: nameStyles.key }).from(nameStyles).where(eq(nameStyles.key, body.targetKey)).limit(1))[0]
      : body.category === "item"
        ? (await db.select({ k: items.key }).from(items).where(eq(items.key, body.targetKey)).limit(1))[0]
        : body.category === "cosmetic"
          ? (await db.select({ k: cosmetics.key }).from(cosmetics).where(eq(cosmetics.key, body.targetKey)).limit(1))[0]
          : (await db.select({ k: freeformBorders.key }).from(freeformBorders).where(eq(freeformBorders.key, body.targetKey)).limit(1))[0];
    if (!exists) {
      reply.code(404);
      return { error: `no ${body.category} with key '${body.targetKey}'` };
    }
    // Upsert by (category, forDate) — replacing an admin's earlier
    // pick on the same slot rather than 409ing.
    await db
      .insert(flashSaleOverrides)
      .values({
        category: body.category,
        forDate: body.forDate,
        targetKey: body.targetKey,
        discountPct: body.discountPct ?? null,
      })
      .onConflictDoUpdate({
        target: [flashSaleOverrides.category, flashSaleOverrides.forDate],
        set: { targetKey: body.targetKey, discountPct: body.discountPct ?? null },
      });
    return { ok: true };
  });

  /* =========================================================
   *  Flair moderation — clear a user's banner URL
   *
   *  Admin-only moderation lever for the URL-based profile banner.
   *  Use case: a user pastes a hotlink to something the admin's
   *  community shouldn't see (NSFW outside the NSFW gate, doxxing,
   *  copyrighted material). Clearing wipes the column on master OR
   *  on a specific character. The user retains ownership of the
   *  `flair_profile_banner` cosmetic and can paste a new (hopefully
   *  policy-compliant) URL afterwards.
   *
   *  Auditable via `profile_banner_clear` in the audit log so the
   *  reason + actor survive for the moderation timeline.
   * ========================================================= */
  const clearBannerBody = z.object({
    /** Master username — the account to clear. Same lookup the grant endpoints use. */
    username: z.string().min(1).max(80),
    /** When set, clears that character's banner instead of the master's. */
    characterId: z.string().nullable().optional(),
    /** Optional moderator reason recorded in the audit row. */
    reason: z.string().max(500).optional(),
  }).strict();

  app.post<{ Body: unknown }>("/admin/earning/clear-banner", async (req, reply) => {
    const me = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser;
    if (!me) { reply.code(401); return { error: "auth" }; }
    let body: z.infer<typeof clearBannerBody>;
    try { body = clearBannerBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "no such user" }; }
    if (body.characterId) {
      // Verify the character belongs to the target. Without this an
      // admin could clear a stranger's character banner by guessing
      // ids — the column would still wipe but the audit row would
      // be misleading.
      const c = (await db
        .select({ id: characters.id, userId: characters.userId })
        .from(characters)
        .where(eq(characters.id, body.characterId))
        .limit(1))[0];
      if (!c || c.userId !== target.id) {
        reply.code(404); return { error: "no such character on this user" };
      }
      await db.update(characterEarning)
        .set({ profileBannerUrl: null, updatedAt: new Date() })
        .where(eq(characterEarning.characterId, body.characterId));
    } else {
      await db.update(userActiveCosmetics)
        .set({ profileBannerUrl: null, updatedAt: new Date() })
        .where(eq(userActiveCosmetics.userId, target.id));
    }
    await recordAudit(db, {
      actorUserId: me.id,
      action: "profile_banner_clear",
      targetUserId: target.id,
      reason: body.reason ?? null,
      metadata: body.characterId ? { characterId: body.characterId } : null,
    });
    return { ok: true };
  });

  /* =========================================================
   *  POST /admin/earning/clear-typing-phrase
   *
   *  Twin of clear-banner above, for the Phase 5 custom typing
   *  phrase Flair. Wipes the `typing_phrase` column on master or
   *  on a specific character. Ownership of `flair_typing_phrase`
   *  is retained — the user can set a (presumably policy-
   *  compliant) phrase again afterwards.
   *
   *  Auditable via `typing_phrase_clear` in the audit log.
   * ========================================================= */
  const clearTypingPhraseBody = z.object({
    username: z.string().min(1).max(80),
    characterId: z.string().nullable().optional(),
    reason: z.string().max(500).optional(),
  }).strict();

  app.post<{ Body: unknown }>("/admin/earning/clear-typing-phrase", async (req, reply) => {
    const me = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser;
    if (!me) { reply.code(401); return { error: "auth" }; }
    let body: z.infer<typeof clearTypingPhraseBody>;
    try { body = clearTypingPhraseBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "no such user" }; }
    if (body.characterId) {
      const c = (await db
        .select({ id: characters.id, userId: characters.userId })
        .from(characters)
        .where(eq(characters.id, body.characterId))
        .limit(1))[0];
      if (!c || c.userId !== target.id) {
        reply.code(404); return { error: "no such character on this user" };
      }
      await db.update(characterEarning)
        .set({ typingPhrase: null, updatedAt: new Date() })
        .where(eq(characterEarning.characterId, body.characterId));
    } else {
      // Master scope writes to user_earning (NOT user_active_cosmetics
      // — typing phrase lives on the earning row alongside other
      // master-pool fields).
      await db.update(userEarning)
        .set({ typingPhrase: null, updatedAt: new Date() })
        .where(eq(userEarning.userId, target.id));
    }
    await recordAudit(db, {
      actorUserId: me.id,
      action: "typing_phrase_clear",
      targetUserId: target.id,
      reason: body.reason ?? null,
      metadata: body.characterId ? { characterId: body.characterId } : null,
    });
    return { ok: true };
  });

  /* =========================================================
   *  POST /admin/earning/clear-room-presence
   *  POST /admin/earning/clear-session-presence
   *
   *  Twins of clear-typing-phrase above, for the migration 0161
   *  room-presence and session-presence Flairs. Same body shape:
   *  username + optional characterId + optional reason. Master
   *  scope when characterId is null; character scope when set.
   *
   *  Both endpoints clear BOTH templates the flair owns at once —
   *  granular per-slot clears would be too fiddly for moderation
   *  (the abuse case is usually "wipe all of this user's custom
   *  presence text"; surgical per-slot is unnecessary).
   *
   *  session-presence is master-only; passing a characterId returns
   *  400 since there's no character-scoped session template.
   * ========================================================= */
  const clearRoomPresenceBody = z.object({
    username: z.string().min(1).max(80),
    characterId: z.string().nullable().optional(),
    reason: z.string().max(500).optional(),
  }).strict();

  app.post<{ Body: unknown }>("/admin/earning/clear-room-presence", async (req, reply) => {
    const me = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser;
    if (!me) { reply.code(401); return { error: "auth" }; }
    let body: z.infer<typeof clearRoomPresenceBody>;
    try { body = clearRoomPresenceBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "no such user" }; }
    if (body.characterId) {
      const c = (await db
        .select({ id: characters.id, userId: characters.userId })
        .from(characters)
        .where(eq(characters.id, body.characterId))
        .limit(1))[0];
      if (!c || c.userId !== target.id) {
        reply.code(404); return { error: "no such character on this user" };
      }
      await db.update(characterEarning)
        .set({ roomJoinTemplate: null, roomLeaveTemplate: null, updatedAt: new Date() })
        .where(eq(characterEarning.characterId, body.characterId));
    } else {
      await db.update(userEarning)
        .set({ roomJoinTemplate: null, roomLeaveTemplate: null, updatedAt: new Date() })
        .where(eq(userEarning.userId, target.id));
    }
    await recordAudit(db, {
      actorUserId: me.id,
      action: "room_presence_clear",
      targetUserId: target.id,
      reason: body.reason ?? null,
      metadata: body.characterId ? { characterId: body.characterId } : null,
    });
    return { ok: true };
  });

  const clearSessionPresenceBody = z.object({
    username: z.string().min(1).max(80),
    reason: z.string().max(500).optional(),
  }).strict();

  app.post<{ Body: unknown }>("/admin/earning/clear-session-presence", async (req, reply) => {
    const me = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser;
    if (!me) { reply.code(401); return { error: "auth" }; }
    let body: z.infer<typeof clearSessionPresenceBody>;
    try { body = clearSessionPresenceBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const target = await resolveTargetUser(body.username);
    if (!target) { reply.code(404); return { error: "no such user" }; }
    await db.update(userEarning)
      .set({ sessionConnectTemplate: null, sessionExitTemplate: null, updatedAt: new Date() })
      .where(eq(userEarning.userId, target.id));
    await recordAudit(db, {
      actorUserId: me.id,
      action: "session_presence_clear",
      targetUserId: target.id,
      reason: body.reason ?? null,
      metadata: null,
    });
    return { ok: true };
  });
}
