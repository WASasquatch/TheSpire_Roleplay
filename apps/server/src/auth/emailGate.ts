/**
 * Email-verification content gate (defense-in-depth behind the client UI).
 *
 * When email verification is ON in "block" mode, an unverified NON-staff
 * account is blocked from posting content (room chat) and from accessing the
 * forums. Staff (admin/masteradmin) are exempt everywhere so an unverified
 * admin can never be locked out of the Email settings that turn block mode
 * off — mirrors the client `isEmailBlockGate` and the original inline gate in
 * the `chat:input` socket handler.
 *
 * This intentionally does NOT gate direct messages / the messenger: DMs are
 * the escape hatch a gated user needs to reach staff about a problem.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { users } from "../db/schema.js";
import { getSettings } from "../settings.js";

/**
 * True when the account is content-blocked: block mode is on, the user is
 * unverified, and they are not staff. Only queries `users.emailVerifiedAt`
 * when block mode is actually on, so the common config pays nothing.
 */
export async function emailContentBlocked(
  user: { id: string; role: string },
  db: Db,
): Promise<boolean> {
  if (user.role === "admin" || user.role === "masteradmin") return false;
  const s = await getSettings(db);
  if (!s.emailVerificationEnabled || s.emailVerificationMode !== "block") return false;
  const vr = (await db
    .select({ v: users.emailVerifiedAt })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1))[0];
  return !vr?.v;
}
