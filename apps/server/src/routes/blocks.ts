/**
 * Block management API, the HTTP side of the global mutual Block feature.
 *
 *   GET    /me/blocks            , list everyone I've blocked (Privacy tab)
 *   POST   /me/blocks            , block a user (profile "Block" button)
 *   DELETE /me/blocks/:userId    , lift a block I created (Privacy tab)
 *
 * Blocks are global + mutual + keyed on the master userId; see auth/blocks.ts
 * for the read helpers every other surface uses to enforce invisibility.
 * Enforcement lives at those surfaces; this module only mutates the list and
 * fires the live-refresh fan-out.
 */
import type { FastifyInstance } from "fastify";
import type { Server as IoServer } from "socket.io";
import { desc, eq } from "drizzle-orm";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import { blocks, characters, users } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { createBlock, deleteBlock, isBlockedBetween, isBlockProtected } from "../auth/blocks.js";
import { notifyBlockChange } from "../realtime/broadcast.js";
import { resolveIdentityArg } from "../commands/identityArg.js";
import { getSessionUser } from "./auth.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

export async function registerBlockRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  /** Everyone I (the master account) have blocked, newest first. The blocked
   *  user never appears in their own list of who blocked them, only the
   *  blocker sees the row, and only the blocker can remove it. */
  app.get("/me/blocks", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const rows = await db
      .select({
        userId: blocks.blockedUserId,
        username: users.username,
        avatarUrl: users.avatarUrl,
        createdAt: blocks.createdAt,
      })
      .from(blocks)
      .innerJoin(users, eq(users.id, blocks.blockedUserId))
      .where(eq(blocks.blockerUserId, me.id))
      .orderBy(desc(blocks.createdAt));
    return {
      blocks: rows.map((r) => ({
        userId: r.userId,
        username: r.username,
        avatarUrl: r.avatarUrl ?? null,
        createdAt: +r.createdAt,
      })),
    };
  });

  /**
   * Block a user. Accepts (in priority order) an explicit `targetUserId`, a
   * `targetCharacterId` (resolved to its owner), or a free-text `name` /
   * identity token. Always resolves to the MASTER userId so the block spans
   * every character on both sides. Self-blocking is rejected; a redundant
   * block is a quiet 200.
   */
  app.post<{ Body: { targetUserId?: string; targetCharacterId?: string; name?: string } }>(
    "/me/blocks",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }

      let targetUserId: string | null = null;
      const body = req.body ?? {};
      if (typeof body.targetUserId === "string" && body.targetUserId.trim()) {
        const u = (await db
          .select({ id: users.id, disabledAt: users.disabledAt })
          .from(users)
          .where(eq(users.id, body.targetUserId.trim()))
          .limit(1))[0];
        if (!u || u.disabledAt) { reply.code(404); return { error: "no_user" }; }
        targetUserId = u.id;
      } else if (typeof body.targetCharacterId === "string" && body.targetCharacterId.trim()) {
        const c = (await db
          .select({ userId: characters.userId, deletedAt: characters.deletedAt })
          .from(characters)
          .where(eq(characters.id, body.targetCharacterId.trim()))
          .limit(1))[0];
        if (!c || c.deletedAt) { reply.code(404); return { error: "no_user" }; }
        targetUserId = c.userId;
      } else if (typeof body.name === "string" && body.name.trim()) {
        const resolution = await resolveIdentityArg(db, body.name.trim());
        if (resolution.kind === "none") { reply.code(404); return { error: "no_user" }; }
        if (resolution.kind === "ambiguous") {
          reply.code(409);
          return { error: "ambiguous", matches: resolution.matches };
        }
        targetUserId = resolution.target.userId;
      } else {
        reply.code(400); return { error: "target required" };
      }

      if (targetUserId === me.id) { reply.code(400); return { error: "self" }; }
      // Moderators and admins can't be blocked (by anyone, including other
      // staff). Same rule as the /block command.
      if (await isBlockProtected(db, targetUserId)) {
        reply.code(403); return { error: "cannot_block_staff" };
      }

      const created = await createBlock(db, me.id, targetUserId);
      // Only fan out the live refresh when the relationship actually changed
      // (a re-block of someone already blocked is a no-op).
      if (created) await notifyBlockChange(io, db, me.id, targetUserId, true);
      reply.code(created ? 201 : 200);
      return { ok: true, userId: targetUserId };
    },
  );

  /** Lift a block I created. No-op-success if it wasn't there (keeps the
   *  Privacy-tab Remove button idempotent across double-clicks / stale lists). */
  app.delete<{ Params: { userId: string } }>("/me/blocks/:userId", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const targetUserId = req.params.userId;
    const removed = await deleteBlock(db, me.id, targetUserId);
    // Only fan out when the EFFECTIVE state changed. If the other party also
    // blocked us (a reciprocal row in the opposite direction), the pair stays
    // mutually invisible after we drop our row, so there's nothing to repaint
    // or un-hide, telling clients "unblocked" then would wrongly resurface
    // the still-blocked user.
    if (removed && !(await isBlockedBetween(db, me.id, targetUserId))) {
      await notifyBlockChange(io, db, me.id, targetUserId, false);
    }
    return { ok: true };
  });
}
