import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { characters, users } from "../db/schema.js";
import { sanitizeBio } from "../auth/html.js";
import { getSessionUser } from "./auth.js";
import { normalizeTheme } from "@thekeep/shared";
import { getSettings } from "../settings.js";
import type { Db } from "../db/index.js";

const HEX_RX = /^#[0-9a-fA-F]{6}$/;
const themeSchema = z.object({
  bg: z.string().regex(HEX_RX),
  panel: z.string().regex(HEX_RX),
  border: z.string().regex(HEX_RX),
  text: z.string().regex(HEX_RX),
  muted: z.string().regex(HEX_RX),
  action: z.string().regex(HEX_RX),
  accent: z.string().regex(HEX_RX),
  system: z.string().regex(HEX_RX),
}).strict();

const statsSchema = z.object({
  age: z.string().max(40).optional(),
  race: z.string().max(40).optional(),
  gender: z.string().max(40).optional(),
  height: z.string().max(40).optional(),
  weight: z.string().max(40).optional(),
  alignment: z.string().max(40).optional(),
  occupation: z.string().max(80).optional(),
  custom: z.record(z.string().max(40), z.string().max(200)).optional(),
}).strict();

// Restrict avatarUrl to http(s) — z.string().url() also allows
// javascript:, data:, file:, etc., which would let a hostile profile load
// payloads or leak referrers. Same shape used for both update bodies.
const httpUrl = z.string().url().max(500).refine(
  (s) => /^https?:\/\//i.test(s),
  { message: "avatarUrl must use http or https" },
);

// Bios are capped at 200KB at the schema layer (the highest the admin can
// configure); the per-deployment cap is enforced in code below so admins can
// tune it without redeploys.
const BIO_HARD_CAP = 200_000;

const updateBody = z.object({
  bioHtml: z.string().max(BIO_HARD_CAP).optional(),
  stats: statsSchema.optional(),
  avatarUrl: httpUrl.nullable().optional(),
  /** null = inherit master/default theme */
  theme: themeSchema.nullable().optional(),
});

const masterUpdateBody = z.object({
  bioHtml: z.string().max(BIO_HARD_CAP).optional(),
  avatarUrl: httpUrl.nullable().optional(),
  gender: z.enum(["male", "female", "nonbinary", "other", "undisclosed"]).optional(),
  /** null = revert to system default */
  theme: themeSchema.nullable().optional(),
  notifyPref: z.enum(["off", "mentions", "all"]).optional(),
});

async function checkBioCap(
  db: Db,
  reply: FastifyReply,
  bioHtml: string | undefined,
): Promise<boolean> {
  if (bioHtml === undefined) return true;
  const { maxBioLength } = await getSettings(db);
  if (bioHtml.length > maxBioLength) {
    reply.code(413);
    reply.send({ error: `bio is longer than the configured ${maxBioLength}-char limit` });
    return false;
  }
  return true;
}

export async function registerCharacterRoutes(app: FastifyInstance, db: Db): Promise<void> {
  /** Save a character's editor body. */
  app.put<{ Params: { id: string }; Body: unknown }>(
    "/characters/:id",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }

      const c = (await db.select().from(characters).where(eq(characters.id, req.params.id)).limit(1))[0];
      if (!c || c.deletedAt) { reply.code(404); return { error: "not found" }; }
      if (c.userId !== me.id && me.role !== "admin") {
        reply.code(403);
        return { error: "not yours" };
      }

      const body = updateBody.parse(req.body);
      if (!(await checkBioCap(db, reply, body.bioHtml))) return;
      await db
        .update(characters)
        .set({
          ...(body.bioHtml !== undefined ? { bioHtml: sanitizeBio(body.bioHtml) } : {}),
          ...(body.stats !== undefined ? { statsJson: JSON.stringify(body.stats) } : {}),
          ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl } : {}),
          ...(body.theme !== undefined
            ? { themeJson: body.theme === null ? null : JSON.stringify(body.theme) }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(characters.id, c.id));
      return { ok: true };
    },
  );

  app.get<{ Params: { id: string } }>("/characters/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const c = (await db.select().from(characters).where(eq(characters.id, req.params.id)).limit(1))[0];
    if (!c || c.deletedAt) { reply.code(404); return { error: "not found" }; }
    return c;
  });

  app.get("/characters", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const list = await db
      .select()
      .from(characters)
      .where(and(eq(characters.userId, me.id), isNull(characters.deletedAt)));
    return { characters: list };
  });

  /** Read your own master profile (used by the editor to populate). */
  app.get("/me/profile", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const u = (await db.select().from(users).where(eq(users.id, me.id)).limit(1))[0];
    if (!u) { reply.code(404); return { error: "not found" }; }

    // Resolve active character name (when set) so the client can do
    // self-detection on @mentions without a second roundtrip.
    let activeCharacterName: string | null = null;
    if (u.activeCharacterId) {
      const c = (await db
        .select()
        .from(characters)
        .where(eq(characters.id, u.activeCharacterId))
        .limit(1))[0];
      if (c && !c.deletedAt) activeCharacterName = c.name;
    }

    return {
      userId: u.id,
      username: u.username,
      bioHtml: u.bioHtml,
      avatarUrl: u.avatarUrl,
      gender: u.gender,
      chatColor: u.chatColor,
      awayMessage: u.awayMessage,
      activeCharacterId: u.activeCharacterId,
      activeCharacterName,
      theme: await parseUserTheme(db, u.themeJson),
      notifyPref: u.notifyPref,
    };
  });

  /** Master account profile editor. */
  app.put<{ Body: unknown }>("/me/profile", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const body = masterUpdateBody.parse(req.body);
    if (!(await checkBioCap(db, reply, body.bioHtml))) return;
    await db
      .update(users)
      .set({
        ...(body.bioHtml !== undefined ? { bioHtml: sanitizeBio(body.bioHtml) } : {}),
        ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl } : {}),
        ...(body.gender !== undefined ? { gender: body.gender } : {}),
        ...(body.theme !== undefined
          ? { themeJson: body.theme === null ? null : JSON.stringify(body.theme) }
          : {}),
        ...(body.notifyPref !== undefined ? { notifyPref: body.notifyPref } : {}),
      })
      .where(eq(users.id, me.id));
    return { ok: true };
  });
}

async function parseUserTheme(db: Db, json: string | null) {
  if (json) {
    try { return normalizeTheme(JSON.parse(json)); }
    catch { /* fall through */ }
  }
  return (await getSettings(db)).defaultTheme;
}
