/**
 * serversConsole - owner console: invites, appearance + identity images,
 * per-server settings, per-server room admin, members + roles, and usergroups.
 * Move-only extraction from registerServerRoutes; behavior is byte-identical.
 */
import {
  RESERVED_SERVER_SLUGS,
  SERVER_MAX_AUTO_RULES,
  SERVER_MAX_OWNED_DEFAULT,
  SERVER_MAX_USERGROUPS,
  SERVER_MOD_DEFAULT_PERMISSIONS,
  SERVER_MOD_PERMISSIONS,
  SERVER_NAME_MAX,
  SERVER_NAME_MIN,
  SERVER_PERMISSIONS,
  SERVER_PURPOSE_MAX,
  SERVER_PURPOSE_MIN,
  SERVER_REAPPLY_COOLDOWN_DAYS,
  SERVER_SLUG_RE,
  SERVER_TAGLINE_MAX,
  SERVER_USERGROUP_NAME_MAX,
  hasTag,
  isGrantableServerModPermission,
  isModeratorRole,
  isServerFeaturePermission,
  normalizeServerSlug,
  normalizeTheme,
  parseTagsJson,
  serializeTags,
  parseServerAutoRules,
  parseServerFeaturePermissions,
  parseServerModPermissions,
  serializeServerAutoRules,
  serializeServerFeaturePermissions,
  serializeServerModPermissions,
} from "@thekeep/shared";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type {
  ServerAutoRule,
  ServerFeaturePermission,
  ServerModPermission,
  ServerPermission,
  ServerRole,
  ServerViewerState,
} from "@thekeep/shared";
import {
  accountMutes,
  auditLog,
  characters,
  messages,
  rooms,
  serverBans,
  serverCreationApplications,
  serverInvites,
  serverMembers,
  serverMembershipApplications,
  serverSettings,
  serverUsergroupMembers,
  serverUsergroups,
  serverVisits,
  servers,
  siteSettings,
  users,
} from "../db/schema.js";
import { getSessionUser } from "./auth.js";
import { hasPermission } from "../auth/permissions.js";
import { serverAuthority, serverCan } from "../servers/authority.js";
import { isServerModerationActive, serverModerationNotice } from "../servers/moderation.js";
import { ensureDefaultUsergroup, serverRoomIds } from "../servers/usergroups.js";
import { notifyUser, emitServersChanged } from "../servers/notifications.js";
import { invalidateServerSettings } from "../settings.js";
import {
  broadcastPresence,
  broadcastRoomState,
  emitTreeChanged,
  findCanonicalLanding,
  findServerLanding,
  sendRoomBacklogTo,
} from "../realtime/broadcast.js";
import { deriveUniqueRoomSlug } from "../lib/roomSlug.js";
import { softHideUserMessages } from "../lib/purgeUserMessages.js";
import { DEFAULT_SERVER_ID } from "../earning/pool.js";
import {
  auditServer,
  buildServerSummary,
  catalogRank,
  parseCrop,
  roomInServer,
  roomsOfServerWhere,
  SERVER_SUMMARY_COLUMNS,
} from "./serversShared.js";
import type { ServerRoutesCtx, ServerSummaryRow, SummaryViewerCtx } from "./serversShared.js";

export function registerServerConsoleRoutes(ctx: ServerRoutesCtx): void {
  const { app, db, io, serversLive, requireServerOwner, requireServerPermission, resolveServerTarget, writeServerImage, unlinkServerImage } = ctx;

  /* =========================================================
   *  Invites (joinMode = "invite")
   * ========================================================= */

  /** Mint an unguessable invite code. Same alphabet/length nanoid the rest of
   *  the routes use for opaque ids — collision odds are negligible and the
   *  column's UNIQUE constraint is the backstop. */
  function mintInviteCode(): string {
    return nanoid(16);
  }

  const inviteWire = (r: typeof serverInvites.$inferSelect, origin?: string) => ({
    code: r.code,
    link: origin ? `${origin}/servers/join/${r.code}` : null,
    maxUses: r.maxUses ?? null,
    usedCount: r.usedCount,
    expiresAt: r.expiresAt ? +r.expiresAt : null,
    createdAt: +r.createdAt,
  });

  /** Origin for the shareable join link, derived from the request (mirrors how
   *  the export route builds absolute URLs); null when it can't be resolved. */
  function requestOrigin(req: { headers: Record<string, unknown>; protocol?: string }): string | null {
    const host = req.headers["x-forwarded-host"] ?? req.headers["host"];
    if (!host || typeof host !== "string") return null;
    const fwdProto = req.headers["x-forwarded-proto"];
    const proto = (typeof fwdProto === "string" ? fwdProto.split(",")[0] : null) ?? req.protocol ?? "https";
    return `${proto}://${host}`;
  }

  const createInviteBody = z.object({
    maxUses: z.number().int().min(1).max(100_000).nullable().optional(),
    /** Lifetime in hours from now; null/omitted → never expires. */
    expiresInHours: z.number().int().min(1).max(24 * 365).nullable().optional(),
  }).strict();

  /** POST /servers/:id/invites — mint a fresh invite code (manage_invites). */
  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/invites", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_invites");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof createInviteBody>;
    try { body = createInviteBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const expiresAt = body.expiresInHours ? new Date(Date.now() + body.expiresInHours * 3_600_000) : null;
    const id = nanoid();
    const code = mintInviteCode();
    await db.insert(serverInvites).values({
      id,
      serverId: gate.server.id,
      code,
      createdByUserId: gate.me.id,
      maxUses: body.maxUses ?? null,
      expiresAt,
    });
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_invite_create",
      metadata: { slug: gate.server.slug, code, maxUses: body.maxUses ?? null, expiresAt: expiresAt ? +expiresAt : null },
    });
    const row = (await db.select().from(serverInvites).where(eq(serverInvites.id, id)).limit(1))[0]!;
    return { invite: inviteWire(row, requestOrigin(req) ?? undefined) };
  });

  /** GET /servers/:id/invites — list LIVE invites (non-revoked, non-expired)
   *  with usage counts (manage_invites). */
  app.get<{ Params: { id: string } }>("/servers/:id/invites", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_invites");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const now = Date.now();
    const rows = await db.select().from(serverInvites)
      .where(and(
        eq(serverInvites.serverId, gate.server.id),
        isNull(serverInvites.revokedAt),
        sql`(${serverInvites.expiresAt} is null or ${serverInvites.expiresAt} > ${now})`,
      ))
      .orderBy(desc(serverInvites.createdAt));
    const origin = requestOrigin(req) ?? undefined;
    return { invites: rows.map((r) => inviteWire(r, origin)) };
  });

  /** DELETE /servers/:id/invites/:code — revoke an invite (manage_invites). */
  app.delete<{ Params: { id: string; code: string } }>("/servers/:id/invites/:code", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_invites");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const existing = (await db.select().from(serverInvites)
      .where(and(
        eq(serverInvites.serverId, gate.server.id),
        eq(serverInvites.code, req.params.code),
        isNull(serverInvites.revokedAt),
      )).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "no such invite" }; }
    await db.update(serverInvites).set({ revokedAt: new Date() })
      .where(eq(serverInvites.id, existing.id));
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_invite_revoke",
      metadata: { slug: gate.server.slug, code: existing.code },
    });
    return { ok: true };
  });
  /* =========================================================
   *  Owner console: appearance (PATCH /servers/:id)
   * ========================================================= */

  // Pan/zoom focus for the icon + banner — the same AvatarCrop shape user
  // avatars use ({zoom,offsetX,offsetY}); persisted as JSON.
  const cropSchema = z.object({
    zoom: z.number().min(1).max(4),
    offsetX: z.number().min(0).max(100),
    offsetY: z.number().min(0).max(100),
  }).strict();

  const patchServerBody = z.object({
    name: z.string().trim().min(SERVER_NAME_MIN).max(SERVER_NAME_MAX).optional(),
    tagline: z.string().trim().max(SERVER_TAGLINE_MAX).nullable().optional(),
    descriptionHtml: z.string().max(5000 * 4).nullable().optional(),
    logoUrl: z.string().trim().max(2048).nullable().optional(),
    iconColor: z.string().trim().max(32).nullable().optional(),
    borderColor: z.string().trim().max(32).nullable().optional(),
    iconCrop: cropSchema.nullable().optional(),
    bannerCrop: cropSchema.nullable().optional(),
    themeJson: z.string().max(4000).nullable().optional(),
    themeStyleKey: z.string().trim().min(1).max(64).nullable().optional(),
    bannerFocusY: z.number().int().min(0).max(100).optional(),
    bannerHeight: z.number().int().min(48).max(240).nullable().optional(),
    publicBrowsing: z.boolean().optional(),
    joinMode: z.enum(["open", "application", "invite"]).optional(),
    applicationPrompt: z.string().trim().max(300).nullable().optional(),
    /** Owner-set discovery tags (migration 0301). normalizeTags/serializeTags
     *  do the real sanitizing on persist — the loose array bound just rejects
     *  absurd payloads before we touch the normalizer. */
    tags: z.array(z.string()).max(64).optional(),
    /** Welcome + rules HTML live in the per-server settings row (Track owns
     *  that surface separately); appearance here is the servers-table slice. */
    roomOrder: z.array(z.string()).max(200).optional(),
  }).strict();

  app.patch<{ Params: { id: string }; Body: unknown }>("/servers/:id", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_appearance");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof patchServerBody>;
    try { body = patchServerBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const update: Partial<typeof servers.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) update.name = body.name;
    if (body.tagline !== undefined) update.tagline = body.tagline?.trim() ? body.tagline.trim() : null;
    if (body.descriptionHtml !== undefined) {
      const { sanitizeBio } = await import("../auth/html.js");
      update.descriptionHtml = body.descriptionHtml?.trim() ? sanitizeBio(body.descriptionHtml) : null;
    }
    if (body.logoUrl !== undefined) update.logoUrl = body.logoUrl?.trim() ? body.logoUrl.trim() : null;
    if (body.iconColor !== undefined) update.iconColor = body.iconColor?.trim() ? body.iconColor.trim() : null;
    if (body.borderColor !== undefined) update.borderColor = body.borderColor?.trim() ? body.borderColor.trim() : null;
    if (body.iconCrop !== undefined) update.iconCrop = body.iconCrop ? JSON.stringify(body.iconCrop) : null;
    if (body.bannerCrop !== undefined) update.bannerCrop = body.bannerCrop ? JSON.stringify(body.bannerCrop) : null;
    if (body.themeJson !== undefined) {
      if (body.themeJson === null || !body.themeJson.trim()) {
        update.themeJson = null;
      } else {
        try { update.themeJson = JSON.stringify(normalizeTheme(JSON.parse(body.themeJson))); }
        catch { reply.code(400); return { error: "themeJson must be a JSON theme object" }; }
      }
    }
    if (body.themeStyleKey !== undefined) update.themeStyleKey = body.themeStyleKey;
    if (body.bannerFocusY !== undefined) update.bannerFocusY = body.bannerFocusY;
    if (body.bannerHeight !== undefined) update.bannerHeight = body.bannerHeight;
    if (body.publicBrowsing !== undefined) update.publicBrowsing = body.publicBrowsing;
    if (body.applicationPrompt !== undefined) {
      update.applicationPrompt = body.applicationPrompt?.trim() ? body.applicationPrompt.trim() : null;
    }
    // serializeTags normalizes (lowercase/dedupe/clamp) and returns NULL when
    // the list is empty, so an empty array clears the column.
    if (body.tags !== undefined) update.tagsJson = serializeTags(body.tags);
    // The system/default server is the platform home: its join mode stays open
    // (everyone is an implicit member) — refuse to gate it.
    if (body.joinMode !== undefined) {
      if (gate.server.isSystem && body.joinMode !== "open") {
        reply.code(409); return { error: "The home server can't be gated." };
      }
      update.joinMode = body.joinMode;
    }
    if (body.roomOrder !== undefined) {
      const own = new Set((await db.select({ id: rooms.id }).from(rooms)
        .where(roomsOfServerWhere(gate.server.id))).map((r) => r.id));
      update.roomOrderJson = JSON.stringify(body.roomOrder.filter((id) => own.has(id)));
    }
    await db.update(servers).set(update).where(eq(servers.id, gate.server.id));
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_appearance_update",
      metadata: { slug: gate.server.slug, fields: Object.keys(update).filter((k) => k !== "updatedAt") },
    });
    return { ok: true };
  });

  /* ---------- Identity images: icon (logo) / banner upload ---------- */

  const serverImageBody = z.union([
    z.object({ imageDataUrl: z.string().min(32).max(4_000_000) }).strict(),
    z.object({ clear: z.literal(true) }).strict(),
  ]);

  // POST /servers/:id/{logo,banner,horizontal-logo} — upload (or clear) the
  // server's round icon / header banner / wide top-bar wordmark. Mirrors the
  // forum image endpoints; gated on manage_appearance (the same key the
  // appearance PATCH uses).
  const IMAGE_COLUMN = { logo: "logoUrl", banner: "bannerImageUrl", "horizontal-logo": "horizontalLogoUrl" } as const;
  for (const kind of ["logo", "banner", "horizontal-logo"] as const) {
    const maxBytes = kind === "logo" ? 512 * 1024 : kind === "horizontal-logo" ? 1024 * 1024 : 2 * 1024 * 1024;
    const column = IMAGE_COLUMN[kind];
    app.post<{ Params: { id: string }; Body: unknown }>(`/servers/:id/${kind}`, async (req, reply) => {
      if (!(await serversLive(reply))) return { error: "not found" };
      const gate = await requireServerPermission(req, req.params.id, "manage_appearance");
      if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
      let body: z.infer<typeof serverImageBody>;
      try { body = serverImageBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }
      const prev = gate.server[column];
      if ("clear" in body) {
        await db.update(servers).set({ [column]: null, updatedAt: new Date() }).where(eq(servers.id, gate.server.id));
        unlinkServerImage(prev);
      } else {
        const written = await writeServerImage(`${gate.server.id}-${kind}`, body.imageDataUrl, maxBytes);
        if ("error" in written) { reply.code(written.status); return { error: written.error }; }
        await db.update(servers).set({ [column]: written.url, updatedAt: new Date() }).where(eq(servers.id, gate.server.id));
        if (prev !== written.url) unlinkServerImage(prev);
        await auditServer(db, {
          serverId: gate.server.id, actorUserId: gate.me.id, action: "server_appearance_update",
          metadata: { slug: gate.server.slug, fields: [column] },
        });
        return { ok: true, url: written.url };
      }
      await auditServer(db, {
        serverId: gate.server.id, actorUserId: gate.me.id, action: "server_appearance_update",
        metadata: { slug: gate.server.slug, fields: [column], cleared: true },
      });
      return { ok: true, url: null };
    });
  }

  /* =========================================================
   *  Owner console: per-server ROOM admin (manage_rooms)
   *  The per-server analog of /admin/rooms — a server owner/mod manages THIS
   *  server's rooms (create/edit/delete) from the console instead of the global
   *  admin panel (plan.md §4 partition: "Rooms are a server's content").
   * ========================================================= */

  const serverRoomCreateBody = z.object({
    name: z.string().trim().min(1).max(40),
    type: z.enum(["public", "private"]).default("public"),
    password: z.string().min(1).max(128).optional(),
    topic: z.string().max(200).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
    replyMode: z.enum(["flat", "nested"]).optional(),
    // A server channel persists when empty by default (Discord-like); the owner
    // can untick this to make an ephemeral, park-when-empty room instead.
    persistent: z.boolean().default(true),
  }).strict();
  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/rooms", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_rooms");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof serverRoomCreateBody>;
    try { body = serverRoomCreateBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    if (body.type === "private" && !body.password) { reply.code(400); return { error: "a private room needs a password" }; }
    const dup = (await db.select({ id: rooms.id }).from(rooms)
      .where(sql`lower(${rooms.name}) = ${body.name.toLowerCase()}`).limit(1))[0];
    if (dup) { reply.code(409); return { error: "a room with that name already exists" }; }
    const id = nanoid();
    const argon2 = (await import("argon2")).default;
    await db.insert(rooms).values({
      id,
      name: body.name,
      slug: await deriveUniqueRoomSlug(db, body.name),
      type: body.type,
      passwordHash: body.type === "private" && body.password ? await argon2.hash(body.password) : null,
      topic: body.topic?.trim() ? body.topic.trim() : null,
      description: body.description?.trim() ? body.description : null,
      ownerId: gate.me.id,
      originalOwnerUserId: gate.me.id,
      lastOwnerUserId: gate.me.id,
      replyMode: body.replyMode ?? "flat",
      serverId: gate.server.id,
      // Channels persist when empty so the server's structure survives a quiet
      // moment; without this the zombie sweep parks them within ~60s.
      persistent: body.persistent,
    });
    await auditServer(db, { serverId: gate.server.id, actorUserId: gate.me.id, action: "server_room_create", targetRoomId: id, metadata: { name: body.name } });
    emitTreeChanged(io, gate.server.id);
    return { ok: true, id };
  });

  const serverRoomPatchBody = z.object({
    name: z.string().trim().min(1).max(40).optional(),
    topic: z.string().max(200).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
    type: z.enum(["public", "private"]).optional(),
    password: z.string().max(128).nullable().optional(),
    replyMode: z.enum(["flat", "nested"]).optional(),
    messageExpiryMinutes: z.number().int().min(0).max(100_000).nullable().optional(),
    isDefault: z.boolean().optional(),
    persistent: z.boolean().optional(),
  }).strict();

  app.patch<{ Params: { id: string; roomId: string }; Body: unknown }>("/servers/:id/rooms/:roomId", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_rooms");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.roomId)).limit(1))[0];
    if (!room || !roomInServer(room, gate.server.id)) { reply.code(404); return { error: "no such room in this server" }; }
    let body: z.infer<typeof serverRoomPatchBody>;
    try { body = serverRoomPatchBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    if (body.name && body.name.toLowerCase() !== room.name.toLowerCase()) {
      const dup = (await db.select({ id: rooms.id }).from(rooms)
        .where(and(sql`lower(${rooms.name}) = ${body.name.toLowerCase()}`, ne(rooms.id, room.id))).limit(1))[0];
      if (dup) { reply.code(409); return { error: "a room with that name already exists" }; }
    }
    const update: Partial<typeof rooms.$inferInsert> = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.topic !== undefined) update.topic = body.topic?.trim() ? body.topic.trim() : null;
    if (body.description !== undefined) update.description = body.description?.trim() ? body.description : null;
    if (body.replyMode !== undefined) update.replyMode = body.replyMode;
    if (body.persistent !== undefined) update.persistent = body.persistent;
    if (body.messageExpiryMinutes !== undefined) update.messageExpiryMinutes = body.messageExpiryMinutes;
    // One default room PER server (rooms_one_default_per_server). Flag-on first
    // clears whichever room in THIS server currently holds it.
    if (body.isDefault === true && !room.isDefault) {
      await db.update(rooms).set({ isDefault: false })
        .where(and(roomsOfServerWhere(gate.server.id), eq(rooms.isDefault, true)));
      update.isDefault = true;
    } else if (body.isDefault === false) {
      update.isDefault = false;
    }
    if (body.type !== undefined && body.type !== room.type) {
      update.type = body.type;
      const argon2 = (await import("argon2")).default;
      if (body.type === "private") {
        if (body.password) update.passwordHash = await argon2.hash(body.password);
        else if (!room.passwordHash) { reply.code(400); return { error: "switching to private requires a password" }; }
      } else { update.passwordHash = null; }
    } else if (body.password !== undefined) {
      const argon2 = (await import("argon2")).default;
      update.passwordHash = body.password ? await argon2.hash(body.password) : null;
    }
    await db.update(rooms).set(update).where(eq(rooms.id, room.id));
    await auditServer(db, { serverId: gate.server.id, actorUserId: gate.me.id, action: "server_room_update", targetRoomId: room.id, metadata: { fields: Object.keys(update) } });
    await broadcastRoomState(io, db, room.id);
    emitTreeChanged(io, gate.server.id);
    return { ok: true };
  });

  app.delete<{ Params: { id: string; roomId: string } }>("/servers/:id/rooms/:roomId", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_rooms");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.roomId)).limit(1))[0];
    if (!room || !roomInServer(room, gate.server.id)) { reply.code(404); return { error: "no such room in this server" }; }
    // System rooms are the server's structural landings. Only the SERVER OWNER
    // (authority.isOwner also covers the site owner / global staff) may remove
    // one, and never the last one — the server must always keep a home room to
    // land people in. This lets an owner clear a vestigial system room (e.g. the
    // old "Forums" landing, now that forums are their own system).
    let systemSurvivor: typeof room | undefined;
    if (room.isSystem) {
      if (!gate.authority.isOwner) {
        reply.code(403);
        return { error: "only the server owner can remove a system room" };
      }
      systemSurvivor = (await db
        .select()
        .from(rooms)
        .where(and(eq(rooms.serverId, gate.server.id), eq(rooms.isSystem, true), ne(rooms.id, room.id)))
        .orderBy(asc(rooms.createdAt))
        .limit(1))[0];
      if (!systemSurvivor) {
        reply.code(400);
        return { error: "can't remove the server's only system room; make another room first" };
      }
    }
    // Relocate live occupants to this server's landing (then canonical), mirror
    // the global admin hatchet; cascade FKs clean up members/messages/bans. If
    // the landing IS the system room being deleted, fall back to the surviving
    // system room so no one is stranded in the deleted room.
    let landing = (await findServerLanding(db, gate.server.id)) ?? (await findCanonicalLanding(db));
    if (landing && landing.id === room.id) landing = systemSurvivor ?? (await findCanonicalLanding(db));
    const remoteSockets = await io.in(`room:${room.id}`).fetchSockets();
    for (const s of remoteSockets) {
      s.leave(`room:${room.id}`);
      s.emit("error:notice", { code: "ROOM_DELETED", message: `Room "${room.name}" was removed.` });
      if (landing) {
        s.join(`room:${landing.id}`);
        (s.data as { roomId?: string }).roomId = landing.id;
        const uid = (s.data as { userId?: string }).userId;
        if (uid) await sendRoomBacklogTo(s, db, landing.id, uid);
      }
    }
    await db.delete(rooms).where(eq(rooms.id, room.id));
    await auditServer(db, { serverId: gate.server.id, actorUserId: gate.me.id, action: "server_room_delete", metadata: { roomId: room.id, roomName: room.name } });
    if (landing && remoteSockets.length > 0) await broadcastRoomState(io, db, landing.id);
    emitTreeChanged(io, gate.server.id);
    return { ok: true };
  });

  /* =========================================================
   *  Owner console: per-server settings (server_settings row)
   * ========================================================= */

  /** GET /servers/:id/settings — the RAW per-server overrides (migration 0276
   *  columns; NULL = inherit the platform default). Track 1 consumes this to
   *  render the settings form; the resolved/effective values live behind
   *  getServerSettings. Visible to any member/mod (read-only). */
  app.get<{ Params: { id: string } }>("/servers/:id/settings", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const a = await serverAuthority(db, me, req.params.id);
    if (!a.server) { reply.code(404); return { error: "no server" }; }
    if (!a.isMember && !a.isMod) { reply.code(403); return { error: "forbidden" }; }
    const row = (await db.select().from(serverSettings)
      .where(eq(serverSettings.serverId, a.server.id)).limit(1))[0];
    return {
      settings: {
        messageRetentionMs: row?.messageRetentionMs ?? null,
        maxRoomsPerOwner: row?.maxRoomsPerOwner ?? null,
        maxMessageLength: row?.maxMessageLength ?? null,
        editGraceMs: row?.editGraceMs ?? null,
        rulesHtml: row?.rulesHtml ?? null,
        securityNoticeHtml: row?.securityNoticeHtml ?? null,
        welcomeHtml: row?.welcomeHtml ?? null,
        newUserWelcomeHtml: row?.newUserWelcomeHtml ?? null,
        maxForumPostLength: row?.maxForumPostLength ?? null,
        // Onboarding flow (migration 0320): the stored OnboardingConfig JSON +
        // the per-server master switch. The console's Onboarding editor reads
        // these; the member-facing flow reads them via getServerSettings.
        onboardingConfigJson: row?.onboardingConfigJson ?? null,
        onboardingEnabled: !!row?.onboardingEnabled,
      },
    };
  });

  /** PATCH /servers/:id/settings — upsert the per-server overrides for the
   *  provided fields (NULL = clear the override, inherit the platform default).
   *  Gated on manage_appearance (same chair as the appearance slice). Numeric
   *  caps are positive ints; HTML copy is sanitized like the appearance
   *  description. Invalidates the getServerSettings cache after the write. */
  const patchSettingsBody = z.object({
    messageRetentionMs: z.number().int().positive().nullable().optional(),
    maxRoomsPerOwner: z.number().int().positive().max(10_000).nullable().optional(),
    maxMessageLength: z.number().int().positive().max(100_000).nullable().optional(),
    editGraceMs: z.number().int().min(0).nullable().optional(),
    maxForumPostLength: z.number().int().positive().max(1_000_000).nullable().optional(),
    rulesHtml: z.string().max(200_000).nullable().optional(),
    securityNoticeHtml: z.string().max(200_000).nullable().optional(),
    welcomeHtml: z.string().max(200_000).nullable().optional(),
    newUserWelcomeHtml: z.string().max(200_000).nullable().optional(),
    // Onboarding flow (migration 0320): the raw OnboardingConfig JSON + master
    // switch. JSON is stored verbatim (parsed/validated by the self-roles route);
    // null clears the override.
    onboardingConfigJson: z.string().max(200_000).nullable().optional(),
    onboardingEnabled: z.boolean().nullable().optional(),
  }).strict();

  app.patch<{ Params: { id: string }; Body: unknown }>("/servers/:id/settings", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_appearance");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof patchSettingsBody>;
    try { body = patchSettingsBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const update: Partial<typeof serverSettings.$inferInsert> = {
      updatedAt: new Date(),
      updatedById: gate.me.id,
    };
    if (body.messageRetentionMs !== undefined) update.messageRetentionMs = body.messageRetentionMs;
    if (body.maxRoomsPerOwner !== undefined) update.maxRoomsPerOwner = body.maxRoomsPerOwner;
    if (body.maxMessageLength !== undefined) update.maxMessageLength = body.maxMessageLength;
    if (body.editGraceMs !== undefined) update.editGraceMs = body.editGraceMs;
    if (body.maxForumPostLength !== undefined) update.maxForumPostLength = body.maxForumPostLength;
    // Onboarding flow (migration 0320). JSON stored verbatim (blank ⇒ cleared);
    // the enabled switch coerces null ⇒ false so a cleared toggle turns it off.
    if (body.onboardingConfigJson !== undefined) {
      update.onboardingConfigJson = body.onboardingConfigJson?.trim() ? body.onboardingConfigJson : null;
    }
    if (body.onboardingEnabled !== undefined) update.onboardingEnabled = body.onboardingEnabled ?? false;
    if (body.rulesHtml !== undefined || body.securityNoticeHtml !== undefined
      || body.welcomeHtml !== undefined || body.newUserWelcomeHtml !== undefined) {
      const { sanitizeBio } = await import("../auth/html.js");
      const clean = (v: string | null | undefined) =>
        v === undefined ? undefined : (v?.trim() ? sanitizeBio(v) : null);
      if (body.rulesHtml !== undefined) update.rulesHtml = clean(body.rulesHtml) ?? null;
      if (body.securityNoticeHtml !== undefined) update.securityNoticeHtml = clean(body.securityNoticeHtml) ?? null;
      if (body.welcomeHtml !== undefined) update.welcomeHtml = clean(body.welcomeHtml) ?? null;
      if (body.newUserWelcomeHtml !== undefined) update.newUserWelcomeHtml = clean(body.newUserWelcomeHtml) ?? null;
    }

    await db.insert(serverSettings)
      .values({ serverId: gate.server.id, ...update })
      .onConflictDoUpdate({ target: serverSettings.serverId, set: update });
    invalidateServerSettings(gate.server.id);
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_settings_update",
      metadata: { slug: gate.server.slug, fields: Object.keys(update).filter((k) => k !== "updatedAt" && k !== "updatedById") },
    });
    return { ok: true };
  });

  /* =========================================================
   *  Members + roles
   * ========================================================= */

  app.get<{ Params: { id: string } }>("/servers/:id/members", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    // The member roster is basic staff info: ANY server staff may READ it — the
    // Users moderation tab needs it for a mod holding kick/mute/ban, not only
    // manage_members. (Role/permission WRITES stay gated on manage_members in
    // the mutation routes below.) So gate the read on "holds any server grant".
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const a = await serverAuthority(db, me, req.params.id);
    if (!a.server) { reply.code(404); return { error: "no server" }; }
    if (!(a.isOwner || a.permissions.length > 0)) { reply.code(403); return { error: "you don't manage this server" }; }
    // Capture after the null-guard so the non-null narrowing survives the awaits
    // below (TS re-widens a mutable property across await/calls otherwise).
    const server = a.server;
    const owner = (await db.select({ username: users.username, avatarUrl: users.avatarUrl })
      .from(users).where(eq(users.id, server.ownerUserId)).limit(1))[0];
    const rows = await db
      .select({
        userId: serverMembers.userId, username: users.username, avatarUrl: users.avatarUrl,
        role: serverMembers.role, permissionsJson: serverMembers.permissionsJson, joinedAt: serverMembers.joinedAt,
      })
      .from(serverMembers)
      .leftJoin(users, eq(users.id, serverMembers.userId))
      .where(eq(serverMembers.serverId, server.id));
    const members = rows
      .filter((r) => r.userId !== server.ownerUserId)
      .map((r) => ({
        userId: r.userId,
        username: r.username ?? "unknown",
        avatarUrl: r.avatarUrl ?? null,
        role: r.role,
        permissions: r.role === "mod" ? parseServerModPermissions(r.permissionsJson) : [],
        joinedAt: +r.joinedAt,
      }));
    return {
      managerPermissions: a.permissions,
      members: [
        { userId: server.ownerUserId, username: owner?.username ?? "unknown", avatarUrl: owner?.avatarUrl ?? null, role: "owner" as const, permissions: [], joinedAt: +server.createdAt },
        ...members,
      ],
    };
  });

  /** Clamp a requested mod grant to what the ACTOR may grant (no escalation). */
  function clampGrant(requested: ServerPermission[], actorPerms: ServerPermission[], isOwner: boolean): ServerPermission[] {
    if (isOwner) return requested;
    const allowed = new Set(actorPerms);
    return requested.filter((p) => allowed.has(p));
  }

  const setRoleBody = z.object({
    role: z.enum(["admin", "mod", "member"]),
    /** Only honored for role="mod"; omitted → the default janitor set. */
    permissions: z.array(z.string()).max(SERVER_MOD_PERMISSIONS.length + 5).optional(),
  }).strict();

  /** PUT /servers/:id/members/:userId/role — set a member's tier. Promoting to
   *  admin (the lieutenant) or assigning mods is OWNER-only; granting/editing a
   *  mod's granular keys needs manage_members. */
  app.put<{ Params: { id: string; userId: string }; Body: unknown }>(
    "/servers/:id/members/:userId/role",
    async (req, reply) => {
      if (!(await serversLive(reply))) return { error: "not found" };
      let body: z.infer<typeof setRoleBody>;
      try { body = setRoleBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }
      // Appointing the admin lieutenant tier is owner-only (matches the powers
      // matrix: "assign mods/admins" stays owner-tier); the mod chair + member
      // demote ride manage_members.
      const gate = body.role === "admin"
        ? await requireServerOwner(req, req.params.id)
        : await requireServerPermission(req, req.params.id, "manage_members");
      if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
      if (req.params.userId === gate.server.ownerUserId) {
        reply.code(409); return { error: "The owner already holds every power." };
      }
      const ban = (await db.select().from(serverBans)
        .where(and(eq(serverBans.serverId, gate.server.id), eq(serverBans.userId, req.params.userId))).limit(1))[0];
      if (ban && (!ban.until || +ban.until > Date.now())) {
        reply.code(409); return { error: "That user is banned from this server - lift the ban first." };
      }
      // A mod's grant excludes owner-only keys (manage_appearance) — appearance
      // stays owner-only, so even the owner can't hand it to a mod here.
      const permsJson = body.role === "mod"
        ? serializeServerModPermissions(
            (clampGrant(
              (body.permissions ? body.permissions.filter(isGrantableServerModPermission) : SERVER_MOD_DEFAULT_PERMISSIONS) as ServerPermission[],
              gate.authority.permissions,
              gate.authority.isOwner,
            ).filter(isGrantableServerModPermission)),
          )
        : "[]";
      await db.insert(serverMembers)
        .values({ serverId: gate.server.id, userId: req.params.userId, role: body.role, permissionsJson: permsJson })
        .onConflictDoUpdate({
          target: [serverMembers.serverId, serverMembers.userId],
          set: { role: body.role, permissionsJson: permsJson },
        });
      await auditServer(db, {
        serverId: gate.server.id, actorUserId: gate.me.id, action: "server_role_set",
        targetUserId: req.params.userId, metadata: { slug: gate.server.slug, role: body.role },
      });
      return { ok: true, role: body.role };
    },
  );

  /** PATCH /servers/:id/members/:userId/permissions — edit an existing mod's
   *  granular keys (manage_members; clamped to the actor's own powers). */
  const setModPermsBody = z.object({ permissions: z.array(z.string()).max(SERVER_MOD_PERMISSIONS.length + 5) }).strict();
  app.patch<{ Params: { id: string; userId: string }; Body: unknown }>(
    "/servers/:id/members/:userId/permissions",
    async (req, reply) => {
      if (!(await serversLive(reply))) return { error: "not found" };
      const gate = await requireServerPermission(req, req.params.id, "manage_members");
      if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
      let body: z.infer<typeof setModPermsBody>;
      try { body = setModPermsBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }
      const row = (await db.select().from(serverMembers)
        .where(and(
          eq(serverMembers.serverId, gate.server.id),
          eq(serverMembers.userId, req.params.userId),
          eq(serverMembers.role, "mod"),
        )).limit(1))[0];
      if (!row) { reply.code(404); return { error: "not a mod here" }; }
      // Owner-only keys (manage_appearance) are never grantable to a mod.
      const requested = body.permissions.filter(isGrantableServerModPermission) as ServerPermission[];
      const clamped = clampGrant(requested, gate.authority.permissions, gate.authority.isOwner).filter(isGrantableServerModPermission);
      // Preserve grantable powers the mod already holds that a lesser manager
      // can't grant — like the usergroup PATCH, a non-owner manager can only
      // add/remove within their OWN powers, never strip a power the owner gave.
      const preserved = gate.authority.isOwner
        ? []
        : parseServerModPermissions(row.permissionsJson).filter((p) => isGrantableServerModPermission(p) && !gate.authority.permissions.includes(p));
      const perms = [...new Set<ServerModPermission>([...clamped, ...preserved])];
      await db.update(serverMembers).set({ permissionsJson: serializeServerModPermissions(perms) })
        .where(and(eq(serverMembers.serverId, gate.server.id), eq(serverMembers.userId, req.params.userId)));
      await auditServer(db, {
        serverId: gate.server.id, actorUserId: gate.me.id, action: "server_mod_perms",
        targetUserId: req.params.userId, metadata: { slug: gate.server.slug, permissions: perms },
      });
      return { ok: true, permissions: perms };
    },
  );

  /** DELETE /servers/:id/members/:userId — remove a member (or demote+remove a
   *  mod/admin) from the server. Owner can never be removed. */
  app.delete<{ Params: { id: string; userId: string } }>("/servers/:id/members/:userId", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_members");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    if (req.params.userId === gate.server.ownerUserId) { reply.code(409); return { error: "The owner can't be removed." }; }
    const row = (await db.select().from(serverMembers)
      .where(and(eq(serverMembers.serverId, gate.server.id), eq(serverMembers.userId, req.params.userId))).limit(1))[0];
    if (!row) { reply.code(404); return { error: "not a member here" }; }
    // Removing an admin lieutenant is an owner-only act (mirrors appointing).
    if (row.role === "admin" && !gate.authority.isOwner) {
      reply.code(403); return { error: "Only the owner can remove an admin." };
    }
    await db.delete(serverMembers)
      .where(and(eq(serverMembers.serverId, gate.server.id), eq(serverMembers.userId, req.params.userId)));
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_member_remove",
      targetUserId: req.params.userId, metadata: { slug: gate.server.slug },
    });
    return { ok: true };
  });

  /** GET /servers/:id/user-search?q= — typeahead for the role/ban/group
   *  pickers (manage_members OR ban_member). */
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>("/servers/:id/user-search", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const a = await serverAuthority(db, me, req.params.id);
    if (!a.server) { reply.code(404); return { error: "no server" }; }
    if (!(serverCan(a, "manage_members") || serverCan(a, "ban_member") || serverCan(a, "manage_usergroups"))) {
      reply.code(403); return { error: "forbidden" };
    }
    const q = (req.query.q ?? "").trim().toLowerCase();
    if (q.length < 2) return { hits: [] };
    const like = `${q.replace(/[%_]/g, "")}%`;
    const byName = await db
      .select({ id: users.id, username: users.username, avatarUrl: users.avatarUrl })
      .from(users)
      .where(and(ne(users.username, "system"), sql`lower(${users.username}) LIKE ${like}`))
      .orderBy(asc(users.username)).limit(12);
    const byChar = await db
      .select({ id: users.id, username: users.username, avatarUrl: users.avatarUrl })
      .from(characters).innerJoin(users, eq(users.id, characters.userId))
      .where(and(isNull(characters.deletedAt), sql`lower(${characters.name}) LIKE ${like}`))
      .limit(12);
    const map = new Map<string, { id: string; username: string; avatarUrl: string | null }>();
    for (const r of [...byName, ...byChar]) if (!map.has(r.id)) map.set(r.id, r);
    const ids = [...map.keys()].slice(0, 12);
    if (ids.length === 0) return { hits: [] };
    const roleRows = await db.select({ userId: serverMembers.userId, role: serverMembers.role })
      .from(serverMembers).where(and(eq(serverMembers.serverId, a.server.id), inArray(serverMembers.userId, ids)));
    const roleByUser = new Map(roleRows.map((r) => [r.userId, r.role] as const));
    const banRows = await db.select({ userId: serverBans.userId, until: serverBans.until })
      .from(serverBans).where(and(eq(serverBans.serverId, a.server.id), inArray(serverBans.userId, ids)));
    const bannedSet = new Set(banRows.filter((b) => !b.until || +b.until > Date.now()).map((b) => b.userId));
    const ownerId = a.server.ownerUserId;
    return {
      hits: ids.map((id) => {
        const u = map.get(id)!;
        return {
          userId: id,
          username: u.username,
          avatarUrl: u.avatarUrl ?? null,
          serverRole: id === ownerId ? "owner" as const : (roleByUser.get(id) ?? null),
          banned: bannedSet.has(id),
        };
      }),
    };
  });

  /* =========================================================
   *  Usergroups (member-feature bundles + auto-join rules)
   *  Moderation power comes from the role tier, never a group.
   * ========================================================= */

  /** Usergroups grant MEMBER-FEATURE perms only — moderation power comes from
   *  the role tier, never from a group (so a group can't silently mint a mod).
   *  Clamp the request to the feature half AND to the actor's own powers. */
  function clampFeaturePerms(requested: ServerFeaturePermission[], actorPerms: ServerPermission[], isOwner: boolean): ServerFeaturePermission[] {
    const featureOnly = requested.filter(isServerFeaturePermission);
    if (isOwner) return featureOnly;
    const allowed = new Set(actorPerms);
    return featureOnly.filter((p) => allowed.has(p));
  }

  /** Validate a group's auto-join rules against THIS server: parse to the
   *  canonical shape (floor min:1, cap) and drop `posted_in_room` rules whose
   *  room isn't one of this server's rooms. */
  async function validServerAutoRules(serverId: string, raw: unknown): Promise<ServerAutoRule[]> {
    const parsed = parseServerAutoRules(JSON.stringify(raw ?? []));
    const roomRuleIds = parsed.filter((r) => r.kind === "posted_in_room").map((r) => (r as { roomId: string }).roomId);
    let validRooms = new Set<string>();
    if (roomRuleIds.length) {
      // Reuse serverRoomIds so room validation adopts legacy NULL-serverId rooms
      // on the default server identically to the auto-group evaluator.
      validRooms = new Set(await serverRoomIds(db, serverId));
    }
    return parsed.filter((r) => r.kind !== "posted_in_room" || validRooms.has((r as { roomId: string }).roomId)).slice(0, SERVER_MAX_AUTO_RULES);
  }

  const groupBody = z.object({
    name: z.string().trim().min(1).max(SERVER_USERGROUP_NAME_MAX),
    color: z.string().trim().max(32).nullable().optional(),
    permissions: z.array(z.string()).max(SERVER_PERMISSIONS.length + 5).optional(),
    autoRules: z.array(z.unknown()).max(SERVER_MAX_AUTO_RULES + 4).optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
    // Self-role fields (migration 0320): let members pick this group + a blurb.
    memberSelectable: z.boolean().optional(),
    description: z.string().trim().max(500).nullable().optional(),
  }).strict();
  const patchGroupBody = z.object({
    name: z.string().trim().min(1).max(SERVER_USERGROUP_NAME_MAX).optional(),
    color: z.string().trim().max(32).nullable().optional(),
    permissions: z.array(z.string()).max(SERVER_PERMISSIONS.length + 5).optional(),
    autoRules: z.array(z.unknown()).max(SERVER_MAX_AUTO_RULES + 4).optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
    // Self-role fields (migration 0320): let members pick this group + a blurb.
    memberSelectable: z.boolean().optional(),
    description: z.string().trim().max(500).nullable().optional(),
  }).strict();

  app.get<{ Params: { id: string } }>("/servers/:id/usergroups", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_usergroups");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    await ensureDefaultUsergroup(db, gate.server.id);
    const rows = await db.select().from(serverUsergroups)
      .where(eq(serverUsergroups.serverId, gate.server.id))
      .orderBy(desc(serverUsergroups.isDefault), asc(serverUsergroups.sortOrder), asc(serverUsergroups.createdAt));
    const ids = rows.map((g) => g.id);
    const counts = ids.length
      ? await db.select({ groupId: serverUsergroupMembers.groupId, n: sql<number>`count(*)` })
          .from(serverUsergroupMembers).where(inArray(serverUsergroupMembers.groupId, ids))
          .groupBy(serverUsergroupMembers.groupId)
      : [];
    const countMap = new Map(counts.map((c) => [c.groupId, Number(c.n)]));
    return {
      managerPermissions: gate.authority.permissions,
      groups: rows.map((g) => ({
        id: g.id,
        name: g.name,
        color: g.color ?? null,
        permissions: parseServerFeaturePermissions(g.permissionsJson),
        isDefault: !!g.isDefault,
        sortOrder: g.sortOrder,
        autoRules: parseServerAutoRules(g.autoRulesJson),
        memberCount: g.isDefault ? 0 : (countMap.get(g.id) ?? 0),
        // Self-role fields (migration 0320): whether members may pick this group
        // themselves + its member-facing blurb. The console's usergroup editor
        // reads these; the self-roles/onboarding member surfaces consume them.
        memberSelectable: !!g.memberSelectable,
        description: g.description ?? null,
      })),
    };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/usergroups", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_usergroups");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof groupBody>;
    try { body = groupBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const count = Number((await db.select({ n: sql<number>`count(*)` }).from(serverUsergroups).where(eq(serverUsergroups.serverId, gate.server.id)))[0]?.n ?? 0);
    if (count >= SERVER_MAX_USERGROUPS) { reply.code(409); return { error: `A server can have at most ${SERVER_MAX_USERGROUPS} usergroups.` }; }
    const requested = (body.permissions ?? []).filter(isServerFeaturePermission) as ServerFeaturePermission[];
    const perms = clampFeaturePerms(requested, gate.authority.permissions, gate.authority.isOwner);
    const autoRules = await validServerAutoRules(gate.server.id, body.autoRules);
    const id = nanoid();
    await db.insert(serverUsergroups).values({
      id, serverId: gate.server.id, name: body.name, color: body.color ?? null,
      permissionsJson: serializeServerFeaturePermissions(perms),
      isDefault: false, sortOrder: body.sortOrder ?? count, autoRulesJson: serializeServerAutoRules(autoRules),
      // Self-role fields (migration 0320). A brand-new group is never the default,
      // so member_selectable is honored as sent.
      memberSelectable: body.memberSelectable ?? false,
      description: body.description?.trim() ? body.description.trim() : null,
    });
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_usergroup_change",
      metadata: { slug: gate.server.slug, op: "create", group: body.name, permissions: perms },
    });
    return { ok: true, id };
  });

  app.patch<{ Params: { id: string; gid: string }; Body: unknown }>("/servers/:id/usergroups/:gid", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_usergroups");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const group = (await db.select().from(serverUsergroups)
      .where(and(eq(serverUsergroups.id, req.params.gid), eq(serverUsergroups.serverId, gate.server.id))).limit(1))[0];
    if (!group) { reply.code(404); return { error: "no such usergroup" }; }
    let body: z.infer<typeof patchGroupBody>;
    try { body = patchGroupBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const update: Partial<typeof serverUsergroups.$inferInsert> = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.color !== undefined) update.color = body.color ?? null;
    if (body.permissions !== undefined) {
      const requested = body.permissions.filter(isServerFeaturePermission) as ServerFeaturePermission[];
      const clamped = clampFeaturePerms(requested, gate.authority.permissions, gate.authority.isOwner);
      // Preserve feature perms the group already holds that a lesser manager
      // can't grant — they can only add/remove within their own powers.
      const preserved = gate.authority.isOwner
        ? []
        : parseServerFeaturePermissions(group.permissionsJson).filter((p) => !gate.authority.permissions.includes(p));
      update.permissionsJson = serializeServerFeaturePermissions([...new Set([...clamped, ...preserved])]);
    }
    // Auto-rules are meaningless on the default group (its membership is
    // everyone) — only honored on named groups.
    if (body.autoRules !== undefined && !group.isDefault) {
      update.autoRulesJson = serializeServerAutoRules(await validServerAutoRules(gate.server.id, body.autoRules));
    }
    if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
    // Self-role fields (migration 0320). The default group applies to everyone,
    // so it can never be self-selectable — force it off there regardless of the
    // client. Named groups honor the flag as sent.
    if (body.memberSelectable !== undefined) update.memberSelectable = group.isDefault ? false : body.memberSelectable;
    if (body.description !== undefined) update.description = body.description?.trim() ? body.description.trim() : null;
    if (Object.keys(update).length) {
      await db.update(serverUsergroups).set(update).where(eq(serverUsergroups.id, group.id));
      await auditServer(db, {
        serverId: gate.server.id, actorUserId: gate.me.id, action: "server_usergroup_change",
        metadata: { slug: gate.server.slug, op: "edit", group: update.name ?? group.name },
      });
    }
    return { ok: true };
  });

  app.delete<{ Params: { id: string; gid: string } }>("/servers/:id/usergroups/:gid", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_usergroups");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const group = (await db.select().from(serverUsergroups)
      .where(and(eq(serverUsergroups.id, req.params.gid), eq(serverUsergroups.serverId, gate.server.id))).limit(1))[0];
    if (!group) { reply.code(404); return { error: "no such usergroup" }; }
    if (group.isDefault) { reply.code(400); return { error: "The default group can't be deleted." }; }
    await db.delete(serverUsergroups).where(eq(serverUsergroups.id, group.id)); // cascades members
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_usergroup_change",
      metadata: { slug: gate.server.slug, op: "delete", group: group.name },
    });
    return { ok: true };
  });

  app.get<{ Params: { id: string; gid: string } }>("/servers/:id/usergroups/:gid/members", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_usergroups");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const group = (await db.select().from(serverUsergroups)
      .where(and(eq(serverUsergroups.id, req.params.gid), eq(serverUsergroups.serverId, gate.server.id))).limit(1))[0];
    if (!group) { reply.code(404); return { error: "no such usergroup" }; }
    if (group.isDefault) return { members: [] }; // everyone; not enumerated
    const rows = await db
      .select({ userId: serverUsergroupMembers.userId, username: users.username, avatarUrl: users.avatarUrl, isAuto: serverUsergroupMembers.isAuto, addedAt: serverUsergroupMembers.addedAt })
      .from(serverUsergroupMembers)
      .leftJoin(users, eq(users.id, serverUsergroupMembers.userId))
      .where(eq(serverUsergroupMembers.groupId, group.id))
      .orderBy(desc(serverUsergroupMembers.addedAt));
    return {
      members: rows.map((r) => ({
        userId: r.userId, username: r.username ?? "unknown", avatarUrl: r.avatarUrl ?? null, isAuto: !!r.isAuto, addedAt: +r.addedAt,
      })),
    };
  });

  const groupMemberBody = z.object({ target: z.string().trim().min(1).max(120) }).strict();
  app.put<{ Params: { id: string; gid: string }; Body: unknown }>("/servers/:id/usergroups/:gid/members", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_usergroups");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const group = (await db.select().from(serverUsergroups)
      .where(and(eq(serverUsergroups.id, req.params.gid), eq(serverUsergroups.serverId, gate.server.id))).limit(1))[0];
    if (!group) { reply.code(404); return { error: "no such usergroup" }; }
    if (group.isDefault) { reply.code(400); return { error: "Everyone already belongs to the default group." }; }
    let body: z.infer<typeof groupMemberBody>;
    try { body = groupMemberBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const target = await resolveServerTarget(body.target);
    if (!target.ok) { reply.code(404); return { error: target.error }; }
    await db.insert(serverUsergroupMembers)
      .values({ groupId: group.id, userId: target.userId, addedBy: gate.me.id, isAuto: false })
      .onConflictDoNothing();
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_usergroup_change",
      targetUserId: target.userId, metadata: { slug: gate.server.slug, op: "add_member", group: group.name },
    });
    return { ok: true, username: target.username };
  });

  app.delete<{ Params: { id: string; gid: string; userId: string } }>("/servers/:id/usergroups/:gid/members/:userId", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_usergroups");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const group = (await db.select().from(serverUsergroups)
      .where(and(eq(serverUsergroups.id, req.params.gid), eq(serverUsergroups.serverId, gate.server.id))).limit(1))[0];
    if (!group) { reply.code(404); return { error: "no such usergroup" }; }
    if (group.isDefault) { reply.code(400); return { error: "The default group has no removable members." }; }
    await db.delete(serverUsergroupMembers)
      .where(and(eq(serverUsergroupMembers.groupId, group.id), eq(serverUsergroupMembers.userId, req.params.userId)));
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_usergroup_change",
      targetUserId: req.params.userId, metadata: { slug: gate.server.slug, op: "remove_member", group: group.name },
    });
    return { ok: true };
  });
}
