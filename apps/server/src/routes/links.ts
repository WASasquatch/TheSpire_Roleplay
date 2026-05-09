import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { characters, profileLinks } from "../db/schema.js";
import { getSessionUser } from "./auth.js";
import type { Db } from "../db/index.js";

/** Hard cap matching the editor UX ("up to 6 links per profile"). */
const MAX_LINKS_PER_PROFILE = 6;

const HEX_RX = /^#[0-9a-fA-F]{6}$/;

/**
 * Restrict link URLs to http/https. Same shape used for avatarUrl elsewhere -
 * `z.string().url()` would also let `javascript:` / `data:` / `file:` through.
 * Capped at 500 chars; a label-bearing chip beyond that is meaningless anyway.
 */
const linkUrl = z.string().url().max(500).refine(
  (s) => /^https?:\/\//i.test(s),
  { message: "url must use http or https" },
);

const linkColor = z.string().regex(HEX_RX, "color must be #rrggbb").nullable().optional();

const createLinkBody = z.object({
  title: z.string().min(1).max(60),
  url: linkUrl,
  borderColor: linkColor,
  bgColor: linkColor,
  textColor: linkColor,
}).strict();

const updateLinkBody = z.object({
  title: z.string().min(1).max(60).optional(),
  url: linkUrl.optional(),
  borderColor: linkColor,
  bgColor: linkColor,
  textColor: linkColor,
  sortOrder: z.number().int().min(0).max(1000).optional(),
}).strict();

interface ScopeMaster { kind: "master"; userId: string }
interface ScopeCharacter { kind: "character"; userId: string; characterId: string }
type Scope = ScopeMaster | ScopeCharacter;

/**
 * Resolve the scope for a `/me/links` or `/characters/:id/links` request.
 * Returns either { kind: 'master' } or { kind: 'character', characterId },
 * or null when the caller isn't authorized for the implied profile.
 *
 * For characters, the caller must own the row OR be a site admin (mirrors
 * the rest of the character-edit endpoints).
 */
type ResolveResult =
  | { ok: true; scope: Scope }
  | { ok: false; statusCode: 401 | 403 | 404; error: string };

async function resolveScope(
  db: Db,
  req: FastifyRequest,
  characterId: string | null,
): Promise<ResolveResult> {
  const me = await getSessionUser(req, db);
  if (!me) return { ok: false, statusCode: 401, error: "auth" };
  if (characterId === null) {
    return { ok: true, scope: { kind: "master", userId: me.id } };
  }
  const c = (await db.select().from(characters).where(eq(characters.id, characterId)).limit(1))[0];
  if (!c || c.deletedAt) return { ok: false, statusCode: 404, error: "not found" };
  if (c.userId !== me.id && me.role !== "admin") return { ok: false, statusCode: 403, error: "not yours" };
  return { ok: true, scope: { kind: "character", userId: c.userId, characterId: c.id } };
}

/**
 * Fastify route registrar for player-set profile links. Each `/me/links/*`
 * route operates on master/OOC links (characterId IS NULL); each
 * `/characters/:id/links/*` operates on that character's links.
 */
export async function registerLinkRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // ---------------- master / OOC scope ----------------
  app.get("/me/links", async (req, reply) => {
    const r = await resolveScope(db, req, null);
    if (!r.ok) { reply.code(r.statusCode); return { error: r.error }; }
    return list(db, r.scope);
  });

  app.post<{ Body: unknown }>("/me/links", async (req, reply) => {
    const r = await resolveScope(db, req, null);
    if (!r.ok) { reply.code(r.statusCode); return { error: r.error }; }
    return create(db, reply, r.scope, req.body);
  });

  app.patch<{ Params: { linkId: string }; Body: unknown }>("/me/links/:linkId", async (req, reply) => {
    const r = await resolveScope(db, req, null);
    if (!r.ok) { reply.code(r.statusCode); return { error: r.error }; }
    return patch(db, reply, r.scope, req.params.linkId, req.body);
  });

  app.delete<{ Params: { linkId: string } }>("/me/links/:linkId", async (req, reply) => {
    const r = await resolveScope(db, req, null);
    if (!r.ok) { reply.code(r.statusCode); return { error: r.error }; }
    return remove(db, reply, r.scope, req.params.linkId);
  });

  // ---------------- character scope ----------------
  app.get<{ Params: { id: string } }>("/characters/:id/links", async (req, reply) => {
    const r = await resolveScope(db, req, req.params.id);
    if (!r.ok) { reply.code(r.statusCode); return { error: r.error }; }
    return list(db, r.scope);
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/characters/:id/links", async (req, reply) => {
    const r = await resolveScope(db, req, req.params.id);
    if (!r.ok) { reply.code(r.statusCode); return { error: r.error }; }
    return create(db, reply, r.scope, req.body);
  });

  app.patch<{ Params: { id: string; linkId: string }; Body: unknown }>(
    "/characters/:id/links/:linkId",
    async (req, reply) => {
      const r = await resolveScope(db, req, req.params.id);
      if (!r.ok) { reply.code(r.statusCode); return { error: r.error }; }
      return patch(db, reply, r.scope, req.params.linkId, req.body);
    },
  );

  app.delete<{ Params: { id: string; linkId: string } }>(
    "/characters/:id/links/:linkId",
    async (req, reply) => {
      const r = await resolveScope(db, req, req.params.id);
      if (!r.ok) { reply.code(r.statusCode); return { error: r.error }; }
      return remove(db, reply, r.scope, req.params.linkId);
    },
  );
}

/* ============================================================
 *  Internal CRUD helpers (scope-aware)
 * ============================================================ */

function whereScope(scope: Scope) {
  return scope.kind === "master"
    ? and(eq(profileLinks.userId, scope.userId), isNull(profileLinks.characterId))
    : and(eq(profileLinks.userId, scope.userId), eq(profileLinks.characterId, scope.characterId));
}

async function list(db: Db, scope: Scope) {
  const rows = await db
    .select()
    .from(profileLinks)
    .where(whereScope(scope))
    .orderBy(asc(profileLinks.sortOrder), asc(profileLinks.createdAt));
  return { links: rows };
}

async function create(db: Db, reply: { code: (n: number) => unknown }, scope: Scope, body: unknown) {
  let parsed;
  try { parsed = createLinkBody.parse(body); }
  catch { reply.code(400); return { error: "invalid body" }; }

  const countRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(profileLinks)
    .where(whereScope(scope));
  const count = countRows[0]?.n ?? 0;
  if (count >= MAX_LINKS_PER_PROFILE) {
    reply.code(429);
    return { error: `Limit of ${MAX_LINKS_PER_PROFILE} links per profile.` };
  }

  // Find the current max sortOrder so the new one slots after the rest.
  const lastRow = (await db
    .select({ s: profileLinks.sortOrder })
    .from(profileLinks)
    .where(whereScope(scope))
    .orderBy(desc(profileLinks.sortOrder))
    .limit(1))[0];
  const nextSort = (lastRow?.s ?? -1) + 1;

  const id = nanoid();
  await db.insert(profileLinks).values({
    id,
    userId: scope.userId,
    characterId: scope.kind === "character" ? scope.characterId : null,
    title: parsed.title.trim(),
    url: parsed.url.trim(),
    borderColor: parsed.borderColor ?? null,
    bgColor: parsed.bgColor ?? null,
    textColor: parsed.textColor ?? null,
    sortOrder: nextSort,
  });
  const row = (await db.select().from(profileLinks).where(eq(profileLinks.id, id)).limit(1))[0];
  reply.code(201);
  return row;
}

async function patch(db: Db, reply: { code: (n: number) => unknown }, scope: Scope, linkId: string, body: unknown) {
  let parsed;
  try { parsed = updateLinkBody.parse(body); }
  catch { reply.code(400); return { error: "invalid body" }; }

  const existing = (await db.select().from(profileLinks).where(eq(profileLinks.id, linkId)).limit(1))[0];
  if (!existing) { reply.code(404); return { error: "not found" }; }
  // Confirm the link belongs to the resolved scope (don't let /me/links edit
  // a row that's actually on a character's profile or vice versa).
  const matchScope = scope.kind === "master"
    ? existing.userId === scope.userId && existing.characterId === null
    : existing.userId === scope.userId && existing.characterId === scope.characterId;
  if (!matchScope) { reply.code(404); return { error: "not found" }; }

  await db
    .update(profileLinks)
    .set({
      ...(parsed.title !== undefined ? { title: parsed.title.trim() } : {}),
      ...(parsed.url !== undefined ? { url: parsed.url.trim() } : {}),
      ...(parsed.borderColor !== undefined ? { borderColor: parsed.borderColor } : {}),
      ...(parsed.bgColor !== undefined ? { bgColor: parsed.bgColor } : {}),
      ...(parsed.textColor !== undefined ? { textColor: parsed.textColor } : {}),
      ...(parsed.sortOrder !== undefined ? { sortOrder: parsed.sortOrder } : {}),
    })
    .where(eq(profileLinks.id, linkId));
  return { ok: true };
}

async function remove(db: Db, reply: { code: (n: number) => unknown }, scope: Scope, linkId: string) {
  const existing = (await db.select().from(profileLinks).where(eq(profileLinks.id, linkId)).limit(1))[0];
  if (!existing) { reply.code(404); return { error: "not found" }; }
  const matchScope = scope.kind === "master"
    ? existing.userId === scope.userId && existing.characterId === null
    : existing.userId === scope.userId && existing.characterId === scope.characterId;
  if (!matchScope) { reply.code(404); return { error: "not found" }; }
  await db.delete(profileLinks).where(eq(profileLinks.id, linkId));
  return { ok: true };
}
