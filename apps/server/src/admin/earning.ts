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
  characters,
  cosmetics,
  nameStyles,
  rankTiers,
  ranks,
  earningLedger,
  userActiveCosmetics,
  userOwnedBorders,
  userOwnedNameStyles,
  userEarning,
  users,
} from "../db/schema.js";
import { getSettings, updateSettings } from "../settings.js";
import {
  DEFAULT_EARNING_CONFIG,
  type EarningConfig,
  normalizeEarningConfig,
} from "../earning/config.js";
import { backfillAllRankPlacements, mergeMaxEverHeld, resolveRankForXp } from "../earning/resolver.js";
import { creditPool } from "../earning/award.js";

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

  const styleBody = z.object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    template: z.string().min(1).max(4000).optional(),
    styleCss: z.string().max(8000).optional(),
    cost: z.number().int().min(0).max(1_000_000).optional(),
    enabled: z.boolean().optional(),
    order: z.number().int().optional(),
  }).strict();

  const createStyleBody = z.object({
    key: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    template: z.string().min(1).max(4000),
    styleCss: z.string().max(8000).optional(),
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
    return {
      userId: target.id,
      ownedStyles: ownedStyles.map((s) => s.styleKey),
      ownedBorders: ownedBorders.map((b) => b.rankKey),
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
    await db.insert(userEarning).values({ userId: target.id }).onConflictDoNothing();
    await db.update(userEarning).set({
      xp: 0,
      currency: 0,
      rankKey: null,
      tier: null,
      maxRankKeyEverHeld: null,
      maxTierEverHeld: null,
      selectedBorderRankKey: null,
      updatedAt: new Date(),
    }).where(eq(userEarning.userId, target.id));

    // Zero out every character pool tied to this user.
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
        updatedAt: new Date(),
      }).where(inArray(characterEarning.characterId, ownedCharIds));
    }

    // Wipe ownership rows. Deleting (rather than soft-marking) is
    // intentional — the whole point is a clean slate for testing.
    await db.delete(userOwnedBorders).where(eq(userOwnedBorders.userId, target.id));
    await db.delete(userOwnedNameStyles).where(eq(userOwnedNameStyles.userId, target.id));
    await db.delete(userActiveCosmetics).where(eq(userActiveCosmetics.userId, target.id));

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
}
