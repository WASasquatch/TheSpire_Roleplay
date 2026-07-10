import type { FastifyInstance } from "fastify";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  BUILTIN_ENTITY_KIND_KEYS,
  WORLD_ARCS_CAP,
  WORLD_ENTITY_BODY_MAX,
  WORLD_ENTITY_KINDS_CAP,
  WORLD_ENTITY_NAME_MAX,
  WORLD_ENTITY_PER_KIND_CAP,
  WORLD_ENTITY_SUMMARY_MAX,
  WORLD_SESSIONS_CAP,
  deriveSlug,
  parseTagList,
  serializeTagList,
} from "@thekeep/shared";
import { tFor } from "../../i18n.js";
import { getSessionUser } from "../auth.js";
import {
  worldArcs,
  worldEntities,
  worldEntityKinds,
  worldPages,
  worldSessions,
  worlds,
} from "../../db/schema.js";
import { sanitizeBio } from "../../auth/html.js";
import type { Db } from "../../db/index.js";
import {
  SLUG_RX,
  resolveWorld,
  canEditWorld,
  entityLightToWire,
  entityRowToWire,
  entityKindRowToWire,
  arcRowToWire,
  sessionRowToWire,
} from "./shared.js";
import type { Io } from "./shared.js";

export async function registerWorldKnowledgeBaseRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  /* ===================================================== *
   *  Knowledge base — typed entries (Locations / NPCs /
   *  Items / Factions / custom kinds). Mirrors the
   *  Scriptorium codex. "Lore" stays the worldPages tree.
   * ===================================================== */

  const entityStatsSchema = z
    .record(z.string().max(200))
    .refine((r) => Object.keys(r).length <= 50, { message: "too many stats" });
  const entityImageUrl = z
    .string().trim().max(2000)
    .refine((s) => /^https?:\/\//i.test(s), { message: "imageUrl must be http(s)" });
  const entityTag = z
    .string().min(1).max(32)
    .transform((s) => s.trim().toLowerCase())
    .refine((s) => /^[a-z0-9-]+$/.test(s), { message: "tags must be lowercase letters/digits/hyphens" });
  const entityTags = z.array(entityTag).max(20).transform((a) => parseTagList(a.join(",")));

  const createEntityBody = z.object({
    kind: z.string().min(1).max(40),
    name: z.string().min(1).max(WORLD_ENTITY_NAME_MAX),
    slug: z.string().optional(),
    summary: z.string().max(WORLD_ENTITY_SUMMARY_MAX).optional(),
    bodyHtml: z.string().max(WORLD_ENTITY_BODY_MAX * 4).optional(),
    stats: entityStatsSchema.optional(),
    tags: entityTags.optional(),
    imageUrl: entityImageUrl.nullable().optional(),
    isPublic: z.boolean().optional(),
    arcId: z.string().nullable().optional(),
  }).strict();
  const updateEntityBody = z.object({
    name: z.string().min(1).max(WORLD_ENTITY_NAME_MAX).optional(),
    slug: z.string().optional(),
    summary: z.string().max(WORLD_ENTITY_SUMMARY_MAX).optional(),
    bodyHtml: z.string().max(WORLD_ENTITY_BODY_MAX * 4).optional(),
    stats: entityStatsSchema.optional(),
    tags: entityTags.optional(),
    imageUrl: entityImageUrl.nullable().optional(),
    isPublic: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    arcId: z.string().nullable().optional(),
  }).strict();

  /** Reserved kind keys a custom kind can't reuse (built-ins + synthetic lore). */
  const RESERVED_KIND_KEYS = new Set<string>([...BUILTIN_ENTITY_KIND_KEYS, "lore"]);
  /** Valid entity kind = a built-in (npc/location/faction/item) OR a registered
   *  custom key on this world. */
  async function isValidEntityKind(worldId: string, kind: string): Promise<boolean> {
    if ((BUILTIN_ENTITY_KIND_KEYS as readonly string[]).includes(kind)) return true;
    const row = (await db
      .select({ key: worldEntityKinds.key })
      .from(worldEntityKinds)
      .where(and(eq(worldEntityKinds.worldId, worldId), sql`lower(${worldEntityKinds.key}) = ${kind.toLowerCase()}`))
      .limit(1))[0];
    return !!row;
  }

  /** True iff the arc exists in this world (soft-FK validation for arcId). */
  async function arcInWorld(worldId: string, arcId: string): Promise<boolean> {
    const row = (await db.select({ id: worldArcs.id }).from(worldArcs)
      .where(and(eq(worldArcs.id, arcId), eq(worldArcs.worldId, worldId))).limit(1))[0];
    return !!row;
  }

  app.get<{ Params: { idOrSlug: string } }>("/worlds/:idOrSlug/entities", async (req, reply) => {
    const me = await getSessionUser(req, db);
    const w = await resolveWorld(db, req.params.idOrSlug, me?.id ?? null, me?.role ?? null);
    if (!w) { reply.code(404); return { error: "not found" }; }
    const canEdit = await canEditWorld(db, w, me?.id ?? null, me?.role ?? null);
    const rows = await db.select().from(worldEntities).where(eq(worldEntities.worldId, w.id))
      .orderBy(asc(worldEntities.kind), asc(worldEntities.sortOrder), asc(worldEntities.createdAt));
    const visible = canEdit ? rows : rows.filter((r) => !!r.isPublic);
    return { entities: visible.map(entityLightToWire) };
  });

  app.get<{ Params: { idOrSlug: string; eid: string } }>("/worlds/:idOrSlug/entities/:eid", async (req, reply) => {
    const me = await getSessionUser(req, db);
    const w = await resolveWorld(db, req.params.idOrSlug, me?.id ?? null, me?.role ?? null);
    if (!w) { reply.code(404); return { error: "not found" }; }
    const canEdit = await canEditWorld(db, w, me?.id ?? null, me?.role ?? null);
    const e = (await db.select().from(worldEntities)
      .where(and(eq(worldEntities.id, req.params.eid), eq(worldEntities.worldId, w.id))).limit(1))[0];
    if (!e || (!canEdit && !e.isPublic)) { reply.code(404); return { error: "not found" }; }
    return { entity: entityRowToWire(e) };
  });

  app.post<{ Params: { idOrSlug: string }; Body: unknown }>("/worlds/:idOrSlug/entities", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    let body; try { body = createEntityBody.parse(req.body); } catch { reply.code(400); return { error: "invalid body" }; }
    if (!(await isValidEntityKind(w.id, body.kind))) { reply.code(400); return { error: "unknown kind" }; }
    if (body.arcId && !(await arcInWorld(w.id, body.arcId))) { reply.code(400); return { error: "unknown arc" }; }
    const countRow = (await db.select({ n: sql<number>`count(*)` }).from(worldEntities)
      .where(and(eq(worldEntities.worldId, w.id), eq(worldEntities.kind, body.kind))))[0];
    if ((countRow?.n ?? 0) >= WORLD_ENTITY_PER_KIND_CAP) { reply.code(409); return { error: tFor(me.locale, "errors:server.worlds.tooManyOfKind") }; }
    const slug = (body.slug?.trim() || deriveSlug(body.name)).toLowerCase();
    if (!SLUG_RX.test(slug)) { reply.code(400); return { error: "invalid slug" }; }
    const dup = (await db.select({ id: worldEntities.id }).from(worldEntities)
      .where(and(eq(worldEntities.worldId, w.id), eq(worldEntities.kind, body.kind), sql`lower(${worldEntities.slug}) = ${slug}`)).limit(1))[0];
    if (dup) { reply.code(409); return { error: tFor(me.locale, "errors:server.worlds.entrySlugExists") }; }
    const maxRow = (await db.select({ m: sql<number>`COALESCE(MAX(${worldEntities.sortOrder}), -1)` }).from(worldEntities)
      .where(and(eq(worldEntities.worldId, w.id), eq(worldEntities.kind, body.kind))))[0];
    const now = new Date();
    const id = nanoid();
    await db.insert(worldEntities).values({
      id, worldId: w.id, kind: body.kind, slug, name: body.name,
      summary: body.summary ?? "", bodyHtml: sanitizeBio(body.bodyHtml ?? ""),
      statsJson: JSON.stringify(body.stats ?? {}), tags: serializeTagList(body.tags ?? []),
      imageUrl: body.imageUrl ?? null, isPublic: body.isPublic ? 1 : 0,
      sortOrder: Number(maxRow?.m ?? -1) + 1,
      arcId: body.arcId ?? null,
      createdAt: now, updatedAt: now,
    });
    await db.update(worlds).set({ updatedAt: now }).where(eq(worlds.id, w.id));
    const created = (await db.select().from(worldEntities).where(eq(worldEntities.id, id)).limit(1))[0]!;
    return { entity: entityRowToWire(created) };
  });

  app.patch<{ Params: { idOrSlug: string; eid: string }; Body: unknown }>("/worlds/:idOrSlug/entities/:eid", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    const existing = (await db.select().from(worldEntities)
      .where(and(eq(worldEntities.id, req.params.eid), eq(worldEntities.worldId, w.id))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }
    let body; try { body = updateEntityBody.parse(req.body); } catch { reply.code(400); return { error: "invalid body" }; }
    const update: Partial<typeof worldEntities.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) update.name = body.name;
    if (body.summary !== undefined) update.summary = body.summary;
    if (body.bodyHtml !== undefined) update.bodyHtml = sanitizeBio(body.bodyHtml);
    if (body.stats !== undefined) update.statsJson = JSON.stringify(body.stats);
    if (body.tags !== undefined) update.tags = serializeTagList(body.tags);
    if (body.imageUrl !== undefined) update.imageUrl = body.imageUrl;
    if (body.isPublic !== undefined) update.isPublic = body.isPublic ? 1 : 0;
    if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
    if (body.arcId !== undefined) {
      if (body.arcId && !(await arcInWorld(w.id, body.arcId))) { reply.code(400); return { error: "unknown arc" }; }
      update.arcId = body.arcId;
    }
    if (body.slug !== undefined) {
      const slug = (body.slug.trim() || deriveSlug(body.name ?? existing.name)).toLowerCase();
      if (!SLUG_RX.test(slug)) { reply.code(400); return { error: "invalid slug" }; }
      const dup = (await db.select({ id: worldEntities.id }).from(worldEntities)
        .where(and(eq(worldEntities.worldId, w.id), eq(worldEntities.kind, existing.kind), sql`lower(${worldEntities.slug}) = ${slug}`, ne(worldEntities.id, existing.id))).limit(1))[0];
      if (dup) { reply.code(409); return { error: tFor(me.locale, "errors:server.worlds.entrySlugExists") }; }
      update.slug = slug;
    }
    await db.update(worldEntities).set(update).where(eq(worldEntities.id, existing.id));
    await db.update(worlds).set({ updatedAt: new Date() }).where(eq(worlds.id, w.id));
    const updated = (await db.select().from(worldEntities).where(eq(worldEntities.id, existing.id)).limit(1))[0]!;
    return { entity: entityRowToWire(updated) };
  });

  app.delete<{ Params: { idOrSlug: string; eid: string } }>("/worlds/:idOrSlug/entities/:eid", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    const existing = (await db.select({ id: worldEntities.id }).from(worldEntities)
      .where(and(eq(worldEntities.id, req.params.eid), eq(worldEntities.worldId, w.id))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }
    await db.delete(worldEntities).where(eq(worldEntities.id, existing.id));
    await db.update(worlds).set({ updatedAt: new Date() }).where(eq(worlds.id, w.id));
    return { ok: true };
  });

  /* ---------- Custom entry-kind registry ---------- */

  const createKindBody = z.object({
    key: z.string().min(1).max(40),
    label: z.string().min(1).max(60),
    description: z.string().max(200).optional(),
    icon: z.string().max(8).nullable().optional(),
    color: z.string().max(32).nullable().optional(),
  }).strict();
  const updateKindBody = z.object({
    label: z.string().min(1).max(60).optional(),
    description: z.string().max(200).optional(),
    icon: z.string().max(8).nullable().optional(),
    color: z.string().max(32).nullable().optional(),
    sortOrder: z.number().int().optional(),
  }).strict();

  app.get<{ Params: { idOrSlug: string } }>("/worlds/:idOrSlug/entity-kinds", async (req, reply) => {
    const me = await getSessionUser(req, db);
    const w = await resolveWorld(db, req.params.idOrSlug, me?.id ?? null, me?.role ?? null);
    if (!w) { reply.code(404); return { error: "not found" }; }
    const rows = await db.select().from(worldEntityKinds).where(eq(worldEntityKinds.worldId, w.id))
      .orderBy(asc(worldEntityKinds.sortOrder), asc(worldEntityKinds.key));
    return { entityKinds: rows.map(entityKindRowToWire) };
  });

  app.post<{ Params: { idOrSlug: string }; Body: unknown }>("/worlds/:idOrSlug/entity-kinds", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    let body; try { body = createKindBody.parse(req.body); } catch { reply.code(400); return { error: "invalid body" }; }
    const key = body.key.trim().toLowerCase();
    if (!SLUG_RX.test(key)) { reply.code(400); return { error: "invalid kind key" }; }
    if (RESERVED_KIND_KEYS.has(key)) { reply.code(409); return { error: tFor(me.locale, "errors:server.worlds.kindReserved") }; }
    const countRow = (await db.select({ n: sql<number>`count(*)` }).from(worldEntityKinds).where(eq(worldEntityKinds.worldId, w.id)))[0];
    if ((countRow?.n ?? 0) >= WORLD_ENTITY_KINDS_CAP) { reply.code(409); return { error: tFor(me.locale, "errors:server.worlds.tooManyKinds") }; }
    const dup = (await db.select({ key: worldEntityKinds.key }).from(worldEntityKinds)
      .where(and(eq(worldEntityKinds.worldId, w.id), sql`lower(${worldEntityKinds.key}) = ${key}`)).limit(1))[0];
    if (dup) { reply.code(409); return { error: tFor(me.locale, "errors:server.worlds.kindExists") }; }
    const maxRow = (await db.select({ m: sql<number>`COALESCE(MAX(${worldEntityKinds.sortOrder}), -1)` }).from(worldEntityKinds).where(eq(worldEntityKinds.worldId, w.id)))[0];
    await db.insert(worldEntityKinds).values({
      worldId: w.id, key, label: body.label, description: body.description ?? "",
      icon: body.icon ?? null, color: body.color ?? null,
      sortOrder: Number(maxRow?.m ?? -1) + 1, createdAt: new Date(),
    });
    const rows = await db.select().from(worldEntityKinds).where(eq(worldEntityKinds.worldId, w.id))
      .orderBy(asc(worldEntityKinds.sortOrder), asc(worldEntityKinds.key));
    return { entityKinds: rows.map(entityKindRowToWire) };
  });

  app.patch<{ Params: { idOrSlug: string; key: string }; Body: unknown }>("/worlds/:idOrSlug/entity-kinds/:key", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    let body; try { body = updateKindBody.parse(req.body); } catch { reply.code(400); return { error: "invalid body" }; }
    const key = req.params.key.toLowerCase();
    const existing = (await db.select().from(worldEntityKinds)
      .where(and(eq(worldEntityKinds.worldId, w.id), sql`lower(${worldEntityKinds.key}) = ${key}`)).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }
    const update: Partial<typeof worldEntityKinds.$inferInsert> = {};
    if (body.label !== undefined) update.label = body.label;
    if (body.description !== undefined) update.description = body.description;
    if (body.icon !== undefined) update.icon = body.icon;
    if (body.color !== undefined) update.color = body.color;
    if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
    await db.update(worldEntityKinds).set(update)
      .where(and(eq(worldEntityKinds.worldId, w.id), eq(worldEntityKinds.key, existing.key)));
    const rows = await db.select().from(worldEntityKinds).where(eq(worldEntityKinds.worldId, w.id))
      .orderBy(asc(worldEntityKinds.sortOrder), asc(worldEntityKinds.key));
    return { entityKinds: rows.map(entityKindRowToWire) };
  });

  app.delete<{ Params: { idOrSlug: string; key: string } }>("/worlds/:idOrSlug/entity-kinds/:key", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    const key = req.params.key.toLowerCase();
    // Refuse to delete a kind that still has entries (avoids orphaning them).
    const inUse = (await db.select({ id: worldEntities.id }).from(worldEntities)
      .where(and(eq(worldEntities.worldId, w.id), eq(worldEntities.kind, key))).limit(1))[0];
    if (inUse) { reply.code(409); return { error: tFor(me.locale, "errors:server.worlds.kindHasEntries") }; }
    await db.delete(worldEntityKinds).where(and(eq(worldEntityKinds.worldId, w.id), sql`lower(${worldEntityKinds.key}) = ${key}`));
    return { ok: true };
  });

  /* ===================================================== *
   *  Arcs (storyline groupings)
   * ===================================================== */

  const arcStatus = z.enum(["planned", "active", "concluded", "archived"]);
  const createArcBody = z.object({
    title: z.string().min(1).max(120),
    slug: z.string().optional(),
    summary: z.string().max(500).optional(),
    status: arcStatus.optional(),
    color: z.string().max(32).nullable().optional(),
  }).strict();
  const updateArcBody = z.object({
    title: z.string().min(1).max(120).optional(),
    slug: z.string().optional(),
    summary: z.string().max(500).optional(),
    status: arcStatus.optional(),
    color: z.string().max(32).nullable().optional(),
    sortOrder: z.number().int().optional(),
  }).strict();

  app.get<{ Params: { idOrSlug: string } }>("/worlds/:idOrSlug/arcs", async (req, reply) => {
    const me = await getSessionUser(req, db);
    const w = await resolveWorld(db, req.params.idOrSlug, me?.id ?? null, me?.role ?? null);
    if (!w) { reply.code(404); return { error: "not found" }; }
    const rows = await db.select().from(worldArcs).where(eq(worldArcs.worldId, w.id))
      .orderBy(asc(worldArcs.sortOrder), asc(worldArcs.createdAt));
    return { arcs: rows.map(arcRowToWire) };
  });

  app.post<{ Params: { idOrSlug: string }; Body: unknown }>("/worlds/:idOrSlug/arcs", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    let body; try { body = createArcBody.parse(req.body); } catch { reply.code(400); return { error: "invalid body" }; }
    const countRow = (await db.select({ n: sql<number>`count(*)` }).from(worldArcs).where(eq(worldArcs.worldId, w.id)))[0];
    if ((countRow?.n ?? 0) >= WORLD_ARCS_CAP) { reply.code(409); return { error: tFor(me.locale, "errors:server.worlds.tooManyArcs") }; }
    const slug = (body.slug?.trim() || deriveSlug(body.title)).toLowerCase();
    if (!SLUG_RX.test(slug)) { reply.code(400); return { error: "invalid slug" }; }
    const dup = (await db.select({ id: worldArcs.id }).from(worldArcs)
      .where(and(eq(worldArcs.worldId, w.id), sql`lower(${worldArcs.slug}) = ${slug}`)).limit(1))[0];
    if (dup) { reply.code(409); return { error: tFor(me.locale, "errors:server.worlds.arcSlugExists") }; }
    const maxRow = (await db.select({ m: sql<number>`COALESCE(MAX(${worldArcs.sortOrder}), -1)` }).from(worldArcs).where(eq(worldArcs.worldId, w.id)))[0];
    const now = new Date();
    const aid = nanoid();
    await db.insert(worldArcs).values({
      id: aid, worldId: w.id, slug, title: body.title, summary: body.summary ?? "",
      status: body.status ?? "active", color: body.color ?? null,
      sortOrder: Number(maxRow?.m ?? -1) + 1, createdAt: now, updatedAt: now,
    });
    await db.update(worlds).set({ updatedAt: now }).where(eq(worlds.id, w.id));
    const created = (await db.select().from(worldArcs).where(eq(worldArcs.id, aid)).limit(1))[0]!;
    return { arc: arcRowToWire(created) };
  });

  app.patch<{ Params: { idOrSlug: string; aid: string }; Body: unknown }>("/worlds/:idOrSlug/arcs/:aid", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    const existing = (await db.select().from(worldArcs)
      .where(and(eq(worldArcs.id, req.params.aid), eq(worldArcs.worldId, w.id))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }
    let body; try { body = updateArcBody.parse(req.body); } catch { reply.code(400); return { error: "invalid body" }; }
    const update: Partial<typeof worldArcs.$inferInsert> = { updatedAt: new Date() };
    if (body.title !== undefined) update.title = body.title;
    if (body.summary !== undefined) update.summary = body.summary;
    if (body.status !== undefined) update.status = body.status;
    if (body.color !== undefined) update.color = body.color;
    if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
    if (body.slug !== undefined) {
      const slug = (body.slug.trim() || deriveSlug(body.title ?? existing.title)).toLowerCase();
      if (!SLUG_RX.test(slug)) { reply.code(400); return { error: "invalid slug" }; }
      const dup = (await db.select({ id: worldArcs.id }).from(worldArcs)
        .where(and(eq(worldArcs.worldId, w.id), sql`lower(${worldArcs.slug}) = ${slug}`, ne(worldArcs.id, existing.id))).limit(1))[0];
      if (dup) { reply.code(409); return { error: tFor(me.locale, "errors:server.worlds.arcSlugExists") }; }
      update.slug = slug;
    }
    await db.update(worldArcs).set(update).where(eq(worldArcs.id, existing.id));
    const updated = (await db.select().from(worldArcs).where(eq(worldArcs.id, existing.id)).limit(1))[0]!;
    return { arc: arcRowToWire(updated) };
  });

  app.delete<{ Params: { idOrSlug: string; aid: string } }>("/worlds/:idOrSlug/arcs/:aid", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    const aid = req.params.aid;
    const existing = (await db.select({ id: worldArcs.id }).from(worldArcs)
      .where(and(eq(worldArcs.id, aid), eq(worldArcs.worldId, w.id))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }
    // Detach references so nothing dangles (no DB FK on arcId).
    await db.update(worldEntities).set({ arcId: null }).where(and(eq(worldEntities.worldId, w.id), eq(worldEntities.arcId, aid)));
    await db.update(worldPages).set({ arcId: null }).where(and(eq(worldPages.worldId, w.id), eq(worldPages.arcId, aid)));
    await db.update(worldSessions).set({ arcId: null }).where(and(eq(worldSessions.worldId, w.id), eq(worldSessions.arcId, aid)));
    await db.delete(worldArcs).where(eq(worldArcs.id, aid));
    await db.update(worlds).set({ updatedAt: new Date() }).where(eq(worlds.id, w.id));
    return { ok: true };
  });

  /* ===================================================== *
   *  Sessions (chronological logs)
   * ===================================================== */

  const createSessionBody = z.object({
    title: z.string().min(1).max(160),
    slug: z.string().optional(),
    summary: z.string().max(500).optional(),
    bodyHtml: z.string().max(WORLD_ENTITY_BODY_MAX * 4).optional(),
    sessionDate: z.number().int().nullable().optional(),
    arcId: z.string().nullable().optional(),
  }).strict();
  const updateSessionBody = z.object({
    title: z.string().min(1).max(160).optional(),
    slug: z.string().optional(),
    summary: z.string().max(500).optional(),
    bodyHtml: z.string().max(WORLD_ENTITY_BODY_MAX * 4).optional(),
    sessionDate: z.number().int().nullable().optional(),
    arcId: z.string().nullable().optional(),
    sortOrder: z.number().int().optional(),
  }).strict();

  app.get<{ Params: { idOrSlug: string; sid: string } }>("/worlds/:idOrSlug/sessions/:sid", async (req, reply) => {
    const me = await getSessionUser(req, db);
    const w = await resolveWorld(db, req.params.idOrSlug, me?.id ?? null, me?.role ?? null);
    if (!w) { reply.code(404); return { error: "not found" }; }
    const s = (await db.select().from(worldSessions)
      .where(and(eq(worldSessions.id, req.params.sid), eq(worldSessions.worldId, w.id))).limit(1))[0];
    if (!s) { reply.code(404); return { error: "not found" }; }
    return { session: sessionRowToWire(s) };
  });

  app.post<{ Params: { idOrSlug: string }; Body: unknown }>("/worlds/:idOrSlug/sessions", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    let body; try { body = createSessionBody.parse(req.body); } catch { reply.code(400); return { error: "invalid body" }; }
    if (body.arcId && !(await arcInWorld(w.id, body.arcId))) { reply.code(400); return { error: "unknown arc" }; }
    const countRow = (await db.select({ n: sql<number>`count(*)` }).from(worldSessions).where(eq(worldSessions.worldId, w.id)))[0];
    if ((countRow?.n ?? 0) >= WORLD_SESSIONS_CAP) { reply.code(409); return { error: tFor(me.locale, "errors:server.worlds.tooManySessions") }; }
    const slug = (body.slug?.trim() || deriveSlug(body.title)).toLowerCase();
    if (!SLUG_RX.test(slug)) { reply.code(400); return { error: "invalid slug" }; }
    const dup = (await db.select({ id: worldSessions.id }).from(worldSessions)
      .where(and(eq(worldSessions.worldId, w.id), sql`lower(${worldSessions.slug}) = ${slug}`)).limit(1))[0];
    if (dup) { reply.code(409); return { error: tFor(me.locale, "errors:server.worlds.sessionSlugExists") }; }
    const maxRow = (await db.select({ m: sql<number>`COALESCE(MAX(${worldSessions.sortOrder}), -1)` }).from(worldSessions).where(eq(worldSessions.worldId, w.id)))[0];
    const now = new Date();
    const sid = nanoid();
    await db.insert(worldSessions).values({
      id: sid, worldId: w.id, arcId: body.arcId ?? null, slug, title: body.title,
      summary: body.summary ?? "", bodyHtml: sanitizeBio(body.bodyHtml ?? ""),
      sessionDate: body.sessionDate != null ? new Date(body.sessionDate) : null,
      sortOrder: Number(maxRow?.m ?? -1) + 1, createdAt: now, updatedAt: now,
    });
    await db.update(worlds).set({ updatedAt: now }).where(eq(worlds.id, w.id));
    const created = (await db.select().from(worldSessions).where(eq(worldSessions.id, sid)).limit(1))[0]!;
    return { session: sessionRowToWire(created) };
  });

  app.patch<{ Params: { idOrSlug: string; sid: string }; Body: unknown }>("/worlds/:idOrSlug/sessions/:sid", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    const existing = (await db.select().from(worldSessions)
      .where(and(eq(worldSessions.id, req.params.sid), eq(worldSessions.worldId, w.id))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }
    let body; try { body = updateSessionBody.parse(req.body); } catch { reply.code(400); return { error: "invalid body" }; }
    const update: Partial<typeof worldSessions.$inferInsert> = { updatedAt: new Date() };
    if (body.title !== undefined) update.title = body.title;
    if (body.summary !== undefined) update.summary = body.summary;
    if (body.bodyHtml !== undefined) update.bodyHtml = sanitizeBio(body.bodyHtml);
    if (body.sessionDate !== undefined) update.sessionDate = body.sessionDate != null ? new Date(body.sessionDate) : null;
    if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
    if (body.arcId !== undefined) {
      if (body.arcId && !(await arcInWorld(w.id, body.arcId))) { reply.code(400); return { error: "unknown arc" }; }
      update.arcId = body.arcId;
    }
    if (body.slug !== undefined) {
      const slug = (body.slug.trim() || deriveSlug(body.title ?? existing.title)).toLowerCase();
      if (!SLUG_RX.test(slug)) { reply.code(400); return { error: "invalid slug" }; }
      const dup = (await db.select({ id: worldSessions.id }).from(worldSessions)
        .where(and(eq(worldSessions.worldId, w.id), sql`lower(${worldSessions.slug}) = ${slug}`, ne(worldSessions.id, existing.id))).limit(1))[0];
      if (dup) { reply.code(409); return { error: tFor(me.locale, "errors:server.worlds.sessionSlugExists") }; }
      update.slug = slug;
    }
    await db.update(worldSessions).set(update).where(eq(worldSessions.id, existing.id));
    await db.update(worlds).set({ updatedAt: new Date() }).where(eq(worlds.id, w.id));
    const updated = (await db.select().from(worldSessions).where(eq(worldSessions.id, existing.id)).limit(1))[0]!;
    return { session: sessionRowToWire(updated) };
  });

  app.delete<{ Params: { idOrSlug: string; sid: string } }>("/worlds/:idOrSlug/sessions/:sid", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    const existing = (await db.select({ id: worldSessions.id }).from(worldSessions)
      .where(and(eq(worldSessions.id, req.params.sid), eq(worldSessions.worldId, w.id))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }
    await db.delete(worldSessions).where(eq(worldSessions.id, existing.id));
    await db.update(worlds).set({ updatedAt: new Date() }).where(eq(worlds.id, w.id));
    return { ok: true };
  });
}
