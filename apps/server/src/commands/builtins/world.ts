import { and, eq, or, sql } from "drizzle-orm";
import { roomMembers, roomWorldLinks, rooms, worldMembers, worlds } from "../../db/schema.js";
import { broadcastPresence, broadcastRoomState } from "../../realtime/broadcast.js";
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
  const sockets = await ctx.io.fetchSockets();
  const rooms = new Set<string>();
  for (const s of sockets) {
    if ((s.data as { userId?: string }).userId !== ctx.user.id) continue;
    for (const r of s.rooms) {
      if (r.startsWith("room:")) rooms.add(r.slice(5));
    }
  }
  for (const rid of rooms) {
    await broadcastPresence(ctx.io, ctx.db, rid).catch(() => {});
  }
}

async function callerCanModerateRoom(ctx: CommandContext): Promise<boolean> {
  if (ctx.user.role === "admin" || ctx.user.role === "mod") return true;
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
 * /world              - opens the linked world viewer for everyone
 * /world link <slug>  - room owner/mod/admin links the caller's own world
 *                       to this room. (Use the World Catalog modal to link
 *                       someone else's open world.)
 * /world unlink       - room owner/mod/admin removes the link
 * /world catalog      - opens the world catalog modal
 * /world join [slug]  - join an open world (or the room's linked world if
 *                       no slug). Doesn't change room access; affiliates
 *                       you with the world for userlist grouping + profile.
 * /world leave [slug] - leave a world membership.
 * /world primary [slug] - set this world as your primary affiliation
 *                       (clears primary if no slug).
 */
export const worldCommand: CommandHandler = {
  name: "world",
  usage: "/world | /world link <slug> | /world unlink | /world catalog | /world join [slug] | /world leave [slug] | /world primary [slug]",
  description: "Show, link, or join the world (wiki) attached to this room.",
  subcommands: [
    { verb: "(no args)", usage: "/world", description: "Open the linked world's wiki, if any." },
    { verb: "link", usage: "/world link <slug>", description: "Link one of YOUR worlds to this room. (Owner/mod/admin only.)" },
    { verb: "unlink", usage: "/world unlink", description: "Remove the linked world. (Owner/mod/admin only.)" },
    { verb: "catalog", usage: "/world catalog", description: "Browse the world catalog (open worlds usable in any room)." },
    { verb: "join", usage: "/world join [slug]", description: "Join an open world (or the room's linked world)." },
    { verb: "leave", usage: "/world leave [slug]", description: "Leave a world (or the room's linked world)." },
    { verb: "primary", usage: "/world primary [slug]", description: "Set your primary world (clears primary if no slug)." },
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
      // Same gate as the route: open worlds (or your own) are joinable.
      if (w.ownerUserId !== ctx.user.id && w.visibility !== "open" && ctx.user.role !== "admin") {
        return notice(ctx, "NOT_OPEN", `"${w.name}" isn't open for community membership.`);
      }
      const existing = (await ctx.db
        .select()
        .from(worldMembers)
        .where(and(eq(worldMembers.worldId, w.id), eq(worldMembers.userId, ctx.user.id)))
        .limit(1))[0];
      if (existing) {
        return notice(ctx, "ALREADY_MEMBER", `You're already a member of "${w.name}".`);
      }
      await ctx.db.insert(worldMembers).values({ worldId: w.id, userId: ctx.user.id, isPrimary: 0 });
      await rebroadcastSelfOccupancy(ctx);
      return notice(ctx, "JOINED", `Joined "${w.name}". /world primary ${w.slug} to display it in the userlist.`);
    }

    if (subLower === "leave") {
      const slug = rest.join(" ").trim();
      const w = await resolveWorldForMembership(ctx, slug);
      if (!w) {
        return notice(ctx, "NO_WORLD", slug
          ? `No visible world with slug "${slug}".`
          : "No world is linked to this room. Pass a slug, e.g. /world leave darkrealm.");
      }
      const r = await ctx.db
        .delete(worldMembers)
        .where(and(eq(worldMembers.worldId, w.id), eq(worldMembers.userId, ctx.user.id)));
      if (r.changes === 0) {
        return notice(ctx, "NOT_MEMBER", `You're not a member of "${w.name}".`);
      }
      await rebroadcastSelfOccupancy(ctx);
      return notice(ctx, "LEFT", `Left "${w.name}".`);
    }

    if (subLower === "primary") {
      const slug = rest.join(" ").trim();
      // No slug = clear primary (matches the PUT /me/primary-world {worldId: null} contract).
      if (!slug) {
        await ctx.db
          .update(worldMembers)
          .set({ isPrimary: 0 })
          .where(and(eq(worldMembers.userId, ctx.user.id), eq(worldMembers.isPrimary, 1)));
        await rebroadcastSelfOccupancy(ctx);
        return notice(ctx, "PRIMARY_CLEARED", "Primary world cleared.");
      }
      const w = await resolveWorldForMembership(ctx, slug);
      if (!w) return notice(ctx, "NO_WORLD", `No visible world with slug "${slug}".`);
      const m = (await ctx.db
        .select()
        .from(worldMembers)
        .where(and(eq(worldMembers.worldId, w.id), eq(worldMembers.userId, ctx.user.id)))
        .limit(1))[0];
      if (!m) {
        return notice(ctx, "NOT_MEMBER", `Join "${w.name}" first: /world join ${w.slug}.`);
      }
      // Single transaction: clear other primaries, set this one. Mirrors
      // the route handler so the partial unique index can't trip us up.
      ctx.db.transaction((tx) => {
        tx.update(worldMembers)
          .set({ isPrimary: 0 })
          .where(and(eq(worldMembers.userId, ctx.user.id), eq(worldMembers.isPrimary, 1)))
          .run();
        tx.update(worldMembers)
          .set({ isPrimary: 1 })
          .where(and(eq(worldMembers.userId, ctx.user.id), eq(worldMembers.worldId, w.id)))
          .run();
      });
      await rebroadcastSelfOccupancy(ctx);
      return notice(ctx, "PRIMARY_SET", `"${w.name}" is now your primary world.`);
    }

    return notice(ctx, "BAD_SUBCMD", "Try /world, /world link <slug>, /world unlink, /world catalog, /world join, /world leave, or /world primary.");
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
