import os from "node:os";
import { statSync, utimesSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { and, asc, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import {
  auditLog,
  automodRules,
  builtinCommandConfig,
  characters,
  customCommandAliases,
  customCommands,
  exportReceipts,
  items as itemsTable,
  messages,
  mutualTitles,
  reports,
  roomMembers,
  rooms,
  sessions,
  titleKinds,
  users,
  worlds,
} from "../db/schema.js";
import { COLOR_TOKEN_OR_HEX_RE, CUSTOM_CMD_CSS_MAX_LEN, extractExportManifest, sanitizeCustomCmdCss, type AuditEntry, type PermissionKey, type Role } from "@thekeep/shared";
import { verifyExportManifest } from "../export/sign.js";
import { requireSessionPermission } from "../auth/requireSessionPermission.js";
import { CRASH_LOG_PATH, readRecentCrashes } from "../crashLog.js";
import type { Db } from "../db/index.js";
import type { CommandRegistry } from "../commands/registry.js";
import {
  broadcastRoomState,
  emitTreeChanged,
  findCanonicalLanding,
  sendRoomBacklogTo,
} from "../realtime/broadcast.js";
import { getSettings, updateSettings } from "../settings.js";
import {
  applyFilters,
  getCompiledRuleset,
  invalidateAutomodCache,
  validateAutomodPattern,
} from "../realtime/automod.js";
import type { AutomodRule } from "@thekeep/shared";
import { DEFAULT_SERVER_ID } from "../earning/pool.js";
import { globalAuditScopeWhere, recordAudit } from "../audit.js";
import { deriveUniqueRoomSlug } from "../lib/roomSlug.js";
import { registerAdminEarningRoutes } from "./earning.js";
import { registerAdminBackupRoutes } from "./backup.js";
import { registerAdminPermissionRoutes } from "./permissions.js";
import { registerAdminAnnouncementRoutes } from "./announcements.js";
import { registerAdminModCaseRoutes } from "./modCases.js";
import { registerAdminFaqRoutes } from "./faqs.js";
import { registerAdminEmailRoutes } from "./email.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

interface SessionUserCtx {
  id: string;
  role: Role;
}

/**
 * Admin HTTP routes.
 *
 * Privacy contract: even admins cannot read messages from password-protected
 * or private rooms. They CAN see that those rooms exist, who is in them, and
 * the room metadata (name, owner, topic, member count).
 *
 * Public-room messages ARE inspectable for moderation purposes.
 */
export async function registerAdminRoutes(
  app: FastifyInstance,
  deps: {
    db: Db;
    io: Io;
    registry: CommandRegistry;
    /**
     * Absolute path to the persistent uploads directory. The admin-
     * upload routes write into this; the matching `/uploads/*` static
     * registration in index.ts serves them back to clients.
     */
    uploadsRoot: string;
    /** Returns the current authenticated session user (or null if unauthenticated). */
    getSessionUser: (req: FastifyRequest) => Promise<SessionUserCtx | null>;
  },
): Promise<void> {
  const { db, io, registry, uploadsRoot, getSessionUser } = deps;

  // Authentication-only preHandler. Earlier drafts tried to gate
  // every /admin/* request on "user holds at least one view_admin_*
  // key", convenient as a coarse filter, but it broke matrix-
  // customized roles that hold only a `manage_*` or `grant_*` key
  // without a corresponding view-tab key (e.g. a delegate with
  // `hard_delete_user` alone). The per-route `requirePermission`
  // checks farther down already enforce the right per-action gate,
  // so this hook now only confirms the request carries a valid
  // session and attaches it for downstream handlers; authorization
  // is the route's job.
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/admin")) return;
    const user = await getSessionUser(req);
    if (!user) {
      reply.code(401);
      throw new Error("authentication required");
    }
    (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser = user;
  });

  // Earning, admin endpoints (Awards + Ranks tabs). Both tiers can
  // read; the PUT awards handler enforces masteradmin-only on the
  // multi-character divisor + backfill rate fields internally. The
  // Ranks endpoints accept asset uploads under the shared
  // `uploads/ranks/` directory served by the static handler.
  registerAdminEarningRoutes(app, { db, io, uploadsRoot, getSessionUser });

  // Backups, masteradmin-only. Mounts /admin/backup/* endpoints for
  // creating, inspecting, importing, and managing full-DB and
  // content snapshots on the persistent volume. The backup module
  // owns its own gate (every handler calls masterAdminOnly internally
  // because the destructive-restore paths warrant stricter access
  // than the plain-`admin` preHandler check that gates everything
  // under /admin/*).
  registerAdminBackupRoutes(app, { db, uploadsRoot });

  // Roles & Permissions matrix, Phase 2. Mounts /admin/permissions
  // GET (matrix snapshot), PATCH /roles (per-role grant flip), PATCH
  // /users (per-user override upsert / clear), plus the /users/search
  // typeahead + per-user detail endpoints the By-user sub-tab uses.
  // Each handler enforces `view_admin_permissions` or
  // `manage_permissions` internally, both default to masteradmin-only
  // via the migration seed but are matrix-grantable so a senior admin
  // can manage the matrix on the masteradmin's behalf.
  registerAdminPermissionRoutes(app, { db });

  // Announcements, admin Banners + Scheduled CRUD. The scheduler
  // tick that fires due rows is launched separately at boot via
  // `startAnnouncementScheduler` in apps/server/src/index.ts so it
  // runs once per process, not once per route registration.
  await registerAdminAnnouncementRoutes(app, { db, io });

  // Moderation case log, mod-authored complaint/resolution records.
  // Gated by `view_admin_mod_cases` (read) / `manage_mod_cases` (write),
  // seeded to mod + admin by migration 0254.
  await registerAdminModCaseRoutes(app, { db });

  // FAQ entries, admin-authored public Q&A with shareable slugs. Gated by
  // `view_admin_faqs` (read) / `manage_faqs` (write), seeded to admin by
  // migration 0255. Public read lives in routes/faqs.ts.
  await registerAdminFaqRoutes(app, { db });

  // Admin emailer: single send + throttled broadcast, plus verification
  // settings live alongside in the Email tab. Gated by `view_admin_email`
  // (read) / `send_admin_email` (send), seeded by migration 0257.
  await registerAdminEmailRoutes(app, { db });

  // Per-route granular gate. Each handler that performs a side-effect
  // or returns sensitive data calls this with the specific
  // `PermissionKey` it needs; resolution flows through the masteradmin
  // bypass → user override → role grant → default-deny precedence in
  // `hasPermission`. Wraps the shared `requireSessionPermission`
  // helper so call sites in this file don't have to thread `db`
  // through each call.
  const requirePermission = (req: FastifyRequest, reply: FastifyReply, key: PermissionKey) =>
    requireSessionPermission(req, reply, key, db);

  /* ---------- site overview (admin dashboard) ----------
   *
   * Rich admin-only dashboard counters. Distinct from the public /stats
   * endpoint, which intentionally exposes only the splash-page subset (no
   * audit / report / DAU figures, no per-day login or registration series).
   *
   * Login series caveat: `sessions` rows are purged on expiry, so the
   * loginsPerDay buckets only stay accurate while the configured session
   * TTL is at least the chart's lookback (7d here, 30d for MAU). Past that
   * the older days will undercount, fine for a dashboard, called out so
   * future-us doesn't chase a phantom bug.
   */
  /* ---------- crash diagnostics ----------
   *
   * Reads the durable crash log from /data so an admin can see what
   * killed past starts even after Fly's "10 restarts → purged logs"
   * cycle. Sources: process-level uncaughtException / unhandledRejection
   * handlers (apps/server/src/crashLog.ts) AND the migration runner
   * (apps/server/scripts/apply-migrations.mjs). Both write the same
   * JSONL format to /data/crash-log.jsonl which this endpoint reads.
   *
   * Masteradmin-only: this surface lets you see the raw output of
   * every crash on the host, which can include error strings carrying
   * env-var values or DB row content. The `view_admin_overview`
   * permission is the closest existing key but isn't strict enough
   * for operational-secret-adjacent data, so we hard-gate on role.
   *
   * Off-server fallback: `node apps/server/scripts/print-crashes.mjs`
   * does the same dump from the command line (run via `fly ssh
   * console` when the server itself is down).
   */
  app.get<{ Querystring: { limit?: string } }>("/admin/diagnostics/crashes", async (req, reply) => {
    const me = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser;
    if (!me || me.role !== "masteradmin") {
      reply.code(403);
      return { error: "forbidden", message: "masteradmin only" };
    }
    const rawLimit = req.query.limit;
    const limit = Math.max(1, Math.min(500, parseInt(rawLimit ?? "100", 10) || 100));
    const crashes = readRecentCrashes(limit);
    return {
      crashes,
      logPath: CRASH_LOG_PATH,
      // Tells the caller "if this is empty AND you expected entries,
      // make sure the volume is mounted at the right place." Helps
      // distinguish "no crashes" from "log file missing."
      totalReturned: crashes.length,
    };
  });

  /* ---------- System tab: live metrics ----------
   *
   * Semi-live server vitals for the admin System tab: process + host
   * resource use, live connection counts, the SQLite file size, headline
   * row counts, and (when running on Fly) the machine's identity from the
   * FLY_* env. Cheap enough to poll every few seconds. Read-only; gated on
   * `view_system_metrics`.
   */
  app.get("/admin/system/metrics", async (req, reply) => {
    if (!(await requirePermission(req, reply, "view_system_metrics"))) return;

    const mem = process.memoryUsage();
    const cpus = os.cpus();

    // Live socket connections, deduped to distinct users (same approach
    // as /admin/overview).
    const sockets = await io.fetchSockets();
    const onlineUsers = new Set<string>();
    for (const s of sockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (uid) onlineUsers.add(uid);
    }

    // SQLite file size (main DB + its -wal). Mirrors the path resolution
    // in db/index.ts so it points at the live file on the Fly volume.
    const dbPath = resolve(process.env.SQLITE_PATH ?? process.env.DATABASE_URL ?? "./data/thekeep.sqlite");
    const sizeOf = (p: string): number => { try { return statSync(p).size; } catch { return 0; } };

    const countOf = (table: SQLiteTable): Promise<number> =>
      db.select({ n: sql<number>`count(*)` }).from(table).then((r) => Number(r[0]?.n ?? 0));
    const [userCount, roomCount, messageCount, sessionCount, worldCount] = await Promise.all([
      countOf(users), countOf(rooms), countOf(messages), countOf(sessions), countOf(worlds),
    ]);

    return {
      serverTimeMs: Date.now(),
      process: {
        uptimeSec: Math.floor(process.uptime()),
        nodeVersion: process.version,
        pid: process.pid,
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
      },
      host: {
        platform: os.platform(),
        cpuCount: cpus.length,
        cpuModel: cpus[0]?.model ?? "unknown",
        // loadavg is [1m, 5m, 15m]; all-zero on platforms that don't
        // report it (e.g. Windows dev), which the UI renders as "n/a".
        loadAvg: os.loadavg(),
        totalMem: os.totalmem(),
        freeMem: os.freemem(),
        hostUptimeSec: Math.floor(os.uptime()),
      },
      connections: {
        sockets: sockets.length,
        onlineUsers: onlineUsers.size,
      },
      database: {
        bytes: sizeOf(dbPath),
        walBytes: sizeOf(`${dbPath}-wal`),
      },
      counts: {
        users: userCount,
        rooms: roomCount,
        messages: messageCount,
        sessions: sessionCount,
        worlds: worldCount,
      },
      fly: {
        machineId: process.env.FLY_MACHINE_ID ?? null,
        region: process.env.FLY_REGION ?? null,
        app: process.env.FLY_APP_NAME ?? null,
        imageRef: process.env.FLY_IMAGE_REF ?? null,
      },
    };
  });

  /* ---------- System tab: restart the server process ----------
   *
   * The server NEVER spawns its own replacement — that orphaned a
   * detached process (its own session via setsid) that ignored Ctrl-C
   * and squatted the port, breaking the next start with EADDRINUSE.
   * Instead we hand off to whatever launched us, two clean paths:
   *
   *   - UNDER `tsx watch` (dev `pnpm dev`): tsx watch already manages
   *     the process and restarts it on any watched-file change, so we
   *     just TOUCH this file. The watcher does a managed in-place
   *     restart — no orphan, still Ctrl-C-able, hot reload intact.
   *
   *   - OTHERWISE (Fly, `./local-deploy.sh --prod`, bare `tsx`): exit
   *     with the RESTART sentinel code. On Fly any non-zero exit trips
   *     the machine restart policy; local-deploy.sh's boot loop watches
   *     for this exact code and relaunches in the SAME terminal. A bare
   *     `pnpm start` with no supervisor just stops (no orphan — the
   *     operator relaunches), which is the honest outcome there.
   *
   * Gated on `restart_application` (masteradmin-only by default).
   */
  app.post("/admin/system/restart", async (req, reply) => {
    if (!(await requirePermission(req, reply, "restart_application"))) return;
    const actor = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser;
    const underTsxWatch = (process.env.npm_lifecycle_script ?? "").includes("tsx watch");
    await recordAudit(db, { actorUserId: actor?.id ?? "system", action: "system_restart", metadata: { underTsxWatch } });
    req.log.warn({ by: actor?.id, underTsxWatch }, "[system] admin-triggered process restart");
    void reply.send({ ok: true, message: "Restarting, the server will be back in a few seconds." });
    setTimeout(() => {
      if (underTsxWatch) {
        // Bump our own mtime so the watcher sees a change and restarts us.
        try {
          const self = fileURLToPath(import.meta.url);
          const now = new Date();
          utimesSync(self, now, now);
          return;
        } catch (err) {
          req.log.error({ err }, "[system] watch-touch restart failed; exiting instead");
        }
      }
      // RESTART_EXIT_CODE: EX_TEMPFAIL (75) = "relaunch me". local-deploy.sh's
      // boot loop and Fly's restart policy both bring up a fresh process.
      process.exit(75);
    }, 400);
    return reply;
  });

  /* ---------- System tab: purge ALL chat messages ----------
   *
   * Irreversibly deletes every row in `messages` site-wide. Rooms,
   * accounts, worlds, etc. are untouched. Requires an explicit
   * `{ confirm: "PURGE" }` body so a stray POST can't trigger it, on top
   * of the `purge_all_messages` permission (masteradmin-only by default).
   */
  app.post<{ Body: unknown }>("/admin/system/purge-messages", async (req, reply) => {
    if (!(await requirePermission(req, reply, "purge_all_messages"))) return;
    const parsed = z.object({ confirm: z.string() }).safeParse(req.body);
    if (!parsed.success || parsed.data.confirm !== "PURGE") {
      reply.code(400);
      return { error: "confirm_required", message: 'Send { "confirm": "PURGE" } to proceed.' };
    }
    const actor = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser;
    const before = Number((await db.select({ n: sql<number>`count(*)` }).from(messages))[0]?.n ?? 0);
    await db.delete(messages);
    await recordAudit(db, { actorUserId: actor?.id ?? "system", action: "system_purge_messages", metadata: { deleted: before } });
    req.log.warn({ by: actor?.id, deleted: before }, "[system] purged all chat messages");
    return { ok: true, deleted: before };
  });

  /* ---------- Verify Log tool ----------
   *
   * Staff paste/drop a submitted `/export` chat log; we extract its inert
   * signed manifest, verify the HMAC against this server's key, and cross-
   * check the content hash against the receipt recorded at export time. The
   * response carries the verdict, the receipt metadata, and the SIGNED
   * messages — so staff read what was signed, not the (possibly edited)
   * visible HTML around it. Bodies are returned raw; the client renders them
   * as plain text. Gated on `verify_export_logs` (seeded to admin, migration
   * 0261; masteradmin bypasses).
   */
  app.post<{ Body: unknown }>("/admin/export/verify", { bodyLimit: 24 * 1024 * 1024 }, async (req, reply) => {
    if (!(await requirePermission(req, reply, "verify_export_logs"))) return;
    const parsed = z.object({ file: z.string().min(1).max(24 * 1024 * 1024) }).safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "bad_request", message: "Send { file: <the exported log text> }." };
    }

    const manifest = extractExportManifest(parsed.data.file);
    if (!manifest) {
      return {
        found: false,
        valid: false,
        reason: "No verification data found. This doesn't look like a log exported from here (or the manifest was removed).",
      };
    }

    const result = verifyExportManifest(manifest);
    const p = manifest.payload;

    // Cross-check the receipt recorded at export time. A row found by id whose
    // stored hash matches the file's recomputed hash is the strongest possible
    // confirmation: the file's content is byte-identical to what the server
    // logged when it was generated.
    const row = (await db
      .select()
      .from(exportReceipts)
      .where(eq(exportReceipts.id, manifest.receiptId))
      .limit(1))[0];
    const stored = row
      ? {
          exists: true,
          matchesHash: !!result.contentHash && row.contentHash === result.contentHash,
          generatedAt: Number(row.generatedAt),
          exportedByUsername: row.exportedByUsername,
          roomName: row.roomName,
          messageCount: row.messageCount,
        }
      : { exists: false, matchesHash: false };

    return {
      found: true,
      valid: result.valid,
      reason: result.reason,
      receiptId: manifest.receiptId,
      meta: {
        roomName: p.roomName,
        exportedByUsername: p.exportedByUsername,
        generatedAtMs: p.generatedAtMs,
        windowMs: p.windowMs,
        rangeStartMs: p.rangeStartMs,
        rangeEndMs: p.rangeEndMs,
        messageCount: p.messageCount,
        truncated: p.truncated,
      },
      stored,
      // Only hand back the signed messages when the signature checks out — a
      // failed verdict means the bodies can't be trusted, so we don't display
      // them as if they were authoritative.
      messages: result.valid ? p.messages : [],
    };
  });

  app.get<{ Querystring: { tzOffsetMin?: string } }>("/admin/overview", async (req, reply) => {
    if (!(await requirePermission(req, reply, "view_admin_overview"))) return;
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const since24h = new Date(now - dayMs);
    const since5d = new Date(now - 5 * dayMs);
    const since7d = new Date(now - 7 * dayMs);
    const since30d = new Date(now - 30 * dayMs);
    // Caller's timezone offset in minutes (JS `Date.getTimezoneOffset()`
    // convention, positive = west of UTC). Used to align the day
    // buckets (sparkline + day-grouped widgets) with the viewer's
    // local "Today / Yesterday" rather than the server's. Without
    // this, a registration around midnight ended up in one bucket
    // on the panel ("Yesterday") and another on the chart
    // ("Today") depending on which side of UTC midnight it landed
    // on, exactly the desync that surfaced as "Today says 0 but
    // the chart shows 1."
    //
    // Clamp to a generous ±14h range so a malformed input can't
    // poison the SQL math. Default 0 = server time / UTC.
    const rawTz = parseInt(req.query.tzOffsetMin ?? "0", 10);
    const tzOffsetMin = Number.isFinite(rawTz) && Math.abs(rawTz) <= 14 * 60
      ? rawTz
      : 0;
    // Local time = UTC - offset minutes. We shift the unixepoch by
    // the offset before feeding strftime so the rendered date is
    // the viewer's local date.
    const tzShiftSec = -tzOffsetMin * 60;

    // Currently-connected users, dedupe by userId across sockets.
    const sockets = await io.fetchSockets();
    const onlineUsers = new Set<string>();
    for (const s of sockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (uid) onlineUsers.add(uid);
    }

    // Registered users exclude the "system" sentinel (owner of server-authored
    // system messages); counting it as a user inflates the figure misleadingly.
    const notSystem = ne(users.username, "system");
    const [usersTotalRow] = await db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(notSystem);
    const [users7dRow] = await db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(and(notSystem, gte(users.createdAt, since7d)));
    const [users30dRow] = await db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(and(notSystem, gte(users.createdAt, since30d)));

    // Recent registrations, the actual rows, newest first, for the
    // dashboard breakdown. Capped at 50 so an absurd signup spike doesn't
    // bloat the overview payload; admins drop into the Users tab for the
    // full list anyway.
    const recentRegRows = await db
      .select({
        id: users.id,
        username: users.username,
        role: users.role,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .where(and(notSystem, gte(users.createdAt, since5d)))
      .orderBy(desc(users.createdAt))
      .limit(50);

    // DAU/WAU/MAU derived from sessions.createdAt, every login mints a row,
    // so distinct user IDs in each window approximate active-user counts.
    const [dauRow] = await db
      .select({ n: sql<number>`count(distinct ${sessions.userId})` })
      .from(sessions)
      .where(gte(sessions.createdAt, since24h));
    const [wauRow] = await db
      .select({ n: sql<number>`count(distinct ${sessions.userId})` })
      .from(sessions)
      .where(gte(sessions.createdAt, since7d));
    const [mauRow] = await db
      .select({ n: sql<number>`count(distinct ${sessions.userId})` })
      .from(sessions)
      .where(gte(sessions.createdAt, since30d));

    // Rooms by type (public/private). The public /stats endpoint uses the
    // same shape, kept consistent so cards look the same across both views.
    const roomCounts = await db
      .select({ type: rooms.type, n: sql<number>`count(*)` })
      .from(rooms)
      .groupBy(rooms.type);
    const roomsByType: Record<string, number> = { public: 0, private: 0 };
    for (const r of roomCounts) roomsByType[r.type] = r.n;

    // Real chat = excludes the system kind (presence/join chatter that
    // would otherwise dominate the message-volume figures) and soft-deleted
    // rows.
    const realChat = sql`${messages.kind} != 'system' and ${messages.deletedAt} is null`;

    // Topic / reply detection mirrors the canonical filter used by
    // `/rooms/:id/topics` (routes/rooms.ts): scoped to nested-mode rooms,
    // kind="say" only (the forum composer's wire format), not deleted.
    // Detecting topics via `title IS NOT NULL` would miss legacy topics
    // created before the title column was added in migration 0039,
    // they're still real topics, the renderer falls back to a body
    // excerpt for the header.
    const nestedRooms = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(eq(rooms.replyMode, "nested"));
    const nestedRoomIds = nestedRooms.map((r) => r.id);
    // When no forum rooms exist yet, all forum metrics collapse to zero,
    // `inArray` on an empty list would otherwise produce invalid SQL.
    const inForum = nestedRoomIds.length > 0
      ? inArray(messages.roomId, nestedRoomIds)
      : sql`1 = 0`;
    const isTopic = and(
      inForum,
      sql`${messages.replyToId} is null`,
      eq(messages.kind, "say"),
      sql`${messages.deletedAt} is null`,
    );
    const isReply = and(
      inForum,
      sql`${messages.replyToId} is not null`,
      eq(messages.kind, "say"),
      sql`${messages.deletedAt} is null`,
    );

    const [msg24Row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(and(realChat, gte(messages.createdAt, since24h)));
    const [msg7Row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(and(realChat, gte(messages.createdAt, since7d)));
    const [msg30Row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(and(realChat, gte(messages.createdAt, since30d)));

    const [topicsTotalRow] = await db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(isTopic);
    const [repliesTotalRow] = await db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(isReply);
    const [topics7Row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(and(isTopic, gte(messages.createdAt, since7d)));
    const [replies7Row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(and(isReply, gte(messages.createdAt, since7d)));

    const [charactersRow] = await db.select({ n: sql<number>`count(*)` }).from(characters);
    const [worldsRow] = await db.select({ n: sql<number>`count(*)` }).from(worlds);

    const [reports7Row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(reports)
      .where(gte(reports.createdAt, since7d));
    const [audit7Row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(auditLog)
      .where(gte(auditLog.createdAt, since7d));

    // 7-day daily series. Day buckets are aligned to the CALLER's
    // local time (via `tzShiftSec` above) so a midnight-crossing
    // registration lands in the same row everywhere on the
    // dashboard. Missing days fill as 0.
    const dayExpr = (col: typeof messages.createdAt | typeof sessions.createdAt | typeof users.createdAt) =>
      sql<string>`strftime('%Y-%m-%d', (${col} / 1000) + ${tzShiftSec}, 'unixepoch')`.as("day");

    const messageFreq = await db
      .select({ day: dayExpr(messages.createdAt), n: sql<number>`count(*)` })
      .from(messages)
      .where(and(realChat, gte(messages.createdAt, since7d)))
      .groupBy(sql`day`);
    const topicFreq = await db
      .select({ day: dayExpr(messages.createdAt), n: sql<number>`count(*)` })
      .from(messages)
      .where(and(isTopic, gte(messages.createdAt, since7d)))
      .groupBy(sql`day`);
    const loginFreq = await db
      .select({
        day: dayExpr(sessions.createdAt),
        n: sql<number>`count(distinct ${sessions.userId})`,
      })
      .from(sessions)
      .where(gte(sessions.createdAt, since7d))
      .groupBy(sql`day`);
    const regFreq = await db
      .select({ day: dayExpr(users.createdAt), n: sql<number>`count(*)` })
      .from(users)
      .where(and(notSystem, gte(users.createdAt, since7d)))
      .groupBy(sql`day`);

    // Build dayKeys in the CALLER's local time so the labels match
    // the SQL buckets above. We shift `now` by the offset before
    // slicing the ISO date, same math `tzShiftSec` applies to the
    // strftime expression.
    const dayKeys: string[] = [];
    for (let i = 6; i >= 0; i--) {
      const shifted = new Date(now - i * dayMs - tzOffsetMin * 60_000);
      dayKeys.push(shifted.toISOString().slice(0, 10));
    }
    const fill = (rows: { day: string; n: number }[]) => {
      const map = new Map(rows.map((r) => [r.day, r.n]));
      return dayKeys.map((d) => ({ day: d, count: map.get(d) ?? 0 }));
    };

    return {
      online: onlineUsers.size,
      users: {
        total: usersTotalRow?.n ?? 0,
        newLast7d: users7dRow?.n ?? 0,
        newLast30d: users30dRow?.n ?? 0,
        dau: dauRow?.n ?? 0,
        wau: wauRow?.n ?? 0,
        mau: mauRow?.n ?? 0,
        recentRegistrations: recentRegRows.map((u) => ({
          userId: u.id,
          username: u.username,
          role: u.role,
          createdAt: +u.createdAt,
          lastLoginAt: u.lastLoginAt ? +u.lastLoginAt : null,
        })),
      },
      rooms: {
        public: roomsByType.public ?? 0,
        private: roomsByType.private ?? 0,
        total: roomCounts.reduce((s, r) => s + r.n, 0),
      },
      messages: {
        last24h: msg24Row?.n ?? 0,
        last7d: msg7Row?.n ?? 0,
        last30d: msg30Row?.n ?? 0,
      },
      forum: {
        topics: topicsTotalRow?.n ?? 0,
        replies: repliesTotalRow?.n ?? 0,
        topicsLast7d: topics7Row?.n ?? 0,
        repliesLast7d: replies7Row?.n ?? 0,
      },
      content: {
        characters: charactersRow?.n ?? 0,
        worlds: worldsRow?.n ?? 0,
      },
      moderation: {
        reportsLast7d: reports7Row?.n ?? 0,
        auditLast7d: audit7Row?.n ?? 0,
      },
      series: {
        messages: fill(messageFreq),
        topics: fill(topicFreq),
        logins: fill(loginFreq),
        registrations: fill(regFreq),
      },
    };
  });

  /* ---------- room overview ---------- */
  app.get("/admin/rooms", async (req, reply) => {
    if (!(await requirePermission(req, reply, "view_admin_rooms"))) return;
    const allRooms = await db.select().from(rooms).orderBy(asc(rooms.name));
    const counts = await db
      .select({ roomId: roomMembers.roomId, n: sql<number>`count(*)` })
      .from(roomMembers)
      .groupBy(roomMembers.roomId);
    const countByRoom = new Map(counts.map((r) => [r.roomId, r.n]));

    // Hydrate display names for the three owner slots (current /
    // original / last) so the admin UI doesn't have to repeat a
    // batch user-lookup. One IN-query over every userId referenced
    // by any of the three slots, then map back.
    const ownerIds = new Set<string>();
    for (const r of allRooms) {
      if (r.ownerId) ownerIds.add(r.ownerId);
      if (r.originalOwnerUserId) ownerIds.add(r.originalOwnerUserId);
      if (r.lastOwnerUserId) ownerIds.add(r.lastOwnerUserId);
    }
    const ownerNameByUserId = new Map<string, string>();
    if (ownerIds.size > 0) {
      const userRows = await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(inArray(users.id, [...ownerIds]));
      for (const u of userRows) ownerNameByUserId.set(u.id, u.username);
    }
    const usernameFor = (uid: string | null): string | null =>
      uid ? (ownerNameByUserId.get(uid) ?? null) : null;

    return {
      rooms: allRooms.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        topic: r.topic,
        description: r.description,
        ownerId: r.ownerId,
        ownerUsername: usernameFor(r.ownerId),
        // Owner-history surface (migration 0196). `originalOwnerUserId`
        // is the very first creator and never moves; `lastOwnerUserId`
        // is whoever held the room immediately before the current
        // owner (or equal to the current owner when nothing has
        // changed hands). Useful when investigating "who used to
        // run this room before so-and-so took it over."
        originalOwnerUserId: r.originalOwnerUserId,
        originalOwnerUsername: usernameFor(r.originalOwnerUserId),
        lastOwnerUserId: r.lastOwnerUserId,
        lastOwnerUsername: usernameFor(r.lastOwnerUserId),
        isSystem: r.isSystem,
        isDefault: r.isDefault,
        replyMode: r.replyMode,
        // hasPassword tells the editor whether to show "(replace password)"
        // vs "(set password)" - the hash itself is never exposed.
        hasPassword: r.passwordHash != null,
        memberCount: countByRoom.get(r.id) ?? 0,
        // Per-room message-expiry override in minutes. NULL = inherit the
        // global `messageRetentionMs` setting. The admin's Message
        // Expiry panel renders this either as the room's explicit value
        // or as "global (Xd)" when null. Forum/nested rooms are exempt
        // from BOTH sweeps and surface as "never expires", that's a
        // render-time decision in the panel, not a server filter.
        messageExpiryMinutes: r.messageExpiryMinutes,
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/admin/rooms/:id/occupants", async (req, reply) => {
    if (!(await requirePermission(req, reply, "view_admin_rooms"))) return;
    const { id } = req.params;
    const occupants = await db
      .select({
        userId: roomMembers.userId,
        role: roomMembers.role,
        joinedAt: roomMembers.joinedAt,
        username: users.username,
      })
      .from(roomMembers)
      .innerJoin(users, eq(users.id, roomMembers.userId))
      .where(eq(roomMembers.roomId, id))
      .orderBy(asc(users.username));
    return { occupants };
  });

  /**
   * Messages endpoint - explicitly REFUSES to return:
   *   - any messages from private/password-protected rooms (whole-room privacy)
   *   - whispers from any room (per-pair privacy - even public rooms persist
   *     whispers there for sender/recipient scrollback, but those exchanges
   *     are NOT moderation-visible content)
   *
   * Privacy promise: admins never read user-to-user private content. They
   * see what was said in the open, full stop. If a user is being abused
   * via whispers, they screenshot and report - the server doesn't act as
   * a backdoor.
   */
  app.get<{ Params: { id: string } }>("/admin/rooms/:id/messages", async (req, reply) => {
    if (!(await requirePermission(req, reply, "view_room_messages_as_admin"))) return;
    const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.id)).limit(1))[0];
    if (!room) {
      reply.code(404);
      return { error: "room not found" };
    }
    if (room.type !== "public") {
      reply.code(403);
      return {
        error: "private",
        message: "Private rooms are not viewable, even by administrators.",
      };
    }
    const rows = await db
      .select()
      .from(messages)
      .where(and(
        eq(messages.roomId, room.id),
        sql`${messages.kind} != 'whisper'`,
      ))
      .orderBy(desc(messages.createdAt))
      .limit(200);
    return { messages: rows.reverse() };
  });

  /* ---------- admin room create / edit ----------
   *
   * Admins can mint system rooms (permanent, exempt from auto-expire) with
   * a name, type, optional topic + description, and an optional password
   * for private rooms. Editing covers the same surface plus an `isSystem`
   * toggle so a room can be promoted to permanent (or vice-versa) after
   * the fact.
   */
  const ROOM_NAME_RX = /^[\p{L}\p{N}_\-' ]{1,40}$/u;
  const adminRoomCreateBody = z.object({
    name: z.string().min(1).max(40).regex(ROOM_NAME_RX, "name: letters, numbers, spaces, _ - '"),
    type: z.enum(["public", "private"]),
    /** Required when type=private. */
    password: z.string().min(1).max(100).optional(),
    topic: z.string().max(200).nullable().optional(),
    description: z.string().max(5000).nullable().optional(),
    /** Defaults to true - admin-created rooms are permanent unless explicitly opted out. */
    isSystem: z.boolean().optional(),
    /** When true, this room becomes the default landing, any existing default is automatically cleared first. */
    isDefault: z.boolean().optional(),
    /** "flat" = chronological chat; "nested" = forum-style threads with persistent top-level posts and grouped replies. Enables thread-category management. */
    replyMode: z.enum(["flat", "nested"]).optional(),
  });
  const adminRoomPatchBody = z.object({
    name: z.string().min(1).max(40).regex(ROOM_NAME_RX).optional(),
    /** Pass null in topic/description to clear; omit to leave unchanged. */
    topic: z.string().max(200).nullable().optional(),
    description: z.string().max(5000).nullable().optional(),
    isSystem: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    /** Same semantics as create: "flat" or "nested". Same in-chat command (/replymode) toggles this too. */
    replyMode: z.enum(["flat", "nested"]).optional(),
    type: z.enum(["public", "private"]).optional(),
    /** Required if type changes to private and the room currently has no password. */
    password: z.string().min(1).max(100).nullable().optional(),
    /**
     * Per-room message expiry override in minutes. Null clears the
     * override (room falls back to global `messageRetentionMs`).
     * Bounded to 1..43200 (30 days), same range the user-facing
     * `/expiry` command accepts. Mirrors the column comment on
     * `rooms.message_expiry_minutes`.
     */
    messageExpiryMinutes: z.number().int().min(1).max(43_200).nullable().optional(),
  });

  app.post<{ Body: unknown }>("/admin/rooms", async (req, reply) => {
    if (!(await requirePermission(req, reply, "create_system_room"))) return;
    const body = adminRoomCreateBody.parse(req.body);
    const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
    if (body.type === "private" && !body.password) {
      reply.code(400);
      return { error: "private rooms require a password" };
    }
    // Name uniqueness (case-insensitive). Mirrors the user-facing /go and
    // /private guards.
    const dup = (await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(sql`lower(${rooms.name}) = ${body.name.toLowerCase()}`)
      .limit(1))[0];
    if (dup) {
      reply.code(409);
      return { error: `a room named "${body.name}" already exists` };
    }
    const argon2 = (await import("argon2")).default;
    const id = nanoid();
    // Single-default invariant: if this room is being flagged the default,
    // clear it off whichever room currently carries it first. The partial
    // unique index would reject the insert otherwise.
    if (body.isDefault) {
      await db.update(rooms).set({ isDefault: false }).where(eq(rooms.isDefault, true));
    }
    await db.insert(rooms).values({
      id,
      name: body.name,
      slug: await deriveUniqueRoomSlug(db, body.name),
      type: body.type,
      passwordHash: body.type === "private" && body.password
        ? await argon2.hash(body.password)
        : null,
      topic: body.topic ?? null,
      description: body.description ?? null,
      // Owner is the creating admin. Cascade `set null` on user delete keeps
      // the room around even if the admin is later removed.
      ownerId: sessionUser.id,
      // Owner-history seeds, the admin creating the room is both the
      // original creator and the current last-known owner. Migration
      // 0196 added these columns; see commands/builtins/room.ts for
      // the user-facing /go / /private create paths that mirror this.
      originalOwnerUserId: sessionUser.id,
      lastOwnerUserId: sessionUser.id,
      isSystem: body.isSystem ?? true,
      isDefault: body.isDefault ?? false,
      replyMode: body.replyMode ?? "flat",
      // Home admin-created rooms in the default (is_system) server so the row
      // is never NULL (the column has no DB default). The site-admin "create
      // room" surface is server-agnostic; per-server rooms come from the owner
      // console (admin/servers.ts), which stamps its own serverId.
      serverId: DEFAULT_SERVER_ID,
    });
    // The creating admin gets an owner row in case they want to /topic etc
    // from inside the chat without elevating to site-admin every time.
    await db.insert(roomMembers).values({
      roomId: id,
      userId: sessionUser.id,
      role: "owner",
    }).onConflictDoNothing();
    // Live-publish the new room into every connected client's rooms tree.
    // No one is in the room yet so broadcastRoomState/Presence would be
    // no-ops here; emit the pulse directly. The room is homed in the default
    // server, so scope the pulse there when the flag is on; emitTreeChanged
    // falls back to the bare global pulse when servers are off.
    emitTreeChanged(io, DEFAULT_SERVER_ID);
    return { id, name: body.name, type: body.type };
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/admin/rooms/:id", async (req, reply) => {
    if (!(await requirePermission(req, reply, "edit_any_room_metadata"))) return;
    const body = adminRoomPatchBody.parse(req.body);
    const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.id)).limit(1))[0];
    if (!room) { reply.code(404); return { error: "not found" }; }

    // Name conflict (case-insensitive, ignoring this room).
    if (body.name && body.name.toLowerCase() !== room.name.toLowerCase()) {
      const dup = (await db
        .select({ id: rooms.id })
        .from(rooms)
        .where(and(
          sql`lower(${rooms.name}) = ${body.name.toLowerCase()}`,
          sql`${rooms.id} != ${room.id}`,
        ))
        .limit(1))[0];
      if (dup) { reply.code(409); return { error: "a room with that name already exists" }; }
    }

    // Type/password handling: switching to private requires a password
    // (either supplied here or already on the row); switching to public
    // clears the password.
    const update: Partial<typeof rooms.$inferInsert> = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.topic !== undefined) update.topic = body.topic;
    if (body.description !== undefined) update.description = body.description;
    if (body.isSystem !== undefined) update.isSystem = body.isSystem;
    if (body.isDefault !== undefined) update.isDefault = body.isDefault;
    if (body.replyMode !== undefined) update.replyMode = body.replyMode;
    if (body.messageExpiryMinutes !== undefined) update.messageExpiryMinutes = body.messageExpiryMinutes;

    // Single-default invariant: flagging this room as the default first
    // clears whichever room currently carries the flag. Skipped when the
    // target is already the default (no-op) and when we're un-flagging
    // (the user is explicitly clearing, not stealing).
    if (body.isDefault === true && !room.isDefault) {
      await db.update(rooms).set({ isDefault: false }).where(eq(rooms.isDefault, true));
    }

    if (body.type !== undefined && body.type !== room.type) {
      update.type = body.type;
      const argon2 = (await import("argon2")).default;
      if (body.type === "private") {
        if (body.password) {
          update.passwordHash = await argon2.hash(body.password);
        } else if (!room.passwordHash) {
          reply.code(400);
          return { error: "switching to private requires a password" };
        }
      } else {
        // public: drop any stored password
        update.passwordHash = null;
      }
    } else if (body.password !== undefined) {
      // Same-type update: rotate or clear password explicitly. Clearing on a
      // private room is a no-op (login still requires it via /invite or
      // membership); we treat it as "remove the password but keep the room
      // private" - admins can clear and set again to rotate.
      if (body.password === null) {
        update.passwordHash = null;
      } else {
        const argon2 = (await import("argon2")).default;
        update.passwordHash = await argon2.hash(body.password);
      }
    }

    await db.update(rooms).set(update).where(eq(rooms.id, room.id));

    // If the metadata changed, refresh anyone currently in the room so they
    // see the new name/topic/replyMode without manually /refresh-ing.
    // replyMode in particular flips the MessageList renderer (flat ↔
    // nested) and gates the thread-category picker in the composer.
    if (
      update.name !== undefined ||
      update.topic !== undefined ||
      update.type !== undefined ||
      update.replyMode !== undefined
    ) {
      await broadcastRoomState(io, db, room.id);
    }

    return { ok: true };
  });

  /**
   * Bulk-set the per-room message-expiry override across many rooms in
   * one round-trip. Used by the admin's Message Expiry panel for batch
   * tagging (e.g. "all OOC rooms get a 1h window"). Single transaction
   * via Drizzle's update-with-IN, atomic from the client's POV: either
   * every targeted row updates or none do.
   *
   * Forum/nested rooms accept the value but the sweep ignores them (the
   * per-room sweep in seed.ts skips replyMode='nested' unconditionally).
   * We don't filter them out here so admins can still set a "documented
   * intent" value on a forum room without surprise.
   */
  const adminRoomBulkExpiryBody = z.object({
    /** Room ids to apply the value to. Capped at 500 so a malformed UI doesn't blow the row limit. */
    roomIds: z.array(z.string()).min(1).max(500),
    /** Minutes (1..43200). Null clears the override on every selected room. */
    minutes: z.number().int().min(1).max(43_200).nullable(),
  });
  app.patch<{ Body: unknown }>("/admin/rooms/expiry/bulk", async (req, reply) => {
    if (!(await requirePermission(req, reply, "bulk_edit_rooms"))) return;
    const body = adminRoomBulkExpiryBody.parse(req.body);
    const result = await db
      .update(rooms)
      .set({ messageExpiryMinutes: body.minutes })
      .where(inArray(rooms.id, body.roomIds));
    reply.code(200);
    return { ok: true, updated: result.changes };
  });

  /**
   * DELETE /admin/rooms/:id - moderator hatchet. Refuses system rooms.
   *
   * Currently-online occupants are relocated to the canonical landing room
   * and shown a notice; cascade FKs (room_members, messages, bans,
   * invites) clean up. Even private/password rooms can be deleted (admin
   * moderation overrides the privacy contract because messages are still
   * never read, only removed wholesale).
   */
  app.delete<{ Params: { id: string } }>("/admin/rooms/:id", async (req, reply) => {
    if (!(await requirePermission(req, reply, "delete_room"))) return;
    const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.id)).limit(1))[0];
    if (!room) {
      reply.code(404);
      return { error: "not found" };
    }
    if (room.isSystem) {
      reply.code(400);
      return { error: "system rooms cannot be deleted" };
    }

    const landing = await findCanonicalLanding(db);
    const remoteSockets = await io.in(`room:${room.id}`).fetchSockets();

    for (const s of remoteSockets) {
      s.leave(`room:${room.id}`);
      s.emit("error:notice", {
        code: "ROOM_DELETED",
        message: `Room "${room.name}" was removed by an administrator.`,
      });
      if (landing) {
        s.join(`room:${landing.id}`);
        (s.data as { roomId?: string }).roomId = landing.id;
        const userId = (s.data as { userId?: string }).userId;
        if (userId) await sendRoomBacklogTo(s, db, landing.id, userId);
      }
    }

    await db.delete(rooms).where(eq(rooms.id, room.id));
    const actor = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser;
    if (actor) {
      await recordAudit(db, {
        actorUserId: actor.id,
        action: "room_delete",
        // The room is gone so the FK would set null anyway; we keep the
        // metadata for queryability instead.
        metadata: { roomId: room.id, roomName: room.name, type: room.type, isSystem: room.isSystem },
      });
    }

    if (landing && remoteSockets.length > 0) {
      await broadcastRoomState(io, db, landing.id);
    }
    // A room vanished from the world; every connected rail needs to know,
    // not just the ones who happened to be inside it. broadcastRoomState
    // above only fires when the deleted room had live occupants, an empty
    // archived room going away would otherwise be invisible until the 20s
    // backstop poll. The deleted room row is in hand, so its serverId is
    // free; emitTreeChanged falls back to the bare global pulse when the
    // servers flag is off.
    emitTreeChanged(io, room.serverId);

    return { ok: true, deleted: room.id, name: room.name };
  });

  /* ---------- site settings ---------- */
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
  const settingsBody = z.object({
    /** ms; 0 = retain forever. Capped at ~10 years to refuse pathological values. */
    messageRetentionMs: z.number().int().min(0).max(10 * 365 * 24 * 60 * 60 * 1000).optional(),
    /** ms; min 5 minutes (don't lock users out instantly), max 10 years. */
    sessionTtlMs: z.number().int().min(5 * 60 * 1000).max(10 * 365 * 24 * 60 * 60 * 1000).optional(),
    /** ms; min 30 seconds, max 24 hours. How long a disconnected user lingers in the userlist as "idle" before being dropped. */
    idleGraceMs: z.number().int().min(30 * 1000).max(24 * 60 * 60 * 1000).optional(),
    /** Pass null to clear; pass a Theme to set. */
    defaultTheme: themeSchema.nullable().optional(),
    /** Public site name. Empty becomes "The Spire". */
    siteName: z.string().min(0).max(60).optional(),
    /**
     * Canonical site URL the banner logo links to. Empty string clears
     * the wrapping (logo renders bare). Non-empty must be http/https,
     * the Zod `.url()` refinement rejects bare hostnames or other
     * schemes, and a max-length cap keeps a runaway paste from getting
     * persisted.
     */
    siteUrl: z
      .string()
      .max(500)
      .refine(
        (s) => s === "" || /^https?:\/\//i.test(s),
        { message: "siteUrl must start with http:// or https:// (or be empty to clear)" },
      )
      .refine(
        (s) => {
          if (s === "") return true;
          try { new URL(s); return true; } catch { return false; }
        },
        { message: "siteUrl must be a valid URL" },
      )
      .optional(),
    /**
     * CSS background shorthand applied to the banner. Pass null to clear.
     * Sanity-capped at 1KB; admins can use url(), gradient(), or solid color.
     */
    bannerCoverCss: z.string().max(1000).nullable().optional(),
    /** Pass null to clear; pass a #rrggbb hex to override the logo color. */
    logoColor: z.string().regex(HEX_RX).nullable().optional(),
    /** Pass null to clear; pass a CSS font-family stack. */
    logoFont: z.string().max(200).nullable().optional(),
    /**
     * Banner/splash logo URL. Empty string clears the image (text
     * title takes over). Otherwise: an `/uploads/...` path (written
     * by the upload endpoint), a built-in path like `/thespire-logo
     * .png`, or a remote `https://...` URL. The 1KB cap is a sanity
     * check; uploaded paths are short, hosted URLs rarely exceed
     * a few hundred chars.
     */
    logoUrl: z.string().max(1000).optional(),
    /* ----- Limits / capacity controls ----- */
    /** 1..1000. */
    maxCharactersPerUser: z.number().int().min(1).max(1000).optional(),
    /** 1..50 - admins can lift the email-uniqueness cap for shared accounts. */
    maxAccountsPerEmail: z.number().int().min(1).max(50).optional(),
    /** 0..1000. 0 = no user-created rooms (public sites that only want admin rooms). */
    maxRoomsPerOwner: z.number().int().min(0).max(1000).optional(),
    /** 100..50000 chars per chat message. */
    maxMessageLength: z.number().int().min(100).max(50_000).optional(),
    /** 100..50000 chars per direct message body. */
    maxDirectMessageLength: z.number().int().min(100).max(50_000).optional(),
    /** 100..50000 chars per forum post body (topic OR reply). */
    maxForumPostLength: z.number().int().min(100).max(50_000).optional(),
    /** 10..500 chars on a forum topic title, keep titles list-renderable. */
    maxForumTopicTitleLength: z.number().int().min(10).max(500).optional(),
    /**
     * 5..100 topics-per-page on the forum's numbered pagination strip
     * (migration 0193). Picks reasonable bounds: under 5 makes the
     * page strip unreadable, over 100 defeats the whole point of
     * pagination on long-running categories.
     */
    forumTopicsPerPage: z.number().int().min(5).max(100).optional(),
    /**
     * Author-edit / author-delete grace window in ms for chat + DM
     * messages. 0..7 days. Mods and admins bypass the gate. Forum
     * rooms ignore it (indefinite edits with an (edited) badge).
     */
    editGraceMs: z.number().int().min(0).max(7 * 24 * 60 * 60 * 1000).optional(),
    /** 1000..200000 chars per bio HTML. */
    maxBioLength: z.number().int().min(1000).max(200_000).optional(),
    /** Email verification toggle + enforcement mode + broadcast daily cap. */
    emailVerificationEnabled: z.boolean().optional(),
    emailVerificationMode: z.enum(["nudge", "block"]).optional(),
    emailDailyCap: z.number().int().min(1).max(100_000).optional(),
    /** Master switch for /auth/register. */
    registrationOpen: z.boolean().optional(),
    // Long-form HTML fields. Caps tuned for "fully comprehensive rules,
    // ToS, and privacy disclosure", admins shouldn't bump against these
    // for any realistic document. Each is independently capped so a
    // huge rules doc doesn't lock the admin out of editing the smaller
    // welcome blurb (or vice versa). Sanitizer (sanitizeBio) has no
    // length limit of its own; Fastify's bodyLimit (12MB) is the
    // outer guard rail.
    /** HTML rendered above the splash login form. Sanitized on save. */
    welcomeHtml: z.string().max(500_000).optional(),
    /** HTML body of the Rules modal AND the /rules public page. Sanitized on save. */
    rulesHtml: z.string().max(1_000_000).optional(),
    /** HTML body of the privacy/safety notice in the Rules modal AND on /rules. Sanitized on save. */
    securityNoticeHtml: z.string().max(500_000).optional(),
    /** HTML body of the registration disclaimer (effectively the ToS). Sanitized on save. */
    registerDisclaimerHtml: z.string().max(500_000).optional(),
    /** HTML rules shown with an "I agree" gate when applying to register a server. Sanitized on save. */
    serverRegistrationRulesHtml: z.string().max(500_000).optional(),
    /** HTML rules shown with an "I agree" gate when applying to create a forum. Sanitized on save. */
    forumRegistrationRulesHtml: z.string().max(500_000).optional(),
    /** Plain-text SEO description (meta description, OG, Twitter card). 500-char cap. */
    metaDescription: z.string().max(500).optional(),
    /**
     * Raw HTML injected into <head> for analytics scripts. NOT sanitized -
     * admins paste from their provider's dashboard. 20KB cap as a sanity
     * check; the UI warns the field is admin-trusted raw HTML.
     */
    customHeadHtml: z.string().max(20_000).optional(),
    /** Default social-card image URL (og:image / twitter:image fallback). Empty clears. */
    ogImageUrl: z.string().max(2_000).optional(),
    /** Homepage/login/register title tagline. Empty falls back to the built-in. */
    homepageTagline: z.string().max(200).optional(),
    /** Keyword shelf for <meta name="keywords">. Empty falls back to DEFAULT_KEYWORDS. */
    seoKeywords: z.string().max(1_000).optional(),
    /** google-site-verification content token (paste only the token, not the tag). */
    googleSiteVerification: z.string().max(200).optional(),
    /** Bing msvalidate.01 content token (paste only the token, not the tag). */
    bingSiteVerification: z.string().max(200).optional(),
    /** Master search-indexing switch. When false: robots Disallow / + noindex meta. */
    searchIndexingEnabled: z.boolean().optional(),
    /** Newline-separated social profile URLs mapped into Organization.sameAs. */
    socialProfileUrls: z.string().max(2_000).optional(),
    /** First-party analytics master switch (migration 0310). When false the ingest routes + server page-view recorder no-op. */
    analyticsEnabled: z.boolean().optional(),
    /** Days of RAW analytics rows to keep before the nightly rollup sweep deletes them. 1..365; aggregates in analytics_daily persist. */
    analyticsRawRetentionDays: z.number().int().min(1).max(365).optional(),
    /** Honor the browser DNT / Sec-GPC opt-out signal. */
    analyticsRespectDnt: z.boolean().optional(),
    /** Surfaces live community activity counters on the splash + future feed rails. Off during cold-start. */
    activityFeedsEnabled: z.boolean().optional(),
    serversEnabled: z.boolean().optional(),
    /** Escalating chat anti-spam master switch. */
    antiSpamEnabled: z.boolean().optional(),
    /** Content auto-moderation master switch. */
    automodEnabled: z.boolean().optional(),
    /** Splash page featured-worlds carousel toggle. */
    featuredWorldsEnabled: z.boolean().optional(),
    /** Splash stat: rolling 24h chat message count. Independent toggle. */
    splashMessages24hEnabled: z.boolean().optional(),
    /** Visual bio Designer availability on the profile bio tab (desktop). */
    profileDesignerEnabled: z.boolean().optional(),
    /** Sanitized HTML for the post-login welcome modal. Empty string clears the welcome. Same 50KB cap as other rich-text settings. */
    newUserWelcomeHtml: z.string().max(50_000).optional(),
    /**
     * Default theme STYLE key, 'medieval', 'modern', or 'scifi'. Users
     * who haven't picked an override inherit this. Stored verbatim, the
     * client validates against its registered style catalog and falls
     * back to 'medieval' if the value is unknown.
     */
    defaultStyleKey: z.string().min(1).max(64).optional(),
    /**
     * Per-preset design map. Keys are theme preset names (Parchment,
     * Twilight, …), values are design keys (medieval/modern/scifi).
     * Bounded so admins can't bloat the JSON column: at most 64 keys,
     * each key + value capped at 64 chars. Null/empty clears the map.
     */
    themeDesignMap: z
      .record(z.string().min(1).max(64), z.string().min(1).max(64))
      .refine((m) => Object.keys(m).length <= 64, { message: "too many preset entries" })
      .nullable()
      .optional(),
  });

  function settingsResponse(s: Awaited<ReturnType<typeof getSettings>>) {
    return {
      messageRetentionMs: s.messageRetentionMs,
      sessionTtlMs: s.sessionTtlMs,
      idleGraceMs: s.idleGraceMs,
      defaultThemeJson: s.defaultThemeJson,
      defaultTheme: s.defaultTheme,
      siteName: s.siteName,
      siteUrl: s.siteUrl,
      bannerCoverCss: s.bannerCoverCss,
      logoColor: s.logoColor,
      logoFont: s.logoFont,
      logoUrl: s.logoUrl,
      maxCharactersPerUser: s.maxCharactersPerUser,
      maxAccountsPerEmail: s.maxAccountsPerEmail,
      maxRoomsPerOwner: s.maxRoomsPerOwner,
      maxMessageLength: s.maxMessageLength,
      maxDirectMessageLength: s.maxDirectMessageLength,
      maxForumPostLength: s.maxForumPostLength,
      maxForumTopicTitleLength: s.maxForumTopicTitleLength,
      forumTopicsPerPage: s.forumTopicsPerPage,
      editGraceMs: s.editGraceMs,
      maxBioLength: s.maxBioLength,
      emailVerificationEnabled: s.emailVerificationEnabled,
      emailVerificationMode: s.emailVerificationMode,
      emailDailyCap: s.emailDailyCap,
      registrationOpen: s.registrationOpen,
      welcomeHtml: s.welcomeHtml,
      rulesHtml: s.rulesHtml,
      securityNoticeHtml: s.securityNoticeHtml,
      registerDisclaimerHtml: s.registerDisclaimerHtml,
      serverRegistrationRulesHtml: s.serverRegistrationRulesHtml,
      forumRegistrationRulesHtml: s.forumRegistrationRulesHtml,
      metaDescription: s.metaDescription,
      customHeadHtml: s.customHeadHtml,
      ogImageUrl: s.ogImageUrl,
      homepageTagline: s.homepageTagline,
      seoKeywords: s.seoKeywords,
      googleSiteVerification: s.googleSiteVerification,
      bingSiteVerification: s.bingSiteVerification,
      searchIndexingEnabled: s.searchIndexingEnabled,
      socialProfileUrls: s.socialProfileUrls,
      analyticsEnabled: s.analyticsEnabled,
      analyticsRawRetentionDays: s.analyticsRawRetentionDays,
      analyticsRespectDnt: s.analyticsRespectDnt,
      activityFeedsEnabled: s.activityFeedsEnabled,
      serversEnabled: s.serversEnabled,
      antiSpamEnabled: s.antiSpamEnabled,
      automodEnabled: s.automodEnabled,
      featuredWorldsEnabled: s.featuredWorldsEnabled,
      splashMessages24hEnabled: s.splashMessages24hEnabled,
      profileDesignerEnabled: s.profileDesignerEnabled,
      newUserWelcomeHtml: s.newUserWelcomeHtml,
      defaultStyleKey: s.defaultStyleKey,
      themeDesignMap: s.themeDesignMap,
      updatedAt: s.updatedAt,
    };
  }

  app.get("/admin/settings", async (req, reply) => {
    if (!(await requirePermission(req, reply, "view_admin_settings"))) return;
    return settingsResponse(await getSettings(db));
  });

  app.put<{ Body: unknown }>("/admin/settings", async (req, reply) => {
    // This single endpoint backs every Settings, Branding, and Rules
    // form in the admin panel. Gating is split by which FIELDS the
    // patch touches:
    //
    //   - If the patch ONLY touches branding fields (site name + URL,
    //     banner cover CSS, logo color/font/URL, splash welcome HTML,
    //     SEO meta description, custom head HTML, theme-design map,
    //     default style key/theme), `edit_branding` suffices. This
    //     lets a masteradmin delegate "edit the splash + theming"
    //     without handing out the broader keymaster role.
    //
    //   - Any patch that touches anything else (retention, TTLs,
    //     caps, registration toggle, rules HTML, etc.) still requires
    //     `edit_site_settings`.
    //
    // BRANDING_FIELDS below is the source of truth for the split. If
    // you add a new branding-shaped field to the schema, list it
    // here too. (The audit-coverage script reads from this list via
    // its TAB_DATA_MAP for the view_admin_branding tab → data
    // coherence check.)
    const body = settingsBody.parse(req.body);
    const BRANDING_FIELDS = new Set<string>([
      "siteName", "siteUrl", "bannerCoverCss",
      "logoColor", "logoFont", "logoUrl",
      "welcomeHtml", "metaDescription", "customHeadHtml",
      "ogImageUrl", "homepageTagline", "seoKeywords",
      "googleSiteVerification", "bingSiteVerification",
      "searchIndexingEnabled", "socialProfileUrls",
      "themeDesignMap", "defaultStyleKey", "defaultTheme",
    ]);
    const touchedKeys = Object.keys(body).filter(
      (k) => (body as Record<string, unknown>)[k] !== undefined,
    );
    const brandingOnly = touchedKeys.length > 0
      && touchedKeys.every((k) => BRANDING_FIELDS.has(k));
    const requiredKey = brandingOnly ? "edit_branding" : "edit_site_settings";
    if (!(await requirePermission(req, reply, requiredKey))) return;
    const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
    // Drop undefined keys - exactOptionalPropertyTypes refuses `{ x: undefined }`
    // even on optional properties; we want true omission.
    const patch: Parameters<typeof updateSettings>[1] = {};
    if (body.messageRetentionMs !== undefined) patch.messageRetentionMs = body.messageRetentionMs;
    if (body.sessionTtlMs !== undefined) patch.sessionTtlMs = body.sessionTtlMs;
    if (body.idleGraceMs !== undefined) patch.idleGraceMs = body.idleGraceMs;
    if (body.defaultTheme !== undefined) patch.defaultTheme = body.defaultTheme;
    if (body.siteName !== undefined) patch.siteName = body.siteName;
    if (body.siteUrl !== undefined) patch.siteUrl = body.siteUrl;
    if (body.bannerCoverCss !== undefined) patch.bannerCoverCss = body.bannerCoverCss;
    if (body.logoColor !== undefined) patch.logoColor = body.logoColor;
    if (body.logoFont !== undefined) patch.logoFont = body.logoFont;
    if (body.logoUrl !== undefined) patch.logoUrl = body.logoUrl;
    if (body.maxCharactersPerUser !== undefined) patch.maxCharactersPerUser = body.maxCharactersPerUser;
    if (body.maxAccountsPerEmail !== undefined) patch.maxAccountsPerEmail = body.maxAccountsPerEmail;
    if (body.maxRoomsPerOwner !== undefined) patch.maxRoomsPerOwner = body.maxRoomsPerOwner;
    if (body.maxMessageLength !== undefined) patch.maxMessageLength = body.maxMessageLength;
    if (body.maxDirectMessageLength !== undefined) patch.maxDirectMessageLength = body.maxDirectMessageLength;
    if (body.maxForumPostLength !== undefined) patch.maxForumPostLength = body.maxForumPostLength;
    if (body.maxForumTopicTitleLength !== undefined) patch.maxForumTopicTitleLength = body.maxForumTopicTitleLength;
    if (body.forumTopicsPerPage !== undefined) patch.forumTopicsPerPage = body.forumTopicsPerPage;
    if (body.editGraceMs !== undefined) patch.editGraceMs = body.editGraceMs;
    if (body.maxBioLength !== undefined) patch.maxBioLength = body.maxBioLength;
    if (body.emailVerificationEnabled !== undefined) patch.emailVerificationEnabled = body.emailVerificationEnabled;
    if (body.emailVerificationMode !== undefined) patch.emailVerificationMode = body.emailVerificationMode;
    if (body.emailDailyCap !== undefined) patch.emailDailyCap = body.emailDailyCap;
    if (body.registrationOpen !== undefined) patch.registrationOpen = body.registrationOpen;
    if (body.welcomeHtml !== undefined) {
      // Sanitize on save (same allow-list as bios) - never trust admin HTML input.
      const { sanitizeBio } = await import("../auth/html.js");
      patch.welcomeHtml = sanitizeBio(body.welcomeHtml);
    }
    if (body.rulesHtml !== undefined) {
      const { sanitizeBio } = await import("../auth/html.js");
      patch.rulesHtml = sanitizeBio(body.rulesHtml);
    }
    if (body.securityNoticeHtml !== undefined) {
      const { sanitizeBio } = await import("../auth/html.js");
      patch.securityNoticeHtml = sanitizeBio(body.securityNoticeHtml);
    }
    if (body.registerDisclaimerHtml !== undefined) {
      const { sanitizeBio } = await import("../auth/html.js");
      patch.registerDisclaimerHtml = sanitizeBio(body.registerDisclaimerHtml);
    }
    if (body.serverRegistrationRulesHtml !== undefined) {
      const { sanitizeBio } = await import("../auth/html.js");
      patch.serverRegistrationRulesHtml = sanitizeBio(body.serverRegistrationRulesHtml);
    }
    if (body.forumRegistrationRulesHtml !== undefined) {
      const { sanitizeBio } = await import("../auth/html.js");
      patch.forumRegistrationRulesHtml = sanitizeBio(body.forumRegistrationRulesHtml);
    }
    // metaDescription is plain text - just trim. Newlines collapse to spaces
    // since meta descriptions are single-line.
    if (body.metaDescription !== undefined) {
      patch.metaDescription = body.metaDescription.replace(/\s+/g, " ").trim();
    }
    // customHeadHtml is verbatim raw HTML - DO NOT sanitize. Admins paste
    // analytics scripts here and sanitization would strip <script>. The
    // 20KB cap on the input schema is the only guard.
    if (body.customHeadHtml !== undefined) {
      patch.customHeadHtml = body.customHeadHtml;
    }
    // SEO fields are plain text - trim; empty string is the explicit clear.
    if (body.ogImageUrl !== undefined) patch.ogImageUrl = body.ogImageUrl.trim();
    if (body.homepageTagline !== undefined) patch.homepageTagline = body.homepageTagline.replace(/\s+/g, " ").trim();
    if (body.seoKeywords !== undefined) patch.seoKeywords = body.seoKeywords.replace(/\s+/g, " ").trim();
    if (body.googleSiteVerification !== undefined) patch.googleSiteVerification = body.googleSiteVerification.trim();
    if (body.bingSiteVerification !== undefined) patch.bingSiteVerification = body.bingSiteVerification.trim();
    if (body.searchIndexingEnabled !== undefined) patch.searchIndexingEnabled = body.searchIndexingEnabled;
    // Social profile URLs: keep newlines (one URL per line for Organization.sameAs);
    // only trim leading/trailing whitespace on the whole block.
    if (body.socialProfileUrls !== undefined) patch.socialProfileUrls = body.socialProfileUrls.trim();
    if (body.analyticsEnabled !== undefined) patch.analyticsEnabled = body.analyticsEnabled;
    if (body.analyticsRawRetentionDays !== undefined) patch.analyticsRawRetentionDays = body.analyticsRawRetentionDays;
    if (body.analyticsRespectDnt !== undefined) patch.analyticsRespectDnt = body.analyticsRespectDnt;
    if (body.activityFeedsEnabled !== undefined) {
      patch.activityFeedsEnabled = body.activityFeedsEnabled;
    }
    if (body.featuredWorldsEnabled !== undefined) {
      patch.featuredWorldsEnabled = body.featuredWorldsEnabled;
    }
    if (body.splashMessages24hEnabled !== undefined) {
      patch.splashMessages24hEnabled = body.splashMessages24hEnabled;
    }
    if (body.profileDesignerEnabled !== undefined) {
      patch.profileDesignerEnabled = body.profileDesignerEnabled;
    }
    // Multi-server master switch. NOT a branding field → requires
    // edit_site_settings (it changes sitewide behavior, not just chrome).
    if (body.serversEnabled !== undefined) {
      patch.serversEnabled = body.serversEnabled;
    }
    // Escalating chat anti-spam. Sitewide behavior change → edit_site_settings.
    if (body.antiSpamEnabled !== undefined) {
      patch.antiSpamEnabled = body.antiSpamEnabled;
    }
    // Content auto-moderation. Sitewide behavior change → edit_site_settings.
    if (body.automodEnabled !== undefined) {
      patch.automodEnabled = body.automodEnabled;
    }
    if (body.newUserWelcomeHtml !== undefined) {
      // Sanitize via the bio allow-list (same trust posture as welcomeHtml /
      // rulesHtml). Empty string passes through and represents "no welcome
      // to show".
      const { sanitizeBio } = await import("../auth/html.js");
      patch.newUserWelcomeHtml = sanitizeBio(body.newUserWelcomeHtml);
    }
    if (body.defaultStyleKey !== undefined) patch.defaultStyleKey = body.defaultStyleKey;
    if (body.themeDesignMap !== undefined) patch.themeDesignMap = body.themeDesignMap;
    const result = settingsResponse(await updateSettings(db, patch, sessionUser.id));
    await recordAudit(db, {
      actorUserId: sessionUser.id,
      action: "settings_update",
      // Record which fields were touched so the audit reads as "changed
      // welcomeHtml + maxMessageLength" rather than dumping a 50KB HTML diff.
      metadata: { keys: Object.keys(patch) },
    });
    return result;
  });

  /* ---------- auto-moderation rules (CRUD) ----------
   *
   * Content auto-moderation config surface. Site-wide (serverId = null) rules
   * for v1; the same table + shape carries a future per-server dispatch path.
   * Gated on `edit_site_settings` (same key that toggles the master switch).
   *
   * Every mutating route invalidates the compiled-ruleset cache in
   * realtime/automod.ts so the dispatch hot path picks up the change on the
   * next message without re-reading the table per send. Regex/keyword patterns
   * are validated (ReDoS screen + length cap) at save time so a bad pattern is
   * rejected here rather than silently never matching or wedging the loop
   * later. */
  const AUTOMOD_KINDS = ["keyword", "regex", "link", "invite", "mention_cap"] as const;
  const AUTOMOD_ACTIONS = ["warn", "delete", "mute"] as const;
  const AUTOMOD_SCOPES = ["chat", "forum", "both"] as const;

  function automodRowToWire(row: typeof automodRules.$inferSelect): AutomodRule {
    return {
      id: row.id,
      serverId: row.serverId,
      enabled: !!row.enabled,
      kind: row.kind,
      pattern: row.pattern,
      action: row.action,
      muteMs: row.muteMs,
      scope: row.scope,
      caseInsensitive: !!row.caseInsensitive,
      wholeWord: !!row.wholeWord,
      note: row.note,
      createdByUserId: row.createdByUserId,
      createdAt: +row.createdAt,
      updatedAt: +row.updatedAt,
    };
  }

  app.get("/admin/automod/rules", async (req, reply) => {
    if (!(await requirePermission(req, reply, "edit_site_settings"))) return;
    // Site-wide rules only for v1 (serverId IS NULL). Newest first.
    const rows = await db
      .select()
      .from(automodRules)
      .where(sql`${automodRules.serverId} IS NULL`)
      .orderBy(desc(automodRules.createdAt));
    return { rules: rows.map(automodRowToWire) };
  });

  const automodCreateBody = z.object({
    enabled: z.boolean().optional(),
    kind: z.enum(AUTOMOD_KINDS),
    pattern: z.string().max(1_000).default(""),
    action: z.enum(AUTOMOD_ACTIONS).default("warn"),
    /** Mute duration (ms) when action = 'mute'; null/omit = engine default. */
    muteMs: z.number().int().min(1_000).max(30 * 24 * 60 * 60 * 1000).nullable().optional(),
    scope: z.enum(AUTOMOD_SCOPES).default("both"),
    caseInsensitive: z.boolean().default(true),
    wholeWord: z.boolean().default(false),
    note: z.string().max(500).nullable().optional(),
  });

  app.post<{ Body: unknown }>("/admin/automod/rules", async (req, reply) => {
    if (!(await requirePermission(req, reply, "edit_site_settings"))) return;
    const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
    let body: z.infer<typeof automodCreateBody>;
    try { body = automodCreateBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    // Save-time pattern validation (ReDoS screen + length cap). Rejects a bad
    // regex/keyword before it can ever reach the dispatch matcher.
    const v = validateAutomodPattern(body.kind, body.pattern);
    if (!v.ok) { reply.code(400); return { error: v.reason ?? "invalid pattern" }; }
    const now = new Date();
    const rule = {
      id: nanoid(),
      serverId: null,
      enabled: body.enabled ?? true,
      kind: body.kind,
      pattern: body.pattern,
      action: body.action,
      muteMs: body.muteMs ?? null,
      scope: body.scope,
      caseInsensitive: body.caseInsensitive,
      wholeWord: body.wholeWord,
      note: body.note ?? null,
      createdByUserId: sessionUser.id,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(automodRules).values(rule);
    invalidateAutomodCache();
    await recordAudit(db, {
      actorUserId: sessionUser.id,
      action: "automod",
      reason: `created automod rule (${body.kind}/${body.action})`,
      metadata: { ruleId: rule.id, op: "create", kind: body.kind, action: body.action, scope: body.scope },
    });
    const created = (await db.select().from(automodRules).where(eq(automodRules.id, rule.id)).limit(1))[0]!;
    return { rule: automodRowToWire(created) };
  });

  const automodPatchBody = z.object({
    enabled: z.boolean().optional(),
    kind: z.enum(AUTOMOD_KINDS).optional(),
    pattern: z.string().max(1_000).optional(),
    action: z.enum(AUTOMOD_ACTIONS).optional(),
    muteMs: z.number().int().min(1_000).max(30 * 24 * 60 * 60 * 1000).nullable().optional(),
    scope: z.enum(AUTOMOD_SCOPES).optional(),
    caseInsensitive: z.boolean().optional(),
    wholeWord: z.boolean().optional(),
    note: z.string().max(500).nullable().optional(),
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/admin/automod/rules/:id", async (req, reply) => {
    if (!(await requirePermission(req, reply, "edit_site_settings"))) return;
    const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
    const id = req.params.id;
    let body: z.infer<typeof automodPatchBody>;
    try { body = automodPatchBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    // Never trust the client id: load the existing row (site-wide only) first.
    const existing = (await db
      .select()
      .from(automodRules)
      .where(and(eq(automodRules.id, id), sql`${automodRules.serverId} IS NULL`))
      .limit(1))[0];
    if (!existing) { reply.code(404); return { error: "rule not found" }; }
    // Re-validate whenever kind OR pattern is touched (the effective pair is
    // what the matcher compiles), using the merged values.
    const effectiveKind = body.kind ?? existing.kind;
    const effectivePattern = body.pattern ?? existing.pattern;
    if (body.kind !== undefined || body.pattern !== undefined) {
      const v = validateAutomodPattern(effectiveKind, effectivePattern);
      if (!v.ok) { reply.code(400); return { error: v.reason ?? "invalid pattern" }; }
    }
    const update: Partial<typeof automodRules.$inferInsert> = { updatedAt: new Date() };
    if (body.enabled !== undefined) update.enabled = body.enabled;
    if (body.kind !== undefined) update.kind = body.kind;
    if (body.pattern !== undefined) update.pattern = body.pattern;
    if (body.action !== undefined) update.action = body.action;
    if (body.muteMs !== undefined) update.muteMs = body.muteMs;
    if (body.scope !== undefined) update.scope = body.scope;
    if (body.caseInsensitive !== undefined) update.caseInsensitive = body.caseInsensitive;
    if (body.wholeWord !== undefined) update.wholeWord = body.wholeWord;
    if (body.note !== undefined) update.note = body.note;
    await db.update(automodRules).set(update).where(eq(automodRules.id, id));
    invalidateAutomodCache();
    await recordAudit(db, {
      actorUserId: sessionUser.id,
      action: "automod",
      reason: "updated automod rule",
      metadata: { ruleId: id, op: "update", keys: Object.keys(body) },
    });
    const updated = (await db.select().from(automodRules).where(eq(automodRules.id, id)).limit(1))[0]!;
    return { rule: automodRowToWire(updated) };
  });

  app.delete<{ Params: { id: string } }>("/admin/automod/rules/:id", async (req, reply) => {
    if (!(await requirePermission(req, reply, "edit_site_settings"))) return;
    const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
    const id = req.params.id;
    const existing = (await db
      .select()
      .from(automodRules)
      .where(and(eq(automodRules.id, id), sql`${automodRules.serverId} IS NULL`))
      .limit(1))[0];
    if (!existing) { reply.code(404); return { error: "rule not found" }; }
    await db.delete(automodRules).where(eq(automodRules.id, id));
    invalidateAutomodCache();
    await recordAudit(db, {
      actorUserId: sessionUser.id,
      action: "automod",
      reason: "deleted automod rule",
      metadata: { ruleId: id, op: "delete" },
    });
    return { ok: true };
  });

  /* ---------- auto-moderation test box ----------
   * Paste sample text; get back which currently-enabled site-wide rules would
   * fire (and the resolved action) on each surface. Read-only, no persistence.
   * Lets an admin blunt false positives before turning the feature on. */
  const automodTestBody = z.object({
    text: z.string().max(50_000),
    surface: z.enum(["chat", "forum"]).default("chat"),
  });

  app.post<{ Body: unknown }>("/admin/automod/test", async (req, reply) => {
    if (!(await requirePermission(req, reply, "edit_site_settings"))) return;
    let body: z.infer<typeof automodTestBody>;
    try { body = automodTestBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    // Reuse the EXACT dispatch matcher + compiled cache so the test mirrors
    // production behavior 1:1 (same ruleset epoch, same precedence).
    const ruleset = await getCompiledRuleset(db);
    const verdict = applyFilters(body.text, ruleset, body.surface);
    return {
      action: verdict.action,
      muteMs: verdict.muteMs,
      hits: verdict.hits.map((h) => ({
        ruleId: h.ruleId,
        kind: h.kind,
        action: h.action,
        label: h.label,
      })),
    };
  });

  /* ---------- logo upload ----------
   * Admins paste an image's base64 data URL ("data:image/png;base64,…")
   * via the Branding tab's Upload button; the server validates the
   * magic bytes against a small image allow-list, writes the file
   * under /uploads/logos/<sha>.<ext>, and persists the served path
   * onto `site_settings.logo_url`. Content-hash filenames make the
   * 1-year immutable cache (set on the /uploads static route) safe
   * even when admins replace the logo, the URL changes.
   *
   * Plain JSON body (no multipart plugin) keeps the dep surface small;
   * 8MB cap is plenty for any reasonable logo and well under the
   * `bodyLimit` we'd hit at the Fastify level. */
  const uploadLogoBody = z.object({
    /** Data URL, e.g. `data:image/png;base64,iVBORw0K...`. */
    dataUrl: z.string().min(32).max(8 * 1024 * 1024),
  });

  // Image signatures we accept. Keep this short on purpose, any new
  // entry has to round-trip through DOMPurify-safe rendering and the
  // CSP image-src allow-list. Each entry maps to the file extension
  // we write so the browser content-type sniff matches the blob.
  const ACCEPTED_IMAGE_PREFIXES: Array<{ mime: string; ext: string; magic: Uint8Array }> = [
    { mime: "image/png", ext: "png", magic: Uint8Array.of(0x89, 0x50, 0x4e, 0x47) },
    { mime: "image/jpeg", ext: "jpg", magic: Uint8Array.of(0xff, 0xd8, 0xff) },
    { mime: "image/webp", ext: "webp", magic: Uint8Array.of(0x52, 0x49, 0x46, 0x46) },
    { mime: "image/gif", ext: "gif", magic: Uint8Array.of(0x47, 0x49, 0x46, 0x38) },
  ];

  function detectImage(bytes: Uint8Array): { ext: string; mime: string } | null {
    for (const sig of ACCEPTED_IMAGE_PREFIXES) {
      if (bytes.length < sig.magic.length) continue;
      let match = true;
      for (let i = 0; i < sig.magic.length; i++) {
        if (bytes[i] !== sig.magic[i]) { match = false; break; }
      }
      if (match) return { ext: sig.ext, mime: sig.mime };
    }
    return null;
  }

  app.post<{ Body: unknown }>("/admin/upload/logo", async (req, reply) => {
    // Branding upload, gated on the granular `upload_logo` key
    // (masteradmin-default but matrix-grantable, same pattern as
    // `edit_site_settings`).
    if (!(await requirePermission(req, reply, "upload_logo"))) return;
    let body: z.infer<typeof uploadLogoBody>;
    try { body = uploadLogoBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(body.dataUrl.trim());
    if (!m) { reply.code(400); return { error: "expected a base64 data URL" }; }
    let bytes: Buffer;
    try { bytes = Buffer.from(m[2]!, "base64"); }
    catch { reply.code(400); return { error: "invalid base64 payload" }; }
    const detected = detectImage(bytes);
    if (!detected) {
      reply.code(415);
      return { error: "unsupported image type (png, jpg, webp, gif only)" };
    }
    // Content-hash filename so a re-upload of the same bytes deduplicates
    // and a different image necessarily produces a different URL. The
    // hex hash is collision-resistant for our scale; we slice to 16
    // chars to keep the URL short without sacrificing uniqueness.
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const filename = `${hash}.${detected.ext}`;
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = join(uploadsRoot, "logos");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), bytes);
    const url = `/uploads/logos/${filename}`;
    const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
    const result = await updateSettings(db, { logoUrl: url }, sessionUser.id);
    await recordAudit(db, {
      actorUserId: sessionUser.id,
      action: "logo_upload",
      metadata: { url, bytes: bytes.length, mime: detected.mime },
    });
    return { ok: true, url, settings: result };
  });

  /* ---------- custom commands ---------- */
  const customCommandBody = z.object({
    name: z.string().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/i, "command name must start with a letter"),
    kind: z.enum(["action", "say"]),
    template: z.string().min(1).max(2000),
    description: z.string().max(200).optional(),
    aliases: z.array(z.string().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/i)).max(20).optional(),
    enabled: z.boolean().optional(),
    /**
     * Pass null to clear; pass a hex like `#990000` to fix a literal
     * color; or pass `theme:<slot>` (slot ∈ system / action / accent /
     * muted / text) to follow the viewer's theme palette. Theme tokens
     * mean an "alert" command keeps the right visual identity for
     * every reader regardless of which palette they've chosen.
     */
    color: z
      .string()
      .regex(COLOR_TOKEN_OR_HEX_RE, "color must be a 6-digit hex like #990000 or a theme:<slot> token")
      .nullable()
      .optional(),
    /** Opt this command into mid-message `!name` expansion. Defaults to
     *  false on insert; existing rows untouched by the migration are
     *  also false so we never silently expose a command to a new
     *  trigger surface. */
    allowInline: z.boolean().optional(),
    /** Optional alternate template for the inline path. Null clears
     *  back to the fallback (use `template`). Same length cap as the
     *  main template, both end up rendered through the same engine. */
    inlineTemplate: z.string().max(2000).nullable().optional(),
    /** Optional CSS declaration list applied to the rendered body. Stored
     *  as raw text (e.g. `font-weight: bold; color: #4a8;`) and validated
     *  on save against {@link sanitizeCustomCmdCss}, any property not in
     *  the typography/color allow-list, or any value that doesn't match
     *  the per-property regex, is dropped before persistence. Pass null
     *  to clear. */
    css: z
      .string()
      .max(CUSTOM_CMD_CSS_MAX_LEN)
      .nullable()
      .optional(),
  });

  app.get("/admin/custom-commands", async (req, reply) => {
    if (!(await requirePermission(req, reply, "view_admin_custom_commands"))) return;
    const cmds = await db.select().from(customCommands).orderBy(asc(customCommands.name));
    const aliases = await db.select().from(customCommandAliases);
    const aliasesByCmd = new Map<string, string[]>();
    for (const a of aliases) {
      const list = aliasesByCmd.get(a.commandId) ?? [];
      list.push(a.alias);
      aliasesByCmd.set(a.commandId, list);
    }
    return {
      commands: cmds.map((c) => ({ ...c, aliases: aliasesByCmd.get(c.id) ?? [] })),
    };
  });

  app.post<{ Body: unknown }>("/admin/custom-commands", async (req, reply) => {
    if (!(await requirePermission(req, reply, "manage_custom_commands"))) return;
    const body = customCommandBody.parse(req.body);
    const conflict = registry.resolve(body.name);
    if (conflict) {
      reply.code(409);
      return { error: "name conflicts with an existing command", existing: conflict.name };
    }
    for (const a of body.aliases ?? []) {
      if (registry.resolve(a)) {
        reply.code(409);
        return { error: `alias "${a}" conflicts with an existing command` };
      }
    }
    const id = nanoid();
    const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
    // CSS gets sanitized here on write, any property not in the allow-
    // list (or any value that fails its per-property regex) is dropped,
    // so the persisted value is always already safe to feed straight
    // back to the renderer.
    const safeCss = body.css == null ? body.css : sanitizeCustomCmdCss(body.css) || null;
    await db.insert(customCommands).values({
      id,
      name: body.name.toLowerCase(),
      kind: body.kind,
      template: body.template,
      description: body.description ?? null,
      enabled: body.enabled ?? true,
      color: body.color ?? null,
      allowInline: body.allowInline ?? false,
      inlineTemplate: body.inlineTemplate ?? null,
      css: safeCss ?? null,
      createdById: sessionUser.id,
    });
    if (body.aliases?.length) {
      await db.insert(customCommandAliases).values(
        body.aliases.map((a) => ({ alias: a.toLowerCase(), commandId: id })),
      );
    }
    await registry.reloadCustom(db);
    // Hot-reload every connected client's autocomplete + help cache,
    // otherwise a brand-new command stays invisible until each user
    // refreshes their tab.
    io.emit("commands:updated");
    await recordAudit(db, {
      actorUserId: sessionUser.id,
      action: "custom_command_create",
      metadata: { id, name: body.name.toLowerCase(), kind: body.kind },
    });
    return { id };
  });

  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/admin/custom-commands/:id",
    async (req, reply) => {
      if (!(await requirePermission(req, reply, "manage_custom_commands"))) return;
      const body = customCommandBody.partial().parse(req.body);
      const existing = (await db
        .select()
        .from(customCommands)
        .where(eq(customCommands.id, req.params.id))
        .limit(1))[0];
      if (!existing) {
        reply.code(404);
        return { error: "not found" };
      }
      if (body.name !== undefined) {
        const nextName = body.name.toLowerCase();
        if (nextName !== existing.name) {
          const conflict = registry.resolve(nextName);
          if (conflict && conflict.name !== existing.name) {
            reply.code(409);
            return { error: "name conflicts with an existing command", existing: conflict.name };
          }
        }
      }
      if (body.aliases !== undefined) {
        for (const a of body.aliases) {
          const conflict = registry.resolve(a);
          if (conflict && conflict.name !== existing.name) {
            reply.code(409);
            return { error: `alias "${a}" conflicts with an existing command` };
          }
        }
      }
      await db
        .update(customCommands)
        .set({
          ...(body.name !== undefined ? { name: body.name.toLowerCase() } : {}),
          ...(body.kind !== undefined ? { kind: body.kind } : {}),
          ...(body.template !== undefined ? { template: body.template } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.color !== undefined ? { color: body.color } : {}),
          ...(body.allowInline !== undefined ? { allowInline: body.allowInline } : {}),
          ...(body.inlineTemplate !== undefined ? { inlineTemplate: body.inlineTemplate } : {}),
          ...(body.css !== undefined
            ? { css: body.css == null ? null : sanitizeCustomCmdCss(body.css) || null }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(customCommands.id, req.params.id));

      if (body.aliases !== undefined) {
        await db.delete(customCommandAliases).where(eq(customCommandAliases.commandId, req.params.id));
        if (body.aliases.length) {
          await db.insert(customCommandAliases).values(
            body.aliases.map((a) => ({ alias: a.toLowerCase(), commandId: req.params.id })),
          );
        }
      }
      await registry.reloadCustom(db);
      io.emit("commands:updated");
      const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
      await recordAudit(db, {
        actorUserId: sessionUser.id,
        action: "custom_command_update",
        metadata: { id: req.params.id, keys: Object.keys(body) },
      });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>("/admin/custom-commands/:id", async (req, reply) => {
    if (!(await requirePermission(req, reply, "manage_custom_commands"))) return;
    const existing = (await db.select().from(customCommands).where(eq(customCommands.id, req.params.id)).limit(1))[0];
    await db.delete(customCommands).where(eq(customCommands.id, req.params.id));
    await registry.reloadCustom(db);
    io.emit("commands:updated");
    const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
    await recordAudit(db, {
      actorUserId: sessionUser.id,
      action: "custom_command_delete",
      metadata: { id: req.params.id, ...(existing ? { name: existing.name } : {}) },
    });
    return { ok: true };
  });

  /* ---------- builtin command config (social-game tuning) ----------
   * Per-command admin overrides for the built-in social games.
   * Each entry in the static `BUILTIN_COMMAND_CATALOG` exposes a
   * code-default duration and a description shown in the admin
   * panel; the live `builtin_command_config` row (if any) carries
   * the admin's chosen reward + duration. Game modules read merged
   * values via `getBuiltinCommandConfig` at game-start.
   *
   * Authorization: shares the `manage_custom_commands` key with
   * the custom-command CRUD endpoints, both surfaces live in the
   * same admin Commands tab and an admin who can manage one should
   * be able to manage the other. Read uses
   * `view_admin_custom_commands` for the same reason.
   */
  interface BuiltinCommandCatalogEntry {
    name: string;
    label: string;
    description: string;
    /** Code default for the duration (ms). Shown as the placeholder
     *  in the admin UI; admins who leave the field blank get this. */
    defaultDurationMs: number;
    /** Friendly duration label so admins pick a value that matches
     *  the game's window (e.g. "round window" for RPS, "claim
     *  window" for raffles). */
    durationLabel: string;
    /** Some commands (raffles) deliberately ignore the reward
     *  fields, their prize IS the host's stake. Set to false to
     *  hide the reward inputs in the admin UI. */
    supportsReward: boolean;
    /** Out-of-the-box reward when no admin row exists yet. Surfaced
     *  to the admin UI as placeholder values so admins can see what
     *  users currently earn even before they touch the panel. The
     *  moment an admin saves the row, their values (including
     *  explicit zeros) take precedence over these defaults. */
    defaultRewardXp: number;
    defaultRewardCurrency: number;
  }
  const BUILTIN_COMMAND_CATALOG: ReadonlyArray<BuiltinCommandCatalogEntry> = [
    {
      name: "rps",
      label: "Rock-paper-scissors",
      description: "30-second round in the current room. Every winner of the round mints the reward in full. Leave fields blank to use the ship default reward.",
      defaultDurationMs: 30_000,
      durationLabel: "Round window",
      supportsReward: true,
      defaultRewardXp: 8,
      defaultRewardCurrency: 3,
    },
    {
      name: "trivia",
      label: "Trivia",
      description: "60-second trivia round. The first /answer that matches the host's hidden answer wins. Leave fields blank to use the ship default reward.",
      defaultDurationMs: 60_000,
      durationLabel: "Round window",
      supportsReward: true,
      defaultRewardXp: 12,
      defaultRewardCurrency: 5,
    },
    {
      name: "storydice",
      label: "Story Dice",
      description: "3-minute round. Server picks four prompt words; players /storydice <text> to submit. Room votes the winner. Leave fields blank to use the ship default reward.",
      defaultDurationMs: 180_000,
      durationLabel: "Submission window",
      supportsReward: true,
      defaultRewardXp: 20,
      defaultRewardCurrency: 10,
    },
    {
      name: "scramble",
      label: "Word Scramble",
      description: "Multi-round word-find game. The duration setting is PER ROUND (default 60s); host picks 1–5 rounds at start. Winner's reward is scaled by their accumulated points via the round-game multiplier (XP / Currency only; items unscaled). Leave fields blank to use the ship default reward.",
      defaultDurationMs: 60_000,
      durationLabel: "Per-round window",
      supportsReward: true,
      defaultRewardXp: 10,
      defaultRewardCurrency: 4,
    },
    {
      name: "duel",
      label: "Duel",
      description: "Class-based 1v1 turn combat. The window setting controls how long opponents have to accept the challenge. Reward is scaled by damage dealt / damage taken; the loser also earns XP at 0.25× their own performance (no currency or items). Leave fields blank to use the ship default reward.",
      defaultDurationMs: 60_000,
      durationLabel: "Challenge accept window",
      supportsReward: true,
      defaultRewardXp: 15,
      defaultRewardCurrency: 5,
    },
    {
      name: "raffle",
      label: "Room raffle",
      description: "60-second item / Currency raffle in the host's room. Reward fields are ignored, the prize IS the host's stake.",
      defaultDurationMs: 60_000,
      durationLabel: "Claim window",
      supportsReward: false,
      defaultRewardXp: 0,
      defaultRewardCurrency: 0,
    },
    {
      name: "announceraffle",
      label: "Sitewide raffle",
      description: "3-minute admin-only sitewide raffle. Reward fields are ignored, the prize IS the host's stake.",
      defaultDurationMs: 180_000,
      durationLabel: "Claim window",
      supportsReward: false,
      defaultRewardXp: 0,
      defaultRewardCurrency: 0,
    },
  ];
  const configurableCommandNames = new Set(BUILTIN_COMMAND_CATALOG.map((c) => c.name));

  app.get("/admin/builtin-commands", async (req, reply) => {
    if (!(await requirePermission(req, reply, "view_admin_custom_commands"))) return;
    const rows = await db.select().from(builtinCommandConfig);
    const rowByName = new Map(rows.map((r) => [r.commandName, r]));
    return {
      commands: BUILTIN_COMMAND_CATALOG.map((entry) => {
        const row = rowByName.get(entry.name);
        return {
          name: entry.name,
          label: entry.label,
          description: entry.description,
          defaultDurationMs: entry.defaultDurationMs,
          durationLabel: entry.durationLabel,
          supportsReward: entry.supportsReward,
          defaultRewardXp: entry.defaultRewardXp,
          defaultRewardCurrency: entry.defaultRewardCurrency,
          // Whether the admin has saved any config for this command.
          // The UI uses this to decide between rendering the ACTUAL
          // values (admin-set, possibly explicit zeros) vs the
          // SHIP DEFAULTS as placeholders, so an admin who hasn't
          // touched the panel sees what users are actually earning.
          hasAdminConfig: !!row,
          rewardXp: row?.rewardXp ?? 0,
          rewardCurrency: row?.rewardCurrency ?? 0,
          rewardItemKey: row?.rewardItemKey ?? null,
          rewardItemCount: row?.rewardItemCount ?? 0,
          durationMs: row?.durationMs ?? null,
          updatedAt: row?.updatedAt ? +row.updatedAt : null,
        };
      }),
    };
  });

  const builtinCommandPatchBody = z.object({
    rewardXp: z.number().int().min(0).max(1_000_000).optional(),
    rewardCurrency: z.number().int().min(0).max(1_000_000).optional(),
    /** Null clears the item; empty string is treated like null. Any
     *  non-null string is verified against the items catalog. */
    rewardItemKey: z.string().nullable().optional(),
    rewardItemCount: z.number().int().min(0).max(1000).optional(),
    /** Null clears the override → game uses the code default. */
    durationMs: z.number().int().min(1000).max(30 * 60_000).nullable().optional(),
  }).strict();

  app.put<{ Params: { name: string }; Body: unknown }>(
    "/admin/builtin-commands/:name",
    async (req, reply) => {
      if (!(await requirePermission(req, reply, "manage_custom_commands"))) return;
      const me = await getSessionUser(req);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const name = req.params.name.toLowerCase();
      if (!configurableCommandNames.has(name)) {
        reply.code(404); return { error: "not a configurable built-in command" };
      }
      const body = builtinCommandPatchBody.parse(req.body);

      // Item-key validation: when the admin sets a non-null key,
      // verify the item actually exists. Empty string normalizes to
      // null (matches the "clear" semantics).
      let normalizedItemKey: string | null | undefined = body.rewardItemKey;
      if (typeof normalizedItemKey === "string") {
        const trimmed = normalizedItemKey.trim();
        if (!trimmed) {
          normalizedItemKey = null;
        } else {
          const itemRow = (await db.select().from(itemsTable).where(eq(itemsTable.key, trimmed)).limit(1))[0];
          if (!itemRow) {
            reply.code(400);
            return { error: `unknown item key "${trimmed}"` };
          }
          normalizedItemKey = trimmed;
        }
      }

      // Upsert. We don't trust the partial body to carry every
      // field, so we merge with the existing row.
      const existing = (await db
        .select()
        .from(builtinCommandConfig)
        .where(eq(builtinCommandConfig.commandName, name))
        .limit(1))[0];
      const merged = {
        commandName: name,
        rewardXp: body.rewardXp ?? existing?.rewardXp ?? 0,
        rewardCurrency: body.rewardCurrency ?? existing?.rewardCurrency ?? 0,
        rewardItemKey: normalizedItemKey !== undefined ? normalizedItemKey : (existing?.rewardItemKey ?? null),
        rewardItemCount: body.rewardItemCount ?? existing?.rewardItemCount ?? 0,
        durationMs: body.durationMs !== undefined ? body.durationMs : (existing?.durationMs ?? null),
        updatedAt: new Date(),
        updatedByUserId: me.id,
      };
      if (existing) {
        await db.update(builtinCommandConfig).set(merged).where(eq(builtinCommandConfig.commandName, name));
      } else {
        await db.insert(builtinCommandConfig).values(merged);
      }
      await recordAudit(db, {
        actorUserId: me.id,
        action: "builtin_command_config_update",
        metadata: { name, ...merged, updatedAt: undefined, updatedByUserId: undefined },
      });
      return { ok: true };
    },
  );

  /* ---------- title kinds (mutual-title catalog) ----------
   * CRUD over the title_kinds table. Slug is the user-facing keyword for
   * /request <slug> <user>; format strings use {target} as the substitution
   * point for the other party's display name. Deleting a kind cascades to
   * any in-flight or accepted titles of that kind, so we surface a count
   * in the GET response so admins can preview the impact.
   */
  app.get("/admin/title-kinds", async (req, reply) => {
    if (!(await requirePermission(req, reply, "view_admin_title_kinds"))) return;
    const kinds = await db.select().from(titleKinds).orderBy(asc(titleKinds.slug));
    const counts = await db
      .select({ kindId: mutualTitles.kindId, n: sql<number>`count(*)` })
      .from(mutualTitles)
      .groupBy(mutualTitles.kindId);
    const byId = new Map(counts.map((r) => [r.kindId, r.n]));
    return {
      kinds: kinds.map((k) => ({
        id: k.id,
        slug: k.slug,
        label: k.label,
        symmetric: k.symmetric,
        formatA: k.formatA,
        formatB: k.formatB,
        exclusive: k.exclusive,
        enabled: k.enabled,
        usageCount: byId.get(k.id) ?? 0,
        updatedAt: +k.updatedAt,
      })),
    };
  });

  // Slug rule: lowercase letters, digits, hyphen, underscore. Matches the
  // shape used in slash-command keywords elsewhere in the app.
  const SLUG_RX = /^[a-z0-9_-]{1,32}$/;
  const titleKindBody = z.object({
    slug: z.string().min(1).max(32).regex(SLUG_RX, "slug must be lowercase a-z/0-9/_/- only"),
    label: z.string().min(1).max(80),
    symmetric: z.boolean(),
    formatA: z.string().min(1).max(120),
    formatB: z.string().min(1).max(120),
    exclusive: z.boolean(),
    enabled: z.boolean(),
  });

  app.post<{ Body: unknown }>("/admin/title-kinds", async (req, reply) => {
    if (!(await requirePermission(req, reply, "manage_title_kinds"))) return;
    const parsed = titleKindBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid", details: parsed.error.flatten() };
    }
    const { slug, label, symmetric, formatA, formatB, exclusive, enabled } = parsed.data;
    const dup = (await db
      .select({ id: titleKinds.id })
      .from(titleKinds)
      .where(sql`lower(${titleKinds.slug}) = ${slug.toLowerCase()}`)
      .limit(1))[0];
    if (dup) {
      reply.code(409);
      return { error: "slug already exists" };
    }
    const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
    const id = nanoid();
    await db.insert(titleKinds).values({
      id,
      slug,
      label,
      symmetric,
      // For symmetric kinds we still store both columns so the listTitles
      // query doesn't need to special-case; we just write formatA into both.
      formatA,
      formatB: symmetric ? formatA : formatB,
      exclusive,
      enabled,
      createdById: sessionUser.id,
    });
    return { ok: true, id };
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/admin/title-kinds/:id", async (req, reply) => {
    if (!(await requirePermission(req, reply, "manage_title_kinds"))) return;
    const parsed = titleKindBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid", details: parsed.error.flatten() };
    }
    const { slug, label, symmetric, formatA, formatB, exclusive, enabled } = parsed.data;
    const existing = (await db.select().from(titleKinds).where(eq(titleKinds.id, req.params.id)).limit(1))[0];
    if (!existing) {
      reply.code(404);
      return { error: "not found" };
    }
    // Slug uniqueness check excluding this row.
    if (slug.toLowerCase() !== existing.slug.toLowerCase()) {
      const dup = (await db
        .select({ id: titleKinds.id })
        .from(titleKinds)
        .where(sql`lower(${titleKinds.slug}) = ${slug.toLowerCase()}`)
        .limit(1))[0];
      if (dup) {
        reply.code(409);
        return { error: "slug already exists" };
      }
    }
    await db
      .update(titleKinds)
      .set({
        slug,
        label,
        symmetric,
        formatA,
        formatB: symmetric ? formatA : formatB,
        exclusive,
        enabled,
        updatedAt: new Date(),
      })
      .where(eq(titleKinds.id, req.params.id));
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/admin/title-kinds/:id", async (req, reply) => {
    if (!(await requirePermission(req, reply, "manage_title_kinds"))) return;
    // Cascade by FK: deletes all mutual_titles rows of this kind too.
    await db.delete(titleKinds).where(eq(titleKinds.id, req.params.id));
    return { ok: true };
  });

  /* ---------- audit log ---------- */
  /**
   * Hydrated audit feed. Resolves actor + target user/room display names so
   * the panel renders legibly without N+1 client requests. Optional filters:
   *
   *   ?action=ban             → exact match on a single action
   *   ?actions=ban,kick,mute  → comma-separated multi-action filter. Used by
   *                             the AuditTab's category-preset dropdown to
   *                             scope the feed to e.g. "Permission changes"
   *                             (which spans four distinct action values).
   *   ?actor=<userId>         → by actor
   *   ?target=<userId>        → by target user
   *   ?room=<roomId>          → by target room
   *   ?limit=200              → cap rows (default 200, max 500)
   */
  app.get<{ Querystring: Record<string, string | undefined> }>("/admin/audit", async (req, reply) => {
    // Single key now, `view_admin_audit` covers BOTH the panel tab
    // visibility AND the data-fetch gate. The previous split between
    // `view_audit_log` and `view_admin_audit` caused a mismatch: mod
    // saw the tab but got 403 on the data fetch. Migration 0182
    // dropped `view_audit_log` from the catalog.
    if (!(await requirePermission(req, reply, "view_admin_audit"))) return;
    const limit = Math.min(500, parseInt(req.query.limit ?? "200", 10) || 200);
    // The GLOBAL Audit feed is platform-owned rows only. Server-scoped
    // moderation (stamped via `auditServerAction`) lands in the owning
    // server's per-server Mod Log and is excluded here. Every legacy and
    // platform row has `server_id` NULL, so this is a no-op against today's
    // data — the feed shows exactly the same rows until a server-scoped write
    // actually happens (flag-off path unchanged).
    const conditions = [globalAuditScopeWhere()] as ReturnType<typeof eq>[];
    if (req.query.action) conditions.push(eq(auditLog.action, req.query.action));
    if (req.query.actions) {
      // Split + trim + filter empty. Cap at 40 entries so a runaway query
      // string can't blow the IN list; the largest legitimate preset
      // (role_changes) currently lists ~9 actions.
      const actions = req.query.actions
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .slice(0, 40);
      if (actions.length > 0) {
        conditions.push(inArray(auditLog.action, actions) as ReturnType<typeof eq>);
      }
    }
    if (req.query.actor) conditions.push(eq(auditLog.actorUserId, req.query.actor));
    if (req.query.target) conditions.push(eq(auditLog.targetUserId, req.query.target));
    if (req.query.room) conditions.push(eq(auditLog.targetRoomId, req.query.room));

    const rows = conditions.length === 0
      ? await db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(limit)
      : await db.select().from(auditLog).where(and(...conditions)).orderBy(desc(auditLog.createdAt)).limit(limit);

    if (rows.length === 0) return { entries: [] };

    // Hydrate referenced users/rooms in a single batched fetch.
    const userIds = new Set<string>();
    const roomIds = new Set<string>();
    for (const r of rows) {
      userIds.add(r.actorUserId);
      if (r.targetUserId) userIds.add(r.targetUserId);
      if (r.targetRoomId) roomIds.add(r.targetRoomId);
    }
    const [userRows, roomRows] = await Promise.all([
      userIds.size > 0
        ? db.select().from(users).where(sql`${users.id} IN (${sql.join([...userIds].map((u) => sql`${u}`), sql`, `)})`)
        : Promise.resolve([] as { id: string; username: string }[]),
      roomIds.size > 0
        ? db.select().from(rooms).where(sql`${rooms.id} IN (${sql.join([...roomIds].map((r) => sql`${r}`), sql`, `)})`)
        : Promise.resolve([] as { id: string; name: string }[]),
    ]);
    const userById = new Map(userRows.map((u) => [u.id, u]));
    const roomById = new Map(roomRows.map((r) => [r.id, r]));

    const entries: AuditEntry[] = rows.map((r) => {
      const actor = userById.get(r.actorUserId);
      const target = r.targetUserId ? userById.get(r.targetUserId) : null;
      const room = r.targetRoomId ? roomById.get(r.targetRoomId) : null;
      let metadata: Record<string, unknown> | null = null;
      if (r.metadataJson) {
        try { metadata = JSON.parse(r.metadataJson) as Record<string, unknown>; }
        catch { metadata = null; }
      }
      return {
        id: r.id,
        actorUserId: r.actorUserId,
        actorDisplayName: actor?.username ?? "(deleted user)",
        action: r.action as AuditEntry["action"],
        targetUserId: r.targetUserId,
        targetDisplayName: target?.username ?? null,
        targetRoomId: r.targetRoomId,
        targetRoomName: room?.name ?? null,
        targetMessageId: r.targetMessageId,
        reason: r.reason,
        metadata,
        createdAt: +r.createdAt,
      };
    });
    return { entries };
  });
}
