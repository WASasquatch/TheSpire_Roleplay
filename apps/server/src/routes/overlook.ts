/**
 * Overlook routes: the per-room / per-world sketch canvas (migration 0371).
 *
 * Five concerns live here:
 *   1. Resolving a scope (room or world) and deciding read/edit rights. Both
 *      scopes reuse the gate that already governs them, so there is no new
 *      permission key to get out of sync. See `resolveRoomScope` /
 *      `resolveWorldScope`.
 *   2. Lazily creating the canvas row on first read, so nothing has to
 *      provision one when a room or world is created.
 *   3. Saving with optimistic concurrency. A stale `version` is refused with
 *      409 rather than merged; the editor set is small and privileged, so a
 *      "someone else saved" warning beats a CRDT.
 *   4. Refusing embedded base64 uploads unless an admin turned them on. This
 *      check is the boundary. The client also hides the affordance, but that
 *      is a courtesy, not a control.
 *   5. Proxying remote images same-origin. Excalidraw loads an image with a
 *      bare `img.src = …`, so a cross-origin URL renders but TAINTS the
 *      canvas, which breaks PNG export and copy-to-clipboard. Serving those
 *      bytes from our own origin keeps export working and gives us a
 *      content-type allowlist and an SSRF guard for free.
 */
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  OVERLOOK_EDITORS_MAX,
  OVERLOOK_ELEMENTS_MAX,
  OVERLOOK_EMPTY_SCENE_JSON,
  OVERLOOK_SCENE_MAX_BYTES,
  summarizeOverlookScene,
  type OverlookDetail,
  type OverlookEditor,
  type OverlookScope,
} from "@thekeep/shared";
import type { Db } from "../db/index.js";
import { overlookEditors, overlooks, roomMembers, rooms, users } from "../db/schema.js";
import { callerCanEditRoom } from "../auth/roomPermissions.js";
import { boardAgeDenied } from "../forums/nsfw.js";
import { isBlockedAddress, serveProxiedImage } from "../lib/imageProxy.js";
import { roleAccessDeniedFor } from "../lib/roleGates.js";
import { getSettings } from "../settings.js";
import { tFor } from "../i18n.js";
import { canEditWorld, resolveWorld } from "./worlds/shared.js";
import { getSessionUser } from "./auth.js";

type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>;
type OverlookRow = typeof overlooks.$inferSelect;

/** A resolved scope: which thing the canvas hangs off, and the viewer's rights. */
interface ScopeResolution {
  scope: OverlookScope;
  scopeId: string;
  scopeName: string;
  /** True when the viewer may save the scene by virtue of the scope itself. */
  canEditScope: boolean;
}

const saveBody = z
  .object({
    /** The whole Excalidraw document, serialized. Opaque to us. */
    sceneJson: z.string().min(2).max(OVERLOOK_SCENE_MAX_BYTES),
    /** The version the client last read. Refused if the server moved on. */
    version: z.number().int().min(0),
  })
  .strict();

const addEditorBody = z.object({ userId: z.string().min(1) }).strict();

/**
 * Resolve a room scope for a viewer, mirroring GET /rooms/:id/info exactly:
 * archived rooms, 18+ rooms for minors, and role-locked / staff-only rooms
 * are indistinguishable from missing, and private rooms need membership.
 * Returns null when the viewer may not even know the room exists.
 */
async function resolveRoomScope(
  db: Db,
  me: SessionUser,
  roomId: string,
): Promise<ScopeResolution | null> {
  const room = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room || room.archivedAt) return null;
  if (await boardAgeDenied(db, me, room)) return null;
  if (await roleAccessDeniedFor(db, me, room)) return null;
  if (room.type === "private") {
    const member = (
      await db
        .select({ userId: roomMembers.userId })
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, me.id)))
        .limit(1)
    )[0];
    if (!member) return null;
  }
  return {
    scope: "room",
    scopeId: room.id,
    scopeName: room.name,
    canEditScope: await callerCanEditRoom(db, me, room.id),
  };
}

/**
 * Resolve a world scope. `resolveWorld` already handles id-or-slug,
 * visibility, the hard 18+ gate and collaborator-sees-private, so the only
 * extra rule here is the owner's per-world opt-in: a world with Overlook
 * switched off has no canvas at all, not even for its owner. (Turning it on
 * is a world-settings toggle, which is where that decision belongs.)
 */
async function resolveWorldScope(
  db: Db,
  me: SessionUser,
  idOrSlug: string,
): Promise<ScopeResolution | null> {
  const world = await resolveWorld(db, idOrSlug, me.id, me.role);
  if (!world) return null;
  if (!world.overlookEnabled) return null;
  return {
    scope: "world",
    scopeId: world.id,
    scopeName: world.name,
    canEditScope: await canEditWorld(db, world, me.id, me.role),
  };
}

/** Load the canvas for a scope, creating the empty row on first touch. */
async function loadOrCreate(db: Db, res: ScopeResolution): Promise<OverlookRow> {
  const where =
    res.scope === "room" ? eq(overlooks.roomId, res.scopeId) : eq(overlooks.worldId, res.scopeId);
  const existing = (await db.select().from(overlooks).where(where).limit(1))[0];
  if (existing) return existing;
  const row = {
    id: nanoid(),
    // Exactly one of these is non-null; the migration's CHECK enforces it, so
    // the null side must be explicit rather than omitted.
    roomId: res.scope === "room" ? res.scopeId : null,
    worldId: res.scope === "world" ? res.scopeId : null,
    sceneJson: OVERLOOK_EMPTY_SCENE_JSON,
    elementCount: 0,
    version: 0,
  };
  await db.insert(overlooks).values(row).onConflictDoNothing();
  // Re-read rather than trusting the insert: two tabs opening the canvas at
  // once both race to create it, and the loser must get the winner's row.
  const created = (await db.select().from(overlooks).where(where).limit(1))[0];
  if (!created) throw new Error("overlook row vanished after insert");
  return created;
}

/** Explicit grants for a canvas, with usernames. */
async function editorListFor(db: Db, overlookId: string): Promise<OverlookEditor[]> {
  const rows = await db
    .select({
      userId: overlookEditors.userId,
      username: users.username,
      addedAt: overlookEditors.addedAt,
    })
    .from(overlookEditors)
    .innerJoin(users, eq(users.id, overlookEditors.userId))
    .where(eq(overlookEditors.overlookId, overlookId));
  return rows.map((r) => ({
    userId: r.userId,
    username: r.username,
    addedAt: r.addedAt ? +r.addedAt : null,
  }));
}

/** Is this user an explicitly granted editor of this canvas? */
export async function hasOverlookGrant(db: Db, overlookId: string, userId: string): Promise<boolean> {
  const row = (
    await db
      .select({ userId: overlookEditors.userId })
      .from(overlookEditors)
      .where(and(eq(overlookEditors.overlookId, overlookId), eq(overlookEditors.userId, userId)))
      .limit(1)
  )[0];
  return !!row;
}

/** Project a row + rights into the wire shape. */
async function toDetail(
  db: Db,
  row: OverlookRow,
  res: ScopeResolution,
  canEdit: boolean,
  uploadsEnabled: boolean,
): Promise<OverlookDetail> {
  let updatedByUsername: string | null = null;
  if (row.updatedByUserId) {
    const u = (
      await db
        .select({ username: users.username })
        .from(users)
        .where(eq(users.id, row.updatedByUserId))
        .limit(1)
    )[0];
    updatedByUsername = u?.username ?? null;
  }
  return {
    id: row.id,
    scope: res.scope,
    scopeId: res.scopeId,
    scopeName: res.scopeName,
    sceneJson: row.sceneJson,
    elementCount: row.elementCount,
    version: row.version,
    updatedAt: +row.updatedAt,
    updatedByUsername,
    canEdit,
    // Managing grants is scope authority, deliberately NOT something a
    // granted editor inherits: otherwise anyone handed edit rights could hand
    // them onward and the owner would lose track of who can draw.
    canManageEditors: res.canEditScope,
    editors: res.canEditScope ? await editorListFor(db, row.id) : [],
    uploadsEnabled,
  };
}

/**
 * Re-exported from `lib/imageProxy` so the proxy's SSRF guard keeps its
 * original import path (tests and any future caller).
 */
export { isBlockedAddress };

export async function registerOverlookRoutes(app: FastifyInstance, db: Db): Promise<void> {
  /**
   * Every Overlook endpoint is dark while the master switch is off, so the
   * feature can be pulled without a deploy. Returns 404 rather than 403: a
   * disabled feature should look absent, not forbidden.
   */
  async function featureOff(): Promise<boolean> {
    return !(await getSettings(db)).overlookEnabled;
  }

  /** Shared handler for both scopes' GET. */
  async function handleGet(
    res: ScopeResolution | null,
    me: SessionUser,
    reply: { code(n: number): unknown },
  ): Promise<{ error: string } | { overlook: OverlookDetail }> {
    if (!res) {
      reply.code(404);
      return { error: tFor(me.locale, "errors:server.overlook.notFound") };
    }
    const settings = await getSettings(db);
    const row = await loadOrCreate(db, res);
    const canEdit = res.canEditScope || (await hasOverlookGrant(db, row.id, me.id));
    return { overlook: await toDetail(db, row, res, canEdit, settings.overlookUploadsEnabled) };
  }

  /** Shared handler for both scopes' PUT. */
  async function handleSave(
    res: ScopeResolution | null,
    me: SessionUser,
    body: unknown,
    reply: { code(n: number): unknown },
  ): Promise<Record<string, unknown>> {
    if (!res) {
      reply.code(404);
      return { error: tFor(me.locale, "errors:server.overlook.notFound") };
    }
    const parsed = saveBody.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return { error: tFor(me.locale, "errors:server.overlook.badScene") };
    }
    const row = await loadOrCreate(db, res);
    const canEdit = res.canEditScope || (await hasOverlookGrant(db, row.id, me.id));
    if (!canEdit) {
      reply.code(403);
      return { error: tFor(me.locale, "errors:server.overlook.readOnly") };
    }

    // Zod's `.max()` counts CHARACTERS, so it's only a coarse pre-filter.
    // A scene of multi-byte text could pass it and still be far over the
    // real limit. Measure the actual UTF-8 size, which is what lands in the
    // row and in every backup. (Fastify's global 12MB body limit sits above
    // this, so an oversized body reaches us rather than being cut off with
    // an opaque framework error.)
    if (Buffer.byteLength(parsed.data.sceneJson, "utf8") > OVERLOOK_SCENE_MAX_BYTES) {
      reply.code(413);
      return { error: tFor(me.locale, "errors:server.overlook.tooBig") };
    }

    let summary;
    try {
      summary = summarizeOverlookScene(parsed.data.sceneJson);
    } catch {
      reply.code(400);
      return { error: tFor(me.locale, "errors:server.overlook.badScene") };
    }
    if (summary.elementCount > OVERLOOK_ELEMENTS_MAX) {
      reply.code(413);
      return {
        error: tFor(me.locale, "errors:server.overlook.tooManyElements", {
          max: OVERLOOK_ELEMENTS_MAX,
        }),
      };
    }
    // THE boundary for uploads. The client hides the affordance when the flag
    // is off, but a hidden button is not a control: a scene assembled by hand
    // (or pasted from another instance) can carry base64 images either way.
    if (summary.hasEmbeddedUploads && !(await getSettings(db)).overlookUploadsEnabled) {
      reply.code(403);
      return { error: tFor(me.locale, "errors:server.overlook.uploadsDisabled") };
    }

    // Optimistic concurrency: only advance the row whose version still
    // matches what the client read. Doing the check inside the UPDATE's WHERE
    // (rather than a read-then-write) closes the race between two saves that
    // both read the same version.
    const next = row.version + 1;
    const updated = await db
      .update(overlooks)
      .set({
        sceneJson: parsed.data.sceneJson,
        elementCount: summary.elementCount,
        version: next,
        updatedByUserId: me.id,
        updatedAt: new Date(),
      })
      .where(and(eq(overlooks.id, row.id), eq(overlooks.version, parsed.data.version)))
      .returning({ id: overlooks.id });
    if (updated.length === 0) {
      const current = (await db.select().from(overlooks).where(eq(overlooks.id, row.id)).limit(1))[0];
      reply.code(409);
      let who: string | null = null;
      if (current?.updatedByUserId) {
        const u = (
          await db
            .select({ username: users.username })
            .from(users)
            .where(eq(users.id, current.updatedByUserId))
            .limit(1)
        )[0];
        who = u?.username ?? null;
      }
      return {
        error: "conflict",
        version: current?.version ?? row.version,
        updatedAt: current ? +current.updatedAt : +row.updatedAt,
        updatedByUsername: who,
      };
    }
    return { version: next, elementCount: summary.elementCount };
  }

  app.get<{ Params: { roomId: string } }>("/overlook/room/:roomId", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (await featureOff()) { reply.code(404); return { error: "disabled" }; }
    return handleGet(await resolveRoomScope(db, me, req.params.roomId), me, reply);
  });

  app.put<{ Params: { roomId: string } }>("/overlook/room/:roomId", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (await featureOff()) { reply.code(404); return { error: "disabled" }; }
    return handleSave(await resolveRoomScope(db, me, req.params.roomId), me, req.body, reply);
  });

  app.get<{ Params: { idOrSlug: string } }>("/overlook/world/:idOrSlug", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (await featureOff()) { reply.code(404); return { error: "disabled" }; }
    return handleGet(await resolveWorldScope(db, me, req.params.idOrSlug), me, reply);
  });

  app.put<{ Params: { idOrSlug: string } }>("/overlook/world/:idOrSlug", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (await featureOff()) { reply.code(404); return { error: "disabled" }; }
    return handleSave(await resolveWorldScope(db, me, req.params.idOrSlug), me, req.body, reply);
  });

  /**
   * Re-resolve a canvas by its own id and confirm the caller holds scope
   * authority. The editor-management endpoints key on the overlook id (the
   * slash command has one, not a scope), so they have to walk back to the
   * scope to answer "may you manage this?".
   */
  async function scopeForOverlookId(
    me: SessionUser,
    overlookId: string,
  ): Promise<{ row: OverlookRow; res: ScopeResolution } | null> {
    const row = (await db.select().from(overlooks).where(eq(overlooks.id, overlookId)).limit(1))[0];
    if (!row) return null;
    const res = row.roomId
      ? await resolveRoomScope(db, me, row.roomId)
      : row.worldId
        ? await resolveWorldScope(db, me, row.worldId)
        : null;
    if (!res) return null;
    return { row, res };
  }

  app.get<{ Params: { id: string } }>("/overlook/:id/editors", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (await featureOff()) { reply.code(404); return { error: "disabled" }; }
    const found = await scopeForOverlookId(me, req.params.id);
    if (!found || !found.res.canEditScope) {
      reply.code(404);
      return { error: tFor(me.locale, "errors:server.overlook.notFound") };
    }
    return { editors: await editorListFor(db, found.row.id) };
  });

  app.post<{ Params: { id: string } }>("/overlook/:id/editors", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (await featureOff()) { reply.code(404); return { error: "disabled" }; }
    const found = await scopeForOverlookId(me, req.params.id);
    if (!found || !found.res.canEditScope) {
      reply.code(404);
      return { error: tFor(me.locale, "errors:server.overlook.notFound") };
    }
    const parsed = addEditorBody.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: "bad request" }; }
    const target = (
      await db.select({ id: users.id }).from(users).where(eq(users.id, parsed.data.userId)).limit(1)
    )[0];
    if (!target) {
      reply.code(404);
      return { error: tFor(me.locale, "errors:server.overlook.noSuchUser") };
    }
    const existing = await editorListFor(db, found.row.id);
    if (existing.length >= OVERLOOK_EDITORS_MAX) {
      reply.code(409);
      return {
        error: tFor(me.locale, "errors:server.overlook.editorCap", { max: OVERLOOK_EDITORS_MAX }),
      };
    }
    await db
      .insert(overlookEditors)
      .values({ overlookId: found.row.id, userId: target.id, addedByUserId: me.id })
      .onConflictDoNothing();
    return { editors: await editorListFor(db, found.row.id) };
  });

  app.delete<{ Params: { id: string; userId: string } }>(
    "/overlook/:id/editors/:userId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      if (await featureOff()) { reply.code(404); return { error: "disabled" }; }
      const found = await scopeForOverlookId(me, req.params.id);
      if (!found || !found.res.canEditScope) {
        reply.code(404);
        return { error: tFor(me.locale, "errors:server.overlook.notFound") };
      }
      await db
        .delete(overlookEditors)
        .where(
          and(
            eq(overlookEditors.overlookId, found.row.id),
            eq(overlookEditors.userId, req.params.userId),
          ),
        );
      return { editors: await editorListFor(db, found.row.id) };
    },
  );

  /**
   * GET /overlook/image?u=<https url>
   *
   * Same-origin image proxy. Exists because Excalidraw renders a remote image
   * fine (`img.src = <url>`, no `data:` validation) but the resulting canvas
   * is TAINTED, so `toBlob` throws and PNG export / copy-to-clipboard break.
   * Serving the bytes from our origin keeps export working AND lets us
   * enforce a content-type allowlist that excludes SVG (a script-capable
   * document; the world-map uploader bans it for the same reason).
   *
   * Auth-gated so this can't be used as an open proxy by anonymous callers,
   * and SSRF-guarded so it can't be pointed at the private network.
   */
  app.get<{ Querystring: { u?: string } }>("/overlook/image", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (await featureOff()) { reply.code(404); return { error: "disabled" }; }
    return serveProxiedImage(reply, req.query.u ?? "");
  });
}

/**
 * True when the given world's canvas exists and has at least one element.
 * Called from the world detail projection, which must not ship the scene.
 */
export async function worldOverlookHasContent(db: Db, worldId: string): Promise<boolean> {
  const row = (
    await db
      .select({ elementCount: overlooks.elementCount })
      .from(overlooks)
      .where(eq(overlooks.worldId, worldId))
      .limit(1)
  )[0];
  return (row?.elementCount ?? 0) > 0;
}

/**
 * Item count on a room's canvas, for the Room Info dossier's Overlook card.
 * Returns null when the feature is off sitewide (the card then hides), and 0
 * when the canvas is blank or has never been opened.
 */
export async function roomOverlookElementCount(db: Db, roomId: string): Promise<number | null> {
  if (!(await getSettings(db)).overlookEnabled) return null;
  const row = (
    await db
      .select({ elementCount: overlooks.elementCount })
      .from(overlooks)
      .where(eq(overlooks.roomId, roomId))
      .limit(1)
  )[0];
  return row?.elementCount ?? 0;
}
