import { useState } from "react";
import { useChat } from "../state/store.js";
import { clearSessionToken } from "../lib/http.js";

/**
 * Email-verification surface for the signed-in user, driven by the
 * `me.emailVerification*` fields the /auth/me poll provides:
 *   - nudge mode: a dismissible top banner asking them to verify.
 *   - block mode: a full-screen overlay that blocks the app until verified.
 * Renders nothing when verification is off or the account is already
 * verified. The actual gating of chat sends is ALSO enforced server-side
 * (block mode); this is the UX layer.
 */
export function VerifyEmailGate() {
  const me = useChat((s) => s.me);
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!me || !me.emailVerificationEnabled || me.emailVerifiedAt != null) return null;
  // Staff are never hard-blocked (mirrors the server chat:input exemption)
  // so an unverified admin can't be locked out of the settings that turn
  // block mode off. They still get the nudge banner.
  const isStaff = me.role === "admin" || me.role === "masteradmin";
  const mode = isStaff ? "nudge" : (me.emailVerificationMode ?? "nudge");

  async function resend() {
    setSending(true);
    setError(null);
    try {
      const r = await fetch("/auth/resend-verification", { method: "POST" });
      if (!r.ok) throw new Error("Couldn't send right now. Try again in a minute.");
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Try again in a minute.");
    } finally {
      setSending(false);
    }
  }

  // Escape hatch for a MISTYPED email. Without it, a user who fat-fingered
  // their address at signup is blocked forever — the link lands in an inbox
  // they can't open, "resend" just repeats the mistake, and they silently
  // churn (a big share of "new users who never chat"). Clearing the token +
  // dropping them on the register form lets them start over with the right
  // address. Server-side the abandoned account simply stays unverified.
  function signOut() {
    clearSessionToken();
    window.location.href = "/register";
  }

  const resendControl = sent ? (
    <span className="text-keep-muted">Sent! Check your inbox (and spam).</span>
  ) : (
    <button
      type="button"
      onClick={resend}
      disabled={sending}
      className="font-semibold underline underline-offset-2 hover:text-keep-action disabled:opacity-50"
    >
      {sending ? "Sending…" : "Resend verification email"}
    </button>
  );

  // ONE top-of-chat banner for both modes. Block mode is non-dismissible and
  // worded as a hard requirement ("verify to chat") with resend + a wrong-email
  // escape; nudge mode is a softer, dismissible reminder. This replaced the old
  // full-screen block overlay so an unverified user can still SEE the community
  // (which motivates them to verify) — their sends are stopped at the composer
  // and the server, not by hiding the whole app behind a wall.
  const isBlock = mode === "block";
  if (!isBlock && dismissed) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-b border-keep-action/50 bg-keep-action/15 px-4 py-2 text-xs text-keep-text/90">
      <span className="min-w-0">
        {isBlock ? (
          <>
            <b>Verify your email to chat.</b> We sent you a link — click it and you're in. Don't see
            it? Check your <b>spam</b> folder, then {resendControl}
            {" · "}
            <button
              type="button"
              onClick={signOut}
              className="underline underline-offset-2 hover:text-keep-action"
            >
              wrong email?
            </button>
          </>
        ) : (
          <>Please verify your email to secure your account. {resendControl}</>
        )}
        {error ? <span className="ml-2 text-keep-accent">{error}</span> : null}
      </span>
      {!isBlock ? (
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded px-2 py-0.5 text-keep-muted hover:text-keep-text"
          aria-label="Dismiss"
          title="Dismiss"
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}
