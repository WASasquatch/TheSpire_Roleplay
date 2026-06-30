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
import { and, count, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
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
import { notifications, servers, users } from "../db/schema.js";
import { blockedUserIdsFor } from "../auth/blocks.js";
import { pushToUser } from "../push.js";

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

/** Total + per-server unread for one user (boot fetch, badge pulses). */
export async function badgeFor(db: Db, userId: string): Promise<NotificationBadge> {
  const unreadRow = (await db
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt))))[0];
  const perServer = await db
    .select({ serverId: notifications.serverId, n: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .groupBy(notifications.serverId);
  const unreadByServer: Record<string, number> = {};
  for (const r of perServer) if (r.serverId) unreadByServer[r.serverId] = r.n;
  return { unread: unreadRow?.n ?? 0, unreadByServer };
}

type NotificationRow = typeof notifications.$inferSelect;

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
    createdAt: +r.createdAt,
    seenAt: r.seenAt ? +r.seenAt : null,
    readAt: r.readAt ? +r.readAt : null,
  }));
}

/** Push a fresh row (optional) + the unread badge to a user's sockets. Returns
 *  whether the user had at least one live socket (drives the offline-push). */
async function pulse(io: Io, db: Db, userId: string, newRowId?: string): Promise<boolean> {
  const badge = await badgeFor(db, userId);
  const socks = await io.fetchSockets();
  const mine = socks.filter((s) => (s.data as { userId?: string }).userId === userId);
  if (newRowId) {
    const row = (await db.select().from(notifications).where(eq(notifications.id, newRowId)).limit(1))[0];
    const wire = row ? (await serializeRows(db, [row]))[0] : undefined;
    if (wire) for (const s of mine) s.emit("notifications:new", wire);
  }
  for (const s of mine) s.emit("notifications:badge", badge);
  return mine.length > 0;
}

function pushPayload(input: NotifyInput): { title: string; body: string; tag: string; url?: string } {
  const copy = input.push ? input.push : { title: input.title, body: input.snippet ?? "" };
  const base = { title: copy.title, body: copy.body, tag: `notif-${input.category}` };
  const url = deepLinkUrl(input.target);
  return url ? { ...base, url } : base;
}

/** Deep-link path the web-push notificationclick handler opens (and the client
 *  resolves into an in-app navigation). An explicit `target.url` wins; otherwise
 *  we encode the target as a `?n=<kind>:<id>` marker the SPA reads on focus/boot. */
function deepLinkUrl(target?: NotifyTarget): string | undefined {
  if (!target) return undefined;
  if (target.url) return target.url;
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
  const conds = [eq(notifications.userId, userId)];
  if (opts.category) conds.push(eq(notifications.category, opts.category));
  if (opts.cursor) conds.push(lt(notifications.createdAt, new Date(opts.cursor)));
  const rows = await db
    .select()
    .from(notifications)
    .where(and(...conds))
    .orderBy(desc(notifications.createdAt))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const wires = await serializeRows(db, page);
  const badge = await badgeFor(db, userId);
  const last = page[page.length - 1];
  const nextCursor = rows.length > opts.limit && last ? +last.createdAt : null;
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
