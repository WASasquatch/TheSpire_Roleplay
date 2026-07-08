/**
 * Servers — the multi-server registry routes (plan §4/§6, Phase 4). The
 * deliberate 1:1 mirror of `routes/forums.ts`, scoped to the OUTER container:
 *
 *   GET    /servers                       catalog rail (ServerSummary[])
 *   GET    /servers/slug-availability     live create-form check
 *   GET    /servers/:id                   detail + viewer state
 *   POST   /servers/applications          "register your server" (global key)
 *   GET    /servers/applications/mine     applicant's own history
 *   POST   /servers/:id/join | leave | visit
 *   POST   /servers/:id/membership-applications  + owner/mod review
 *   PATCH  /servers/:id                   owner console: appearance
 *   members list + role/permission updates, usergroups CRUD, bans CRUD,
 *   GET /servers/:id/mod-log, POST /servers/:id/transfer
 *
 * HARD RULE — flag-off is byte-identical to today: EVERY handler below first
 * checks `areServersEnabled(getSettings(db))` and 404s when off, so with the
 * feature disabled these routes behave exactly like a feature that was never
 * registered. Per-server gating goes through `serverAuthority`/`serverCan`;
 * the four PLATFORM keys (apply_create_server etc.) go through `hasPermission`.
 *
 * The admin review-queue + cross-server oversight routes live in
 * `admin/servers.ts` (registered alongside this from index.ts).
 */
import type { FastifyInstance } from "fastify";
import type { Server as IoServer } from "socket.io";
import { createHash } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClientToServerEvents, ServerPermission, ServerToClientEvents } from "@thekeep/shared";
import type { Db } from "../db/index.js";
import { getSessionUser } from "./auth.js";
import { serverAuthority, serverCan } from "../servers/authority.js";
import { resolveIdentityArg } from "../commands/identityArg.js";
import { getSettings, areServersEnabled } from "../settings.js";
import type { CommandRegistry } from "../commands/registry.js";
// Per-server admin surfaces (Admin Partition - plan_ext.md). Each is a
// self-contained, self-gated module registered below.
import { registerServerReportRoutes } from "../servers/reports.js";
import { registerServerModCaseRoutes } from "../servers/modCases.js";
import { registerServerEmoticonRoutes } from "../servers/emoticons.js";
import { registerServerAnnouncementRoutes } from "../servers/announcements.js";
import { registerServerFaqRoutes } from "../servers/faqs.js";
import { registerServerCommandTitleRoutes } from "../servers/commandsTitles.js";
import { registerServerEarningRoutes } from "../servers/earning.js";
import { registerServerEventRoutes } from "../servers/events.js";
// Member-facing self-roles + onboarding (Batch 2). Self-gated on serversEnabled
// + canParticipate; mounted alongside the manager usergroup routes below.
import { registerSelfRolesRoutes } from "../servers/selfRoles.js";
// Route groups extracted from this file (move-only split). registerServerRoutes
// builds the shared ServerRoutesCtx below and hands it to each sub-registrar.
import type { ServerRoutesCtx } from "./serversShared.js";
import { registerServerCatalogRoutes } from "./serversCatalog.js";
import { registerServerMembershipRoutes } from "./serversMembership.js";
import { registerServerConsoleRoutes } from "./serversConsole.js";
import { registerServerModerationRoutes } from "./serversModeration.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/* ----- Server identity images (icon / banner). Mirrors the forum image
 *  pipeline (routes/forums.ts): base64 data URL in, magic-byte sniffed,
 *  content-hashed, served from /uploads/servers/. Kept server-local because
 *  the forum helpers are private closures over the forums dir. ----- */
const SERVER_IMAGE_TYPES: Array<{ mime: string; ext: string; magic: number[] }> = [
  { mime: "image/png", ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  { mime: "image/webp", ext: "webp", magic: [0x52, 0x49, 0x46, 0x46] },
  { mime: "image/gif", ext: "gif", magic: [0x47, 0x49, 0x46, 0x38] },
];

function decodeServerDataUrl(dataUrl: string, maxBytes: number): Buffer | { error: string } {
  const m = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(dataUrl.trim());
  if (!m) return { error: "expected a base64 image data URL" };
  let bytes: Buffer;
  try { bytes = Buffer.from(m[1]!, "base64"); }
  catch { return { error: "bad base64 payload" }; }
  if (bytes.length === 0) return { error: "empty image" };
  if (bytes.length > maxBytes) return { error: `image too large (max ${Math.round(maxBytes / 1024)}KB)` };
  return bytes;
}

function sniffServerImage(bytes: Buffer): { mime: string; ext: string } | null {
  for (const t of SERVER_IMAGE_TYPES) {
    if (bytes.length >= t.magic.length && t.magic.every((b, i) => bytes[i] === b)) return t;
  }
  return null;
}

export async function registerServerRoutes(app: FastifyInstance, db: Db, io: Io, uploadsRoot: string, registry: CommandRegistry): Promise<void> {
  // Per-server admin surfaces (Admin Partition — plan_ext.md §7). Self-contained
  // modules, each gated on its own SERVER_MOD_PERMISSION via serverAuthority.
  await registerServerReportRoutes(app, db, io);
  await registerServerModCaseRoutes(app, db, io);
  await registerServerEmoticonRoutes(app, db, io, uploadsRoot);
  await registerServerAnnouncementRoutes(app, db, io);
  await registerServerFaqRoutes(app, db, io);
  await registerServerCommandTitleRoutes(app, db, io, registry);
  await registerServerEarningRoutes(app, db, io, uploadsRoot);
  await registerServerEventRoutes(app, db, io);
  // Member-facing self-roles + onboarding (Batch 2). Takes (app, db) only —
  // no io. Gated on canParticipate + the servers flag inside the module.
  await registerSelfRolesRoutes(app, db);

  const serversImgDir = join(uploadsRoot, "servers");

  /** Write a content-hashed server image; returns its public URL. */
  async function writeServerImage(
    prefix: string,
    dataUrl: string,
    maxBytes: number,
  ): Promise<{ url: string } | { error: string; status: number }> {
    const decoded = decodeServerDataUrl(dataUrl, maxBytes);
    if ("error" in decoded) return { error: decoded.error, status: 400 };
    const detected = sniffServerImage(decoded);
    if (!detected) return { error: "unsupported image type (png, jpg, webp, gif only)", status: 415 };
    const hash = createHash("sha256").update(decoded).digest("hex").slice(0, 16);
    const filename = `${prefix}-${hash}.${detected.ext}`;
    await mkdir(serversImgDir, { recursive: true });
    await writeFile(join(serversImgDir, filename), decoded);
    return { url: `/uploads/servers/${filename}` };
  }

  /** Best-effort removal of a replaced /uploads/servers/ file. */
  function unlinkServerImage(url: string | null | undefined): void {
    if (!url?.startsWith("/uploads/servers/")) return;
    const filename = url.slice("/uploads/servers/".length);
    if (filename) unlink(join(serversImgDir, filename)).catch(() => { /* best-effort */ });
  }

  /** Single gate the top of every handler runs: when the feature is off the
   *  route 404s exactly like a disabled feature, keeping flag-off byte-
   *  identical to today. Returns false (and sets the 404) when off. */
  async function serversLive(reply: { code: (c: number) => unknown }): Promise<boolean> {
    if (!areServersEnabled(await getSettings(db))) {
      reply.code(404);
      return false;
    }
    return true;
  }

  /* =========================================================
   *  Owner console gates
   * ========================================================= */

  /** Owner-or-staff gate (server owner, the admin lieutenant, or
   *  manage_any_server staff — i.e. authority.isOwner). */
  async function requireServerOwner(req: Parameters<typeof getSessionUser>[0], serverId: string) {
    const me = await getSessionUser(req, db);
    if (!me) return { fail: { code: 401 as const, error: "auth" } };
    const a = await serverAuthority(db, me, serverId);
    if (!a.server) return { fail: { code: 404 as const, error: "no server" } };
    if (!a.isOwner) return { fail: { code: 403 as const, error: "server owner only" } };
    return { me, server: a.server, authority: a };
  }

  /** Gate for an action a mod CAN be granted: passes for owner/staff (who hold
   *  every key) OR a mod/admin holding the specific granular permission. */
  async function requireServerPermission(
    req: Parameters<typeof getSessionUser>[0],
    serverId: string,
    key: ServerPermission,
  ) {
    const me = await getSessionUser(req, db);
    if (!me) return { fail: { code: 401 as const, error: "auth" } };
    const a = await serverAuthority(db, me, serverId);
    if (!a.server) return { fail: { code: 404 as const, error: "no server" } };
    if (!serverCan(a, key)) return { fail: { code: 403 as const, error: "you don't have that server permission" } };
    return { me, server: a.server, authority: a };
  }

  /** Resolve a mod/ban/group target to a user account (identity tokens + names). */
  async function resolveServerTarget(raw: string): Promise<
    | { ok: true; userId: string; username: string }
    | { ok: false; error: string }
  > {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, error: "Name or @id:/@cid: token required." };
    const res = await resolveIdentityArg(db, trimmed);
    if (res.kind === "none") return { ok: false, error: `No one matches "${trimmed}".` };
    if (res.kind === "ambiguous") {
      return { ok: false, error: `"${trimmed}" matches several identities - paste their @id: token from the profile.` };
    }
    return { ok: true, userId: res.target.userId, username: res.target.masterUsername };
  }

  // Build the shared context once and register each extracted route group.
  const ctx: ServerRoutesCtx = {
    app,
    db,
    io,
    serversLive,
    requireServerOwner,
    requireServerPermission,
    resolveServerTarget,
    writeServerImage,
    unlinkServerImage,
  };
  registerServerCatalogRoutes(ctx);
  registerServerMembershipRoutes(ctx);
  registerServerConsoleRoutes(ctx);
  registerServerModerationRoutes(ctx);
}
