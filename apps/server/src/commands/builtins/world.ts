import { and, eq, or, sql } from "drizzle-orm";
import { roomMembers, roomWorldLinks, rooms, worldMembers, worlds } from "../../db/schema.js";
import { broadcastRoomState, rebroadcastPresenceForUser } from "../../realtime/broadcast.js";
import { hasPermission } from "../../auth/permissions.js";
import type { CommandContext, CommandHandler } from "../types.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/**
 * Resolve a world by slug for membership commands. Unlike findOwnWorld,
 * this looks across all visible worlds: the caller's own (any visibility),
 * plus any open world (which is the only kind a non-owner can join).
 */
async function findVisibleWorldBySlug(ctx: CommandContext, slug: string) {
  const lower = slug.toLowerCase();
  const own = (await ctx.db
    .select()
    .from(worlds)
    .where(and(eq(worlds.ownerUserId, ctx.user.id), sql`lower(${worlds.slug}) = ${lower}`))
    .limit(1))[0];
  if (own) return own;
  return (await ctx.db
    .select()
    .from(worlds)
    .where(and(
      sql`lower(${worlds.slug}) = ${lower}`,
      or(eq(worlds.visibility, "public"), eq(worlds.visibility, "open")),
    ))
    .limit(1))[0];
}

/** Find the world id from a `[slug]` arg or the room's linked world (when no slug). */
async function resolveWorldForMembership(ctx: CommandContext, slug: string) {
  if (slug) {
    const w = await findVisibleWorldBySlug(ctx, slug);
    return w ?? null;
  }
  const link = (await ctx.db
    .select()
    .from(roomWorldLinks)
    .where(eq(roomWorldLinks.roomId, ctx.roomId))
    .limit(1))[0];
  if (!link) return null;
  return (await ctx.db.select().from(worlds).where(eq(worlds.id, link.worldId)).limit(1))[0] ?? null;
}

/**
 * Re-broadcast presence in every room the caller currently has a socket in.
 * Membership changes alter userlist grouping, so the rooms need a fresh
 * occupants payload to re-sort. Mirrors the route-layer helper.
 */
async function rebroadcastSelfOccupancy(ctx: CommandContext) {
  await rebroadcastPresenceForUser(ctx.io, ctx.db, ctx.user.id);
}

async function callerCanModerateRoom(ctx: CommandContext): Promise<boolean> {
  // Site-wide override (admin-default seed).
  if (await hasPermission(ctx.user, "edit_any_room_metadata", ctx.db)) return true;
  const room = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
  if (!room) return false;
  if (room.ownerId === ctx.user.id) return true;
  const m = (await ctx.db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, ctx.roomId), eq(roomMembers.userId, ctx.user.id)))
    .limit(1))[0];
  return m?.role === "owner" || m?.role === "mod";
}

/** Resolve a slug owned by the caller. Cross-author linking goes through the catalog UI, not the slash command. */
async function findOwnWorld(ctx: CommandContext, slug: string) {
  return (await ctx.db
    .select()
    .from(worlds)
    .where(and(eq(worlds.ownerUserId, ctx.user.id), sql`lower(${worlds.slug}) = ${slug.toLowerCase()}`))
    .limit(1))[0];
}

/**
 * /world                - opens the linked world viewer for everyone
 * /world <slug>         - open any visible world by slug (shortcut for
 *                         /world view <slug>; only resolves when the
 *                         arg doesn't match a known verb).
 * /world view <slug>    - explicit form of the slug shortcut
 * /world link <slug>    - room owner/mod/admin links the caller's own
 *                         world to this room. (Use the World Catalog modal
 *                         to link someone else's open world.)
 * /world unlink         - room owner/mod/admin removes the link
 * /world catalog        - opens the world catalog modal
 * /world join [slug]    - join an open world (or the room's linked
 *                         world if no slug) AS THE CURRENT IDENTITY
 *                         (master OOC or active character). Per
 *                         migration 0187, characters and OOC have
 *                         independent memberships.
 * /world leave [slug]   - leave a world AS THE CURRENT IDENTITY.
 *
 * /world primary was retired in 0187 along with userlist world-bucket
 * grouping, primary world no longer means anything cross-identity.
 */
export const worldCommand: CommandHandler = {
  name: "world",
  usage: "/world | /world <slug> | /world view <slug> | /world link <slug> | /world unlink | /world catalog | /world join [slug] | /world leave [slug]",
  description: "Show, link, or join a world (wiki). Pass a slug to open any visible world directly.",
  subcommands: [
    { verb: "(no args)", usage: "/world", description: "Open the linked world's wiki, if any." },
    { verb: "(slug)", usage: "/world <slug>", description: "Open any visible world by slug." },
    { verb: "view", usage: "/world view <slug>", description: "Explicit form of the slug shortcut." },
    { verb: "link", usage: "/world link <slug>", description: "Link one of YOUR worlds to this room. (Owner/mod/admin only.)" },
    { verb: "unlink", usage: "/world unlink", description: "Remove the linked world. (Owner/mod/admin only.)" },
    { verb: "catalog", usage: "/world catalog", description: "Browse the world catalog (open worlds usable in any room)." },
    { verb: "join", usage: "/world join [slug]", description: "Join an open world; opens the application form if the world requires one; tells you if the world is invite-only." },
    { verb: "leave", usage: "/world leave [slug]", description: "Leave a world as your current identity." },
  ],
  async run(ctx) {
    const [sub, ...rest] = ctx.args;
    const subLower = (sub ?? "").toLowerCase();

    if (subLower === "" || subLower === "open" || subLower === "show") {
      const link = (await ctx.db
        .select()
        .from(roomWorldLinks)
        .where(eq(roomWorldLinks.roomId, ctx.roomId))
        .limit(1))[0];
      if (!link) {
        return notice(ctx, "NO_WORLD", "No world is linked to this room. Use /world link <slug> to attach one.");
      }
      ctx.socket.emit("ui:hint", { kind: "open-world", worldId: link.worldId });
      return;
    }

    if (subLower === "view") {
      // Explicit form: /world view <slug>. The unambiguous variant for
      // users who don't want to risk the implicit `/world <slug>` shortcut
      // shadowing a slug that collides with a future verb.
      const slug = rest.join(" ").trim();
      if (!slug) return notice(ctx, "VIEW_USAGE", "Usage: /world view <slug>");
      const w = await findVisibleWorldBySlug(ctx, slug);
      if (!w) return notice(ctx, "NO_WORLD", `No visible world with slug "${slug}".`);
      ctx.socket.emit("ui:hint", { kind: "open-world", worldId: w.id });
      return;
    }

    if (subLower === "catalog" || subLower === "browse") {
      ctx.socket.emit("ui:hint", { kind: "open-world-catalog" });
      return;
    }

    if (subLower === "link" || subLower === "attach") {
      if (!(await callerCanModerateRoom(ctx))) {
        return notice(ctx, "PERM", "Only the room owner / mod / admin can link a world.");
      }
      const slug = rest.join(" ").trim();
      if (!slug) return notice(ctx, "LINK_USAGE", "Usage: /world link <slug>");
      const w = await findOwnWorld(ctx, slug);
      if (!w) {
        return notice(ctx, "NO_WORLD", `You don't own a world with slug "${slug}". Browse the catalog with /world catalog to use someone else's open world.`);
      }
      await ctx.db
        .insert(roomWorldLinks)
        .values({ roomId: ctx.roomId, worldId: w.id, linkedByUserId: ctx.user.id })
        .onConflictDoUpdate({
          target: roomWorldLinks.roomId,
          set: { worldId: w.id, linkedByUserId: ctx.user.id, linkedAt: new Date() },
        });
      await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
      return;
    }

    if (subLower === "unlink" || subLower === "detach" || subLower === "remove") {
      if (!(await callerCanModerateRoom(ctx))) {
        return notice(ctx, "PERM", "Only the room owner / mod / admin can unlink the world.");
      }
      const r = await ctx.db.delete(roomWorldLinks).where(eq(roomWorldLinks.roomId, ctx.roomId));
      if (r.changes === 0) {
        return notice(ctx, "NO_WORLD", "No world is linked to this room.");
      }
      await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
      return;
    }

    if (subLower === "join") {
      const slug = rest.join(" ").trim();
      const w = await resolveWorldForMembership(ctx, slug);
      if (!w) {
        return notice(ctx, "NO_WORLD", slug
          ? `No visible world with slug "${slug}".`
          : "No world is linked to this room. Pass a slug, e.g. /world join darkrealm.");
      }
      const isOwner = w.ownerUserId === ctx.user.id;
      const isAdmin = !isOwner && (await hasPermission(ctx.user, "edit_others_world", ctx.db));
      if (!isOwner && !isAdmin) {
        // Visibility gate first: private / public-with-no-catalog worlds
        // aren't catalog-joinable. The catalog only ever surfaces
        // `visibility = "open"` worlds, so the rest of the gating logic
        // below assumes the world is at least open.
        if (w.visibility !== "open") {
          return notice(ctx, "NOT_OPEN", `"${w.name}" isn't open for community membership.`);
        }
        // joinMode gate. Pre-0186 worlds default to "open" so the
        // missing-column fallback below behaves the same as the
        // legacy slash command did. Application + invite-only worlds
        // now route to the right UI affordance instead of being
        // silently joined by the slash-command bypass.
        const joinMode = (w.joinMode ?? "open");
        if (joinMode === "invite-only") {
          return notice(
            ctx,
            "INVITE_ONLY",
            `"${w.name}" is invite-only. The author adds members directly, ask them if you'd like in.`,
          );
        }
        if (joinMode === "application") {
          // Open the world viewer first so the user can read what
          // they're applying to, then ask the client to surface the
          // application form on top of it. Two hints keeps the modal
          // composition the same as the catalog Apply path (viewer
          // open + ApplicationFormModal mounted).
          ctx.socket.emit("ui:hint", { kind: "open-world", worldId: w.id });
          ctx.socket.emit("ui:hint", {
            kind: "world-application-prompt",
            worldId: w.id,
            worldName: w.name,
          });
          return notice(
            ctx,
            "APPLICATION_REQUIRED",
            `"${w.name}" accepts new members by application. Opened the form for you.`,
          );
        }
      }
      // Per-identity (migration 0187): the joining face is whatever
      // character the user is currently voicing, or OOC.
      const charId = ctx.user.activeCharacterId;
      const identityMatch = charId === null
        ? sql`${worldMembers.characterId} IS NULL`
        : eq(worldMembers.characterId, charId);
      const existing = (await ctx.db
        .select()
        .from(worldMembers)
        .where(and(
          eq(worldMembers.worldId, w.id),
          eq(worldMembers.userId, ctx.user.id),
          identityMatch,
        ))
        .limit(1))[0];
      if (existing) {
        return notice(ctx, "ALREADY_MEMBER", `You're already a member of "${w.name}" (as this identity).`);
      }
      await ctx.db.insert(worldMembers).values({
        worldId: w.id,
        userId: ctx.user.id,
        characterId: charId,
      });
      await rebroadcastSelfOccupancy(ctx);
      return notice(ctx, "JOINED", `Joined "${w.name}".`);
    }

    if (subLower === "leave") {
      const slug = rest.join(" ").trim();
      const w = await resolveWorldForMembership(ctx, slug);
      if (!w) {
        return notice(ctx, "NO_WORLD", slug
          ? `No visible world with slug "${slug}".`
          : "No world is linked to this room. Pass a slug, e.g. /world leave darkrealm.");
      }
      const charId = ctx.user.activeCharacterId;
      const identityMatch = charId === null
        ? sql`${worldMembers.characterId} IS NULL`
        : eq(worldMembers.characterId, charId);
      const r = await ctx.db
        .delete(worldMembers)
        .where(and(
          eq(worldMembers.worldId, w.id),
          eq(worldMembers.userId, ctx.user.id),
          identityMatch,
        ));
      if (r.changes === 0) {
        return notice(ctx, "NOT_MEMBER", `You're not a member of "${w.name}" (as this identity).`);
      }
      await rebroadcastSelfOccupancy(ctx);
      return notice(ctx, "LEFT", `Left "${w.name}".`);
    }

    // `/world primary` was retired in migration 0187, primary world
    // is no longer a thing now that memberships are per-identity. The
    // userlist no longer groups by world; visit the world's own page
    // to see its member list.

    // Slug shortcut: any unknown first arg is tried as a world slug. Lets
    // users type `/world darkrealm` instead of `/world view darkrealm`
    // once they've memorized the slug, same energy as IRC's `/join #foo`
    // skipping a separate "join" verb. Only fires when nothing else
    // matched, so future verbs added above can't be silently shadowed.
    if (subLower) {
      const w = await findVisibleWorldBySlug(ctx, sub!);
      if (w) {
        ctx.socket.emit("ui:hint", { kind: "open-world", worldId: w.id });
        return;
      }
      // Fall through to BAD_SUBCMD with a hint that the unknown token also
      // wasn't a slug, so users who fat-fingered a verb get one notice,
      // not two attempts.
      return notice(
        ctx,
        "BAD_SUBCMD",
        `"${sub}" isn't a /world subcommand or a visible world slug. Try /world, /world view <slug>, /world catalog, etc.`,
      );
    }

    return notice(ctx, "BAD_SUBCMD", "Try /world, /world <slug>, /world view <slug>, /world link <slug>, /world unlink, /world catalog, /world join, /world leave, or /world primary.");
  },
};

/** /worlds - open the manager modal listing your own worlds. */
export const worldsCommand: CommandHandler = {
  name: "worlds",
  aliases: ["myworlds"],
  usage: "/worlds",
  description: "Open the manager listing the worlds you've built.",
  run(ctx) {
    ctx.socket.emit("ui:hint", { kind: "open-worlds-list" });
  },
};
