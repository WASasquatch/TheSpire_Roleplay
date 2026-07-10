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
  announcementBanners,
  characterEarning,
  characterOwnedBorders,
  characterOwnedFreeformBorders,
  characterOwnedNameStyles,
  cosmetics,
  customCommands,
  earningLedger,
  earningNotifications,
  eidolonHall,
  eidolonState,
  eidolonVisits,
  emoticonSheets,
  faqs,
  flashSaleOverrides,
  flashSales,
  forums,
  freeformBorders,
  gameStats,
  identityCollection,
  identityInventory,
  identityPetCollection,
  items,
  messages,
  modCases,
  nameStyles,
  notifications,
  ranks,
  reports,
  rooms,
  roomTransitions,
  scheduledAnnouncements,
  scriptoriumWriteStreaks,
  serverBackfillState,
  serverBuiltinCommandConfig,
  serverCreationApplications,
  serverMembers,
  servers,
  storyCopies,
  titleKinds,
  urugalRun,
  userActiveCosmetics,
  userEarning,
  userOwnedBorders,
  userOwnedFreeformBorders,
  userOwnedNameStyles,
  users,
} from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "../routes/auth.js";
import { hasPermission } from "../auth/permissions.js";
import { ensureDefaultUsergroup } from "../servers/usergroups.js";
import { notifyUser, emitServersChanged } from "../servers/notifications.js";
import { recordAudit } from "../audit.js";
import { getSettings, areServersEnabled } from "../settings.js";
import { tFor } from "../i18n.js";

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
        if (taken) { reply.code(409); return { error: tFor(me.locale, "errors:server.servers.slugClaimedSince") }; }
        const owned = (await db.select({ n: sql<number>`count(*)` }).from(servers)
          .where(and(eq(servers.ownerUserId, appRow.applicantUserId), sql`${servers.status} != 'archived'`, eq(servers.isSystem, false))))[0]?.n ?? 0;
        if (owned >= SERVER_MAX_OWNED_DEFAULT) {
          reply.code(409); return { error: tFor(me.locale, "errors:server.servers.applicantAtLimit") };
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
              "To access the \"Admin Panel\", click the **Server Admin** button from the top navigation, or the gear icon on your server icon in the server rail.",
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
        reply.code(409); return { error: tFor(me.locale, "errors:server.servers.starterRoomNameClash") };
      }

      // Default usergroup (full FEATURE baseline) so members keep post/create-
      // room/upload/emoticon/invite until the owner narrows it. Outside the tx
      // (it's idempotent + conflict-safe) so the provision stays the lean core.
      if (nextStatus === "approved") {
        await ensureDefaultUsergroup(db, serverId);
      }

      // Toast + persisted bell row render in the APPLICANT's language (the
      // reviewer's locale is irrelevant to what the recipient reads).
      const applicantLocale = (await db
        .select({ locale: users.locale })
        .from(users)
        .where(eq(users.id, appRow.applicantUserId))
        .limit(1))[0]?.locale ?? null;
      await notifyUser(io, db, appRow.applicantUserId, {
        code: nextStatus === "approved" ? "SERVER_APP_APPROVED" : "SERVER_APP_REJECTED",
        message: nextStatus === "approved"
          ? tFor(applicantLocale, "notifications:server.appApprovedMessage", { name: appRow.requestedName })
          : body.note
            ? tFor(applicantLocale, "notifications:server.appDeclinedMessageNote", { name: appRow.requestedName, note: body.note })
            : tFor(applicantLocale, "notifications:server.appDeclinedMessage", { name: appRow.requestedName }),
        persist: {
          category: "server",
          kind: nextStatus === "approved" ? "server_app_approved" : "server_app_rejected",
          serverId: nextStatus === "approved" ? serverId : null,
          title: nextStatus === "approved"
            ? tFor(applicantLocale, "notifications:server.appApprovedTitle", { name: appRow.requestedName })
            : tFor(applicantLocale, "notifications:server.appDeclinedTitle"),
          snippet: nextStatus === "approved"
            ? tFor(applicantLocale, "notifications:server.appApprovedSnippet")
            : (body.note ? body.note : tFor(applicantLocale, "notifications:server.appDeclinedSnippet", { name: appRow.requestedName })),
          ...(nextStatus === "approved" ? { target: { kind: "server", id: serverId } } : {}),
        },
      });
      // Live-add the freshly-approved server to the applicant's rail (fade-in),
      // so the "find it on the server rail!" notice is true without a refresh.
      if (nextStatus === "approved") {
        await emitServersChanged(io, appRow.applicantUserId, serverId);
      }

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
        moderationState: servers.moderationState,
        moderationUntil: servers.moderationUntil,
        moderationNote: servers.moderationNote,
        moderationByUserId: servers.moderationByUserId,
        moderationAt: servers.moderationAt,
      })
      .from(servers)
      .leftJoin(users, eq(users.id, servers.ownerUserId));
    const now = Date.now();
    return {
      servers: rows.map((s) => {
        // Lazy expiry (constraint #3): a 'banned' row past its until behaves
        // exactly like 'none' for the admin list too, so staff never see a
        // stale "BANNED" badge on a server that's already re-openable.
        const untilMs = s.moderationUntil ? +s.moderationUntil : null;
        const expired = s.moderationState === "banned" && untilMs !== null && untilMs <= now;
        const effectiveState = expired ? "none" : s.moderationState;
        return {
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
          moderationState: effectiveState,
          moderationUntil: untilMs,
          moderationNote: expired ? null : (s.moderationNote ?? null),
          moderationByUserId: s.moderationByUserId ?? null,
          moderationAt: s.moderationAt ? +s.moderationAt : null,
        };
      }),
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
      reply.code(409); return { error: tFor(me?.locale, "errors:server.servers.homeCantBeArchived") };
    }
    await db.update(servers).set({ status: body.status, updatedAt: new Date() })
      .where(eq(servers.id, server.id));
    return { ok: true };
  });

  /* ============================================================
   * SERVER MODERATION (Global Admin: suspend / ban / lift) — plan §"server
   * moderation". All gated by `manage_any_server`; the system/home server can
   * NEVER be moderated (409). The suspend/ban BLOCK is enforced at the single
   * chokepoint serverAuthority.canParticipate; this endpoint only writes the
   * state. A ban carries an optional auto-expiry (`untilMs`, null = permanent);
   * a suspension is always indefinite (lifted manually). Lifting = state 'none'.
   * ============================================================ */
  const moderationBody = z
    .object({
      // 'none' lifts an active suspension/ban.
      state: z.enum(["suspended", "banned", "none"]),
      // Ban expiry (ms). Only honored for state='banned'; null/absent = permanent.
      untilMs: z.number().int().positive().nullable().optional(),
      note: z.string().trim().max(1000).nullable().optional(),
    })
    .strict();

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/admin/servers/:id/moderation",
    async (req, reply) => {
      if (!(await serversLive(reply))) return { error: "not found" };
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      if (!(await hasPermission(me, "manage_any_server", db))) {
        reply.code(403); return { error: "forbidden" };
      }
      let body: z.infer<typeof moderationBody>;
      try { body = moderationBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const server = (await db.select().from(servers)
        .where(eq(servers.id, req.params.id)).limit(1))[0];
      if (!server) { reply.code(404); return { error: "no server" }; }
      // HARD CONSTRAINT #1: the system/home server is sacred — never moderated.
      if (server.isSystem) {
        reply.code(409);
        return { error: tFor(me?.locale, "errors:server.servers.homeCantBeModerated") };
      }

      // A ban must have a future expiry when one is supplied (a null until =
      // permanent ban is allowed). Suspensions ignore untilMs entirely.
      const untilMs = body.state === "banned" ? (body.untilMs ?? null) : null;
      if (body.state === "banned" && untilMs !== null && untilMs <= Date.now()) {
        reply.code(400); return { error: tFor(me?.locale, "errors:server.servers.banExpiryFuture") };
      }

      const note = body.state === "none" ? null : (body.note ?? null);
      const now = new Date();
      // The column is a timestamp_ms (Drizzle maps to Date); untilMs stays a raw
      // epoch ms number for the wire response + audit metadata.
      const untilDate = untilMs !== null ? new Date(untilMs) : null;
      await db
        .update(servers)
        .set({
          moderationState: body.state,
          moderationUntil: untilDate,
          moderationNote: note,
          // On lift, clear the actor/timestamp so the row reads clean ('none').
          moderationByUserId: body.state === "none" ? null : me.id,
          moderationAt: body.state === "none" ? null : now,
          updatedAt: now,
        })
        .where(eq(servers.id, server.id));

      // Audit (constraint #7) — global feed (platform action, server_id NULL).
      await recordAudit(db, {
        actorUserId: me.id,
        action:
          body.state === "none"
            ? "server_moderation_lift"
            : body.state === "suspended"
              ? "server_moderation_suspend"
              : "server_moderation_ban",
        reason: note,
        metadata: {
          serverId: server.id,
          serverSlug: server.slug,
          serverName: server.name,
          state: body.state,
          untilMs,
          note,
        },
      });

      return {
        ok: true,
        server: {
          id: server.id,
          slug: server.slug,
          name: server.name,
          moderationState: body.state,
          moderationUntil: untilMs,
          moderationNote: note,
          moderationByUserId: body.state === "none" ? null : me.id,
          moderationAt: body.state === "none" ? null : +now,
        },
      };
    },
  );

  /* ============================================================
   * SERVER DELETE (Global Admin) — HARD, IRREVERSIBLE cascade. Gated by
   * `manage_any_server`; the system/home server can NEVER be deleted (409).
   *
   * FULL CASCADE (constraint #6): SQLite runs with `PRAGMA foreign_keys = ON`
   * (see db/index.ts), so tables whose `server_id` is a real FK ON DELETE
   * CASCADE auto-clear when the `servers` row goes, and composite-FK children
   * clear when their per-server catalog parent goes. But the per-server ECONOMY
   * and GAME tables carry `server_id TEXT NOT NULL DEFAULT 'server_spire_system'`
   * with NO FK to servers (they partition, they don't reference), so they would
   * be left orphaned — those we delete EXPLICITLY. We also explicitly delete the
   * ON DELETE SET NULL scoped tables (rooms/forums/notifications/reports/etc.):
   * constraint #6 says remove EVERY row referencing the server, not un-home it.
   *
   * Order respects FKs: message-bearing rooms before other per-room data is
   * implicit (rooms → messages/pollVotes/bookmarks/reactions/roomMembers/etc.
   * all cascade off rooms.id / messages.id, incl. the migration-0146 reaction
   * trigger); per-server ownership tables before their catalogs; catalogs before
   * the server row. Wrapped in one transaction so a partial delete is impossible.
   * ============================================================ */
  app.delete<{ Params: { id: string } }>(
    "/admin/servers/:id",
    async (req, reply) => {
      if (!(await serversLive(reply))) return { error: "not found" };
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      if (!(await hasPermission(me, "manage_any_server", db))) {
        reply.code(403); return { error: "forbidden" };
      }

      const server = (await db.select().from(servers)
        .where(eq(servers.id, req.params.id)).limit(1))[0];
      if (!server) { reply.code(404); return { error: "no server" }; }
      // HARD CONSTRAINT #1: the system/home server is sacred — never deleted.
      if (server.isSystem) {
        reply.code(409); return { error: tFor(me?.locale, "errors:server.servers.homeCantBeDeleted") };
      }

      const sid = server.id;
      // Snapshot for the audit row (captured before the delete wipes the source).
      const snapshot = {
        id: server.id,
        slug: server.slug,
        name: server.name,
        ownerUserId: server.ownerUserId,
      };

      db.transaction((tx) => {
        // ---- Per-server ECONOMY OWNERSHIP (no FK to servers; delete first so
        //      the catalog delete below can't dangle, and to be self-documenting).
        //      These also cascade off their composite-FK catalog, but explicit
        //      by-server-id deletes are byte-safe and order-independent. ----
        tx.delete(userOwnedBorders).where(eq(userOwnedBorders.serverId, sid)).run();
        tx.delete(characterOwnedBorders).where(eq(characterOwnedBorders.serverId, sid)).run();
        tx.delete(userOwnedNameStyles).where(eq(userOwnedNameStyles.serverId, sid)).run();
        tx.delete(characterOwnedNameStyles).where(eq(characterOwnedNameStyles.serverId, sid)).run();
        tx.delete(userOwnedFreeformBorders).where(eq(userOwnedFreeformBorders.serverId, sid)).run();
        tx.delete(characterOwnedFreeformBorders).where(eq(characterOwnedFreeformBorders.serverId, sid)).run();
        tx.delete(identityInventory).where(eq(identityInventory.serverId, sid)).run();
        tx.delete(identityCollection).where(eq(identityCollection.serverId, sid)).run();
        tx.delete(identityPetCollection).where(eq(identityPetCollection.serverId, sid)).run();

        // ---- Per-server ECONOMY CATALOGS (no FK to servers; deleting a catalog
        //      row also cascades any straggler composite-FK ownership rows). ----
        tx.delete(freeformBorders).where(eq(freeformBorders.serverId, sid)).run();
        tx.delete(nameStyles).where(eq(nameStyles.serverId, sid)).run();
        tx.delete(items).where(eq(items.serverId, sid)).run();
        tx.delete(cosmetics).where(eq(cosmetics.serverId, sid)).run();
        tx.delete(roomTransitions).where(eq(roomTransitions.serverId, sid)).run();
        // rank_tiers has a composite FK ON DELETE CASCADE into ranks, but it also
        // carries its own server_id — delete tiers explicitly, then ranks.
        tx.delete(ranks).where(eq(ranks.serverId, sid)).run();

        // ---- Per-server EARNING pools + ledger + notifications + equipped ----
        tx.delete(userEarning).where(eq(userEarning.serverId, sid)).run();
        tx.delete(characterEarning).where(eq(characterEarning.serverId, sid)).run();
        tx.delete(userActiveCosmetics).where(eq(userActiveCosmetics.serverId, sid)).run();
        tx.delete(earningLedger).where(eq(earningLedger.serverId, sid)).run();
        tx.delete(earningNotifications).where(eq(earningNotifications.serverId, sid)).run();

        // ---- Per-server SCRIPTORIUM economy (write streaks + purchased copies;
        //      no FK to servers). Story rows themselves are NOT server-scoped and
        //      stay; only this server's per-identity economy partition goes. ----
        tx.delete(scriptoriumWriteStreaks).where(eq(scriptoriumWriteStreaks.serverId, sid)).run();
        tx.delete(storyCopies).where(eq(storyCopies.serverId, sid)).run();

        // ---- Per-server FLASH SALES (economy) ----
        tx.delete(flashSales).where(eq(flashSales.serverId, sid)).run();
        tx.delete(flashSaleOverrides).where(eq(flashSaleOverrides.serverId, sid)).run();

        // ---- Per-server GAME state (arcade + social games; no FK to servers) ----
        tx.delete(gameStats).where(eq(gameStats.serverId, sid)).run();
        tx.delete(eidolonState).where(eq(eidolonState.serverId, sid)).run();
        tx.delete(eidolonVisits).where(eq(eidolonVisits.serverId, sid)).run();
        tx.delete(eidolonHall).where(eq(eidolonHall.serverId, sid)).run();
        tx.delete(urugalRun).where(eq(urugalRun.serverId, sid)).run();

        // ---- Per-server config / catalogs with a real FK (would auto-cascade
        //      off the servers row, but we delete explicitly for a clean audit of
        //      what went, and to keep the order deterministic). ----
        tx.delete(serverBuiltinCommandConfig).where(eq(serverBuiltinCommandConfig.serverId, sid)).run();
        tx.delete(serverBackfillState).where(eq(serverBackfillState.serverId, sid)).run();

        // ---- ON DELETE SET NULL scoped tables — constraint #6 says DELETE the
        //      rows, not un-home them. (title_kinds / custom_commands →aliases /
        //      emoticon_sheets / notifications / reports / mod_cases →updates
        //      /evidence / announcement_banners / scheduled_announcements /
        //      faqs / forums →all forum sub-tables.) ----
        tx.delete(titleKinds).where(eq(titleKinds.serverId, sid)).run();
        tx.delete(customCommands).where(eq(customCommands.serverId, sid)).run(); // aliases cascade
        tx.delete(emoticonSheets).where(eq(emoticonSheets.serverId, sid)).run();
        tx.delete(notifications).where(eq(notifications.serverId, sid)).run();
        tx.delete(reports).where(eq(reports.serverId, sid)).run();
        tx.delete(modCases).where(eq(modCases.serverId, sid)).run(); // updates + evidence cascade
        tx.delete(announcementBanners).where(eq(announcementBanners.serverId, sid)).run();
        tx.delete(scheduledAnnouncements).where(eq(scheduledAnnouncements.serverId, sid)).run();
        tx.delete(faqs).where(eq(faqs.serverId, sid)).run();
        tx.delete(forums).where(eq(forums.serverId, sid)).run(); // forum_* children cascade off forums.id

        // ---- Rooms (server_id is SET NULL, so delete explicitly). Deleting a
        //      room cascades: messages (→ pollVotes, bookmarks, and the
        //      migration-0146 message_reactions trigger), room_members, room_mods,
        //      room_invites, room_clears, room_thread_categories, and any reports
        //      / scheduled_announcements pinned to the room. ----
        tx.delete(rooms).where(eq(rooms.serverId, sid)).run();

        // ---- Clear the dangling per-user "default server" pointer. It's a plain
        //      text column with no FK, so it would otherwise point at a dead id;
        //      NULL falls users back to the home server on next resolve. ----
        tx.update(users).set({ defaultServerId: null }).where(eq(users.defaultServerId, sid)).run();

        // ---- Finally the server row. Its real-FK children still remaining
        //      (server_members, server_membership_applications, server_usergroups
        //      → server_usergroup_members, server_bans, server_invites,
        //      server_visits, server_welcome_seen, user_server_last_room,
        //      server_settings) all ON DELETE CASCADE off servers.id. ----
        tx.delete(servers).where(eq(servers.id, sid)).run();
      });

      // Audit (constraint #7) — global feed; the server (and its own per-server
      // Mod Log) no longer exists, so this platform-level record lands globally.
      await recordAudit(db, {
        actorUserId: me.id,
        action: "server_delete",
        metadata: {
          serverId: snapshot.id,
          serverSlug: snapshot.slug,
          serverName: snapshot.name,
          ownerUserId: snapshot.ownerUserId,
        },
      });

      return { ok: true, deleted: snapshot };
    },
  );
}
