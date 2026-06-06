import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { characterJournalEntries, characters } from "../db/schema.js";
import { sanitizeBio } from "../auth/html.js";
import { getSessionUser } from "./auth.js";
import { getSettings } from "../settings.js";
import { hasPermission } from "../auth/permissions.js";
import type { Db } from "../db/index.js";

const TITLE_MAX = 120;

const createBody = z.object({
  title: z.string().max(TITLE_MAX).nullable().optional(),
  bodyHtml: z.string().min(1),
  privacy: z.enum(["public", "private"]).optional(),
}).strict();

const updateBody = z.object({
  title: z.string().max(TITLE_MAX).nullable().optional(),
  bodyHtml: z.string().min(1).optional(),
  privacy: z.enum(["public", "private"]).optional(),
}).strict();

/**
 * Per-character journal CRUD. Owner-only for writes; viewers see only
 * `public` entries via the profile lookup. The `GET /characters/:id/journal`
 * route lets the OWNER's editor see everything (incl. private), while
 * lookupProfile is what other viewers go through.
 */
export async function registerJournalRoutes(app: FastifyInstance, db: Db): Promise<void> {
  /** List entries. Owner sees public+private; other viewers see public only. */
  app.get<{ Params: { id: string } }>("/characters/:id/journal", async (req, reply) => {
    const me = await getSessionUser(req, db);
    const c = (await db.select().from(characters).where(eq(characters.id, req.params.id)).limit(1))[0];
    if (!c || c.deletedAt) { reply.code(404); return { error: "not found" }; }
    // Admin reads other characters' private journals via the
    // `view_others_journal` key (privacy-sensitive, flagged in the
    // matrix UI with the yellow chip per PRIVACY_SENSITIVE_KEYS).
    const isOwner = me?.id === c.userId
      || (!!me && (await hasPermission(me, "view_others_journal", db)));
    const rows = await db
      .select()
      .from(characterJournalEntries)
      .where(eq(characterJournalEntries.characterId, c.id))
      .orderBy(asc(characterJournalEntries.createdAt));
    const filtered = isOwner ? rows : rows.filter((r) => r.privacy === "public");
    return {
      entries: filtered.map((r) => ({
        id: r.id,
        title: r.title,
        bodyHtml: r.bodyHtml,
        privacy: r.privacy,
        createdAt: +r.createdAt,
        updatedAt: +r.updatedAt,
      })),
    };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/characters/:id/journal", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const c = (await db.select().from(characters).where(eq(characters.id, req.params.id)).limit(1))[0];
    if (!c || c.deletedAt) { reply.code(404); return { error: "not found" }; }
    if (c.userId !== me.id && !(await hasPermission(me, "edit_others_journal", db))) {
      reply.code(403); return { error: "not yours" };
    }

    let body;
    try { body = createBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    // Re-use the bio length cap as the journal entry cap. Same admin-tunable
    // setting; a journal post is profile-adjacent content of similar shape.
    const { maxBioLength } = await getSettings(db);
    if (body.bodyHtml.length > maxBioLength) {
      reply.code(413);
      return { error: `Entry body capped at ${maxBioLength} chars.` };
    }

    const id = nanoid();
    await db.insert(characterJournalEntries).values({
      id,
      characterId: c.id,
      title: body.title ? body.title.trim() : null,
      bodyHtml: sanitizeBio(body.bodyHtml),
      privacy: body.privacy ?? "public",
    });
    const row = (await db.select().from(characterJournalEntries).where(eq(characterJournalEntries.id, id)).limit(1))[0];
    reply.code(201);
    return row;
  });

  app.patch<{ Params: { id: string; entryId: string }; Body: unknown }>(
    "/characters/:id/journal/:entryId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const c = (await db.select().from(characters).where(eq(characters.id, req.params.id)).limit(1))[0];
      if (!c || c.deletedAt) { reply.code(404); return { error: "not found" }; }
      if (c.userId !== me.id && !(await hasPermission(me, "edit_others_journal", db))) {
        reply.code(403); return { error: "not yours" };
      }

      let body;
      try { body = updateBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const existing = (await db
        .select()
        .from(characterJournalEntries)
        .where(and(
          eq(characterJournalEntries.id, req.params.entryId),
          eq(characterJournalEntries.characterId, c.id),
        ))
        .limit(1))[0];
      if (!existing) { reply.code(404); return { error: "not found" }; }

      if (body.bodyHtml !== undefined) {
        const { maxBioLength } = await getSettings(db);
        if (body.bodyHtml.length > maxBioLength) {
          reply.code(413);
          return { error: `Entry body capped at ${maxBioLength} chars.` };
        }
      }

      await db.update(characterJournalEntries).set({
        ...(body.title !== undefined ? { title: body.title ? body.title.trim() : null } : {}),
        ...(body.bodyHtml !== undefined ? { bodyHtml: sanitizeBio(body.bodyHtml) } : {}),
        ...(body.privacy !== undefined ? { privacy: body.privacy } : {}),
        updatedAt: new Date(),
      }).where(eq(characterJournalEntries.id, existing.id));
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; entryId: string } }>(
    "/characters/:id/journal/:entryId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const c = (await db.select().from(characters).where(eq(characters.id, req.params.id)).limit(1))[0];
      if (!c || c.deletedAt) { reply.code(404); return { error: "not found" }; }
      if (c.userId !== me.id && !(await hasPermission(me, "edit_others_journal", db))) {
        reply.code(403); return { error: "not yours" };
      }

      const existing = (await db
        .select()
        .from(characterJournalEntries)
        .where(and(
          eq(characterJournalEntries.id, req.params.entryId),
          eq(characterJournalEntries.characterId, c.id),
        ))
        .limit(1))[0];
      if (!existing) { reply.code(404); return { error: "not found" }; }
      await db.delete(characterJournalEntries).where(eq(characterJournalEntries.id, existing.id));
      return { ok: true };
    },
  );
}
