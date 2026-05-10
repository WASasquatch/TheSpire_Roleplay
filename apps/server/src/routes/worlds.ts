import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type {
  Theme,
  WorldCatalogEntry,
  WorldDetail,
  WorldMemberRef,
  WorldMembership,
  WorldPage,
  WorldSummary,
  WorldVisibility,
} from "@thekeep/shared";
import { WORLD_PAGE_DEPTH_CAP, normalizeTheme } from "@thekeep/shared";
import {
  roomMembers,
  roomWorldLinks,
  rooms,
  users,
  worldMembers,
  worldPages,
  worlds,
} from "../db/schema.js";
import { sanitizeBio } from "../auth/html.js";
import { getSessionUser } from "./auth.js";
import { getSettings } from "../settings.js";
import { broadcastPresence, broadcastRoomState } from "../realtime/broadcast.js";
import type { Db } from "../db/index.js";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/**
 * Slug rules: lowercase letters, numbers, hyphens. 1-60 chars. The slug
 * lives in URLs and slash commands, so we keep it tight.
 */
const SLUG_RX = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

function deriveSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

const visibilityEnum = z.enum(["private", "public", "open"]);

const createWorldBody = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().max(60).optional(),
  description: z.string().max(2000).nullable().optional(),
  visibility: visibilityEnum.optional(),
}).strict();

// Theme is a free-form object passed to normalizeTheme on the way in. We
// accept "any object" at the schema level and let normalize do the actual
// sanitisation; null clears the theme back to the default.
const updateWorldBody = z.object({
  name: z.string().min(1).max(120).optional(),
  slug: z.string().max(60).optional(),
  description: z.string().max(2000).nullable().optional(),
  visibility: visibilityEnum.optional(),
  theme: z.union([z.record(z.unknown()), z.null()]).optional(),
}).strict();

const setPrimaryWorldBody = z.object({
  worldId: z.string().nullable(),
}).strict();

const createPageBody = z.object({
  title: z.string().min(1).max(120),
  slug: z.string().max(60).optional(),
  parentPageId: z.string().nullable().optional(),
  bodyHtml: z.string().optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
}).strict();

const updatePageBody = z.object({
  title: z.string().min(1).max(120).optional(),
  slug: z.string().max(60).optional(),
  parentPageId: z.string().nullable().optional(),
  bodyHtml: z.string().optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
}).strict();

const linkWorldBody = z.object({
  worldId: z.string().min(1),
}).strict();

/* =========================================================
 *  Internal helpers
 * ========================================================= */

async function loadOwnerUsername(db: Db, userId: string): Promise<string> {
  const u = (await db.select({ username: users.username }).from(users).where(eq(users.id, userId)).limit(1))[0];
  return u?.username ?? "(deleted user)";
}

async function pageCount(db: Db, worldId: string): Promise<number> {
  const r = (await db
    .select({ n: sql<number>`count(*)` })
    .from(worldPages)
    .where(eq(worldPages.worldId, worldId)))[0];
  return r?.n ?? 0;
}

async function memberCountFor(db: Db, worldId: string): Promise<number> {
  const r = (await db
    .select({ n: sql<number>`count(*)` })
    .from(worldMembers)
    .where(eq(worldMembers.worldId, worldId)))[0];
  return r?.n ?? 0;
}

/**
 * Materialize the member list for a world (used in WorldDetail). Resolves
 * usernames in one extra query per row; fine at chat-room scale, switch to
 * a join if the modal ever paginates.
 */
async function memberListFor(db: Db, worldId: string): Promise<WorldMemberRef[]> {
  const rows = await db
    .select({
      userId: worldMembers.userId,
      joinedAt: worldMembers.joinedAt,
      isPrimary: worldMembers.isPrimary,
      username: users.username,
    })
    .from(worldMembers)
    .innerJoin(users, eq(users.id, worldMembers.userId))
    .where(eq(worldMembers.worldId, worldId))
    .orderBy(desc(worldMembers.isPrimary), asc(worldMembers.joinedAt));
  return rows.map((r) => ({
    userId: r.userId,
    username: r.username,
    joinedAt: +r.joinedAt,
    isPrimary: !!r.isPrimary,
  }));
}

/** Parse the `theme` JSON column. Stored as TEXT to keep SQLite happy. */
function parseStoredTheme(raw: string | null): Theme | null {
  if (!raw) return null;
  try { return normalizeTheme(JSON.parse(raw)); }
  catch { return null; }
}

async function toSummary(db: Db, w: typeof worlds.$inferSelect): Promise<WorldSummary> {
  const ownerUsername = await loadOwnerUsername(db, w.ownerUserId);
  return {
    id: w.id,
    slug: w.slug,
    ownerUserId: w.ownerUserId,
    ownerUsername,
    name: w.name,
    description: w.description,
    visibility: w.visibility as WorldVisibility,
    pageCount: await pageCount(db, w.id),
    memberCount: await memberCountFor(db, w.id),
    theme: parseStoredTheme(w.theme),
    createdAt: +w.createdAt,
    updatedAt: +w.updatedAt,
  };
}

function pageRowToWire(p: typeof worldPages.$inferSelect): WorldPage {
  return {
    id: p.id,
    worldId: p.worldId,
    parentPageId: p.parentPageId,
    slug: p.slug,
    title: p.title,
    bodyHtml: p.bodyHtml,
    sortOrder: p.sortOrder,
    createdAt: +p.createdAt,
    updatedAt: +p.updatedAt,
  };
}

/**
 * Resolve a world by id-or-slug, plus an authenticated viewer's view rights.
 * The slug-shaped routes use this to accept either form for friendly URLs.
 *
 * Visibility check: private worlds resolve only for the owner / admin.
 * public + open resolve for anyone.
 */
async function resolveWorld(
  db: Db,
  idOrSlug: string,
  viewerUserId: string | null,
  viewerRole: "user" | "trusted" | "mod" | "admin" | null,
): Promise<typeof worlds.$inferSelect | null> {
  // Try id first (cheap; slugs are friendlier but ids are uuid-shaped).
  let w = (await db.select().from(worlds).where(eq(worlds.id, idOrSlug)).limit(1))[0];
  if (!w) {
    // Slug lookup is per-owner-unique, so a bare slug needs disambiguation.
    // For viewer convenience: if the viewer is logged in, prefer their own
    // world with that slug; otherwise pick the first public/open match.
    if (viewerUserId) {
      const own = (await db
        .select()
        .from(worlds)
        .where(and(eq(worlds.ownerUserId, viewerUserId), sql`lower(${worlds.slug}) = ${idOrSlug.toLowerCase()}`))
        .limit(1))[0];
      if (own) w = own;
    }
    if (!w) {
      const pub = (await db
        .select()
        .from(worlds)
        .where(and(
          sql`lower(${worlds.slug}) = ${idOrSlug.toLowerCase()}`,
          or(eq(worlds.visibility, "public"), eq(worlds.visibility, "open")),
        ))
        .limit(1))[0];
      if (pub) w = pub;
    }
  }
  if (!w) return null;
  const viewable = w.visibility !== "private"
    || (viewerUserId && w.ownerUserId === viewerUserId)
    || viewerRole === "admin";
  if (!viewable) return null;
  return w;
}

/** Walk the parent chain to compute a candidate page's depth (root = 0). */
async function depthOf(db: Db, parentPageId: string | null): Promise<number> {
  if (!parentPageId) return 0;
  let depth = 1;
  let current = parentPageId;
  for (let i = 0; i < WORLD_PAGE_DEPTH_CAP + 2; i++) {
    const p = (await db.select().from(worldPages).where(eq(worldPages.id, current)).limit(1))[0];
    if (!p?.parentPageId) return depth;
    current = p.parentPageId;
    depth++;
  }
  // Cycle detection bail-out; should never happen with FK cascade integrity.
  return WORLD_PAGE_DEPTH_CAP + 1;
}

async function callerCanModerateRoom(db: Db, userId: string, role: string, roomId: string): Promise<boolean> {
  if (role === "admin") return true;
  const room = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room) return false;
  if (room.ownerId === userId) return true;
  const m = (await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    .limit(1))[0];
  return m?.role === "owner" || m?.role === "mod";
}

/**
 * Membership changes alter the userlist (sort/grouping by primary world), so
 * any room the user is currently in needs a fresh presence broadcast. We
 * scan the user's live sockets for the rooms they're in - cheap at our
 * scale, and avoids piping a "current room id" into every API call.
 */
async function rebroadcastUserOccupancy(io: Io, db: Db, userId: string): Promise<void> {
  const sockets = await io.fetchSockets();
  const roomsToRefresh = new Set<string>();
  for (const s of sockets) {
    if ((s.data as { userId?: string }).userId !== userId) continue;
    for (const r of s.rooms) {
      if (r.startsWith("room:")) roomsToRefresh.add(r.slice(5));
    }
  }
  for (const rid of roomsToRefresh) {
    await broadcastPresence(io, db, rid).catch(() => {});
  }
}

/* =========================================================
 *  Route registration
 * ========================================================= */

export async function registerWorldRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
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
  app.get<{ Querystring: { limit?: string } }>("/worlds/featured", async (req) => {
    const limit = Math.min(10, Math.max(1, parseInt(req.query.limit ?? "10", 10) || 10));
    const rows = await db
      .select()
      .from(worlds)
      .where(eq(worlds.visibility, "open"))
      .orderBy(sql`random()`)
      .limit(limit);
    const entries: WorldCatalogEntry[] = await Promise.all(
      rows.map(async (w) => ({
        id: w.id,
        slug: w.slug,
        ownerUsername: await loadOwnerUsername(db, w.ownerUserId),
        name: w.name,
        description: w.description,
        pageCount: await pageCount(db, w.id),
        memberCount: await memberCountFor(db, w.id),
        updatedAt: +w.updatedAt,
      })),
    );
    return { entries };
  });

  /* ---------- World catalog (open visibility) ---------- */
  app.get<{ Querystring: { limit?: string } }>("/worlds/catalog", async (req) => {
    const limit = Math.min(200, parseInt(req.query.limit ?? "100", 10) || 100);
    const rows = await db
      .select()
      .from(worlds)
      .where(eq(worlds.visibility, "open"))
      .orderBy(desc(worlds.updatedAt))
      .limit(limit);
    const entries: WorldCatalogEntry[] = await Promise.all(
      rows.map(async (w) => ({
        id: w.id,
        slug: w.slug,
        ownerUsername: await loadOwnerUsername(db, w.ownerUserId),
        name: w.name,
        description: w.description,
        pageCount: await pageCount(db, w.id),
        memberCount: await memberCountFor(db, w.id),
        updatedAt: +w.updatedAt,
      })),
    );
    return { entries };
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

    const id = nanoid();
    await db.insert(worlds).values({
      id,
      ownerUserId: me.id,
      slug,
      name: body.name.trim(),
      description: body.description?.trim() || null,
      visibility: body.visibility ?? "private",
    });
    const created = (await db.select().from(worlds).where(eq(worlds.id, id)).limit(1))[0]!;
    reply.code(201);
    return await toSummary(db, created);
  });

  /* ---------- Read world (summary + full pages list + members) ---------- */
  app.get<{ Params: { idOrSlug: string } }>("/worlds/:idOrSlug", async (req, reply) => {
    const me = await getSessionUser(req, db);
    const w = await resolveWorld(db, req.params.idOrSlug, me?.id ?? null, me?.role ?? null);
    if (!w) {
      // Anonymous deep-link to a private world: surface a "private" stub so
      // the splash can render a "this world is private — sign in to view"
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
    const viewerMember = me ? members.find((m) => m.userId === me.id) ?? null : null;
    const detail: WorldDetail = {
      world: await toSummary(db, w),
      pages: pages.map(pageRowToWire),
      members,
      viewerIsMember: viewerMember !== null,
      viewerPrimary: !!viewerMember?.isPrimary,
    };
    return detail;
  });

  /* ---------- Update world ---------- */
  app.patch<{ Params: { idOrSlug: string }; Body: unknown }>("/worlds/:idOrSlug", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (w.ownerUserId !== me.id && me.role !== "admin") { reply.code(403); return { error: "not yours" }; }

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
    if (w.ownerUserId !== me.id && me.role !== "admin") { reply.code(403); return { error: "not yours" }; }
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
      if (w.ownerUserId !== me.id && me.role !== "admin") { reply.code(403); return { error: "not yours" }; }

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
      if (w.ownerUserId !== me.id && me.role !== "admin") { reply.code(403); return { error: "not yours" }; }

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
      if (w.ownerUserId !== me.id && me.role !== "admin") { reply.code(403); return { error: "not yours" }; }
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

  /* ---------- Link a world to a room ---------- */
  app.put<{ Params: { roomId: string }; Body: unknown }>(
    "/rooms/:roomId/world",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      if (!(await callerCanModerateRoom(db, me.id, me.role, req.params.roomId))) {
        reply.code(403); return { error: "room owner / mod / admin only" };
      }

      let body;
      try { body = linkWorldBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const w = await resolveWorld(db, body.worldId, me.id, me.role);
      if (!w) { reply.code(404); return { error: "world not found" }; }
      // Linking other people's worlds requires visibility = open.
      if (w.ownerUserId !== me.id && me.role !== "admin" && w.visibility !== "open") {
        reply.code(403);
        return { error: "world isn't open for catalog use" };
      }

      await db
        .insert(roomWorldLinks)
        .values({
          roomId: req.params.roomId,
          worldId: w.id,
          linkedByUserId: me.id,
        })
        .onConflictDoUpdate({
          target: roomWorldLinks.roomId,
          set: { worldId: w.id, linkedByUserId: me.id, linkedAt: new Date() },
        });
      await broadcastRoomState(io, db, req.params.roomId);
      return { ok: true };
    },
  );

  /* ---------- Unlink the room's current world ---------- */
  app.delete<{ Params: { roomId: string } }>("/rooms/:roomId/world", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (!(await callerCanModerateRoom(db, me.id, me.role, req.params.roomId))) {
      reply.code(403); return { error: "room owner / mod / admin only" };
    }
    await db.delete(roomWorldLinks).where(eq(roomWorldLinks.roomId, req.params.roomId));
    await broadcastRoomState(io, db, req.params.roomId);
    return { ok: true };
  });

  /* ---------- Join a world (members table) ---------- */
  app.post<{ Params: { idOrSlug: string } }>("/worlds/:idOrSlug/members", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    // Owners are implicitly members of their own world for surfacing purposes,
    // but they can still explicitly "join" to get an explicit membership row
    // (and the option to set the world as their primary). All other users
    // need the world to be open.
    if (w.ownerUserId !== me.id && w.visibility !== "open" && me.role !== "admin") {
      reply.code(403);
      return { error: "this world isn't open for community membership" };
    }
    const existing = (await db
      .select()
      .from(worldMembers)
      .where(and(eq(worldMembers.worldId, w.id), eq(worldMembers.userId, me.id)))
      .limit(1))[0];
    if (existing) {
      // Idempotent: already a member is success, not an error.
      return { ok: true, alreadyMember: true };
    }
    await db.insert(worldMembers).values({
      worldId: w.id,
      userId: me.id,
      isPrimary: 0,
    });
    await rebroadcastUserOccupancy(io, db, me.id);
    return { ok: true };
  });

  /* ---------- Leave a world ---------- */
  app.delete<{ Params: { idOrSlug: string } }>("/worlds/:idOrSlug/members", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    const r = await db
      .delete(worldMembers)
      .where(and(eq(worldMembers.worldId, w.id), eq(worldMembers.userId, me.id)));
    if (r.changes === 0) return { ok: true, alreadyAbsent: true };
    await rebroadcastUserOccupancy(io, db, me.id);
    return { ok: true };
  });

  /**
   * Set (or clear) the caller's primary world. Pass `worldId: null` to clear.
   * Enforces the at-most-one-primary invariant client-side too: we unset any
   * existing primary in a single transaction before flipping the new one on.
   */
  app.put<{ Body: unknown }>("/me/primary-world", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    let body;
    try { body = setPrimaryWorldBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    if (body.worldId === null) {
      await db
        .update(worldMembers)
        .set({ isPrimary: 0 })
        .where(and(eq(worldMembers.userId, me.id), eq(worldMembers.isPrimary, 1)));
      await rebroadcastUserOccupancy(io, db, me.id);
      return { ok: true };
    }

    const targetWorldId: string = body.worldId;

    // Must be a current member to be primary.
    const m = (await db
      .select()
      .from(worldMembers)
      .where(and(eq(worldMembers.userId, me.id), eq(worldMembers.worldId, targetWorldId)))
      .limit(1))[0];
    if (!m) {
      reply.code(400);
      return { error: "you must join the world before making it your primary" };
    }
    // Single transaction: clear any other primaries, then set this one.
    db.transaction((tx) => {
      tx.update(worldMembers)
        .set({ isPrimary: 0 })
        .where(and(eq(worldMembers.userId, me.id), eq(worldMembers.isPrimary, 1)))
        .run();
      tx.update(worldMembers)
        .set({ isPrimary: 1 })
        .where(and(eq(worldMembers.userId, me.id), eq(worldMembers.worldId, targetWorldId)))
        .run();
    });
    await rebroadcastUserOccupancy(io, db, me.id);
    return { ok: true };
  });

  /**
   * Caller's world memberships. Used by the WorldsList modal ("Worlds I've
   * joined") and the profile modal ("Member of <World>"). Sorted with the
   * primary first (if any), then by join date.
   */
  app.get("/me/worlds/memberships", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const rows = await db
      .select({
        worldId: worldMembers.worldId,
        joinedAt: worldMembers.joinedAt,
        isPrimary: worldMembers.isPrimary,
        worldSlug: worlds.slug,
        worldName: worlds.name,
        ownerUserId: worlds.ownerUserId,
      })
      .from(worldMembers)
      .innerJoin(worlds, eq(worlds.id, worldMembers.worldId))
      .where(eq(worldMembers.userId, me.id))
      .orderBy(desc(worldMembers.isPrimary), asc(worldMembers.joinedAt));
    const memberships: WorldMembership[] = await Promise.all(
      rows.map(async (r) => ({
        worldId: r.worldId,
        worldSlug: r.worldSlug,
        worldName: r.worldName,
        ownerUsername: await loadOwnerUsername(db, r.ownerUserId),
        isPrimary: !!r.isPrimary,
        joinedAt: +r.joinedAt,
      })),
    );
    return { memberships };
  });

  /**
   * Read another user's memberships (for the profile modal). Returns only
   * memberships in worlds whose visibility allows the viewer to see them
   * (private worlds are filtered out unless the viewer is the owner of the
   * world or an admin).
   */
  app.get<{ Params: { userId: string } }>("/users/:userId/world-memberships", async (req, reply) => {
    const me = await getSessionUser(req, db);
    const rows = await db
      .select({
        worldId: worldMembers.worldId,
        joinedAt: worldMembers.joinedAt,
        isPrimary: worldMembers.isPrimary,
        worldSlug: worlds.slug,
        worldName: worlds.name,
        visibility: worlds.visibility,
        ownerUserId: worlds.ownerUserId,
      })
      .from(worldMembers)
      .innerJoin(worlds, eq(worlds.id, worldMembers.worldId))
      .where(eq(worldMembers.userId, req.params.userId))
      .orderBy(desc(worldMembers.isPrimary), asc(worldMembers.joinedAt));
    const filtered = rows.filter((r) => {
      if (r.visibility !== "private") return true;
      // Private worlds: visible only if the viewer is the world's owner or admin.
      return !!me && (me.role === "admin" || r.ownerUserId === me.id);
    });
    const memberships: WorldMembership[] = await Promise.all(
      filtered.map(async (r) => ({
        worldId: r.worldId,
        worldSlug: r.worldSlug,
        worldName: r.worldName,
        ownerUsername: await loadOwnerUsername(db, r.ownerUserId),
        isPrimary: !!r.isPrimary,
        joinedAt: +r.joinedAt,
      })),
    );
    return { memberships };
  });
}

// Suppress an unused-imports lint flag - FastifyRequest is used implicitly
// by route generic params elsewhere.
void (null as unknown as FastifyRequest);
