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
import { and, count, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import type { Db } from "../db/index.js";
import { forumNotifications, forumTopicWatches, forums, messages, rooms, servers, users } from "../db/schema.js";
import { isAdultUser } from "../auth/ageGate.js";
import { isIsolatedBetween, isolationVisibleSql, type IsolationSubject } from "../auth/ageIsolation.js";
import { maskForMinors } from "../realtime/minorLanguageFilter.js";
import { effectiveBoardNsfw } from "./nsfw.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/**
 * Minor-viewer re-filter (age plan, Phase 3): rows don't exist for a minor
 * viewer when the TOPIC is CURRENTLY NSFW-tagged OR the BOARD is currently
 * effectively 18+ (its room flag, its server's, or its parent forum's) —
 * this is what covers "watched it, then it was tagged/flipped": the durable
 * row snapshots title+snippet, so hiding must key on live flags, not on
 * write-time state (a pre-flip topic row is unstamped). Adults are never
 * filtered (HARD tier — hide-pref adults chose to watch or author the
 * thread, so they keep their rows). Returns undefined (no-op clause) for
 * adult viewers.
 */
function nsfwTopicRowFilter(viewer: { isAdult: boolean }): SQL | undefined {
  if (viewer.isAdult) return undefined;
  return sql`NOT EXISTS (
    SELECT 1 FROM ${messages} t
    WHERE t.id = ${forumNotifications.topicId} AND t.is_nsfw = 1
  ) AND NOT EXISTS (
    SELECT 1 FROM ${rooms} r
    LEFT JOIN ${servers} s ON s.id = r.server_id
    LEFT JOIN ${forums} f ON f.id = r.forum_id
    WHERE r.id = ${forumNotifications.boardRoomId}
      AND (r.is_nsfw = 1 OR COALESCE(s.is_nsfw, 0) = 1 OR COALESCE(f.is_nsfw, 0) = 1)
  )`;
}

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

  // Age gate on the WRITE (age plan, Phase 3): NSFW content notifies
  // adults only. Two live flags feed it: the topic's CURRENT tag (re-read
  // rather than trusting the caller's snapshot, so a topic re-tagged while
  // this reply was in flight still write-skips) and the BOARD's effective
  // 18+ rating (its room flag, its server's, or its parent forum's) — a
  // minor who watched a topic while the board was all-ages must stop
  // getting rows the moment the space flips 18+, because the pre-flip
  // topic row is unstamped. The row would otherwise persist the title +
  // a 140-char body snippet, exactly the leak the skip exists to prevent.
  // The recipients' adult-ness is resolved once here and reused by the
  // badge pulse below.
  const topicFlagRow = (await db
    .select({ isNsfw: messages.isNsfw })
    .from(messages)
    .where(eq(messages.id, topic.id))
    .limit(1))[0];
  const boardRow = (await db
    .select({ isNsfw: rooms.isNsfw, serverId: rooms.serverId, forumId: rooms.forumId })
    .from(rooms)
    .where(eq(rooms.id, boardRoomId))
    .limit(1))[0];
  const boardNsfw = boardRow ? await effectiveBoardNsfw(db, boardRow) : false;
  const recipientRows = await db
    .select({
      id: users.id,
      birthdate: users.birthdate,
      role: users.role,
      isolateFromAdults: users.isolateFromAdults,
    })
    .from(users)
    .where(inArray(users.id, [...kinds.keys()]));
  const recipientById = new Map(recipientRows.map((u) => [u.id, u]));
  const adultById = new Map(recipientRows.map((u) => [u.id, isAdultUser(u)]));
  if (topicFlagRow?.isNsfw || boardNsfw) {
    for (const userId of [...kinds.keys()]) {
      if (!adultById.get(userId)) kinds.delete(userId);
    }
    if (kinds.size === 0) return;
  }

  // Isolation write-skip (age plan, Phase 5): an actively-isolated minor
  // and an adult non-staff account are mutually invisible, so neither may
  // land in the other's inbox — the row would persist the actor's display
  // name plus a 140-char body snippet across the fence, and its deep-link
  // dead-ends (the thread route filters isolated-pair content). Mirrors
  // the adult-only skip above and the notification-center engine's gate
  // (notifications/engine.ts). isIsolatedBetween exempts site staff on
  // either side, so staff replies still notify isolated minors and vice
  // versa.
  const actorRow = (await db
    .select({ role: users.role, birthdate: users.birthdate, isolateFromAdults: users.isolateFromAdults })
    .from(users)
    .where(eq(users.id, actor.id))
    .limit(1))[0];
  if (actorRow) {
    for (const r of recipientRows) {
      if (kinds.has(r.id) && isIsolatedBetween(actorRow, r)) kinds.delete(r.id);
    }
    if (kinds.size === 0) return;
  }

  // Snippet = the reply's OWN words: quoted (`> `) lines drop so the
  // inbox shows what the actor said, not what they were quoting (and the
  // quote-reference markup never leaks into notification text).
  const ownWords = body
    .split("\n")
    .filter((l) => !l.trimStart().startsWith(">"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const snippetSource = ownWords || body.replace(/\s+/g, " ").trim();
  const snippet = snippetSource.slice(0, 140);
  const topicTitle = topic.title ?? "a topic";
  // Minor language filter (age plan Phase 7, plan_ext.md §J): rows are
  // per-recipient and persist the title + snippet, so a minor RECIPIENT'S
  // row is written masked while adult recipients' rows stay byte-identical.
  // Masked ONCE and shared across every minor recipient; the snippet is
  // masked on the FULL source before the 140 cut so a term split at the
  // boundary can't leak its unmasked head (masking is length-preserving).
  // A recipient whose users row vanished mid-flight has no adultById entry
  // and fails closed (masked), matching the badge pulse below.
  const anyMinorRecipient = [...kinds.keys()].some((id) => !adultById.get(id));
  const minorSnippet = anyMinorRecipient
    ? (maskForMinors(snippetSource) ?? snippetSource).slice(0, 140)
    : snippet;
  const minorTopicTitle = anyMinorRecipient
    ? (maskForMinors(topicTitle) ?? topicTitle)
    : topicTitle;
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
      topicTitle: adultById.get(userId) ? topicTitle : minorTopicTitle,
      snippet: adultById.get(userId) ? snippet : minorSnippet,
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
  // total. One fetchSockets() pass, grouped by userId. Viewer-aware (a
  // minor recipient's total must not count rows for since-tagged topics);
  // fail closed for a recipient whose users row vanished mid-flight.
  const unreadByUser = new Map<string, number>();
  for (const userId of kinds.keys()) {
    const r = recipientById.get(userId);
    unreadByUser.set(
      userId,
      await unreadForumNotifications(
        db,
        userId,
        r
          ? { isAdult: adultById.get(userId) ?? false, role: r.role, birthdate: r.birthdate, isolateFromAdults: r.isolateFromAdults }
          // Recipient row vanished mid-flight: fail closed (minor-shaped,
          // no isolation class), matching the old `?? false` posture.
          : { isAdult: false, role: "user", birthdate: "9999-01-01", isolateFromAdults: false },
      ),
    );
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

/** The inbox-owner viewer both read functions key their re-filters on:
 *  the HARD age tier (`isAdult`) plus the isolation fields (`IsolationSubject`)
 *  so rows from isolated-pair actors drop at read time too — covering rows
 *  written BEFORE isolation was toggled on (the write-skip only guards new
 *  rows). Route callers pass their session user, which satisfies this
 *  structurally. */
type InboxViewer = { isAdult: boolean } & IsolationSubject;

/** Unread total for one user (boot fetch + after mark-read). `viewer` is
 *  the OWNER of the inbox (routes pass their session user); minors don't
 *  count rows whose topic is currently NSFW-tagged (see nsfwTopicRowFilter),
 *  and isolated-pair actors' rows don't count in either direction. */
export async function unreadForumNotifications(
  db: Db,
  userId: string,
  viewer: InboxViewer,
): Promise<number> {
  const row = (await db
    .select({ n: count() })
    .from(forumNotifications)
    .where(and(
      eq(forumNotifications.userId, userId),
      isNull(forumNotifications.readAt),
      nsfwTopicRowFilter(viewer),
      // Isolation (Phase 5): rows whose ACTOR is across the isolation fence
      // from the inbox owner don't exist for them (covers rows written
      // before the mode was toggled on; the write side skips new ones).
      isolationVisibleSql(viewer, forumNotifications.actorUserId),
    )))[0];
  return row?.n ?? 0;
}

/** Newest-first inbox page, re-filtered at read for minor viewers (the
 *  "watched it, then it was tagged" case — see nsfwTopicRowFilter) and for
 *  isolated pairs (rows predating an isolation toggle — see InboxViewer). */
export async function listForumNotifications(
  db: Db,
  userId: string,
  limit: number,
  viewer: InboxViewer,
) {
  return db
    .select({
      id: forumNotifications.id,
      userId: forumNotifications.userId,
      kind: forumNotifications.kind,
      forumId: forumNotifications.forumId,
      boardRoomId: forumNotifications.boardRoomId,
      topicId: forumNotifications.topicId,
      messageId: forumNotifications.messageId,
      actorUserId: forumNotifications.actorUserId,
      actorName: forumNotifications.actorName,
      topicTitle: forumNotifications.topicTitle,
      snippet: forumNotifications.snippet,
      createdAt: forumNotifications.createdAt,
      readAt: forumNotifications.readAt,
      // Live context labels so the inbox can say WHERE each notice lives
      // ("in <forum> · <board>") — without them the row is just a title
      // and the reader has no idea which forum it came from. LEFT JOINs:
      // a since-deleted forum/board simply drops the context line while
      // the snapshot title keeps the row readable.
      forumName: forums.name,
      boardName: rooms.name,
    })
    .from(forumNotifications)
    .leftJoin(forums, eq(forums.id, forumNotifications.forumId))
    .leftJoin(rooms, eq(rooms.id, forumNotifications.boardRoomId))
    .where(and(
      eq(forumNotifications.userId, userId),
      nsfwTopicRowFilter(viewer),
      isolationVisibleSql(viewer, forumNotifications.actorUserId),
    ))
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
