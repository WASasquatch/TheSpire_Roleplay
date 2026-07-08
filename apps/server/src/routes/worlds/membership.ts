import type { FastifyInstance } from "fastify";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { hasPermission } from "../../auth/permissions.js";
import {
  characters,
  roomWorldLinks,
  users,
  worldMembers,
  worlds,
} from "../../db/schema.js";
import { resolveIdentityArg } from "../../commands/identityArg.js";
import { getSessionUser } from "../auth.js";
import { broadcastRoomState } from "../../realtime/broadcast.js";
import { pushToUser } from "../../push.js";
import type { WorldJoinMode, WorldMembership } from "@thekeep/shared";
import type { Db } from "../../db/index.js";
import {
  linkWorldBody,
  resolveWorld,
  callerCanModerateRoom,
  rebroadcastUserOccupancy,
  loadOwnerUsername,
} from "./shared.js";
import type { Io } from "./shared.js";

export async function registerWorldMembershipRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  /* ---------- Link a world to a room ---------- */
  app.put<{ Params: { roomId: string }; Body: unknown }>(
    "/rooms/:roomId/world",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      if (!(await callerCanModerateRoom(db, me.id, me.role, req.params.roomId))) {
        reply.code(403); return { error: "room owner / mod / admin only" };
      }

      let body;
      try { body = linkWorldBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const w = await resolveWorld(db, body.worldId, me.id, me.role);
      if (!w) { reply.code(404); return { error: "world not found" }; }
      // Linking other people's worlds requires visibility = open.
      if (w.ownerUserId !== me.id && w.visibility !== "open"
          && !(await hasPermission(me, "edit_others_world", db))) {
        reply.code(403);
        return { error: "world isn't open for catalog use" };
      }

      await db
        .insert(roomWorldLinks)
        .values({
          roomId: req.params.roomId,
          worldId: w.id,
          linkedByUserId: me.id,
        })
        .onConflictDoUpdate({
          target: roomWorldLinks.roomId,
          set: { worldId: w.id, linkedByUserId: me.id, linkedAt: new Date() },
        });
      await broadcastRoomState(io, db, req.params.roomId);
      return { ok: true };
    },
  );

  /* ---------- Unlink the room's current world ---------- */
  app.delete<{ Params: { roomId: string } }>("/rooms/:roomId/world", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (!(await callerCanModerateRoom(db, me.id, me.role, req.params.roomId))) {
      reply.code(403); return { error: "room owner / mod / admin only" };
    }
    await db.delete(roomWorldLinks).where(eq(roomWorldLinks.roomId, req.params.roomId));
    await broadcastRoomState(io, db, req.params.roomId);
    return { ok: true };
  });

  /* ---------- Join a world as the current identity ---------- *
   *
   * Joining is per-identity (migration 0187): the membership row
   * carries the caller's currently-voiced character_id (or null for
   * OOC). Avery can be in Halcyon City without dragging the master's
   * OOC face, or the master's other characters, along.
   *
   * Owners can join their own world as any of their identities;
   * admins with edit_others_world can join any world. Everyone else
   * needs visibility="open" AND joinMode="open".
   */
  app.post<{ Params: { idOrSlug: string } }>("/worlds/:idOrSlug/members", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    const isOwner = w.ownerUserId === me.id;
    const isAdmin = !isOwner && (await hasPermission(me, "edit_others_world", db));
    if (!isOwner && !isAdmin) {
      // joinMode alone gates entry, independent of visibility (resolveWorld above
      // already enforced who can SEE the world). A public / link-shared world with
      // a one-click "open" joinMode is joinable by anyone who can reach it; the
      // invite-only / application branches below still apply. This mirrors the
      // application route (which never checked visibility) and the editor's
      // "joinMode is independent of visibility" contract.
      const joinMode = (w.joinMode ?? "open") as WorldJoinMode;
      if (joinMode === "invite-only") {
        reply.code(403);
        return {
          error: "this world is invite-only; ask the owner to add you",
          code: "INVITE_ONLY",
        };
      }
      if (joinMode === "application") {
        reply.code(403);
        return {
          error: "this world requires an application; use the Apply button",
          code: "APPLICATION_REQUIRED",
        };
      }
    }
    const charId = me.activeCharacterId;
    const existing = (await db
      .select()
      .from(worldMembers)
      .where(and(
        eq(worldMembers.worldId, w.id),
        eq(worldMembers.userId, me.id),
        charId === null
          ? sql`${worldMembers.characterId} IS NULL`
          : eq(worldMembers.characterId, charId),
      ))
      .limit(1))[0];
    if (existing) {
      // Idempotent: this identity is already a member.
      return { ok: true, alreadyMember: true };
    }
    await db.insert(worldMembers).values({
      worldId: w.id,
      userId: me.id,
      characterId: charId,
    });
    await rebroadcastUserOccupancy(io, db, me.id);
    return { ok: true };
  });

  /* ---------- Owner-invited member ----------
   * Direct owner-side membership add. Unlike `POST /members` (which
   * registers the CALLER as a member), this endpoint registers a NAMED
   * target identity that the owner picked. The two paths sit together
   * because they hit the same `worldMembers` table, but the auth model
   * and identity resolution differ, invites are owner/admin only and
   * the target comes from a free-form name OR an unambiguous identity
   * token (`@id:` / `@cid:`) the same shared resolver every other
   * identity-keyed command uses.
   *
   * Per-identity contract preserved: if the target token addresses a
   * specific character (`@cid:`), the membership row is bound to that
   * character; addressing a master (`@id:` or a bare master name)
   * inserts an OOC membership with `characterId = null`. The owner can
   * invite both a master AND any of their characters separately, same
   * as the catalog Join flow, by re-running the invite with each
   * identity token.
   *
   * Useful for ALL three join modes:
   *   - invite-only: the ONLY way anyone gets in besides the owner.
   *   - application: shortcut for "I already trust this person; skip
   *     the queue."
   *   - open: an explicit pre-add for someone who hasn't found the
   *     world yet but the owner wants them seated.
   */
  app.post<{ Params: { idOrSlug: string }; Body: unknown }>(
    "/worlds/:idOrSlug/invites",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
      if (!w) { reply.code(404); return { error: "not found" }; }
      const isOwner = w.ownerUserId === me.id;
      const isAdmin = !isOwner && (await hasPermission(me, "edit_others_world", db));
      if (!isOwner && !isAdmin) {
        reply.code(403); return { error: "owner only" };
      }
      const body = z.object({ target: z.string().min(1).max(120) }).safeParse(req.body);
      if (!body.success) { reply.code(400); return { error: "invalid body" }; }
      const resolution = await resolveIdentityArg(db, body.data.target);
      if (resolution.kind === "none") {
        reply.code(404); return { error: `no user or character matched "${body.data.target}"` };
      }
      if (resolution.kind === "ambiguous") {
        // Surface the disambiguation candidates so the owner can re-run
        // with the right token. Same shape `emitAmbiguousIdentityModal`
        // uses on the chat side, just over HTTP.
        reply.code(409);
        return {
          error: `"${body.data.target}" matches ${resolution.matches.length} identities, re-run with a specific token`,
          candidates: resolution.matches.map((m) => ({
            displayName: m.displayName,
            masterUsername: m.masterUsername,
            characterId: m.characterId,
            userId: m.userId,
            token: m.characterId ? `@cid:${m.characterId}` : `@id:${m.userId}`,
          })),
        };
      }
      const target = resolution.target;
      const targetCharId = target.characterId;
      // Idempotent on (worldId, userId, characterId). Mirrors the
      // same triple-key membership shape `POST /members` uses, so
      // re-inviting an identity that's already in returns success
      // instead of a duplicate-row error.
      const existing = (await db
        .select()
        .from(worldMembers)
        .where(and(
          eq(worldMembers.worldId, w.id),
          eq(worldMembers.userId, target.userId),
          targetCharId === null
            ? sql`${worldMembers.characterId} IS NULL`
            : eq(worldMembers.characterId, targetCharId),
        ))
        .limit(1))[0];
      if (existing) {
        return { ok: true, alreadyMember: true, displayName: target.displayName };
      }
      await db.insert(worldMembers).values({
        worldId: w.id,
        userId: target.userId,
        characterId: targetCharId,
      });
      // Re-broadcast the target's occupancy so any user-list watching
      // them picks up the new world-membership chip immediately, same
      // as the self-join path.
      await rebroadcastUserOccupancy(io, db, target.userId);
      // Fire-and-forget web-push to the invitee. Without this, the
      // direct-add flow was completely silent, the invitee only
      // discovered the membership by stumbling on the member list,
      // which made invite-only worlds borderline unusable. Matches
      // the whisper / mention push posture in `broadcast.pushTriggers`:
      // generic copy, scoped tag so repeats coalesce, never throws.
      pushToUser(db, target.userId, {
        title: "Added to a world",
        body: `${me.username} added you to ${w.name}.`,
        tag: `world-invite-${w.id}`,
      }).catch(() => {});
      return { ok: true, displayName: target.displayName };
    },
  );

  /* ---------- Leave a world as the current identity ---------- */
  app.delete<{ Params: { idOrSlug: string } }>("/worlds/:idOrSlug/members", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    const charId = me.activeCharacterId;
    const r = await db
      .delete(worldMembers)
      .where(and(
        eq(worldMembers.worldId, w.id),
        eq(worldMembers.userId, me.id),
        charId === null
          ? sql`${worldMembers.characterId} IS NULL`
          : eq(worldMembers.characterId, charId),
      ));
    if (r.changes === 0) return { ok: true, alreadyAbsent: true };
    await rebroadcastUserOccupancy(io, db, me.id);
    return { ok: true };
  });

  /**
   * Caller's world memberships across every identity. Used by the
   * WorldsList modal ("Worlds I've joined") and by the catalog's
   * Joined-indicator pre-fetch.
   *
   * Each row carries the identity that joined (`characterId` null =
   * OOC, non-null = the character) plus a resolved `identityDisplayName`
   * so the My Worlds list can render "as Avery, Halcyon City" without
   * a second lookup. Soft-deleted characters drop out.
   */
  app.get("/me/worlds/memberships", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const rows = await db
      .select({
        worldId: worldMembers.worldId,
        characterId: worldMembers.characterId,
        joinedAt: worldMembers.joinedAt,
        worldSlug: worlds.slug,
        worldName: worlds.name,
        ownerUserId: worlds.ownerUserId,
        characterName: characters.name,
        characterDeletedAt: characters.deletedAt,
      })
      .from(worldMembers)
      .innerJoin(worlds, eq(worlds.id, worldMembers.worldId))
      .leftJoin(characters, eq(characters.id, worldMembers.characterId))
      .where(eq(worldMembers.userId, me.id))
      .orderBy(asc(worldMembers.joinedAt));
    const visible = rows.filter((r) => r.characterId === null || r.characterDeletedAt === null);
    const memberships: WorldMembership[] = await Promise.all(
      visible.map(async (r) => ({
        worldId: r.worldId,
        worldSlug: r.worldSlug,
        worldName: r.worldName,
        ownerUsername: await loadOwnerUsername(db, r.ownerUserId),
        characterId: r.characterId,
        identityDisplayName: r.characterId !== null
          ? (r.characterName ?? me.username)
          : me.username,
        joinedAt: +r.joinedAt,
      })),
    );
    return { memberships };
  });

  /**
   * Read another user's memberships (for the profile modal). Returns only
   * memberships in worlds whose visibility allows the viewer to see them
   * (private worlds are filtered out unless the viewer is the owner of the
   * world or an admin).
   */
  app.get<{ Params: { userId: string } }>("/users/:userId/world-memberships", async (req, reply) => {
    const me = await getSessionUser(req, db);
    // Visibility model, runs identically for anonymous and logged-in
    // viewers, with the viewer's identity only affecting which PRIVATE
    // worlds are unblanked:
    //
    //   public / open visibility → always shown (the splash already
    //     features these by name; surfacing them on a profile leaks
    //     nothing extra).
    //   private visibility       → shown ONLY when the viewer is the
    //     world's owner or a site admin. Anonymous viewers and
    //     unrelated logged-in viewers never see private memberships.
    //
    // The previous implementation gated the ENTIRE response on auth
    // ({ private: true } stub for anonymous), which over-hid public
    // worlds the splash was already advertising. Now the gate is per
    // row, scoped to the privacy of each world individually.
    // Per-identity filter via query string: `?characterId=<id>` filters
    // to that character's memberships; `?characterId=ooc` returns the
    // master's OOC memberships only; omit the param to return ALL
    // identities. The profile modal scopes the request to whichever
    // identity it's rendering, character profile passes the character
    // id, master profile passes "ooc".
    const q = req.query as { characterId?: string } | undefined;
    const filterChar = q?.characterId;
    const rows = await db
      .select({
        worldId: worldMembers.worldId,
        characterId: worldMembers.characterId,
        joinedAt: worldMembers.joinedAt,
        worldSlug: worlds.slug,
        worldName: worlds.name,
        visibility: worlds.visibility,
        ownerUserId: worlds.ownerUserId,
        ownerUsername: users.username,
        characterName: characters.name,
        characterDeletedAt: characters.deletedAt,
      })
      .from(worldMembers)
      .innerJoin(worlds, eq(worlds.id, worldMembers.worldId))
      .innerJoin(users, eq(users.id, worlds.ownerUserId))
      .leftJoin(characters, eq(characters.id, worldMembers.characterId))
      .where(eq(worldMembers.userId, req.params.userId))
      .orderBy(asc(worldMembers.joinedAt));
    // Pre-resolve admin override once; the per-row predicate stays
    // synchronous and we avoid 1+N permission lookups on a list filter.
    const meCanSeePrivateAsAdmin = !!me && (await hasPermission(me, "edit_others_world", db));
    // Master username for the OOC identity label. Resolved once.
    const targetMaster = (await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, req.params.userId))
      .limit(1))[0];
    const targetMasterUsername = targetMaster?.username ?? "(deleted user)";
    const filtered = rows.filter((r) => {
      // Drop soft-deleted character rows.
      if (r.characterId !== null && r.characterDeletedAt !== null) return false;
      // Identity filter.
      if (filterChar === "ooc" && r.characterId !== null) return false;
      if (filterChar && filterChar !== "ooc" && r.characterId !== filterChar) return false;
      // Private-world visibility gate (unchanged from v2).
      if (r.visibility !== "private") return true;
      return !!me && (meCanSeePrivateAsAdmin || r.ownerUserId === me.id);
    });
    const memberships: WorldMembership[] = filtered.map((r) => ({
      worldId: r.worldId,
      worldSlug: r.worldSlug,
      worldName: r.worldName,
      ownerUsername: r.ownerUsername,
      characterId: r.characterId,
      identityDisplayName: r.characterId !== null
        ? (r.characterName ?? targetMasterUsername)
        : targetMasterUsername,
      joinedAt: +r.joinedAt,
    }));
    return { memberships };
  });
}
