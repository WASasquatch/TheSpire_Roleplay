/**
 * Event-time IP capture.
 *
 * `sessions.ip` is written once, at login. A session's idle TTL defaults to
 * 30 days, so for a user who stays logged in that column keeps reporting the
 * address they first authenticated from even after they've roamed to a new
 * network (mobile handoff, VPN toggle, travelling). The admin alt-detection
 * in /admin/users reads `sessions.ip`, so without this it slowly drifts out
 * of date and misses every address a long-lived session visits.
 *
 * This module records the *current* client IP on real activity - socket
 * connect, room switch, chat send, and authenticated HTTP writes - into the
 * `user_ip_log` rollup, keyed (user_id, ip). Each distinct address a user
 * touches gets one row whose `last_seen_at` is bumped on subsequent activity.
 *
 * Writes are throttled in-process so a chat spammer can't turn this into a
 * SQLite write storm: at most one write per (key) per THROTTLE_MS. The
 * throttle key includes the IP, so a *new* address for the same user/session
 * is always recorded immediately - which is exactly the case moderation
 * cares about.
 */
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { sessions, userIpLog } from "../db/schema.js";
import type { Db } from "../db/index.js";

/** One effective write per key per minute. */
const THROTTLE_MS = 60_000;
/** Garbage-collect the throttle map once it grows past this many keys. */
const GC_AT = 5_000;

const lastWrite = new Map<string, number>();

function gc(now: number): void {
  if (lastWrite.size < GC_AT) return;
  for (const [k, t] of lastWrite) {
    if (now - t > THROTTLE_MS) lastWrite.delete(k);
  }
}

/** Returns true the first time `key` is seen in a THROTTLE_MS window, then
 *  false until the window lapses. Records `now` as the new mark when true. */
function admit(key: string, now: number): boolean {
  const prev = lastWrite.get(key);
  if (prev !== undefined && now - prev < THROTTLE_MS) return false;
  lastWrite.set(key, now);
  gc(now);
  return true;
}

async function upsert(
  db: Db,
  userId: string,
  ip: string,
  userAgent: string | null,
  event: string,
  now: number,
): Promise<void> {
  const when = new Date(now);
  await db
    .insert(userIpLog)
    .values({
      id: nanoid(21),
      userId,
      ip,
      firstSeenAt: when,
      lastSeenAt: when,
      hitCount: 1,
      lastUserAgent: userAgent,
      lastEvent: event,
    })
    .onConflictDoUpdate({
      target: [userIpLog.userId, userIpLog.ip],
      set: {
        lastSeenAt: when,
        hitCount: sql`${userIpLog.hitCount} + 1`,
        lastUserAgent: userAgent,
        lastEvent: event,
      },
    });
}

/**
 * Record a socket's current IP for a known user. The socket's IP is fixed for
 * the life of the TCP connection, so the connect call alone covers every chat
 * send / room switch on that connection; calling it again from per-event hooks
 * just keeps `last_seen_at` fresh and is a no-op under the throttle. A network
 * change forces a reconnect, which re-keys (new ip) and captures immediately.
 *
 * Fire-and-forget: telemetry must never add latency to or fail a socket event.
 */
export function recordSocketIp(
  db: Db,
  userId: string | null | undefined,
  ip: string | null | undefined,
  userAgent: string | null | undefined,
  event: string,
): void {
  if (!userId || !ip) return;
  const now = Date.now();
  if (!admit(`s:${userId}:${ip}`, now)) return;
  void upsert(db, userId, ip, userAgent ?? null, event, now).catch(() => {});
}

/**
 * Record an authenticated HTTP request's IP. Keyed on the bearer token so the
 * cheap throttle check runs before any DB work: a tab firing many requests
 * does one session lookup + write per minute, the rest short-circuit with no
 * query at all. Anonymous / expired sessions are skipped.
 *
 * Fire-and-forget for the same reason as the socket path.
 */
export function recordHttpIp(
  db: Db,
  sid: string | null | undefined,
  ip: string | null | undefined,
  userAgent: string | null | undefined,
): void {
  if (!sid || !ip) return;
  const now = Date.now();
  if (!admit(`h:${sid}:${ip}`, now)) return;
  void (async () => {
    const row = (await db
      .select({ userId: sessions.userId, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.id, sid))
      .limit(1))[0];
    if (!row || +row.expiresAt < now) return;
    await upsert(db, row.userId, ip, userAgent ?? null, "http", now);
  })().catch(() => {});
}

/**
 * Best-effort client IP for a websocket handshake. socket.io is attached to
 * the raw HTTP server and doesn't go through Fastify's `trustProxy`, so we
 * reproduce that resolution by hand: first hop of X-Forwarded-For, then Fly's
 * `Fly-Client-IP`, then the socket's own remote address. Mirrors what
 * `req.ip` yields for HTTP routes behind the same edge proxy.
 */
export function extractSocketIp(handshake: {
  headers: Record<string, string | string[] | undefined>;
  address?: string;
}): string | null {
  const xff = handshake.headers["x-forwarded-for"];
  const xffStr = Array.isArray(xff) ? xff[0] : xff;
  if (typeof xffStr === "string" && xffStr.length > 0) {
    const first = xffStr.split(",")[0]?.trim();
    if (first) return first;
  }
  const fly = handshake.headers["fly-client-ip"];
  const flyStr = Array.isArray(fly) ? fly[0] : fly;
  if (typeof flyStr === "string" && flyStr.trim()) return flyStr.trim();
  const addr = handshake.address;
  return addr && addr.length > 0 ? addr : null;
}
