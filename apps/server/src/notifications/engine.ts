/**
 * Notification Center engine — the unified analog of the forum reply engine
 * (forums/notifications.ts), but for EVERY source: server approvals, @mentions,
 * DMs, friend requests, earning milestones, announcements, report outcomes.
 *
 * Callers fire-and-forget `notify` / `notifyMany` AFTER their DB write commits.
 * Each call: inserts a snapshot row (so the inbox survives renames), prunes the
 * recipient's inbox to a cap, pulses their sockets with the fresh row + unread
 * badge, and — when they have no live socket — sends a generic web push so they
 * find out while away. Blocked actors never notify; the actor never notifies
 * themselves; a `dedupeKey` collapses repeats from noisy sources.
 *
 * Best-effort by contract: a notification failure NEVER throws back into the
 * route/realtime action that triggered it (the real side-effect already
 * committed).
 */
import { and, count, desc, eq, gt, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Server as IoServer } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  NotificationBadge,
  NotificationCategory,
  NotificationKind,
  NotificationPage,
  NotificationTargetKind,
  NotificationWire,
} from "@thekeep/shared";
import type { Db } from "../db/index.js";
import { forums, messages, notifications, rooms, servers, users } from "../db/schema.js";
import { blockedUserIdsFor } from "../auth/blocks.js";
import { isIsolatedBetweenIds } from "../auth/ageIsolation.js";
import { cursorPageSlice } from "../lib/pagination.js";
import { pushToUser } from "../push.js";
import { emitToUser, socketsForUser } from "../realtime/presence.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/** Keep at most this many inbox rows per user (oldest pruned on write). */
const MAX_INBOX_ROWS = 300;
const DEFAULT_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

export interface NotifyTarget {
  kind: NotificationTargetKind;
  id?: string | null;
  /** Deep-link path the web-push notificationclick handler opens (e.g. "/s/ashfall"). */
  url?: string | null;
}

export interface NotifyInput {
  /** Recipient account. */
  userId: string;
  /** Recipient identity for DM/@mention scoping; omit for account-level. */
  characterId?: string | null;
  category: NotificationCategory;
  kind: NotificationKind;
  /** Originating server (grouping + rail dots); omit for global. */
  serverId?: string | null;
  /** The user who caused this (drives block-filtering + avatar). */
  actor?: { id: string; name: string } | null;
  title: string;
  snippet?: string;
  target?: NotifyTarget;
  /** Extra deep-link coordinates stored as JSON and surfaced on the wire's
   *  `metadata` (e.g. a mention's `{ messageId }`, a DM's `{ otherCharacterId }`)
   *  so the click can jump to the exact message / open the exact DM thread. */
  metadata?: Record<string, string | number | null> | null;
  /** Collapse repeats: a same-key row within `dedupeWindowMs` is skipped. */
  dedupeKey?: string | null;
  dedupeWindowMs?: number;
  /** Generic push copy (keep it generic for privacy). Omit to derive from
   *  title/snippet; pass `false` to suppress push for this notification. */
  push?: { title: string; body: string } | false;
}

/** Per-user Notification Center preferences. */
export interface NotificationPrefs {
  /** Categories the user has silenced (no inbox row, badge, or push). */
  mutedCategories: NotificationCategory[];
}

/** Read a user's notification prefs (null/garbage → nothing muted). */
export async function getNotificationPrefs(db: Db, userId: string): Promise<NotificationPrefs> {
  const row = (await db.select({ p: users.notificationPrefsJson }).from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!row?.p) return { mutedCategories: [] };
  try {
    const parsed = JSON.parse(row.p) as { mutedCategories?: unknown };
    const muted = Array.isArray(parsed.mutedCategories)
      ? parsed.mutedCategories.filter((c): c is NotificationCategory => typeof c === "string")
      : [];
    return { mutedCategories: muted };
  } catch {
    return { mutedCategories: [] };
  }
}

/** Persist a user's muted-category list. */
export async function setNotificationPrefs(db: Db, userId: string, prefs: NotificationPrefs): Promise<void> {
  await db.update(users)
    .set({ notificationPrefsJson: JSON.stringify({ mutedCategories: prefs.mutedCategories }) })
    .where(eq(users.id, userId));
}

/** Insert one row (honoring self/mute/block/dedupe rules). Returns the new id,
 *  or null when the notification was suppressed. */
async function insertOne(db: Db, input: NotifyInput): Promise<string | null> {
  if (input.actor && input.actor.id === input.userId) return null; // never notify yourself
  // Per-user category mute: a silenced category gets no row, badge, or push.
  const prefs = await getNotificationPrefs(db, input.userId);
  if (prefs.mutedCategories.includes(input.category)) return null;
  if (input.actor) {
    const blocked = await blockedUserIdsFor(db, input.userId);
    if (blocked.has(input.actor.id)) return null;
    // Minor isolation (age plan, Phase 5): an isolated pair must not
    // notify each other either — the actor's name/snippet in an inbox row
    // would leak an account that is supposed to not exist for this
    // recipient. Same suppress-silently posture as the block gate above.
    if (await isIsolatedBetweenIds(db, input.userId, input.actor.id)) return null;
  }
  if (input.dedupeKey) {
    const since = new Date(Date.now() - (input.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS));
    const dup = (await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(
        eq(notifications.userId, input.userId),
        eq(notifications.dedupeKey, input.dedupeKey),
        gt(notifications.createdAt, since),
      ))
      .limit(1))[0];
    if (dup) return null;
  }
  const id = nanoid();
  await db.insert(notifications).values({
    id,
    userId: input.userId,
    characterId: input.characterId ?? null,
    category: input.category,
    kind: input.kind,
    serverId: input.serverId ?? null,
    actorUserId: input.actor?.id ?? null,
    actorName: input.actor?.name ?? null,
    title: input.title,
    snippet: input.snippet ?? "",
    targetKind: input.target?.kind ?? "none",
    targetId: input.target?.id ?? null,
    url: input.target?.url ?? null,
    metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
    dedupeKey: input.dedupeKey ?? null,
  });
  // Prune past the cap (cheap bounded subquery, mirrors the forum engine).
  await db.run(sql`
    DELETE FROM notifications
    WHERE user_id = ${input.userId}
      AND id NOT IN (
        SELECT id FROM notifications
        WHERE user_id = ${input.userId}
        ORDER BY created_at DESC
        LIMIT ${MAX_INBOX_ROWS}
      )`);
  return id;
}

/**
 * Read-time age re-filter (age plan — the bell's analog of the forum
 * engine's nsfwTopicRowFilter): rows don't exist for an inbox OWNER who is
 * CURRENTLY a minor when they point into 18+ content — the row's target
 * room is effectively 18+ right now (its flag, its server's, or its parent
 * forum's), or the exact message the row deep-links to (`metadata.messageId`,
 * how chat mentions are stored) is stamped `is_nsfw`. Mention rows persist a
 * 140-char body snippet, so this covers rooms that flipped 18+ AFTER the
 * row was written and admin DOB corrections that turned an adult account
 * into a minor one — the write-side skips only guard rows created while the
 * recipient was already a minor. Adults are never filtered (HARD tier): the
 * first NOT EXISTS ("the owner is a minor"; NULL birthdate = legacy adult,
 * same SQL age test as isolationVisibleSql) short-circuits for them. Keyed
 * on the owner id, so badge pulses and route fetches need no viewer
 * plumbing — the inbox owner IS the viewer on every read path.
 */
function ageVisibleSql(userId: string): SQL {
  return sql`(
    NOT EXISTS (
      SELECT 1 FROM ${users} age_u
      WHERE age_u.id = ${userId}
        AND age_u.birthdate IS NOT NULL
        AND age_u.birthdate > date('now','-18 years')
    )
    OR (
      NOT EXISTS (
        SELECT 1 FROM ${rooms} r
        LEFT JOIN ${servers} s ON s.id = r.server_id
        LEFT JOIN ${forums} f ON f.id = r.forum_id
        WHERE ${notifications.targetKind} = 'room'
          AND r.id = ${notifications.targetId}
          AND (r.is_nsfw = 1 OR COALESCE(s.is_nsfw, 0) = 1 OR COALESCE(f.is_nsfw, 0) = 1)
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${messages} t
        WHERE t.id = json_extract(${notifications.metadataJson}, '$.messageId')
          AND t.is_nsfw = 1
      )
    )
  )`;
}

/** Total + per-server unread for one user (boot fetch, badge pulses). */
export async function badgeFor(db: Db, userId: string): Promise<NotificationBadge> {
  const unreadRow = (await db
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), ageVisibleSql(userId))))[0];
  const perServer = await db
    .select({ serverId: notifications.serverId, n: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), ageVisibleSql(userId)))
    .groupBy(notifications.serverId);
  const unreadByServer: Record<string, number> = {};
  for (const r of perServer) if (r.serverId) unreadByServer[r.serverId] = r.n;
  return { unread: unreadRow?.n ?? 0, unreadByServer };
}

type NotificationRow = typeof notifications.$inferSelect;

/** Parse the stored metadata JSON into the wire's `metadata` object. Returns
 *  null on absent/garbage so a stray value can't break the inbox fetch. */
function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Hydrate stored rows into wire shape: join the actor's CURRENT avatar and the
 *  server's CURRENT name (everything else is a stored snapshot). */
async function serializeRows(db: Db, rows: NotificationRow[]): Promise<NotificationWire[]> {
  const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x))];
  const serverIds = [...new Set(rows.map((r) => r.serverId).filter((x): x is string => !!x))];
  const avatarMap = new Map<string, string | null>();
  if (actorIds.length) {
    for (const a of await db.select({ id: users.id, avatarUrl: users.avatarUrl }).from(users).where(inArray(users.id, actorIds))) {
      avatarMap.set(a.id, a.avatarUrl);
    }
  }
  const serverMap = new Map<string, string>();
  if (serverIds.length) {
    for (const s of await db.select({ id: servers.id, name: servers.name }).from(servers).where(inArray(servers.id, serverIds))) {
      serverMap.set(s.id, s.name);
    }
  }
  return rows.map((r) => ({
    id: r.id,
    category: r.category as NotificationCategory,
    kind: r.kind as NotificationKind,
    characterId: r.characterId,
    serverId: r.serverId,
    serverName: r.serverId ? serverMap.get(r.serverId) ?? null : null,
    actorUserId: r.actorUserId,
    actorName: r.actorName,
    actorAvatarUrl: r.actorUserId ? avatarMap.get(r.actorUserId) ?? null : null,
    title: r.title,
    snippet: r.snippet,
    targetKind: r.targetKind as NotificationTargetKind,
    targetId: r.targetId,
    url: r.url,
    metadata: parseMetadata(r.metadataJson),
    createdAt: +r.createdAt,
    seenAt: r.seenAt ? +r.seenAt : null,
    readAt: r.readAt ? +r.readAt : null,
  }));
}

/** Push a fresh row (optional) + the unread badge to a user's sockets. Returns
 *  whether the user had at least one live socket (drives the offline-push). */
async function pulse(io: Io, db: Db, userId: string, newRowId?: string): Promise<boolean> {
  const badge = await badgeFor(db, userId);
  const mine = await socketsForUser(io, userId);
  if (newRowId) {
    const row = (await db.select().from(notifications).where(eq(notifications.id, newRowId)).limit(1))[0];
    const wire = row ? (await serializeRows(db, [row]))[0] : undefined;
    if (wire) for (const s of mine) s.emit("notifications:new", wire);
  }
  for (const s of mine) s.emit("notifications:badge", badge);
  return mine.length > 0;
}

/**
 * Per-channel unread pulse (migration 0318). The per-channel analog of
 * {@link pulse}: fan a `room:unread` delta to every live socket belonging to
 * `recipientUserId`, so every tab replaces its cached unread for that room
 * wholesale (0 clears the badge). Clones pulse()'s per-user socket fan-out
 * exactly — one `io.fetchSockets()`, filter by `socket.data.userId`, emit — so
 * the read/mute routes and the broadcast bump share one delivery path.
 *
 * Best-effort by the same contract as the notification pulses: a failure never
 * throws back into the route/broadcast action that triggered it.
 */
export async function pulseRoomUnread(
  io: Io,
  _db: Db,
  recipientUserId: string,
  payload: { roomId: string; serverId: string | null; unread: number; hasMention: boolean },
): Promise<void> {
  try {
    await emitToUser(io, recipientUserId, "room:unread", payload);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[notifications] pulseRoomUnread failed", err);
  }
}

function pushPayload(input: NotifyInput): { title: string; body: string; tag: string; url?: string } {
  const copy = input.push ? input.push : { title: input.title, body: input.snippet ?? "" };
  const base = { title: copy.title, body: copy.body, tag: `notif-${input.category}` };
  const url = deepLinkUrl(input.target, input.serverId ?? null);
  return url ? { ...base, url } : base;
}

/** Deep-link path the web-push notificationclick handler opens (and the client
 *  resolves into an in-app navigation). An explicit `target.url` wins; otherwise
 *  we encode the target as a `?n=<kind>:<id>` marker the SPA reads on focus/boot.
 *  `serverId` (the notification's originating server) is folded into the event
 *  marker so a push-opened fresh tab can switch to the owning server. */
function deepLinkUrl(target?: NotifyTarget, serverId?: string | null): string | undefined {
  if (!target) return undefined;
  if (target.url) return target.url;
  // A community-event reminder deep-links to the event by id. The SPA reads the
  // `?n=event:<id>:<serverId>` marker on focus/boot, switches to the owning
  // server, and opens the events panel to that event (see App.tsx). ids and
  // serverIds are colon-free nanoids, so the extra colon is an unambiguous
  // delimiter. serverId is omitted only if unknown (falls back to event:<id>).
  if (target.kind === "event" && target.id) {
    const marker = serverId ? `event:${target.id}:${serverId}` : `event:${target.id}`;
    return `/?n=${encodeURIComponent(marker)}`;
  }
  if (target.kind !== "none" && target.id) {
    return `/?n=${encodeURIComponent(`${target.kind}:${target.id}`)}`;
  }
  return undefined;
}

/** Deliver ONE notification (persist + live pulse + offline push). */
export async function notify(db: Db, io: Io, input: NotifyInput): Promise<void> {
  try {
    const id = await insertOne(db, input);
    if (!id) return;
    const hadSocket = await pulse(io, db, input.userId, id);
    if (!hadSocket && input.push !== false) {
      await pushToUser(db, input.userId, pushPayload(input)).catch(() => {});
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[notifications] notify failed", err);
  }
}

/** Deliver MANY notifications (e.g. @mentions to N recipients). Inserts each,
 *  then pulses every affected user once. */
export async function notifyMany(db: Db, io: Io, inputs: NotifyInput[]): Promise<void> {
  const lastByUser = new Map<string, { id: string; input: NotifyInput }>();
  for (const input of inputs) {
    try {
      const id = await insertOne(db, input);
      if (id) lastByUser.set(input.userId, { id, input });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[notifications] notifyMany insert failed", err);
    }
  }
  for (const [userId, { id, input }] of lastByUser) {
    try {
      const hadSocket = await pulse(io, db, userId, id);
      if (!hadSocket && input.push !== false) {
        await pushToUser(db, userId, pushPayload(input)).catch(() => {});
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[notifications] notifyMany pulse failed", err);
    }
  }
}

/** Newest-first inbox page (optionally filtered by category), plus unread total. */
export async function listNotifications(
  db: Db,
  userId: string,
  opts: { cursor?: number | null; limit: number; category?: NotificationCategory | null },
): Promise<NotificationPage> {
  // Minor viewers get the age re-filter (see ageVisibleSql): the inbox page
  // must agree with the badge, or the bell shows counts for invisible rows.
  const conds = [eq(notifications.userId, userId), ageVisibleSql(userId)];
  if (opts.category) conds.push(eq(notifications.category, opts.category));
  if (opts.cursor) conds.push(lt(notifications.createdAt, new Date(opts.cursor)));
  const rows = await db
    .select()
    .from(notifications)
    .where(and(...conds))
    .orderBy(desc(notifications.createdAt))
    .limit(opts.limit + 1);
  const { page, nextCursor } = cursorPageSlice(rows, opts.limit, (r) => +r.createdAt);
  const wires = await serializeRows(db, page);
  const badge = await badgeFor(db, userId);
  return { notifications: wires, unread: badge.unread, nextCursor };
}

/** Mark rows (or everything) read+seen; returns the fresh badge and pulses tabs. */
export async function markRead(db: Db, io: Io, userId: string, ids: string[] | "all"): Promise<NotificationBadge> {
  const now = new Date();
  if (ids === "all") {
    await db.update(notifications).set({ readAt: now, seenAt: now })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  } else if (ids.length) {
    await db.update(notifications).set({ readAt: now, seenAt: now })
      .where(and(eq(notifications.userId, userId), inArray(notifications.id, ids), isNull(notifications.readAt)));
  }
  await pulse(io, db, userId);
  return badgeFor(db, userId);
}

/** Mark everything seen (the badge is acknowledged on open, but rows stay
 *  unread until clicked). Does not change the unread count. */
export async function markSeen(db: Db, userId: string): Promise<void> {
  await db.update(notifications).set({ seenAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.seenAt)));
}
