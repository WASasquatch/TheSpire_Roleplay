import { useChat } from "../state/store.js";
import type { AuthMe } from "../state/store.js";

/**
 * Email-verification "block" gate for the signed-in user.
 *
 * True when email verification is ON in "block" mode and the account is
 * unverified and NOT staff. Staff (admin/masteradmin) are exempt everywhere
 * so an unverified admin can never be locked out of the Email settings that
 * turn block mode off — mirrors the server `emailContentBlocked` and the
 * original inline logic in VerifyEmailGate.
 *
 * When active, the room-chat feed and the forums are hidden. The verify
 * banner still shows (it's the prompt to verify), and DMs stay accessible so
 * a gated user can reach staff.
 */
export function isEmailBlockGate(me: AuthMe | null | undefined): boolean {
  if (!me || !me.emailVerificationEnabled || me.emailVerifiedAt != null) return false;
  const isStaff = me.role === "admin" || me.role === "masteradmin";
  if (isStaff) return false;
  return (me.emailVerificationMode ?? "nudge") === "block";
}

/** Reactive companion to {@link isEmailBlockGate}, reading the store `me`. */
export function useEmailBlockGate(): boolean {
  const me = useChat((s) => s.me);
  return isEmailBlockGate(me);
}
