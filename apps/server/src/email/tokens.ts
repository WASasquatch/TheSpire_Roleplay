/**
 * Single-use email tokens for password reset + email verification.
 *
 * The raw token only ever travels in the emailed link; we persist a
 * SHA-256 hash, so a DB read can't be turned into account access.
 * Consumption is atomic (UPDATE ... WHERE used_at IS NULL ... RETURNING)
 * so a token can't be redeemed twice even under concurrent requests.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { emailTokens } from "../db/schema.js";
import type { Db } from "../db/index.js";

export type EmailTokenPurpose = "password_reset" | "email_verify";

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Mint a fresh token for (user, purpose), supersede any prior unused
 * tokens of the same purpose for that user, and return the RAW token to
 * embed in the email link. `ttlMs` bounds validity.
 */
export async function createEmailToken(
  db: Db,
  userId: string,
  purpose: EmailTokenPurpose,
  ttlMs: number,
): Promise<string> {
  // Invalidate older outstanding tokens of this purpose so a freshly
  // requested link is the only live one (a re-requested reset shouldn't
  // leave the previous email's link usable).
  await db
    .update(emailTokens)
    .set({ usedAt: new Date() })
    .where(and(
      eq(emailTokens.userId, userId),
      eq(emailTokens.purpose, purpose),
      isNull(emailTokens.usedAt),
    ));
  const raw = randomBytes(32).toString("base64url");
  await db.insert(emailTokens).values({
    id: nanoid(),
    purpose,
    userId,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return raw;
}

/**
 * Atomically redeem a raw token. Returns the userId on success, or null
 * if the token is unknown, wrong-purpose, expired, or already used.
 */
export async function consumeEmailToken(
  db: Db,
  raw: string,
  purpose: EmailTokenPurpose,
): Promise<string | null> {
  const hash = hashToken(raw);
  const now = new Date();
  const row = (await db
    .select()
    .from(emailTokens)
    .where(and(
      eq(emailTokens.tokenHash, hash),
      eq(emailTokens.purpose, purpose),
      isNull(emailTokens.usedAt),
      gt(emailTokens.expiresAt, now),
    ))
    .limit(1))[0];
  if (!row) return null;
  // Single-use guard: only the request that flips used_at from NULL wins.
  const claimed = await db
    .update(emailTokens)
    .set({ usedAt: now })
    .where(and(eq(emailTokens.id, row.id), isNull(emailTokens.usedAt)))
    .returning({ id: emailTokens.id });
  if (claimed.length === 0) return null;
  return row.userId;
}
