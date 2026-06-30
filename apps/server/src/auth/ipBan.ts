/**
 * IP-level ban enforcement (migration 0304). When a global admin bans a user,
 * we mirror their recent PUBLIC IPs into `banned_ips` so the same person can't
 * just register burner accounts to keep harassing users/admins. The block is
 * checked at registration and login; it inherits the account ban's expiry (a
 * timed ban → a timed IP block) and is cleared when the account is unbanned.
 *
 * We block EVERY distinct public IP the account has ever been logged on (across
 * all their devices and locations) — a harasser roams networks, so covering
 * only the recent ones would leave easy holes. Bounded naturally: user_ip_log
 * holds one row per (user, ip). Collateral is real (shared households, CGNAT,
 * university NATs), so private / loopback / link-local addresses are never
 * inserted (dev 127.0.0.1 + NAT hops can't self-block the instance), and an
 * admin unban lifts every block immediately; timed bans expire on their own.
 */
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../db/index.js";
import { bannedIps, sessions, userIpLog } from "../db/schema.js";

/** True when `ip` is a routable PUBLIC address worth blocking. Filters empty,
 *  loopback, RFC1918 private, link-local, and IPv6 ULA so a dev/NAT hop never
 *  becomes a global registration block. */
export function isBlockableIp(ip: string | null | undefined): ip is string {
  if (!ip) return false;
  const s = ip.trim().toLowerCase();
  if (!s) return false;
  // Loopback.
  if (s === "127.0.0.1" || s === "::1" || s.startsWith("::ffff:127.")) return false;
  // RFC1918 private (v4, incl. IPv4-mapped IPv6).
  const v4 = s.startsWith("::ffff:") ? s.slice(7) : s;
  if (v4.startsWith("10.") || v4.startsWith("192.168.")) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v4)) return false;
  // Link-local (v4 169.254/16, v6 fe80::/10) and IPv6 ULA (fc00::/7).
  if (v4.startsWith("169.254.")) return false;
  if (s.startsWith("fe80:") || s.startsWith("fc") || s.startsWith("fd")) return false;
  return true;
}

/** Whether this address currently carries an ACTIVE ban (permanent, or a timed
 *  one that hasn't elapsed). Loopback/private always returns false. */
export async function isIpBanned(db: Db, ip: string | null | undefined): Promise<boolean> {
  if (!isBlockableIp(ip)) return false;
  const row = (await db
    .select({ id: bannedIps.id })
    .from(bannedIps)
    .where(and(
      eq(bannedIps.ip, ip),
      or(isNull(bannedIps.bannedUntil), gt(bannedIps.bannedUntil, new Date())),
    ))
    .limit(1))[0];
  return !!row;
}

/** Mirror a freshly-applied account ban onto EVERY public IP the account has
 *  been seen on (all devices/locations). Returns how many addresses were
 *  blocked. Best-effort: callers fire-and-forget so a logging hiccup never fails
 *  the ban itself. */
export async function banIpsForUser(
  db: Db,
  userId: string,
  opts: { until: Date | null; reason: string | null; bannedById: string },
): Promise<number> {
  // EVERY distinct IP this account has ever been seen on (all devices /
  // locations), not just recent ones — user_ip_log holds one row per (user, ip)
  // so this stays bounded; sessions.ip catches any login address not yet logged.
  const logged = await db.select({ ip: userIpLog.ip }).from(userIpLog).where(eq(userIpLog.userId, userId));
  const sess = await db.select({ ip: sessions.ip }).from(sessions).where(eq(sessions.userId, userId));

  const ips = new Set<string>();
  for (const r of logged) if (isBlockableIp(r.ip)) ips.add(r.ip);
  for (const r of sess) if (isBlockableIp(r.ip)) ips.add(r.ip);
  if (ips.size === 0) return 0;

  const now = new Date();
  for (const ip of ips) {
    await db.insert(bannedIps)
      .values({ id: nanoid(), ip, bannedAt: now, bannedUntil: opts.until, reason: opts.reason, bannedById: opts.bannedById, targetUserId: userId })
      // Re-banning a shared/known IP refreshes its expiry/reason/owner.
      .onConflictDoUpdate({
        target: bannedIps.ip,
        set: { bannedAt: now, bannedUntil: opts.until, reason: opts.reason, bannedById: opts.bannedById, targetUserId: userId },
      });
  }
  return ips.size;
}

/** Lift the IP blocks a given user's ban produced (called on unban). */
export async function unbanIpsForUser(db: Db, userId: string): Promise<void> {
  await db.delete(bannedIps).where(eq(bannedIps.targetUserId, userId));
}

/* ============================================================
 * In-memory active-ban cache — backs the HARDENED global request gate, which
 * rejects EVERY request (API, socket handshake, even the SPA shell) from a
 * blocked IP. A per-request DB hit would be far too costly, so the gate checks
 * this Set instead; it's reloaded at boot, on a timer, and immediately after
 * any ban/unban so a fresh ban takes effect app-wide at once. The
 * register/login/socket paths ALSO hit the authoritative async check, so expiry
 * is exact there; the cache may lag a fresh unban/expiry by at most the refresh
 * interval (it errs toward blocking, never toward leaking access).
 * ============================================================ */
let cache = new Set<string>();

/** Reload the active (non-expired) banned IPs into memory. */
export async function loadBannedIpCache(db: Db): Promise<void> {
  const rows = await db
    .select({ ip: bannedIps.ip })
    .from(bannedIps)
    .where(or(isNull(bannedIps.bannedUntil), gt(bannedIps.bannedUntil, new Date())));
  cache = new Set(rows.map((r) => r.ip));
}

/** Synchronous cache check for the per-request global gate. Loopback/private
 *  addresses are never cached, so they always return false. */
export function isIpBannedCachedSync(ip: string | null | undefined): boolean {
  if (!isBlockableIp(ip)) return false;
  return cache.has(ip);
}
