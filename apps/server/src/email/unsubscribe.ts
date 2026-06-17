/**
 * Stateless one-click unsubscribe for broadcast email. The token is an
 * HMAC of (userId, category) keyed by SESSION_SECRET, so a link drops only
 * its own category and can't be forged or cross-applied to another
 * category. Only bulk (campaign) mail carries an unsubscribe link;
 * transactional account mail (reset, verification) always sends.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

function secret(): string {
  return process.env.SESSION_SECRET ?? "";
}

export function unsubscribeToken(userId: string, category: string): string {
  return createHmac("sha256", secret()).update(`unsub:${userId}:${category}`).digest("base64url");
}

export function verifyUnsubscribe(userId: string, category: string, token: string): boolean {
  const expected = Buffer.from(unsubscribeToken(userId, category));
  const got = Buffer.from(token);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export function unsubscribeUrl(baseUrl: string, userId: string, category: string): string {
  const t = unsubscribeToken(userId, category);
  return `${baseUrl}/unsubscribe?u=${encodeURIComponent(userId)}&c=${encodeURIComponent(category)}&t=${encodeURIComponent(t)}`;
}
