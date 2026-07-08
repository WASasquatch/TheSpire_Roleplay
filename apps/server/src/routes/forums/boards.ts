/**
 * In-modal board reading + the owner console (Phase 1B / Phase 3 / Phase 6).
 *
 *   GET   /forums/boards/:roomId/topics                     topic cards (cursor)
 *   PATCH /forums/:id                                       name/tagline/theme/order/…
 *   POST  /forums/:id/logo | /forums/:id/banner             identity images
 *   POST  /forums/:id/boards/:roomId/categories/:catId/icon category icon
 *   POST  /forums/:id/boards                                raise a board
 *   PATCH /forums/:id/boards/:roomId                        rename / set topic / privacy
 *   POST  /forums/:id/boards/:roomId/archive                retire a board
 *
 * Console mutations are gated by forum ownership (owner or manage_any_forum
 * staff). Forum MODS deliberately fail these — their matrix gives them
 * topic-level tools only.
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  FORUM_NAME_MAX,
  FORUM_NAME_MIN,
  MAX_TAGS_PER_ENTITY,
  normalizeTheme,
  serializeTags,
} from "@thekeep/shared";
import { forums, messages, rooms, users, worlds } from "../../db/schema.js";
import type { Db } from "../../db/index.js";
import { getSessionUser } from "../auth.js";
import { serverAuthority } from "../../servers/authority.js";
import { recordAudit } from "../../audit.js";
import { emitTreeChanged } from "../../realtime/broadcast.js";
import {
  FORUM_BOARD_NAME_RX,
  requireForumOwner as sharedRequireForumOwner,
  resolveTopicAuthorFlair,
  unlinkForumImage as sharedUnlinkForumImage,
  writeForumImage as sharedWriteForumImage,
  type Io,
} from "./shared.js";

export async function registerForumBoardRoutes(app: FastifyInstance, db: Db, io: Io, forumsDir: string): Promise<void> {
  const requireForumOwner = (req: Parameters<typeof getSessionUser>[0], forumId: string) =>
    sharedRequireForumOwner(db, req, forumId);
  const writeForumImage = (prefix: string, dataUrl: string, maxBytes: number) =>
    sharedWriteForumImage(forumsDir, prefix, dataUrl, maxBytes);
  const unlinkForumImage = (url: string | null | undefined) => sharedUnlinkForumImage(forumsDir, url);

  /* =========================================================
   *  In-modal board reading (Phase 1B)
   *
   *  GET /forums/boards/:roomId/topics?before=<ms>&limit=<n>
   *
   *  Topic cards for a board, stickies pinned to the first page, the
   *  rest in lastActivity DESC order with cursor pagination. Forum
   *  gates apply (ban / members-only); the viewer's ignore + block
   *  filters mirror the chat backlog so hidden authors stay hidden.
   *  Reading a single topic reuses the existing
   *  GET /rooms/:roomId/messages/:messageId/thread route.
   * ========================================================= */
  app.get<{
    Params: { roomId: string };
    Querystring: { before?: string; limit?: string };
  }>("/forums/boards/:roomId/topics", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.roomId)).limit(1))[0];
    if (!room || !room.forumId || room.archivedAt) { reply.code(404); return { error: "no board" }; }
    const { forumGateForBoard } = await import("../../forums/authority.js");
    const gate = await forumGateForBoard(db, me, room.forumId);
    if (!gate.ok) { reply.code(403); return { error: gate.message, code: gate.code }; }
    const isMember = gate.authority.isMember;
    // Private board: only owner/mods/members may read it (migration 0239).
    // The board still LISTS in the detail route (shown-but-locked); this
    // refuses its contents so the client renders the lock state.
    if (room.forumMembersOnly && !isMember) {
      reply.code(403);
      return { error: "This board is for forum members only.", code: "FORUM_BOARD_MEMBERS_ONLY" };
    }

    const before = req.query.before ? parseInt(req.query.before, 10) : NaN;
    const hasCursor = Number.isFinite(before) && before > 0;
    const limit = Math.min(50, Math.max(5, parseInt(req.query.limit ?? "30", 10) || 30));

    // Same hide set the chat backlog uses (one-way ignores + mutual blocks).
    const { blockedUserIdsFor } = await import("../../auth/blocks.js");
    const { ignores } = await import("../../db/schema.js");
    const hidden = new Set(
      (await db.select({ ignoredUserId: ignores.ignoredUserId })
        .from(ignores).where(eq(ignores.userId, me.id))).map((r) => r.ignoredUserId),
    );
    for (const b of await blockedUserIdsFor(db, me.id)) hidden.add(b);

    const activityExpr = sql<number>`coalesce(${messages.lastActivityAt}, ${messages.createdAt})`;
    const baseWhere = and(
      eq(messages.roomId, room.id),
      isNotNull(messages.title),
      isNull(messages.deletedAt),
    );

    // Stickies ride the FIRST page only (capped; they're furniture, not a
    // feed). Cursored pages are non-sticky history.
    const stickies = hasCursor ? [] : await db.select().from(messages)
      .where(and(baseWhere, eq(messages.isSticky, true)))
      .orderBy(desc(activityExpr))
      .limit(20);
    const pageRows = await db.select().from(messages)
      .where(and(
        baseWhere,
        eq(messages.isSticky, false),
        hasCursor ? sql`${activityExpr} < ${before}` : undefined,
      ))
      .orderBy(desc(activityExpr))
      .limit(limit + 1);
    const hasMore = pageRows.length > limit;
    const rows = [...stickies, ...(hasMore ? pageRows.slice(0, limit) : pageRows)]
      .filter((m) => !hidden.has(m.userId));

    const ids = rows.map((r) => r.id);
    const replyCounts = ids.length
      ? await db.select({ parentId: messages.replyToId, n: sql<number>`count(*)` })
          .from(messages)
          .where(and(inArray(messages.replyToId, ids), isNull(messages.deletedAt)))
          .groupBy(messages.replyToId)
      : [];
    const repliesBy = new Map(replyCounts.map((r) => [r.parentId, r.n]));

    const { roomThreadCategories } = await import("../../db/schema.js");
    const cats = await db.select().from(roomThreadCategories)
      .where(eq(roomThreadCategories.roomId, room.id))
      .orderBy(roomThreadCategories.sortOrder, roomThreadCategories.createdAt);

    // Private categories: their chips still render (shown-but-locked) but a
    // non-member never sees the topics filed under them. The board itself is
    // open here (board-level gate above already passed).
    const lockedCatIds = new Set(
      isMember ? [] : cats.filter((c) => c.membersOnly).map((c) => c.id),
    );
    const visibleTopics = rows.filter(
      (m) => !(m.threadCategoryId && lockedCatIds.has(m.threadCategoryId)),
    );

    // Per-server author flair (Servers Lift): resolve each topic author's
    // rank sigil / avatar-border / name style from the cosmetics they
    // earned ON THE SERVER THIS FORUM IS AFFILIATED TO. When the forum has
    // NO affiliation (`forums.serverId` NULL) we ship NO flair fields and
    // the cards render bare — the gate is `sid !== null`.
    const sid = (await db.select({ serverId: forums.serverId })
      .from(forums).where(eq(forums.id, room.forumId)).limit(1))[0]?.serverId ?? null;
    const flairByIdentity = sid
      ? await resolveTopicAuthorFlair(
          db,
          sid,
          visibleTopics.map((m) => ({ userId: m.userId, characterId: m.characterId ?? null })),
        )
      : null;

    return {
      boardName: room.name,
      categories: cats.map((c) => ({
        id: c.id, name: c.name, iconUrl: c.iconUrl ?? null, sortOrder: c.sortOrder,
        membersOnly: !!c.membersOnly,
        locked: !!c.membersOnly && !isMember,
      })),
      topics: visibleTopics.map((m) => {
        // Bare card unless the forum is affiliated. When affiliated, spread
        // the resolved per-server flair (values may individually be null
        // for an author who hasn't earned/equipped that cosmetic there).
        const flair = flairByIdentity?.get(`${m.userId}::${m.characterId ?? ""}`) ?? null;
        return {
          id: m.id,
          title: m.title ?? "",
          snippet: m.body.replace(/\s+/g, " ").slice(0, 200),
          authorUserId: m.userId,
          authorDisplayName: m.displayName,
          authorAvatarUrl: m.avatarUrl ?? null,
          authorColor: m.color ?? null,
          characterId: m.characterId ?? null,
          categoryId: m.threadCategoryId ?? null,
          prefixId: m.prefixId ?? null,
          isSticky: !!m.isSticky,
          locked: !!m.lockedAt,
          replyCount: repliesBy.get(m.id) ?? 0,
          createdAt: +m.createdAt,
          lastActivityAt: +(m.lastActivityAt ?? m.createdAt),
          ...(flair
            ? {
                authorRankKey: flair.rankKey,
                authorTier: flair.tier,
                authorSelectedBorderRankKey: flair.selectedBorderRankKey,
                authorSelectedFreeformBorderKey: flair.selectedFreeformBorderKey,
                authorFreeformBorderConfig: flair.freeformBorderConfig,
                authorNameStyleKey: flair.nameStyleKey,
                authorNameStyleConfig: flair.nameStyleConfig,
              }
            : {}),
        };
      }),
      hasMore,
    };
  });

  /* =========================================================
   *  Owner console (Phase 3): forum settings + board management
   * ========================================================= */

  const patchForumBody = z.object({
    name: z.string().trim().min(FORUM_NAME_MIN).max(FORUM_NAME_MAX).optional(),
    tagline: z.string().trim().max(200).nullable().optional(),
    descriptionHtml: z.string().max(5000 * 4).nullable().optional(),
    boardOrder: z.array(z.string()).max(100).optional(),
    /** Phase 5 access gating: who may post. Flipping to "application"
     *  gates non-members on the next board open/post; existing members
     *  keep their rows. Flipping back to "open" simply stops consulting
     *  membership. */
    postingMode: z.enum(["open", "application"]).optional(),
    applicationPrompt: z.string().trim().max(300).nullable().optional(),
    /** Anonymous read access on /f/<slug> (posting still needs login). */
    publicBrowsing: z.boolean().optional(),
    /** Allow mods with create_tags to mint tags on the fly while tagging. */
    allowCustomTags: z.boolean().optional(),
    /** Owner-set discovery tags (genre/category). Round-tripped through
     *  serializeTags on write (lowercased/deduped/clamped); absent = unchanged,
     *  [] clears. Mirrors the chat-server discover tagging. */
    tags: z.array(z.string()).max(MAX_TAGS_PER_ENTITY * 2).optional(),
    /** Phase 6 identity: per-forum theme (JSON string, normalized before
     *  storage; null clears) + linked world (must belong to the FORUM
     *  OWNER and not be private; null unlinks). */
    themeJson: z.string().max(4000).nullable().optional(),
    /** Design style key (ornaments/chrome — "glass" etc.). Stored as-is;
     *  the client's buildOrnamentStyle falls back to the site default for
     *  unknown keys, same loose posture as users.style_key. Null clears. */
    themeStyleKey: z.string().trim().min(1).max(64).nullable().optional(),
    /** Vertical banner focus, 0-100 (percent down the image). */
    bannerFocusY: z.number().int().min(0).max(100).optional(),
    linkedWorldId: z.string().nullable().optional(),
    /** Servers Lift: affiliate this forum to a chat server (`forums.serverId`),
     *  which scopes topic-card author flair to that server's earned cosmetics.
     *  Must be a server the FORUM OWNER owns or can manage. Null un-affiliates
     *  (topic cards go bare). */
    serverId: z.string().nullable().optional(),
  }).strict();

  app.patch<{ Params: { id: string }; Body: unknown }>("/forums/:id", async (req, reply) => {
    const gate = await requireForumOwner(req, req.params.id);
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof patchForumBody>;
    try { body = patchForumBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const update: Partial<typeof forums.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) update.name = body.name;
    if (body.tagline !== undefined) update.tagline = body.tagline?.trim() ? body.tagline.trim() : null;
    if (body.descriptionHtml !== undefined) {
      // Same sanitizer profile bios run through; the description renders
      // inside the catalog + the future /f/ page.
      const { sanitizeBio } = await import("../../auth/html.js");
      update.descriptionHtml = body.descriptionHtml?.trim() ? sanitizeBio(body.descriptionHtml) : null;
    }
    if (body.boardOrder !== undefined) {
      // Persist only ids that are actually this forum's boards — a stale
      // client list can't smuggle foreign room ids into the ordering.
      const own = new Set((await db.select({ id: rooms.id }).from(rooms)
        .where(eq(rooms.forumId, gate.forum.id))).map((r) => r.id));
      update.boardOrderJson = JSON.stringify(body.boardOrder.filter((id) => own.has(id)));
    }
    if (body.postingMode !== undefined) update.postingMode = body.postingMode;
    if (body.publicBrowsing !== undefined) update.publicBrowsing = body.publicBrowsing;
    if (body.allowCustomTags !== undefined) update.allowCustomTags = body.allowCustomTags;
    if (body.tags !== undefined) update.tagsJson = serializeTags(body.tags);
    if (body.applicationPrompt !== undefined) {
      update.applicationPrompt = body.applicationPrompt?.trim() ? body.applicationPrompt.trim() : null;
    }
    if (body.themeJson !== undefined) {
      if (body.themeJson === null || !body.themeJson.trim()) {
        update.themeJson = null;
      } else {
        // normalizeTheme clamps every slot to a sane hex; storing the
        // NORMALIZED form means readers never re-validate.
        try {
          update.themeJson = JSON.stringify(normalizeTheme(JSON.parse(body.themeJson)));
        } catch {
          reply.code(400); return { error: "themeJson must be a JSON theme object" };
        }
      }
    }
    if (body.themeStyleKey !== undefined) {
      update.themeStyleKey = body.themeStyleKey;
    }
    if (body.bannerFocusY !== undefined) {
      update.bannerFocusY = body.bannerFocusY;
    }
    if (body.linkedWorldId !== undefined) {
      if (body.linkedWorldId === null) {
        update.linkedWorldId = null;
      } else {
        // "Link one of the OWNER's worlds" — validated against the forum
        // owner (not the caller) so managing staff can't attach their own
        // world to someone's forum, and private worlds never leak via the
        // public strip.
        const w = (await db.select({ id: worlds.id, ownerUserId: worlds.ownerUserId, visibility: worlds.visibility })
          .from(worlds).where(eq(worlds.id, body.linkedWorldId)).limit(1))[0];
        if (!w || w.ownerUserId !== gate.forum.ownerUserId) {
          reply.code(404); return { error: "That world isn't one of the forum owner's." };
        }
        if (w.visibility === "private") {
          reply.code(409); return { error: "Private worlds can't be linked - the strip would expose them." };
        }
        update.linkedWorldId = w.id;
      }
    }
    if (body.serverId !== undefined) {
      if (body.serverId === null) {
        // Un-affiliate: topic cards drop their per-server flair and render bare.
        update.serverId = null;
      } else {
        // Affiliate to a chat server the FORUM OWNER may manage. Validated
        // against the forum OWNER (not the caller) — same posture as the
        // linked-world check — so managing site staff can't bind someone's
        // forum to a server the owner has no authority over. serverAuthority
        // folds in the owner short-circuit + site `manage_any_server`.
        const ownerRow = (await db.select({ id: users.id, role: users.role })
          .from(users).where(eq(users.id, gate.forum.ownerUserId)).limit(1))[0];
        if (!ownerRow) { reply.code(404); return { error: "forum owner not found" }; }
        const sa = await serverAuthority(db, { id: ownerRow.id, role: ownerRow.role }, body.serverId);
        if (!sa.server) { reply.code(404); return { error: "no such server" }; }
        if (!sa.isOwner) {
          reply.code(403);
          return { error: "You can only affiliate this forum to a server you own or manage." };
        }
        update.serverId = sa.server.id;
      }
    }
    await db.update(forums).set(update).where(eq(forums.id, gate.forum.id));
    return { ok: true };
  });

  /* ---------- Phase 6: identity images (logo / banner / category icons) ---------- */

  const imageBody = z.union([
    z.object({ imageDataUrl: z.string().min(32).max(4_000_000) }).strict(),
    z.object({ clear: z.literal(true) }).strict(),
  ]);

  for (const kind of ["logo", "banner"] as const) {
    const maxBytes = kind === "logo" ? 512 * 1024 : 2 * 1024 * 1024;
    app.post<{ Params: { id: string }; Body: unknown }>(`/forums/:id/${kind}`, async (req, reply) => {
      const gate = await requireForumOwner(req, req.params.id);
      if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
      let body: z.infer<typeof imageBody>;
      try { body = imageBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }
      const column = kind === "logo" ? "logoUrl" as const : "bannerImageUrl" as const;
      const prev = gate.forum[column];
      if ("clear" in body) {
        await db.update(forums).set({ [column]: null, updatedAt: new Date() }).where(eq(forums.id, gate.forum.id));
        unlinkForumImage(prev);
        return { ok: true, url: null };
      }
      const written = await writeForumImage(`${gate.forum.id}-${kind}`, body.imageDataUrl, maxBytes);
      if ("error" in written) { reply.code(written.status); return { error: written.error }; }
      await db.update(forums).set({ [column]: written.url, updatedAt: new Date() }).where(eq(forums.id, gate.forum.id));
      if (prev !== written.url) unlinkForumImage(prev);
      return { ok: true, url: written.url };
    });
  }

  app.post<{ Params: { id: string; roomId: string; catId: string }; Body: unknown }>(
    "/forums/:id/boards/:roomId/categories/:catId/icon",
    async (req, reply) => {
      const gate = await requireForumOwner(req, req.params.id);
      if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
      const board = (await db.select({ id: rooms.id }).from(rooms)
        .where(and(eq(rooms.id, req.params.roomId), eq(rooms.forumId, gate.forum.id))).limit(1))[0];
      if (!board) { reply.code(404); return { error: "no board" }; }
      const { roomThreadCategories } = await import("../../db/schema.js");
      const cat = (await db.select().from(roomThreadCategories)
        .where(and(eq(roomThreadCategories.id, req.params.catId), eq(roomThreadCategories.roomId, board.id))).limit(1))[0];
      if (!cat) { reply.code(404); return { error: "no category" }; }
      let body: z.infer<typeof imageBody>;
      try { body = imageBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }
      if ("clear" in body) {
        await db.update(roomThreadCategories).set({ iconUrl: null }).where(eq(roomThreadCategories.id, cat.id));
        unlinkForumImage(cat.iconUrl);
        return { ok: true, url: null };
      }
      const written = await writeForumImage(`cat-${cat.id}`, body.imageDataUrl, 128 * 1024);
      if ("error" in written) { reply.code(written.status); return { error: written.error }; }
      await db.update(roomThreadCategories).set({ iconUrl: written.url }).where(eq(roomThreadCategories.id, cat.id));
      if (cat.iconUrl !== written.url) unlinkForumImage(cat.iconUrl);
      return { ok: true, url: written.url };
    },
  );

  const createBoardBody = z.object({
    name: z.string().trim().min(1).max(40),
    topic: z.string().trim().max(200).optional(),
  }).strict();

  app.post<{ Params: { id: string }; Body: unknown }>("/forums/:id/boards", async (req, reply) => {
    const gate = await requireForumOwner(req, req.params.id);
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof createBoardBody>;
    try { body = createBoardBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    if (!FORUM_BOARD_NAME_RX.test(body.name)) {
      reply.code(400); return { error: "Board name must be 1-40 chars: letters, numbers, spaces, _ - '" };
    }
    const activeBoards = (await db.select({ n: sql<number>`count(*)` }).from(rooms)
      .where(and(eq(rooms.forumId, gate.forum.id), isNull(rooms.archivedAt))))[0]?.n ?? 0;
    if (activeBoards >= 10) {
      reply.code(409); return { error: "This forum is at its 10-board limit. Archive a board to raise another." };
    }
    // Room names are GLOBALLY unique (a board is a room); friendly 409
    // instead of a UNIQUE explosion.
    const clash = (await db.select({ id: rooms.id }).from(rooms)
      .where(sql`lower(${rooms.name}) = ${body.name.toLowerCase()}`).limit(1))[0];
    if (clash) { reply.code(409); return { error: "A room already uses that name - try a more specific one (board names are site-wide)." }; }

    const boardId = nanoid();
    await db.insert(rooms).values({
      id: boardId,
      name: body.name,
      type: "public",
      ownerId: gate.forum.ownerUserId,
      originalOwnerUserId: gate.forum.ownerUserId,
      lastOwnerUserId: gate.forum.ownerUserId,
      topic: body.topic?.trim() ? body.topic.trim() : null,
      replyMode: "nested",
      forumId: gate.forum.id,
    });
    // A board belongs to its forum, which is homed to a server; the forum
    // row is in hand so its serverId is free. emitTreeChanged falls back to
    // the bare global pulse when the servers flag is off.
    emitTreeChanged(io, gate.forum.serverId);
    await recordAudit(db, {
      actorUserId: gate.me.id,
      action: "forum_board_create",
      targetRoomId: boardId,
      metadata: { forumId: gate.forum.id, slug: gate.forum.slug, boardName: body.name },
    });
    return { roomId: boardId };
  });

  const patchBoardBody = z.object({
    name: z.string().trim().min(1).max(40).optional(),
    topic: z.string().trim().max(200).nullable().optional(),
    /** Private board (migration 0239): owner/mods/members only. */
    membersOnly: z.boolean().optional(),
  }).strict();

  app.patch<{ Params: { id: string; roomId: string }; Body: unknown }>(
    "/forums/:id/boards/:roomId",
    async (req, reply) => {
      const gate = await requireForumOwner(req, req.params.id);
      if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
      const board = (await db.select().from(rooms)
        .where(and(eq(rooms.id, req.params.roomId), eq(rooms.forumId, gate.forum.id))).limit(1))[0];
      if (!board || board.archivedAt) { reply.code(404); return { error: "no board" }; }
      let body: z.infer<typeof patchBoardBody>;
      try { body = patchBoardBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const update: Partial<typeof rooms.$inferInsert> = {};
      if (body.name !== undefined && body.name !== board.name) {
        if (!FORUM_BOARD_NAME_RX.test(body.name)) {
          reply.code(400); return { error: "Board name must be 1-40 chars: letters, numbers, spaces, _ - '" };
        }
        const clash = (await db.select({ id: rooms.id }).from(rooms)
          .where(and(sql`lower(${rooms.name}) = ${body.name.toLowerCase()}`, sql`${rooms.id} != ${board.id}`)).limit(1))[0];
        if (clash) { reply.code(409); return { error: "A room already uses that name." }; }
        update.name = body.name;
      }
      if (body.topic !== undefined) update.topic = body.topic?.trim() ? body.topic.trim() : null;
      if (body.membersOnly !== undefined) update.forumMembersOnly = body.membersOnly;
      if (Object.keys(update).length === 0) return { ok: true };
      await db.update(rooms).set(update).where(eq(rooms.id, board.id));
      // The board (a room) row is in hand, so its serverId is free;
      // emitTreeChanged falls back to the bare global pulse when off.
      emitTreeChanged(io, board.serverId);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string; roomId: string } }>(
    "/forums/:id/boards/:roomId/archive",
    async (req, reply) => {
      const gate = await requireForumOwner(req, req.params.id);
      if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
      const board = (await db.select().from(rooms)
        .where(and(eq(rooms.id, req.params.roomId), eq(rooms.forumId, gate.forum.id))).limit(1))[0];
      if (!board) { reply.code(404); return { error: "no board" }; }
      if (board.archivedAt) return { ok: true };
      // Keep-but-hide: topics stay in the messages table; the board just
      // leaves the catalog. Site admins can resurrect via the admin Rooms
      // tools if a community changes its mind.
      await db.update(rooms).set({ archivedAt: new Date() }).where(eq(rooms.id, board.id));
      // The board (a room) row is in hand, so its serverId is free;
      // emitTreeChanged falls back to the bare global pulse when off.
      emitTreeChanged(io, board.serverId);
      await recordAudit(db, {
        actorUserId: gate.me.id,
        action: "forum_board_archive",
        targetRoomId: board.id,
        metadata: { forumId: gate.forum.id, slug: gate.forum.slug, boardName: board.name },
      });
      return { ok: true };
    },
  );
}
