import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  WORLD_PAGE_DEPTH_CAP,
  WORLD_VIBE_AXES,
  deriveSlug,
  normalizeTheme,
  serializeTagList,
} from "@thekeep/shared";
import type {
  WorldApplicationEntry,
  WorldCatalogPage,
  WorldDetail,
  WorldStatus,
} from "@thekeep/shared";
import { hasPermission } from "../../auth/permissions.js";
import {
  roomWorldLinks,
  users,
  worldApplications,
  worldArcs,
  worldCollaborators,
  worldEntities,
  worldEntityKinds,
  worldPages,
  worldSessions,
  worlds,
} from "../../db/schema.js";
import { sanitizeBio } from "../../auth/html.js";
import { tagIncludes, tagExcludes } from "../../lib/tagFilter.js";
import { escapeLike } from "../../lib/nameLookup.js";
import { resolveOffsetPage, countRows, offsetPageEnvelope } from "../../lib/pagination.js";
import { getSessionUser } from "../auth.js";
import { getSettings } from "../../settings.js";
import { broadcastRoomState } from "../../realtime/broadcast.js";
import type { Db } from "../../db/index.js";
import {
  SLUG_RX,
  catalogQuery,
  createPageBody,
  createWorldBody,
  updatePageBody,
  updateWorldBody,
  toSummary,
  toCatalogEntry,
  resolveWorld,
  canEditWorld,
  memberListFor,
  collaboratorListFor,
  applicationToWire,
  parseApplicationQuestions,
  pageRowToWire,
  entityLightToWire,
  entityKindRowToWire,
  arcRowToWire,
  sessionLightToWire,
  depthOf,
} from "./shared.js";
import type { Io } from "./shared.js";

export async function registerWorldCoreRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  const browseLimit = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } } as const;

  /* ---------- World list (caller's own) ---------- */
  app.get("/me/worlds", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const rows = await db
      .select()
      .from(worlds)
      .where(eq(worlds.ownerUserId, me.id))
      .orderBy(asc(worlds.name));
    const summaries = await Promise.all(rows.map((w) => toSummary(db, w)));
    return { worlds: summaries };
  });

  /* ---------- Featured worlds (public; for the splash carousel) ----------
   *
   * Returns up to `limit` (default 10, capped at 10) randomly-chosen open
   * worlds. Public so the splash AuthGate can fetch it pre-login. Admin
   * toggle `featuredWorldsEnabled` controls whether the splash actually
   * displays the result; this endpoint always serves so callers can preview.
   *
   * The randomness is per-request (`ORDER BY random()`), so two visitors
   * landing simultaneously generally see different rotations - no static
   * cache to bust on world edits, and no popularity bias either.
   */
  app.get<{ Querystring: { limit?: string } }>("/worlds/featured", browseLimit, async (req) => {
    const limit = Math.min(10, Math.max(1, parseInt(req.query.limit ?? "10", 10) || 10));
    // Featured rotation: prefer admin-curated `status="featured"`, fall
    // back to the random sample of open worlds when there aren't enough
    // featured rows to fill the strip. Curated worlds always lead so
    // an admin's deliberate spotlight isn't drowned by the random tail.
    const featured = await db
      .select()
      .from(worlds)
      .where(and(eq(worlds.visibility, "open"), eq(worlds.status, "featured")))
      .orderBy(sql`random()`)
      .limit(limit);
    const need = limit - featured.length;
    const filler = need > 0
      ? await db
          .select()
          .from(worlds)
          .where(and(eq(worlds.visibility, "open"), ne(worlds.status, "featured"), ne(worlds.status, "archived")))
          .orderBy(sql`random()`)
          .limit(need)
      : [];
    const entries = await Promise.all([...featured, ...filler].map((w) => toCatalogEntry(db, w)));
    return { entries };
  });

  /* ---------- World catalog (open visibility, filterable) ---------- */
  app.get<{ Querystring: Record<string, string | string[]> }>("/worlds/catalog", browseLimit, async (req) => {
    const parsed = catalogQuery.safeParse(req.query);
    const q = parsed.success ? parsed.data : ({} as z.infer<typeof catalogQuery>);
    const { page, pageSize } = resolveOffsetPage(q);
    // Build the WHERE incrementally. The base set is "open + not
    // archived" (archived worlds stay reachable via direct link but
    // don't appear in catalog browse).
    const conds: ReturnType<typeof eq>[] = [
      eq(worlds.visibility, "open"),
      ne(worlds.status, "archived"),
    ];
    if (q.genre) conds.push(eq(worlds.genre, q.genre));
    if (q.status) conds.push(eq(worlds.status, q.status));
    // Text search across name + description + tags. SQLite LIKE is
    // case-insensitive for ASCII; the patterns are escaped to keep `%`
    // and `_` literal so a search for "20% off" doesn't go wild.
    if (q.q && q.q.trim()) {
      const like = `%${escapeLike(q.q.trim()).toLowerCase()}%`;
      conds.push(or(
        sql`lower(${worlds.name}) LIKE ${like} ESCAPE '\\'`,
        sql`lower(${worlds.description}) LIKE ${like} ESCAPE '\\'`,
        sql`lower(${worlds.tags}) LIKE ${like} ESCAPE '\\'`,
      )!);
    }
    // Tags: AND together (a world must carry every requested tag). We
    // use substring matches since tags are stored as comma-separated;
    // wrap the column in commas so a search for `,courtly,` doesn't
    // accidentally match `low-courtly` or similar substring overlaps.
    if (q.tag && q.tag.length > 0) {
      for (const tag of q.tag) {
        conds.push(tagIncludes(worlds.tags, tag));
      }
    }
    // Exclude any world that lists ANY of these content warnings. Same
    // bracketed-substring approach as tags.
    if (q.exclude && q.exclude.length > 0) {
      for (const cw of q.exclude) {
        conds.push(tagExcludes(worlds.contentWarnings, cw));
      }
    }
    // Vibe-stat range filters. For each axis the user constrained, the
    // world's tuned value must sit inside the [min, max] closed
    // interval, AND the column must be non-null. "Unset" worlds drop
    // out of any filtered view because "no opinion" doesn't satisfy a
    // specific user constraint; with NO filter applied (the default),
    // unset worlds remain visible because no `conds.push` runs.
    // Each axis maps to its DB column via a small lookup table.
    // Typed as `SqliteColumnLike` (a structural alias for "anything
    // SQL template literals will accept as a column") because the
    // eight columns have distinct drizzle name-literal types and
    // can't all fit one `typeof worlds.statCombat` slot.
    const STAT_COLS = {
      combat: worlds.statCombat,
      magic: worlds.statMagic,
      technology: worlds.statTechnology,
      romance: worlds.statRomance,
      politics: worlds.statPolitics,
      mystery: worlds.statMystery,
      horror: worlds.statHorror,
      exploration: worlds.statExploration,
    } as const;
    for (const axis of WORLD_VIBE_AXES) {
      const min = (q as Record<string, unknown>)[`min_${axis.key}`] as number | undefined;
      const max = (q as Record<string, unknown>)[`max_${axis.key}`] as number | undefined;
      if (min === undefined && max === undefined) continue;
      const col = STAT_COLS[axis.key];
      conds.push(sql`${col} IS NOT NULL`);
      if (min !== undefined) conds.push(sql`${col} >= ${min}`);
      if (max !== undefined) conds.push(sql`${col} <= ${max}`);
    }
    const whereExpr = and(...conds);
    const total = await countRows(db, worlds, whereExpr);
    const rows = await db
      .select()
      .from(worlds)
      .where(whereExpr)
      // Featured first so admin curation reads top-of-page; then by
      // recency so freshly-updated worlds bubble up.
      .orderBy(
        sql`CASE ${worlds.status} WHEN 'featured' THEN 0 ELSE 1 END`,
        desc(worlds.updatedAt),
      )
      .limit(pageSize)
      .offset(page * pageSize);
    const entries = await Promise.all(rows.map((w) => toCatalogEntry(db, w)));
    const payload: WorldCatalogPage = offsetPageEnvelope({ entries, page, pageSize, total });
    return payload;
  });

  /* ---------- Create world ---------- */
  app.post<{ Body: unknown }>("/worlds", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    let body;
    try { body = createWorldBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const slug = (body.slug ?? deriveSlug(body.name)).toLowerCase();
    if (!SLUG_RX.test(slug)) {
      reply.code(400);
      return { error: "slug must be 1-60 lowercase letters, numbers, hyphens" };
    }

    // Per-owner uniqueness.
    const dup = (await db
      .select()
      .from(worlds)
      .where(and(eq(worlds.ownerUserId, me.id), sql`lower(${worlds.slug}) = ${slug}`))
      .limit(1))[0];
    if (dup) { reply.code(409); return { error: "you already have a world with that slug" }; }

    // `featured` is admin-curated only; silently downgrade to `active`
    // when an owner attempts to self-promote on create. We don't error
    // here because the rest of the body is valid, the surprise of a
    // 400 over a single forbidden enum value would be hostile when the
    // owner's intent is clearly "publish this world."
    let initialStatus: WorldStatus = body.status ?? "active";
    if (initialStatus === "featured" && !(await hasPermission(me, "feature_worlds", db))) {
      initialStatus = "active";
    }

    const id = nanoid();
    const vs = body.vibeStats;
    await db.insert(worlds).values({
      id,
      ownerUserId: me.id,
      slug,
      name: body.name.trim(),
      description: body.description?.trim() || null,
      visibility: body.visibility ?? "private",
      genre: body.genre ?? "other",
      tags: body.tags ? serializeTagList(body.tags) : "",
      contentWarnings: body.contentWarnings ? serializeTagList(body.contentWarnings) : "",
      status: initialStatus,
      coverImageUrl: body.coverImageUrl ?? null,
      pacing: body.pacing ?? null,
      statCombat: vs?.combat ?? null,
      statMagic: vs?.magic ?? null,
      statTechnology: vs?.technology ?? null,
      statRomance: vs?.romance ?? null,
      statPolitics: vs?.politics ?? null,
      statMystery: vs?.mystery ?? null,
      statHorror: vs?.horror ?? null,
      statExploration: vs?.exploration ?? null,
      joinMode: body.joinMode ?? "open",
      applicationQuestionsJson: JSON.stringify(body.applicationQuestions ?? []),
    });
    const created = (await db.select().from(worlds).where(eq(worlds.id, id)).limit(1))[0]!;
    reply.code(201);
    return await toSummary(db, created);
  });

  /* ---------- Read world (summary + full pages list + members) ---------- */
  app.get<{ Params: { idOrSlug: string } }>("/worlds/:idOrSlug", browseLimit, async (req, reply) => {
    const me = await getSessionUser(req, db);
    const w = await resolveWorld(db, req.params.idOrSlug, me?.id ?? null, me?.role ?? null);
    if (!w) {
      // Anonymous deep-link to a private world: surface a "private" stub so
      // the splash can render a "this world is private, sign in to view"
      // hint, mirroring the profile flow. We deliberately return HTTP 200
      // so a fetch() doesn't treat it as an error; the discriminating shape
      // is the `private: true` field. Truly missing slugs still 404.
      if (!me) {
        const raw = (await db
          .select()
          .from(worlds)
          .where(or(
            eq(worlds.id, req.params.idOrSlug),
            sql`lower(${worlds.slug}) = ${req.params.idOrSlug.toLowerCase()}`,
          ))
          .limit(1))[0];
        if (raw && raw.visibility === "private") {
          return {
            private: true as const,
            name: raw.name,
            slug: raw.slug,
            requiresAuth: true,
          };
        }
      }
      reply.code(404);
      return { error: "not found" };
    }
    const pages = await db
      .select()
      .from(worldPages)
      .where(eq(worldPages.worldId, w.id))
      .orderBy(asc(worldPages.sortOrder), asc(worldPages.createdAt));
    const members = await memberListFor(db, w.id);
    // viewerIsMember asks "is the viewer's CURRENT identity a member
    // of this world?" Other identities of the same master may also be
    // members; this flag only reflects the face the viewer is wearing
    // right now (which is what drives the catalog button + the world
    // page's Join/Leave affordance).
    const viewerCharId: string | null = me?.activeCharacterId ?? null;
    const viewerMember = me
      ? members.find((m) => m.userId === me.id && m.characterId === viewerCharId) ?? null
      : null;
    // Collaborator surface. Always loaded so the client can show the
    // wiki-editor's owner-only "Collaborators" panel without a second
    // round trip. Non-owners get the same list, handy for "who else
    // can edit this" transparency on a shared wiki, but the client
    // gates the add/remove controls on viewerIsOwner.
    const collaborators = await collaboratorListFor(db, w.id);
    const viewerIsOwner = !!me && w.ownerUserId === me.id;
    const viewerCanEdit = await canEditWorld(db, w, me?.id ?? null, me?.role ?? null);
    // Pull the viewer's most recent application against this world,
    // if any, so the client can drive the Apply/Pending/Rejected
    // button state from a single fetch. Owners look at the editor's
    // full Applications pane instead, so we skip this work for them
    // (the field stays null on the owner's view).
    let viewerApplication: WorldApplicationEntry | null = null;
    if (me && !viewerIsOwner) {
      // Per-identity lookup: an applicant's most recent application
      // for the IDENTITY they're currently voicing. Other identities
      // of the same master have their own application histories
      // (each can apply once at a time per world).
      const appRow = (await db
        .select()
        .from(worldApplications)
        .where(and(
          eq(worldApplications.worldId, w.id),
          eq(worldApplications.applicantUserId, me.id),
          viewerCharId === null
            ? sql`${worldApplications.characterId} IS NULL`
            : eq(worldApplications.characterId, viewerCharId),
        ))
        .orderBy(desc(worldApplications.submittedAt))
        .limit(1))[0];
      if (appRow) {
        viewerApplication = await applicationToWire(
          db,
          appRow,
          parseApplicationQuestions(w.applicationQuestionsJson),
        );
      }
    }
    // Typed entries (light rows) + custom kind registry for the knowledge-base
    // dashboard. Non-editors see only public entries (mirrors the codex gate).
    const entityRows = await db
      .select()
      .from(worldEntities)
      .where(eq(worldEntities.worldId, w.id))
      .orderBy(asc(worldEntities.kind), asc(worldEntities.sortOrder), asc(worldEntities.createdAt));
    const visibleEntities = viewerCanEdit ? entityRows : entityRows.filter((r) => !!r.isPublic);
    const entityKindRows = await db
      .select()
      .from(worldEntityKinds)
      .where(eq(worldEntityKinds.worldId, w.id))
      .orderBy(asc(worldEntityKinds.sortOrder), asc(worldEntityKinds.key));
    const arcRows = await db
      .select()
      .from(worldArcs)
      .where(eq(worldArcs.worldId, w.id))
      .orderBy(asc(worldArcs.sortOrder), asc(worldArcs.createdAt));
    const sessionRows = await db
      .select()
      .from(worldSessions)
      .where(eq(worldSessions.worldId, w.id))
      .orderBy(desc(worldSessions.sessionDate), asc(worldSessions.sortOrder), asc(worldSessions.createdAt));
    const detail: WorldDetail = {
      world: await toSummary(db, w),
      pages: pages.map(pageRowToWire),
      members,
      viewerIsMember: viewerMember !== null,
      viewerIsOwner,
      viewerCanEdit,
      collaborators,
      entities: visibleEntities.map(entityLightToWire),
      entityKinds: entityKindRows.map(entityKindRowToWire),
      arcs: arcRows.map(arcRowToWire),
      sessions: sessionRows.map(sessionLightToWire),
      viewerApplication,
    };
    return detail;
  });

  /* ---------- Collaborators (list / add / remove) ----------
   * Adding and removing collaborators is owner-only (or admin).
   * Collaborators themselves cannot manage the collaborator list,
   * matching the migration 0174 design note. */
  app.post<{ Params: { idOrSlug: string }; Body: unknown }>(
    "/worlds/:idOrSlug/collaborators",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
      if (!w) { reply.code(404); return { error: "not found" }; }
      // Owner OR admin only, collaborators can't promote others.
      if (w.ownerUserId !== me.id && !(await hasPermission(me, "edit_others_world", db))) {
        reply.code(403); return { error: "owner only" };
      }
      const body = z.object({ username: z.string().min(1).max(80) }).safeParse(req.body);
      if (!body.success) { reply.code(400); return { error: "invalid body" }; }
      const username = body.data.username.trim();
      const user = (await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(sql`lower(${users.username}) = lower(${username})`)
        .limit(1))[0];
      if (!user) { reply.code(404); return { error: "no such user" }; }
      if (user.id === w.ownerUserId) {
        reply.code(409); return { error: "owner is already an editor" };
      }
      await db
        .insert(worldCollaborators)
        .values({
          worldId: w.id,
          userId: user.id,
          addedByUserId: me.id,
        })
        .onConflictDoNothing({
          target: [worldCollaborators.worldId, worldCollaborators.userId],
        });
      return { ok: true, collaborators: await collaboratorListFor(db, w.id) };
    },
  );

  app.delete<{ Params: { idOrSlug: string; userId: string } }>(
    "/worlds/:idOrSlug/collaborators/:userId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
      if (!w) { reply.code(404); return { error: "not found" }; }
      // Two valid removers: the world owner / admin, or the
      // collaborator removing themselves ("leave"). Anyone else is 403.
      const selfLeave = req.params.userId === me.id;
      const isOwnerOrAdmin = w.ownerUserId === me.id || (await hasPermission(me, "edit_others_world", db));
      if (!selfLeave && !isOwnerOrAdmin) {
        reply.code(403); return { error: "owner only" };
      }
      await db
        .delete(worldCollaborators)
        .where(and(
          eq(worldCollaborators.worldId, w.id),
          eq(worldCollaborators.userId, req.params.userId),
        ));
      return { ok: true, collaborators: await collaboratorListFor(db, w.id) };
    },
  );

  /* ---------- Update world ---------- */
  app.patch<{ Params: { idOrSlug: string }; Body: unknown }>("/worlds/:idOrSlug", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }

    let body;
    try { body = updateWorldBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const update: Partial<typeof worlds.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) update.name = body.name.trim();
    if (body.description !== undefined) update.description = body.description?.trim() || null;
    if (body.visibility !== undefined) update.visibility = body.visibility;
    if (body.theme !== undefined) {
      // null clears it; any object is normalized to a Theme shape (drops
      // unknown keys, falls back to defaults for missing ones).
      update.theme = body.theme === null
        ? null
        : JSON.stringify(normalizeTheme(body.theme));
    }
    if (body.genre !== undefined) update.genre = body.genre;
    if (body.tags !== undefined) update.tags = serializeTagList(body.tags);
    if (body.contentWarnings !== undefined) {
      update.contentWarnings = serializeTagList(body.contentWarnings);
    }
    if (body.status !== undefined) {
      // Non-admin owners can move between `active` ↔ `archived`. Only
      // admins can set `featured`; an owner attempting to self-promote
      // is silently downgraded to `active` for the same UX reason as
      // the create path (no hostile 400 over one field).
      if (body.status === "featured" && !(await hasPermission(me, "feature_worlds", db))) {
        update.status = "active";
      } else {
        update.status = body.status;
      }
    }
    if (body.coverImageUrl !== undefined) {
      update.coverImageUrl = body.coverImageUrl ?? null;
    }
    if (body.pacing !== undefined) update.pacing = body.pacing ?? null;
    if (body.vibeStats !== undefined) {
      // Only the axes the body actually carries get updated. An axis
      // sent as `null` clears it; an absent axis is left alone. This
      // lets the editor's per-slider "reset" button clear ONE axis
      // without touching the others.
      const vs = body.vibeStats;
      if ("combat" in vs) update.statCombat = vs.combat ?? null;
      if ("magic" in vs) update.statMagic = vs.magic ?? null;
      if ("technology" in vs) update.statTechnology = vs.technology ?? null;
      if ("romance" in vs) update.statRomance = vs.romance ?? null;
      if ("politics" in vs) update.statPolitics = vs.politics ?? null;
      if ("mystery" in vs) update.statMystery = vs.mystery ?? null;
      if ("horror" in vs) update.statHorror = vs.horror ?? null;
      if ("exploration" in vs) update.statExploration = vs.exploration ?? null;
    }
    if (body.joinMode !== undefined) update.joinMode = body.joinMode;
    if (body.applicationQuestions !== undefined) {
      update.applicationQuestionsJson = JSON.stringify(body.applicationQuestions);
    }
    if (body.slug !== undefined) {
      const slug = body.slug.toLowerCase();
      if (!SLUG_RX.test(slug)) { reply.code(400); return { error: "slug must be 1-60 lowercase letters, numbers, hyphens" }; }
      if (slug !== w.slug.toLowerCase()) {
        const dup = (await db
          .select()
          .from(worlds)
          .where(and(eq(worlds.ownerUserId, w.ownerUserId), sql`lower(${worlds.slug}) = ${slug}`, ne(worlds.id, w.id)))
          .limit(1))[0];
        if (dup) { reply.code(409); return { error: "you already have a world with that slug" }; }
        update.slug = slug;
      }
    }
    await db.update(worlds).set(update).where(eq(worlds.id, w.id));
    return { ok: true };
  });

  /* ---------- Delete world (cascade) ---------- */
  app.delete<{ Params: { idOrSlug: string } }>("/worlds/:idOrSlug", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (w.ownerUserId !== me.id && !(await hasPermission(me, "delete_others_world", db))) {
      reply.code(403); return { error: "not yours" };
    }
    // Find all rooms currently linked to this world so we can re-broadcast
    // their state after the link cascade-deletes (so the chat banner
    // disappears in real time).
    const linkedRooms = await db
      .select({ roomId: roomWorldLinks.roomId })
      .from(roomWorldLinks)
      .where(eq(roomWorldLinks.worldId, w.id));
    await db.delete(worlds).where(eq(worlds.id, w.id));
    for (const r of linkedRooms) {
      await broadcastRoomState(io, db, r.roomId).catch(() => {});
    }
    return { ok: true };
  });

  /* ---------- Create page ---------- */
  app.post<{ Params: { idOrSlug: string }; Body: unknown }>(
    "/worlds/:idOrSlug/pages",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
      if (!w) { reply.code(404); return { error: "not found" }; }
      if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }

      let body;
      try { body = createPageBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      // parent existence + same-world check
      if (body.parentPageId) {
        const parent = (await db.select().from(worldPages).where(eq(worldPages.id, body.parentPageId)).limit(1))[0];
        if (!parent || parent.worldId !== w.id) {
          reply.code(400);
          return { error: "parent page does not belong to this world" };
        }
      }

      // Depth cap. depth(parent) + 1 <= WORLD_PAGE_DEPTH_CAP - 1 means
      // child's depth <= cap-1, i.e. cap means "up to 10 levels (0..9)".
      const newDepth = await depthOf(db, body.parentPageId ?? null);
      if (newDepth > WORLD_PAGE_DEPTH_CAP - 1) {
        reply.code(400);
        return { error: `Page tree is capped at ${WORLD_PAGE_DEPTH_CAP} levels.` };
      }

      const slug = (body.slug ?? deriveSlug(body.title)).toLowerCase();
      if (!SLUG_RX.test(slug)) {
        reply.code(400);
        return { error: "slug must be 1-60 lowercase letters, numbers, hyphens" };
      }

      // Body cap follows the bio cap (admin-tunable).
      const { maxBioLength } = await getSettings(db);
      if ((body.bodyHtml ?? "").length > maxBioLength) {
        reply.code(413);
        return { error: `Page body capped at ${maxBioLength} chars.` };
      }

      const id = nanoid();
      await db.insert(worldPages).values({
        id,
        worldId: w.id,
        parentPageId: body.parentPageId ?? null,
        slug,
        title: body.title.trim(),
        bodyHtml: sanitizeBio(body.bodyHtml ?? ""),
        sortOrder: body.sortOrder ?? 0,
      });
      // Touch world.updatedAt so catalog rankings reflect activity.
      await db.update(worlds).set({ updatedAt: new Date() }).where(eq(worlds.id, w.id));
      const row = (await db.select().from(worldPages).where(eq(worldPages.id, id)).limit(1))[0]!;
      reply.code(201);
      return pageRowToWire(row);
    },
  );

  /* ---------- Update page ---------- */
  app.patch<{ Params: { idOrSlug: string; pageId: string }; Body: unknown }>(
    "/worlds/:idOrSlug/pages/:pageId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
      if (!w) { reply.code(404); return { error: "not found" }; }
      if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }

      let body;
      try { body = updatePageBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const existing = (await db
        .select()
        .from(worldPages)
        .where(and(eq(worldPages.id, req.params.pageId), eq(worldPages.worldId, w.id)))
        .limit(1))[0];
      if (!existing) { reply.code(404); return { error: "not found" }; }

      // Reparent? Validate target parent is in this world AND isn't
      // a descendant (no cycles), and that the new depth fits the cap.
      if (body.parentPageId !== undefined && body.parentPageId !== existing.parentPageId) {
        if (body.parentPageId) {
          if (body.parentPageId === existing.id) {
            reply.code(400); return { error: "page can't be its own parent" };
          }
          // Walk new parent up to ensure existing.id isn't an ancestor.
          let cursor: string | null = body.parentPageId;
          for (let i = 0; i < 64; i++) {
            if (!cursor) break;
            const currentId: string = cursor;
            const parentRow = (await db
              .select()
              .from(worldPages)
              .where(eq(worldPages.id, currentId))
              .limit(1))[0];
            if (!parentRow || parentRow.worldId !== w.id) {
              reply.code(400); return { error: "parent page does not belong to this world" };
            }
            if (parentRow.id === existing.id) {
              reply.code(400); return { error: "moving here would create a cycle" };
            }
            cursor = parentRow.parentPageId;
          }
          const newDepth = await depthOf(db, body.parentPageId);
          if (newDepth > WORLD_PAGE_DEPTH_CAP - 1) {
            reply.code(400);
            return { error: `Page tree is capped at ${WORLD_PAGE_DEPTH_CAP} levels.` };
          }
        }
      }

      if (body.bodyHtml !== undefined) {
        const { maxBioLength } = await getSettings(db);
        if (body.bodyHtml.length > maxBioLength) {
          reply.code(413);
          return { error: `Page body capped at ${maxBioLength} chars.` };
        }
      }

      const update: Partial<typeof worldPages.$inferInsert> = { updatedAt: new Date() };
      if (body.title !== undefined) update.title = body.title.trim();
      if (body.bodyHtml !== undefined) update.bodyHtml = sanitizeBio(body.bodyHtml);
      if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
      if (body.parentPageId !== undefined) update.parentPageId = body.parentPageId;
      if (body.slug !== undefined) {
        const slug = body.slug.toLowerCase();
        if (!SLUG_RX.test(slug)) {
          reply.code(400); return { error: "slug must be 1-60 lowercase letters, numbers, hyphens" };
        }
        update.slug = slug;
      }
      await db.update(worldPages).set(update).where(eq(worldPages.id, existing.id));
      await db.update(worlds).set({ updatedAt: new Date() }).where(eq(worlds.id, w.id));
      return { ok: true };
    },
  );

  /* ---------- Delete page (cascades to children) ---------- */
  app.delete<{ Params: { idOrSlug: string; pageId: string } }>(
    "/worlds/:idOrSlug/pages/:pageId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
      if (!w) { reply.code(404); return { error: "not found" }; }
      if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
      const existing = (await db
        .select()
        .from(worldPages)
        .where(and(eq(worldPages.id, req.params.pageId), eq(worldPages.worldId, w.id)))
        .limit(1))[0];
      if (!existing) { reply.code(404); return { error: "not found" }; }
      await db.delete(worldPages).where(eq(worldPages.id, existing.id));
      await db.update(worlds).set({ updatedAt: new Date() }).where(eq(worlds.id, w.id));
      return { ok: true };
    },
  );
}
