/**
 * serversModeration - server-scoped bans, server-wide mutes, the mod log, and
 * ownership transfer. Move-only extraction from registerServerRoutes.
 */
import {
  isModeratorRole,
} from "@thekeep/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  accountMutes,
  auditLog,
  rooms,
  serverBans,
  serverMembers,
  servers,
  users,
} from "../db/schema.js";
import { notifyUser } from "../servers/notifications.js";
import {
  broadcastPresence,
  findServerLanding,
  sendRoomBacklogTo,
} from "../realtime/broadcast.js";
import { softHideUserMessages } from "../lib/purgeUserMessages.js";
import {
  auditServer,
  roomsOfServerWhere,
} from "./serversShared.js";
import type { ServerRoutesCtx } from "./serversShared.js";

export function registerServerModerationRoutes(ctx: ServerRoutesCtx): void {
  const { app, db, io, serversLive, requireServerOwner, requireServerPermission, resolveServerTarget, writeServerImage, unlinkServerImage } = ctx;

  /* =========================================================
   *  Bans
   * ========================================================= */

  app.get<{ Params: { id: string } }>("/servers/:id/bans", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "ban_member");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const rows = await db
      .select({
        userId: serverBans.userId, username: users.username,
        until: serverBans.until, reason: serverBans.reason, createdAt: serverBans.createdAt,
      })
      .from(serverBans)
      .leftJoin(users, eq(users.id, serverBans.userId))
      .where(eq(serverBans.serverId, gate.server.id));
    return {
      bans: rows.map((b) => ({
        userId: b.userId,
        username: b.username ?? "unknown",
        until: b.until ? +b.until : null,
        reason: b.reason ?? null,
        createdAt: +b.createdAt,
        expired: !!b.until && +b.until <= Date.now(),
      })),
    };
  });

  const banBody = z.object({
    target: z.string().trim().min(1).max(120),
    hours: z.number().int().min(1).max(24 * 365).nullable().optional(),
    reason: z.string().trim().max(300).optional(),
    // Optional anti-spam sweep: hide the user's posts IN THIS SERVER'S ROOMS —
    // a lookback window in ms, or "all". Scoped, so the rest of the Spire is
    // untouched (mirrors the server-ban's room-only blast radius).
    purgePosts: z.union([z.number().int().positive().max(366 * 24 * 3_600_000), z.literal("all")]).optional(),
  }).strict();

  app.put<{ Params: { id: string }; Body: unknown }>("/servers/:id/bans", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "ban_member");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof banBody>;
    try { body = banBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const target = await resolveServerTarget(body.target);
    if (!target.ok) { reply.code(404); return { error: target.error }; }
    if (target.userId === gate.me.id) { reply.code(409); return { error: "You can't ban yourself." }; }
    if (target.userId === gate.server.ownerUserId) { reply.code(409); return { error: "The server owner can't be banned from their own server." }; }
    const targetUser = (await db.select({ role: users.role }).from(users)
      .where(eq(users.id, target.userId)).limit(1))[0];
    if (targetUser && isModeratorRole(targetUser.role)) {
      reply.code(409); return { error: `${target.username} is site staff and can't be server-banned.` };
    }

    const until = body.hours ? new Date(Date.now() + body.hours * 3_600_000) : null;
    await db.insert(serverBans)
      .values({
        serverId: gate.server.id, userId: target.userId, until,
        reason: body.reason?.trim() ? body.reason.trim() : null, issuedById: gate.me.id,
      })
      .onConflictDoUpdate({
        target: [serverBans.serverId, serverBans.userId],
        set: { until, reason: body.reason?.trim() ? body.reason.trim() : null, issuedById: gate.me.id, createdAt: new Date() },
      });
    // A banned member/mod/admin loses their chair with the ban.
    await db.delete(serverMembers)
      .where(and(eq(serverMembers.serverId, gate.server.id), eq(serverMembers.userId, target.userId)));

    // Evict live sockets from this server's rooms (mirrors the forum ban):
    // leave the room, notify, land them in the server's landing room (or none).
    const roomIds = (await db.select({ id: rooms.id }).from(rooms)
      .where(roomsOfServerWhere(gate.server.id))).map((r) => r.id);
    if (roomIds.length) {
      const roomSet = new Set(roomIds);
      const landing = await findServerLanding(db, gate.server.id);
      const affected = new Set<string>();
      const socks = await io.fetchSockets();
      for (const s of socks) {
        if ((s.data as { userId?: string }).userId !== target.userId) continue;
        const inRoom = (s.data as { roomId?: string }).roomId;
        if (!inRoom || !roomSet.has(inRoom)) continue;
        s.leave(`room:${inRoom}`);
        affected.add(inRoom);
        s.emit("error:notice", {
          code: "SERVER_BANNED",
          message: `You have been banned from "${gate.server.name}"${until ? ` until ${until.toISOString().slice(0, 10)}` : ""}.`,
        });
        if (landing && landing.id !== inRoom) {
          s.join(`room:${landing.id}`);
          (s.data as { roomId?: string }).roomId = landing.id;
          await sendRoomBacklogTo(s, db, landing.id, target.userId);
        }
      }
      for (const rid of affected) await broadcastPresence(io, db, rid);
      if (landing && affected.size) await broadcastPresence(io, db, landing.id);
    }

    // Optional anti-spam sweep: soft-hide their posts, scoped to THIS server's
    // rooms only. Kept as tombstones for admin audit, removed live for others.
    let postsHidden = 0;
    if (body.purgePosts != null && roomIds.length) {
      try {
        postsHidden = await softHideUserMessages(db, io, {
          targetUserId: target.userId,
          window: body.purgePosts,
          actor: { userId: gate.me.id, displayName: gate.me.username },
          roomIds,
        });
      } catch { /* best-effort; the ban already committed */ }
    }

    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_ban",
      targetUserId: target.userId, reason: body.reason ?? null,
      metadata: {
        slug: gate.server.slug, until: until ? +until : null,
        ...(body.purgePosts != null ? { purgePosts: body.purgePosts, postsHidden } : {}),
      },
    });
    return { ok: true, userId: target.userId, username: target.username, postsHidden };
  });

  app.delete<{ Params: { id: string; userId: string } }>("/servers/:id/bans/:userId", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "unban_member");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const existing = (await db.select().from(serverBans)
      .where(and(eq(serverBans.serverId, gate.server.id), eq(serverBans.userId, req.params.userId))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "no such ban" }; }
    await db.delete(serverBans)
      .where(and(eq(serverBans.serverId, gate.server.id), eq(serverBans.userId, req.params.userId)));
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_unban",
      targetUserId: req.params.userId, metadata: { slug: gate.server.slug },
    });
    return { ok: true };
  });

  /* =========================================================
   *  Server-wide mutes
   *
   *  These routes only CREATE / LIST / DELETE the account_mutes rows that the
   *  chat dispatcher already enforces (realtime/dispatch.ts silences a user when
   *  an active row with scope='site' OR scope='server' matching the room's
   *  server is present). They are the console twin of the /mute chat command's
   *  "server" reach (commands/builtins/mod.ts muteReach): a mod holding
   *  mute_member can silence a member across this whole server without having to
   *  catch them in a room first. Enforcement is untouched.
   * ========================================================= */

  app.get<{ Params: { id: string } }>("/servers/:id/mutes", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "mute_member");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const rows = await db
      .select({
        userId: accountMutes.userId, username: users.username,
        until: accountMutes.until, reason: accountMutes.reason, createdAt: accountMutes.createdAt,
      })
      .from(accountMutes)
      .leftJoin(users, eq(users.id, accountMutes.userId))
      .where(and(
        eq(accountMutes.scope, "server"),
        eq(accountMutes.serverId, gate.server.id),
        sql`${accountMutes.until} > ${Date.now()}`,
      ));
    return {
      mutes: rows.map((m) => ({
        userId: m.userId,
        username: m.username ?? "unknown",
        until: +m.until,
        reason: m.reason ?? null,
        createdAt: +m.createdAt,
      })),
    };
  });

  const muteBody = z.object({
    target: z.string().trim().min(1).max(120),
    hours: z.number().int().min(1).max(24 * 365),
    reason: z.string().trim().max(300).optional(),
  }).strict();

  app.put<{ Params: { id: string }; Body: unknown }>("/servers/:id/mutes", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "mute_member");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof muteBody>;
    try { body = muteBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const target = await resolveServerTarget(body.target);
    if (!target.ok) { reply.code(404); return { error: target.error }; }
    if (target.userId === gate.me.id) { reply.code(409); return { error: "You can't mute yourself." }; }
    if (target.userId === gate.server.ownerUserId) { reply.code(409); return { error: "The server owner can't be muted in their own server." }; }
    const targetUser = (await db.select({ role: users.role }).from(users)
      .where(eq(users.id, target.userId)).limit(1))[0];
    if (targetUser && isModeratorRole(targetUser.role)) {
      reply.code(409); return { error: `${target.username} is site staff and can't be server-muted.` };
    }

    const until = new Date(Date.now() + body.hours * 3_600_000);
    const reason = body.reason?.trim() ? body.reason.trim() : null;
    // Replace any existing server-scope row for this target (the partial UNIQUE
    // index allows one per (userId, serverId)); a re-mute just resets the timer.
    // Mirrors the /mute command's delete-then-insert.
    await db.delete(accountMutes).where(and(
      eq(accountMutes.userId, target.userId),
      eq(accountMutes.scope, "server"),
      eq(accountMutes.serverId, gate.server.id),
    ));
    await db.insert(accountMutes).values({
      id: nanoid(),
      userId: target.userId,
      scope: "server",
      serverId: gate.server.id,
      until,
      reason,
      issuedById: gate.me.id,
    });

    // Best-effort heads-up to the target's live sockets. The mute already
    // committed; a notice failure is harmless.
    try {
      const hoursLabel = `${body.hours}h`;
      const socks = await io.fetchSockets();
      for (const s of socks) {
        if ((s.data as { userId?: string }).userId !== target.userId) continue;
        s.emit("error:notice", {
          code: "SERVER_MUTED",
          message: `You've been muted in "${gate.server.name}" for ${hoursLabel}${reason ? `: ${reason}` : "."}`,
        });
      }
    } catch { /* best-effort */ }

    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_mute",
      targetUserId: target.userId, reason,
      metadata: { slug: gate.server.slug, until: +until, hours: body.hours },
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string; userId: string } }>("/servers/:id/mutes/:userId", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "unmute_member");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const r = await db.delete(accountMutes).where(and(
      eq(accountMutes.userId, req.params.userId),
      eq(accountMutes.scope, "server"),
      eq(accountMutes.serverId, gate.server.id),
    ));
    if (r.changes === 0) { reply.code(404); return { error: "no such mute" }; }
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_unmute",
      targetUserId: req.params.userId, metadata: { slug: gate.server.slug },
    });
    return { ok: true };
  });

  /* =========================================================
   *  Mod Log + transfer
   * ========================================================= */

  /** GET /servers/:id/mod-log — the server's moderation history (audit rows
   *  scoped to this server via the native serverId column). Visible to the
   *  owner + any mod holding view_mod_log. */
  app.get<{ Params: { id: string } }>("/servers/:id/mod-log", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "view_mod_log");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const rows = await db
      .select({
        id: auditLog.id, action: auditLog.action, actorUserId: auditLog.actorUserId,
        targetUserId: auditLog.targetUserId, reason: auditLog.reason,
        metadataJson: auditLog.metadataJson, createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(eq(auditLog.serverId, gate.server.id))
      .orderBy(desc(auditLog.createdAt))
      .limit(150);
    const ids = [...new Set(rows.flatMap((r) => [r.actorUserId, r.targetUserId]).filter((x): x is string => !!x))];
    const names = new Map<string, string>();
    if (ids.length) {
      for (const u of await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, ids))) {
        names.set(u.id, u.username);
      }
    }
    const parseMeta = (j: string | null): Record<string, unknown> | null => {
      if (!j) return null;
      try { const v = JSON.parse(j); return v && typeof v === "object" ? v : null; } catch { return null; }
    };
    return {
      entries: rows.map((r) => ({
        id: r.id,
        action: r.action,
        actorUsername: names.get(r.actorUserId) ?? "unknown",
        targetUsername: r.targetUserId ? (names.get(r.targetUserId) ?? "unknown") : null,
        reason: r.reason ?? null,
        metadata: parseMeta(r.metadataJson),
        createdAt: +r.createdAt,
      })),
    };
  });

  const transferBody = z.object({ target: z.string().trim().min(1).max(120) }).strict();
  /** POST /servers/:id/transfer — hand the server to another member. OWNER-only
   *  (the most sensitive act; the matrix keeps it owner/staff-tier). The new
   *  owner is enrolled as role="owner"; the old owner steps down to "admin"
   *  (the lieutenant) so they keep moderation reach but lose the owner-only
   *  acts. The system/default server can't be transferred. */
  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/transfer", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerOwner(req, req.params.id);
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    if (gate.server.isSystem) { reply.code(409); return { error: "The home server can't be transferred." }; }
    let body: z.infer<typeof transferBody>;
    try { body = transferBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const target = await resolveServerTarget(body.target);
    if (!target.ok) { reply.code(404); return { error: target.error }; }
    if (target.userId === gate.server.ownerUserId) { reply.code(409); return { error: "They already own this server." }; }
    const targetUser = (await db.select({ role: users.role }).from(users)
      .where(eq(users.id, target.userId)).limit(1))[0];
    if (!targetUser) { reply.code(404); return { error: "no such user" }; }
    const ban = (await db.select().from(serverBans)
      .where(and(eq(serverBans.serverId, gate.server.id), eq(serverBans.userId, target.userId))).limit(1))[0];
    if (ban && (!ban.until || +ban.until > Date.now())) {
      reply.code(409); return { error: "That user is banned from this server - lift the ban first." };
    }
    const oldOwnerId = gate.server.ownerUserId;
    db.transaction((tx) => {
      tx.update(servers).set({ ownerUserId: target.userId, updatedAt: new Date() })
        .where(eq(servers.id, gate.server.id)).run();
      // New owner row.
      tx.insert(serverMembers)
        .values({ serverId: gate.server.id, userId: target.userId, role: "owner" })
        .onConflictDoUpdate({
          target: [serverMembers.serverId, serverMembers.userId],
          set: { role: "owner", permissionsJson: "[]" },
        }).run();
      // Old owner steps down to admin (keeps a seat, loses owner-only powers).
      tx.insert(serverMembers)
        .values({ serverId: gate.server.id, userId: oldOwnerId, role: "admin" })
        .onConflictDoUpdate({
          target: [serverMembers.serverId, serverMembers.userId],
          set: { role: "admin", permissionsJson: "[]" },
        }).run();
    });
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_transfer",
      targetUserId: target.userId, metadata: { slug: gate.server.slug, from: oldOwnerId, to: target.userId },
    });
    await notifyUser(io, db, target.userId, {
      code: "SERVER_TRANSFERRED",
      message: `You are now the owner of "${gate.server.name}".`,
      persist: {
        category: "server",
        kind: "system",
        serverId: gate.server.id,
        title: `You now own ${gate.server.name}`,
        snippet: "Ownership was transferred to you.",
        target: { kind: "server", id: gate.server.id },
      },
    });
    return { ok: true, ownerUserId: target.userId, ownerUsername: target.username };
  });
}
