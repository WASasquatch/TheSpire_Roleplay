// Socket.IO connection admission: the per-IP handshake throttle and the
// auth/session handshake middleware. Extracted verbatim from index.ts so the
// entrypoint's main() stays a thin orchestrator; the logic and ordering are
// unchanged.
import { eq } from "drizzle-orm";
import { Server as IoServer } from "socket.io";
import { loadSessionUser, resolveDisplayName } from "./auth/session.js";
import { extractSocketIp } from "./auth/ipLog.js";
import { isIpBanned, isBlockableIp } from "./auth/ipBan.js";
import { userIdFromSessionId } from "./routes/auth.js";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import type { Db } from "./db/index.js";
import { characters } from "./db/schema.js";

/**
 * Per-IP socket handshake throttle. Socket.io handshakes attach to the raw HTTP
 * server and BYPASS Fastify's rate limiter, and each admitted handshake runs
 * ~4-6 DB queries (isIpBanned + userIdFromSessionId + loadSessionUser +
 * resolveDisplayName + character-ownership). A reconnect storm (a runaway /
 * looping client with no backoff) would hammer that path with zero
 * backpressure, so this caps it in-process BEFORE any DB work in io.use.
 *
 * Bucket: client IP (extractSocketIp's first-XFF-hop = the true client behind
 * Fly's edge, so buckets are per-real-client, not collapsed onto the proxy).
 * Window: 10s. Max: 40 connects/window → sustained ceiling ~4 handshakes/sec/IP.
 * Rationale: a real human reconnects a handful of times per minute at worst
 * (network blip, mobile suspend/resume, wake); a deploy reconnects everyone
 * ONCE; even a chunky NAT/CGNAT egress with dozens of tabs reconnecting after a
 * deploy fits inside a single window. Real abuse is qualitatively different —
 * dozens-per-second SUSTAINED — which blows past 40 immediately and stays
 * blocked while it keeps hammering, then auto-clears one window after it idles.
 * A blocked handshake still records its timestamp so a sustained flood keeps the
 * counter saturated; a legit burst that briefly overshoots recovers within ~10s.
 * MAX is the single safe knob to raise if a huge shared IP ever proves tight.
 *
 * Dev-exempt: isBlockableIp is false for null / loopback / RFC1918 / link-local
 * / ULA, so local dev (127.0.0.1 / ::1), the Fly internal 172.16.x hop, and any
 * reverse-proxy-internal address are never throttled — only real routable
 * public IPs are counted.
 *
 * Memory: self-healing per-key (each admit prunes that key to the window and
 * drops it entirely when its pruned array is empty), plus a size-gated global
 * sweep so a flood of one-shot churned IPs (e.g. rotating XFF) can't grow the
 * Map past HANDSHAKE_GC_AT keys.
 */
const HANDSHAKE_WINDOW_MS = 10_000;
const HANDSHAKE_MAX = 40;
const HANDSHAKE_GC_AT = 20_000;
const handshakeHits = new Map<string, number[]>();

function admitHandshake(ip: string, now: number): boolean {
  const cutoff = now - HANDSHAKE_WINDOW_MS;
  const list = (handshakeHits.get(ip) ?? []).filter((t) => t >= cutoff);
  list.push(now);
  if (list.length > HANDSHAKE_MAX) {
    // Over the ceiling: keep the appended list stored so sustained hammering
    // stays saturated and the IP remains throttled until it goes quiet for a
    // full window. No GC on the reject path — the flood keeps this key hot.
    handshakeHits.set(ip, list);
    return false;
  }
  if (list.length === 0) handshakeHits.delete(ip);
  else handshakeHits.set(ip, list);
  // Size-gated global sweep: reclaim idle/churned keys so a rotating-IP flood
  // can't grow the Map unbounded. Fires only past a ceiling far above any real
  // concurrent-distinct-public-IP count.
  if (handshakeHits.size >= HANDSHAKE_GC_AT) {
    for (const [k, arr] of handshakeHits) {
      const kept = arr.filter((t) => t >= cutoff);
      if (kept.length === 0) handshakeHits.delete(k);
      else handshakeHits.set(k, kept);
    }
  }
  return true;
}

/**
 * Install the socket auth handshake, pulls the session id from the client's
 * `auth: { token: ... }` handshake field. That field is set by the
 * web client from sessionStorage, so a fresh tab without a token
 * gets rejected at connect time and the user lands back on the
 * splash + login flow.
 *
 * We accept the token at two well-known shapes: `auth.token` (our
 * canonical) or the legacy `auth.sid` (Socket.io's "set whatever
 * key you like" surface, kept tolerant for future clients).
 */
export function installHandshake(
  io: IoServer<ClientToServerEvents, ServerToClientEvents>,
  db: Db,
): void {
  io.use(async (socket, next) => {
    try {
      // Resolve the client IP once, up front — reused by both the handshake
      // throttle and the ban check so we don't re-parse the XFF/Fly headers.
      const ip = extractSocketIp(socket.handshake);
      // PER-IP handshake throttle — runs FIRST, before any DB work. The
      // handshake bypasses Fastify's rate limiter, and admitting one costs
      // ~4-6 DB queries below, so a reconnect storm from one runaway/looping IP
      // is the uncapped DoS path. Cap it here: over ~40 connects/10s per public
      // IP, reject with connect_error (socket.io then backs off) BEFORE the ban
      // /auth/tabChar lookups ever fire. Non-public IPs (dev/NAT hops) are
      // exempt via isBlockableIp; null IPs skip too (never reject on our own
      // inability to identify a client). See admitHandshake for tuning.
      if (isBlockableIp(ip) && !admitHandshake(ip, Date.now())) {
        return next(new Error("rate"));
      }
      // HARDENED IP ban — reject the handshake outright from a blocked IP, so a
      // pre-ban session token can't keep a banned network connected. Exact
      // (async DB) check; the handshake bypasses Fastify's onRequest gate.
      if (await isIpBanned(db, ip)) {
        return next(new Error("restricted"));
      }
      const a = socket.handshake.auth as {
        token?: unknown;
        sid?: unknown;
        intent?: unknown;
        tabCharId?: unknown;
        tabRoomId?: unknown;
        tabServerId?: unknown;
      } | undefined;
      const raw = typeof a?.token === "string" ? a.token : typeof a?.sid === "string" ? a.sid : "";
      const sid = raw.trim();
      if (!sid) return next(new Error("unauthenticated"));
      const userId = await userIdFromSessionId(db, sid);
      if (!userId) return next(new Error("unauthenticated"));
      const user = await loadSessionUser(db, userId);
      if (!user) return next(new Error("unauthenticated"));
      // Stash the sid so per-event handlers (and the janitor sweep) can
      // verify the session row is still alive. The userId/user fields stay
      // for backwards-compatibility with handlers that reference them.
      (socket.data as { userId: string }).userId = userId;
      (socket.data as { user: typeof user }).user = user;
      (socket.data as { sid: string }).sid = sid;
      // `intent === "login"` flags this connection as the one created
      // immediately after a fresh login / register submit. The client
      // consumes a one-shot sessionStorage marker so this is set on
      // exactly the first socket connect after a form submit, never
      // on socket reconnects, never on page reloads. The join broadcast
      // gates the "X has connected." chat message on this flag so
      // mobile suspend / network blip / tab reload no longer spam the
      // chat log; only an actual login produces the announcement.
      (socket.data as { loginIntent?: boolean }).loginIntent = a?.intent === "login";
      // Per-tab active character. Two seed sources, in order of priority:
      //
      //   1. `auth.tabCharId`, the client's persisted per-tab identity,
      //      replayed on every (re)connect from sessionStorage. The
      //      string value is a character id; `null` is an explicit OOC
      //      choice; undefined/missing means "no override, fall back to
      //      the DB". This is the multi-tab safety net: without it, a
      //      reconnect would re-seed from `users.activeCharacterId`,
      //      which a sibling tab may have mutated, the reconnected tab
      //      would then start posting messages tagged with the sibling
      //      tab's character even though its own UI still shows the
      //      original identity.
      //
      //   2. `user.activeCharacterId`, the DB default, used on the
      //      very first connect of a new tab before any /char has been
      //      issued. Always falls through to OOC when the user has no
      //      character set.
      //
      // We validate any string id against `characters` to ensure the
      // user actually owns it (defensive: handshake auth is client-
      // supplied, so don't trust the id blind). Invalid ids degrade
      // silently to the DB default, same behavior as a stale tab
      // whose character was deleted by another session.
      let tabCharId: string | null = user.activeCharacterId;
      if (typeof a?.tabCharId === "string") {
        const c = (await db
          .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
          .from(characters)
          .where(eq(characters.id, a.tabCharId))
          .limit(1))[0];
        if (c && c.userId === userId && !c.deletedAt) {
          tabCharId = c.id;
        }
      } else if (a?.tabCharId === null) {
        // Explicit OOC handshake, the user's last action on this tab
        // was /char clear (or never switched in), and they want to
        // stay master-voiced even though the DB may default elsewhere.
        tabCharId = null;
      }
      (socket.data as { tabCharId?: string | null }).tabCharId = tabCharId;
      // Per-tab last-known room. Same rationale as tabCharId: each tab
      // tracks its own room separately so a server restart / refresh
      // puts it back where IT was, instead of inheriting whatever
      // `users.lastRoomId` happens to hold (an account-global slot that
      // multiple tabs on different devices race to write). Stored raw
      // here, the connection handler validates existence /
      // public-vs-private / ban state before joining.
      if (typeof a?.tabRoomId === "string" && a.tabRoomId.length > 0) {
        (socket.data as { tabRoomId?: string }).tabRoomId = a.tabRoomId;
      }
      // Per-tab last-known server (multi-server feature, plan §7). Stored
      // raw alongside tabRoomId; the connection handler reads it only when
      // the servers feature is live. Purely additive: when the feature is
      // off nothing consults it, so this is a harmless no-op stash.
      if (typeof a?.tabServerId === "string" && a.tabServerId.length > 0) {
        (socket.data as { tabServerId?: string }).tabServerId = a.tabServerId;
      }
      // Sync the in-memory user's activeCharacterId + displayName to
      // match the resolved tabCharId. Otherwise the user object the
      // socket carries until the next loadSessionUser still reflects
      // the DB default, and any early handler (e.g. room:join's
      // presence broadcast) would render this socket under the wrong
      // identity for the first beat.
      if (tabCharId !== user.activeCharacterId) {
        user.activeCharacterId = tabCharId;
        user.displayName = await resolveDisplayName(db, userId, tabCharId);
      }
      next();
    } catch (err) {
      next(err as Error);
    }
  });
}
