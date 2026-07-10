/**
 * Per-account NPC store (Phase 6, "Action/NPC" forum posting).
 *
 *   GET    /me/npcs            list my saved NPCs (name + stats)
 *   POST   /me/npcs            create one
 *   PATCH  /me/npcs/:id        rename / edit stats
 *   DELETE /me/npcs/:id        delete
 *
 * NPCs are per-account and reusable in ANY forum (the forum's `use_npc`
 * grant gates whether you can actually post as one there). Posting snapshots
 * the NPC's stats onto the message, so editing/deleting an NPC never rewrites
 * existing posts.
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  NPC_MAX_PER_ACCOUNT,
  NPC_MAX_STATS,
  NPC_NAME_MAX,
  NPC_STAT_LABEL_MAX,
  NPC_STAT_VALUE_MAX,
  parseNpcStats,
  serializeNpcStats,
  type UserNpcWire,
} from "@thekeep/shared";
import { nanoid } from "nanoid";
import { userNpcs } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { tFor } from "../i18n.js";
import { getSessionUser } from "./auth.js";

const NPC_NAME_RX = /^[\p{L}\p{N}_\-' ]{1,40}$/u;
const statSchema = z.object({
  label: z.string().trim().min(1).max(NPC_STAT_LABEL_MAX),
  value: z.string().trim().max(NPC_STAT_VALUE_MAX),
}).strict();
const npcBody = z.object({
  name: z.string().trim().min(1).max(NPC_NAME_MAX),
  stats: z.array(statSchema).max(NPC_MAX_STATS).optional(),
}).strict();

function toWire(row: typeof userNpcs.$inferSelect): UserNpcWire {
  return { id: row.id, name: row.name, stats: parseNpcStats(row.statsJson), updatedAt: +row.updatedAt };
}

export async function registerNpcRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.get("/me/npcs", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const rows = await db.select().from(userNpcs).where(eq(userNpcs.userId, me.id)).orderBy(desc(userNpcs.updatedAt));
    return { npcs: rows.map(toWire) };
  });

  app.post<{ Body: unknown }>("/me/npcs", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let body: z.infer<typeof npcBody>;
    try { body = npcBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    if (!NPC_NAME_RX.test(body.name)) { reply.code(400); return { error: tFor(me.locale, "errors:server.npcs.nameRule") }; }
    const count = Number((await db.select({ n: sql<number>`count(*)` }).from(userNpcs).where(eq(userNpcs.userId, me.id)))[0]?.n ?? 0);
    if (count >= NPC_MAX_PER_ACCOUNT) { reply.code(409); return { error: tFor(me.locale, "errors:server.npcs.limit", { max: NPC_MAX_PER_ACCOUNT }) }; }
    const id = nanoid();
    await db.insert(userNpcs).values({ id, userId: me.id, name: body.name, statsJson: serializeNpcStats(body.stats ?? []) });
    const row = (await db.select().from(userNpcs).where(eq(userNpcs.id, id)).limit(1))[0];
    reply.code(201);
    return { npc: row ? toWire(row) : null };
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/me/npcs/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let body: z.infer<typeof npcBody>;
    try { body = npcBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    if (!NPC_NAME_RX.test(body.name)) { reply.code(400); return { error: tFor(me.locale, "errors:server.npcs.nameRule") }; }
    const row = (await db.select().from(userNpcs)
      .where(and(eq(userNpcs.id, req.params.id), eq(userNpcs.userId, me.id))).limit(1))[0];
    if (!row) { reply.code(404); return { error: "no such NPC" }; }
    await db.update(userNpcs)
      .set({ name: body.name, statsJson: serializeNpcStats(body.stats ?? []), updatedAt: new Date() })
      .where(eq(userNpcs.id, row.id));
    const updated = (await db.select().from(userNpcs).where(eq(userNpcs.id, row.id)).limit(1))[0];
    return { npc: updated ? toWire(updated) : null };
  });

  app.delete<{ Params: { id: string } }>("/me/npcs/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    await db.delete(userNpcs).where(and(eq(userNpcs.id, req.params.id), eq(userNpcs.userId, me.id)));
    return { ok: true };
  });
}
