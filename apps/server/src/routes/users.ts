import type { FastifyInstance } from "fastify";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import { characters, users } from "../db/schema.js";
import { getSessionUser } from "./auth.js";
import type { Db } from "../db/index.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

const MAX_LIMIT = 200;

/**
 * Public-facing user directory endpoint. Authenticated users only — we don't
 * leak the registered population to the public internet. Each row carries
 * the master account plus that account's characters so the UI can render
 * them grouped (master on top, characters indented underneath).
 *
 * Sensitive fields (email, role, IP) are NOT included; admin tooling has its
 * own /admin/users that includes them.
 */
export async function registerUsersRoutes(
  app: FastifyInstance,
  db: Db,
  io: Io,
): Promise<void> {
  app.get<{ Querystring: { q?: string; offset?: string; limit?: string } }>("/users", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    const q = (req.query.q ?? "").trim().toLowerCase();
    const offset = Math.max(0, parseInt(req.query.offset ?? "0", 10) || 0);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit ?? "100", 10) || 100));

    // Match search query against master username OR any of the user's
    // character names. Disabled accounts (disabledAt set) and the system
    // sentinel are excluded.
    let matchedUserIds: string[];
    if (q) {
      const byMaster = await db
        .select({ id: users.id })
        .from(users)
        .where(and(
          isNull(users.disabledAt),
          sql`${users.username} != 'system'`,
          sql`lower(${users.username}) LIKE ${"%" + q + "%"}`,
        ));
      const byChar = await db
        .select({ userId: characters.userId })
        .from(characters)
        .where(and(
          isNull(characters.deletedAt),
          sql`lower(${characters.name}) LIKE ${"%" + q + "%"}`,
        ));
      matchedUserIds = [...new Set([
        ...byMaster.map((r) => r.id),
        ...byChar.map((r) => r.userId),
      ])];
    } else {
      const allMasters = await db
        .select({ id: users.id })
        .from(users)
        .where(and(isNull(users.disabledAt), sql`${users.username} != 'system'`));
      matchedUserIds = allMasters.map((r) => r.id);
    }

    const total = matchedUserIds.length;

    // Sort: online users first (alphabetical), then offline (alphabetical).
    const sockets = await io.fetchSockets();
    const onlineUserIds = new Set<string>();
    for (const s of sockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (uid) onlineUserIds.add(uid);
    }

    if (matchedUserIds.length === 0) return { users: [], total: 0, offset, limit };

    const userRows = await db
      .select({
        id: users.id,
        username: users.username,
        gender: users.gender,
        avatarUrl: users.avatarUrl,
        chatColor: users.chatColor,
        awayMessage: users.awayMessage,
        activeCharacterId: users.activeCharacterId,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .where(sql`${users.id} IN (${sql.join(matchedUserIds.map((u) => sql`${u}`), sql`, `)})`);

    const charRows = await db
      .select({
        id: characters.id,
        userId: characters.userId,
        name: characters.name,
        avatarUrl: characters.avatarUrl,
      })
      .from(characters)
      .where(and(
        isNull(characters.deletedAt),
        sql`${characters.userId} IN (${sql.join(matchedUserIds.map((u) => sql`${u}`), sql`, `)})`,
      ))
      .orderBy(asc(characters.name));

    const charsByUser = new Map<string, typeof charRows>();
    for (const c of charRows) {
      const list = charsByUser.get(c.userId) ?? [];
      list.push(c);
      charsByUser.set(c.userId, list);
    }

    const sorted = userRows.sort((a, b) => {
      const aOn = onlineUserIds.has(a.id) ? 0 : 1;
      const bOn = onlineUserIds.has(b.id) ? 0 : 1;
      if (aOn !== bOn) return aOn - bOn;
      return a.username.localeCompare(b.username);
    });

    const page = sorted.slice(offset, offset + limit).map((u) => ({
      userId: u.id,
      username: u.username,
      gender: u.gender,
      avatarUrl: u.avatarUrl,
      chatColor: u.chatColor,
      online: onlineUserIds.has(u.id),
      away: u.awayMessage != null,
      awayMessage: u.awayMessage,
      activeCharacterId: u.activeCharacterId,
      createdAt: +u.createdAt,
      lastLoginAt: u.lastLoginAt ? +u.lastLoginAt : null,
      characters: (charsByUser.get(u.id) ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        avatarUrl: c.avatarUrl,
      })),
    }));

    return { users: page, total, offset, limit };
  });

  /** Admin: same shape as /users plus email/role/disabled state. */
  app.get<{ Querystring: { q?: string; offset?: string; limit?: string } }>("/admin/users", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me || me.role !== "admin") { reply.code(403); return { error: "admin only" }; }

    const q = (req.query.q ?? "").trim().toLowerCase();
    const offset = Math.max(0, parseInt(req.query.offset ?? "0", 10) || 0);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit ?? "100", 10) || 100));

    // Admin search includes email + disabled accounts (for moderation review).
    const where = q
      ? or(
          sql`lower(${users.username}) LIKE ${"%" + q + "%"}`,
          sql`lower(${users.email}) LIKE ${"%" + q + "%"}`,
        )
      : undefined;
    const all = await db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        role: users.role,
        gender: users.gender,
        avatarUrl: users.avatarUrl,
        chatColor: users.chatColor,
        awayMessage: users.awayMessage,
        activeCharacterId: users.activeCharacterId,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
        disabledAt: users.disabledAt,
      })
      .from(users)
      .where(where ? and(sql`${users.username} != 'system'`, where) : sql`${users.username} != 'system'`);

    const ids = all.map((u) => u.id);
    const charRows = ids.length
      ? await db
          .select({ id: characters.id, userId: characters.userId, name: characters.name, deletedAt: characters.deletedAt })
          .from(characters)
          .where(sql`${characters.userId} IN (${sql.join(ids.map((u) => sql`${u}`), sql`, `)})`)
          .orderBy(asc(characters.name))
      : [];
    const charsByUser = new Map<string, typeof charRows>();
    for (const c of charRows) {
      const list = charsByUser.get(c.userId) ?? [];
      list.push(c);
      charsByUser.set(c.userId, list);
    }

    const sockets = await io.fetchSockets();
    const onlineUserIds = new Set<string>();
    for (const s of sockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (uid) onlineUserIds.add(uid);
    }

    const sorted = all.sort((a, b) => a.username.localeCompare(b.username));
    const page = sorted.slice(offset, offset + limit).map((u) => ({
      userId: u.id,
      username: u.username,
      email: u.email,
      role: u.role,
      gender: u.gender,
      avatarUrl: u.avatarUrl,
      chatColor: u.chatColor,
      online: onlineUserIds.has(u.id),
      away: u.awayMessage != null,
      awayMessage: u.awayMessage,
      activeCharacterId: u.activeCharacterId,
      createdAt: +u.createdAt,
      lastLoginAt: u.lastLoginAt ? +u.lastLoginAt : null,
      disabled: u.disabledAt != null,
      disabledAt: u.disabledAt ? +u.disabledAt : null,
      characters: (charsByUser.get(u.id) ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        deleted: c.deletedAt != null,
      })),
    }));

    return { users: page, total: all.length, offset, limit };
  });

  /**
   * Admin user editor. Allows changing username/email/role and toggling
   * disabled state. Password reset is intentionally out of scope here —
   * users go through their own flow for that. role bump to "admin" is
   * allowed from this endpoint (mirrors /promoteadmin).
   */
  app.patch<{ Params: { id: string }; Body: unknown }>("/admin/users/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me || me.role !== "admin") { reply.code(403); return { error: "admin only" }; }
    const { id } = req.params;
    if (id === me.id) { reply.code(400); return { error: "use the profile editor for your own account" }; }
    const target = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
    if (!target || target.username === "system") { reply.code(404); return { error: "not found" }; }

    const { z } = await import("zod");
    const body = z.object({
      username: z.string().min(2).max(40).regex(/^[\p{L}\p{N}_\-]+$/u).optional(),
      email: z.string().email().max(200).optional(),
      role: z.enum(["user", "mod", "admin"]).optional(),
      disabled: z.boolean().optional(),
    }).parse(req.body);

    // Username conflict check (case-insensitive). Email is no longer unique.
    if (body.username && body.username.toLowerCase() !== target.username.toLowerCase()) {
      const dup = (await db.select().from(users).where(sql`lower(${users.username}) = ${body.username.toLowerCase()}`).limit(1))[0];
      if (dup) { reply.code(409); return { error: "username already in use" }; }
    }

    const update: Partial<typeof users.$inferInsert> = {};
    if (body.username !== undefined) update.username = body.username;
    if (body.email !== undefined) update.email = body.email;
    if (body.role !== undefined) update.role = body.role;
    if (body.disabled !== undefined) update.disabledAt = body.disabled ? new Date() : null;
    await db.update(users).set(update).where(eq(users.id, id));

    return { ok: true };
  });

  /**
   * Hard-delete a user. Cascades through every FK — characters, room_members,
   * messages (kept by `set null` for displayName history), bans, mutes,
   * sessions. System and self are off-limits.
   */
  app.delete<{ Params: { id: string } }>("/admin/users/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me || me.role !== "admin") { reply.code(403); return { error: "admin only" }; }
    const { id } = req.params;
    if (id === me.id) { reply.code(400); return { error: "you cannot delete your own account" }; }
    const target = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
    if (!target || target.username === "system") { reply.code(404); return { error: "not found" }; }

    // Disconnect any live sockets so they stop receiving events immediately.
    const sockets = await io.fetchSockets();
    for (const s of sockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (uid === id) s.disconnect(true);
    }

    await db.delete(users).where(eq(users.id, id));
    return { ok: true };
  });
}
