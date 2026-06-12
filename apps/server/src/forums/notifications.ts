/**
 * Forum notification engine (Forums revamp — notification center).
 *
 * Called fire-and-forget from the `forum:post` reply path AFTER the post
 * persists. One new reply can interest three audiences:
 *
 *   - quote:  authors whose posts the reply quotes (the Quote button's
 *             `> **Name** wrote:` attribution lines, matched against the
 *             thread's actual authors so display-name spoofing in prose
 *             can't trigger it)
 *   - reply:  the topic's author ("someone answered your topic")
 *   - watch:  everyone subscribed to the topic
 *
 * A recipient gets ONE row per post — the most specific kind wins
 * (quote > reply > watch) — and the actor never notifies themselves.
 * Rows carry display SNAPSHOTS (actor name, topic title, snippet) so the
 * inbox stays readable after renames; FKs cascade so deleted content
 * takes its notifications with it. Each recipient's sockets get a
 * `forum:notifications` pulse with their fresh unread total.
 */
import { and, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import type { Db } from "../db/index.js";
import { forumNotifications, forumTopicWatches, messages } from "../db/schema.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/** Keep at most this many inbox rows per user (oldest pruned on write). */
const MAX_INBOX_ROWS = 300;

/** Legacy quote attribution lines (`> **Name** wrote:`) from before the
 *  attribution carried a message reference. Kept so re-quoted old posts
 *  still notify. */
const QUOTE_ATTRIBUTION_RX = /^> \*\*(.+?)\*\* wrote:\s*$/gm;

/** Quoted-post references (`[wrote:](msg:<id>)`) — the exact post the
 *  Quote button captured. Preferred over name matching: renames and
 *  same-name characters can't misroute the notification. */
const QUOTE_REF_RX = /\]\(msg:([A-Za-z0-9_-]{4,64})\)/g;

export async function notifyForumReply(db: Db, io: Io, args: {
  forumId: string;
  boardRoomId: string;
  /** The parent TOPIC row (id, userId, title). */
  topic: { id: string; userId: string; title: string | null };
  /** The freshly-persisted reply. */
  messageId: string;
  body: string;
  actor: { id: string; displayName: string };
}): Promise<void> {
  const { forumId, boardRoomId, topic, messageId, body, actor } = args;

  // Most-specific-kind-wins map.
  const kinds = new Map<string, "reply" | "quote" | "watch">();

  const watchers = await db
    .select({ userId: forumTopicWatches.userId })
    .from(forumTopicWatches)
    .where(eq(forumTopicWatches.topicId, topic.id));
  for (const w of watchers) {
    if (w.userId !== actor.id) kinds.set(w.userId, "watch");
  }

  if (topic.userId !== actor.id) kinds.set(topic.userId, "reply");

  // Quoted authors, two generations of attribution:
  //   1. `[wrote:](msg:<id>)` references → resolve the EXACT quoted
  //      post's author (board-scoped so a pasted foreign id can't fish
  //      notifications across rooms).
  //   2. Legacy `> **Name** wrote:` lines → match names against the
  //      thread's real author roster.
  const quotedIds = new Set<string>();
  for (const m of body.matchAll(QUOTE_REF_RX)) {
    if (m[1]) quotedIds.add(m[1]);
  }
  if (quotedIds.size > 0) {
    const quotedRows = await db
      .select({ userId: messages.userId, roomId: messages.roomId })
      .from(messages)
      .where(inArray(messages.id, [...quotedIds].slice(0, 20)));
    for (const q of quotedRows) {
      if (q.roomId === boardRoomId && q.userId !== actor.id) {
        kinds.set(q.userId, "quote");
      }
    }
  }
  const quotedNames = new Set<string>();
  for (const m of body.matchAll(QUOTE_ATTRIBUTION_RX)) {
    const name = m[1]?.trim();
    if (name) quotedNames.add(name);
  }
  if (quotedNames.size > 0) {
    const authors = await db
      .select({ userId: messages.userId, displayName: messages.displayName })
      .from(messages)
      .where(and(
        or(eq(messages.id, topic.id), eq(messages.replyToId, topic.id)),
        isNull(messages.deletedAt),
      ));
    for (const a of authors) {
      if (a.userId !== actor.id && quotedNames.has(a.displayName)) {
        kinds.set(a.userId, "quote");
      }
    }
  }

  if (kinds.size === 0) return;

  // Snippet = the reply's OWN words: quoted (`> `) lines drop so the
  // inbox shows what the actor said, not what they were quoting (and the
  // quote-reference markup never leaks into notification text).
  const ownWords = body
    .split("\n")
    .filter((l) => !l.trimStart().startsWith(">"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const snippet = (ownWords || body.replace(/\s+/g, " ").trim()).slice(0, 140);
  const topicTitle = topic.title ?? "a topic";
  const now = new Date();
  await db.insert(forumNotifications).values(
    [...kinds.entries()].map(([userId, kind]) => ({
      id: nanoid(),
      userId,
      kind,
      forumId,
      boardRoomId,
      topicId: topic.id,
      messageId,
      actorUserId: actor.id,
      actorName: actor.displayName,
      topicTitle,
      snippet,
      createdAt: now,
    })),
  );

  // Prune each recipient's inbox past the cap (cheap: bounded subquery).
  for (const userId of kinds.keys()) {
    await db.run(sql`
      DELETE FROM forum_notifications
      WHERE user_id = ${userId}
        AND id NOT IN (
          SELECT id FROM forum_notifications
          WHERE user_id = ${userId}
          ORDER BY created_at DESC
          LIMIT ${MAX_INBOX_ROWS}
        )`);
  }

  // Live badge pulse: each recipient's sockets get their fresh unread
  // total. One fetchSockets() pass, grouped by userId.
  const unreadByUser = new Map<string, number>();
  for (const userId of kinds.keys()) {
    const row = (await db
      .select({ n: count() })
      .from(forumNotifications)
      .where(and(eq(forumNotifications.userId, userId), isNull(forumNotifications.readAt))))[0];
    unreadByUser.set(userId, row?.n ?? 0);
  }
  const socks = await io.fetchSockets();
  for (const s of socks) {
    const uid = (s.data as { userId?: string }).userId;
    if (!uid) continue;
    const unread = unreadByUser.get(uid);
    if (unread !== undefined) s.emit("forum:notifications", { unread });
  }
}

/** Auto-watch helper: authors watch their own topics, repliers watch
 *  what they reply to. Idempotent (PK upsert-ignore). */
export async function ensureTopicWatch(db: Db, userId: string, topicId: string): Promise<void> {
  await db.insert(forumTopicWatches)
    .values({ userId, topicId })
    .onConflictDoNothing();
}

/** Unread total for one user (boot fetch + after mark-read). */
export async function unreadForumNotifications(db: Db, userId: string): Promise<number> {
  const row = (await db
    .select({ n: count() })
    .from(forumNotifications)
    .where(and(eq(forumNotifications.userId, userId), isNull(forumNotifications.readAt))))[0];
  return row?.n ?? 0;
}

/** Newest-first inbox page. */
export async function listForumNotifications(db: Db, userId: string, limit: number) {
  return db
    .select()
    .from(forumNotifications)
    .where(eq(forumNotifications.userId, userId))
    .orderBy(desc(forumNotifications.createdAt))
    .limit(limit);
}

/** Mark specific rows (or everything) read. */
export async function markForumNotificationsRead(db: Db, userId: string, ids: string[] | "all"): Promise<void> {
  const now = new Date();
  if (ids === "all") {
    await db.update(forumNotifications)
      .set({ readAt: now })
      .where(and(eq(forumNotifications.userId, userId), isNull(forumNotifications.readAt)));
    return;
  }
  if (ids.length === 0) return;
  await db.update(forumNotifications)
    .set({ readAt: now })
    .where(and(
      eq(forumNotifications.userId, userId),
      inArray(forumNotifications.id, ids),
      isNull(forumNotifications.readAt),
    ));
}
