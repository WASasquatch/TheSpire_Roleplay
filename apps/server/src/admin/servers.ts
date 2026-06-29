/**
 * Admin Servers tab — the SITE-staff review queue + cross-server oversight
 * (plan §4/§6, Phase 4). The deliberate mirror of the `/admin/forums*` routes
 * that live at the tail of `routes/forums.ts`, lifted into its own module
 * because the server creation-approval transaction is the heaviest piece:
 *
 *   GET   /admin/servers/applications         review queue (view_admin_servers)
 *   PATCH /admin/servers/applications/:id      approve / reject (review_server_applications)
 *   GET   /admin/servers                       oversight list incl. archived (view_admin_servers)
 *   PATCH /admin/servers/:id                   feature / archive / restore (manage_any_server)
 *
 * Approve runs ONE transaction (mirrors the forum provision): insert the server
 * + the owner's server_members row + a starter room (serverId, is_default=1,
 * slug-prefixed `<slug>_lobby` to dodge rooms_name_uq) + a welcome sticky, then
 * seeds the default usergroup. A half-created server is therefore impossible.
 *
 * HARD RULE — flag-off byte-identical: every handler 404s when
 * `areServersEnabled(getSettings(db))` is off, exactly like a disabled feature.
 */
import type { FastifyInstance } from "fastify";
import type { Server as IoServer } from "socket.io";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { normalizeServerSlug, SERVER_MAX_OWNED_DEFAULT } from "@thekeep/shared";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import {
  messages,
  rooms,
  serverCreationApplications,
  serverMembers,
  servers,
  users,
} from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "../routes/auth.js";
import { hasPermission } from "../auth/permissions.js";
import { ensureDefaultUsergroup } from "../servers/usergroups.js";
import { notifyUser } from "../servers/notifications.js";
import { getSettings, areServersEnabled } from "../settings.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

export async function registerAdminServerRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  async function serversLive(reply: { code: (c: number) => unknown }): Promise<boolean> {
    if (!areServersEnabled(await getSettings(db))) {
      reply.code(404);
      return false;
    }
    return true;
  }

  const toAppWire = async (rows: Array<typeof serverCreationApplications.$inferSelect>) => {
    const userIds = [...new Set(rows.flatMap((r) => [r.applicantUserId, r.reviewedByUserId].filter((x): x is string => !!x)))];
    const names = userIds.length
      ? await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, userIds))
      : [];
    const nameBy = new Map(names.map((n) => [n.id, n.username]));
    return rows.map((r) => ({
      id: r.id,
      applicantUserId: r.applicantUserId,
      applicantUsername: nameBy.get(r.applicantUserId) ?? "unknown",
      requestedName: r.requestedName,
      requestedSlug: r.requestedSlug,
      purpose: r.purpose,
      status: r.status,
      submittedAt: +r.submittedAt,
      reviewedAt: r.reviewedAt ? +r.reviewedAt : null,
      reviewedByUsername: r.reviewedByUserId ? nameBy.get(r.reviewedByUserId) ?? null : null,
      reviewNote: r.reviewNote ?? null,
    }));
  };

  app.get("/admin/servers/applications", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (!(await hasPermission(me, "view_admin_servers", db))) {
      reply.code(403); return { error: "forbidden" };
    }
    const pending = await db.select().from(serverCreationApplications)
      .where(eq(serverCreationApplications.status, "pending"))
      .orderBy(serverCreationApplications.submittedAt);
    const recent = await db.select().from(serverCreationApplications)
      .where(sql`${serverCreationApplications.status} != 'pending'`)
      .orderBy(desc(serverCreationApplications.reviewedAt))
      .limit(20);
    return { pending: await toAppWire(pending), recent: await toAppWire(recent) };
  });

  const reviewBody = z.object({
    action: z.enum(["approve", "reject"]),
    note: z.string().trim().max(500).optional(),
  }).strict();

  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/admin/servers/applications/:id",
    async (req, reply) => {
      if (!(await serversLive(reply))) return { error: "not found" };
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      if (!(await hasPermission(me, "review_server_applications", db))) {
        reply.code(403); return { error: "forbidden" };
      }
      let body: z.infer<typeof reviewBody>;
      try { body = reviewBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const appRow = (await db.select().from(serverCreationApplications)
        .where(eq(serverCreationApplications.id, req.params.id)).limit(1))[0];
      if (!appRow) { reply.code(404); return { error: "application not found" }; }
      if (appRow.status !== "pending") {
        reply.code(409); return { error: `application already ${appRow.status}` };
      }

      if (body.action === "approve") {
        // Re-validate at decision time (the world may have moved since
        // submission). Leaving the row PENDING on failure lets the reviewer
        // resolve (ask the applicant, or reject with a note).
        const slug = normalizeServerSlug(appRow.requestedSlug) ?? appRow.requestedSlug.toLowerCase();
        const taken = (await db.select({ id: servers.id }).from(servers)
          .where(sql`lower(${servers.slug}) = ${slug}`).limit(1))[0];
        if (taken) { reply.code(409); return { error: "That slug was claimed since the application was filed. Reject with a note so the applicant can pick another." }; }
        const owned = (await db.select({ n: sql<number>`count(*)` }).from(servers)
          .where(and(eq(servers.ownerUserId, appRow.applicantUserId), sql`${servers.status} != 'archived'`, eq(servers.isSystem, false))))[0]?.n ?? 0;
        if (owned >= SERVER_MAX_OWNED_DEFAULT) {
          reply.code(409); return { error: "The applicant is already at the owned-servers limit." };
        }
      }

      const nextStatus = body.action === "approve" ? "approved" as const : "rejected" as const;
      const serverId = nanoid();
      // The starter room needs a globally-unique name (rooms_name_uq).
      // Slug-prefixed `<slug>_lobby` is collision-proof and renameable later.
      const roomName = `${appRow.requestedSlug}_lobby`;
      const roomId = nanoid();
      let lostRace = false;
      let roomNameTaken = false;
      try {
        db.transaction((tx) => {
          const updated = tx.update(serverCreationApplications)
            .set({
              status: nextStatus,
              reviewedAt: new Date(),
              reviewedByUserId: me.id,
              reviewNote: body.note ?? null,
            })
            .where(and(
              eq(serverCreationApplications.id, appRow.id),
              eq(serverCreationApplications.status, "pending"),
            ))
            .run();
          if (updated.changes === 0) { lostRace = true; return; }
          if (nextStatus !== "approved") return;

          const nameClash = tx.select({ id: rooms.id }).from(rooms)
            .where(sql`lower(${rooms.name}) = ${roomName.toLowerCase()}`).limit(1).all()[0];
          if (nameClash) { roomNameTaken = true; throw new Error("rollback"); }

          // Server + owner role + starter room + welcome sticky, all in one tx
          // so a half-created server is impossible (mirror of the forum provision).
          tx.insert(servers).values({
            id: serverId,
            slug: appRow.requestedSlug,
            name: appRow.requestedName,
            tagline: appRow.purpose.length <= 200 ? appRow.purpose : `${appRow.purpose.slice(0, 197)}…`,
            ownerUserId: appRow.applicantUserId,
            isSystem: false,
            isDefault: false,
            status: "active",
            visibility: "public",
            joinMode: "open",
          }).run();
          tx.insert(serverMembers).values({
            serverId,
            userId: appRow.applicantUserId,
            role: "owner",
          }).run();
          tx.insert(rooms).values({
            id: roomId,
            name: roomName,
            type: "public",
            ownerId: appRow.applicantUserId,
            originalOwnerUserId: appRow.applicantUserId,
            lastOwnerUserId: appRow.applicantUserId,
            topic: "Welcome",
            isDefault: true,
            serverId,
          }).run();
          // Point the server's landing room at the starter room.
          tx.update(servers).set({ defaultRoomId: roomId }).where(eq(servers.id, serverId)).run();
          tx.insert(messages).values({
            id: nanoid(),
            roomId,
            userId: "system",
            characterId: null,
            displayName: "The Spire",
            kind: "say",
            body: [
              `${appRow.requestedName} is yours to keep. As its owner you can:`,
              "",
              "• Open and arrange rooms for your community.",
              "• Appoint moderators and admins, and set who may join.",
              "• Set the server's banner, sigil, colors, rules, and welcome.",
              "",
              "Find it on the server rail and share the word. The hall is yours.",
            ].join("\n"),
            isSticky: true,
            lastActivityAt: new Date(),
          }).run();
        });
      } catch (err) {
        // The room-name clash aborts via a sentinel throw so the whole approve
        // rolls back atomically; anything else is a real error.
        if (!roomNameTaken) throw err;
      }
      if (lostRace) {
        const current = (await db.select({ status: serverCreationApplications.status })
          .from(serverCreationApplications).where(eq(serverCreationApplications.id, appRow.id)).limit(1))[0];
        reply.code(409); return { error: `application already ${current?.status ?? "decided"}` };
      }
      if (roomNameTaken) {
        reply.code(409); return { error: "A room already uses this server's starter room name - reject with a note so the applicant picks another slug." };
      }

      // Default usergroup (full FEATURE baseline) so members keep post/create-
      // room/upload/emoticon/invite until the owner narrows it. Outside the tx
      // (it's idempotent + conflict-safe) so the provision stays the lean core.
      if (nextStatus === "approved") {
        await ensureDefaultUsergroup(db, serverId);
      }

      await notifyUser(io, appRow.applicantUserId,
        nextStatus === "approved" ? "SERVER_APP_APPROVED" : "SERVER_APP_REJECTED",
        nextStatus === "approved"
          ? `Your server "${appRow.requestedName}" was approved - find it on the server rail!`
          : `Your server application "${appRow.requestedName}" was declined${body.note ? `: ${body.note}` : "."}`);

      const rows = await db.select().from(serverCreationApplications)
        .where(eq(serverCreationApplications.id, appRow.id)).limit(1);
      return { application: (await toAppWire(rows))[0] };
    },
  );

  /** Admin oversight list — every server INCLUDING archived (the public
   *  catalog filters those out), so staff can feature/unfeature/restore. */
  app.get("/admin/servers", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (!(await hasPermission(me, "view_admin_servers", db))) {
      reply.code(403); return { error: "forbidden" };
    }
    const rows = await db
      .select({
        id: servers.id,
        slug: servers.slug,
        name: servers.name,
        status: servers.status,
        visibility: servers.visibility,
        joinMode: servers.joinMode,
        isSystem: servers.isSystem,
        isDefault: servers.isDefault,
        ownerUsername: users.username,
        createdAt: servers.createdAt,
      })
      .from(servers)
      .leftJoin(users, eq(users.id, servers.ownerUserId));
    return {
      servers: rows.map((s) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        status: s.status,
        visibility: s.visibility,
        joinMode: s.joinMode,
        isSystem: !!s.isSystem,
        isDefault: !!s.isDefault,
        ownerUsername: s.ownerUsername ?? "unknown",
        createdAt: +s.createdAt,
      })),
    };
  });

  const adminStatusBody = z.object({
    status: z.enum(["active", "featured", "archived"]),
  }).strict();

  /** Feature (pins the rail/catalog top), un-feature, archive (drops from the
   *  catalog; rooms stay), or restore a server. The system server can't be
   *  archived — the rail/catalog anchors on it. */
  app.patch<{ Params: { id: string }; Body: unknown }>("/admin/servers/:id", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (!(await hasPermission(me, "manage_any_server", db))) {
      reply.code(403); return { error: "forbidden" };
    }
    let body: z.infer<typeof adminStatusBody>;
    try { body = adminStatusBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const server = (await db.select().from(servers).where(eq(servers.id, req.params.id)).limit(1))[0];
    if (!server) { reply.code(404); return { error: "no server" }; }
    if (server.isSystem && body.status === "archived") {
      reply.code(409); return { error: "The home server anchors the rail and can't be archived." };
    }
    await db.update(servers).set({ status: body.status, updatedAt: new Date() })
      .where(eq(servers.id, server.id));
    return { ok: true };
  });
}
