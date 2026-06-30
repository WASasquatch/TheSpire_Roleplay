import { useState } from "react";
import { useChat } from "../state/store.js";

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

  if (mode === "block") {
    return (
      <div className="fixed inset-0 z-[200] flex items-center justify-center bg-keep-bg/95 p-6 backdrop-blur-sm">
        <div className="w-full max-w-md space-y-4 rounded-lg border border-keep-border bg-keep-panel p-6 text-center">
          <h2 className="text-base font-semibold tracking-wide">Verify your email to continue</h2>
          <p className="text-sm text-keep-muted">
            We sent a confirmation link to your email. Click it to unlock chat. Once verified, this screen disappears on its own.
          </p>
          <div className="text-xs">{resendControl}</div>
          {error ? <div className="text-xs text-keep-accent">{error}</div> : null}
        </div>
      </div>
    );
  }

  if (dismissed) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-b border-keep-action/40 bg-keep-action/10 px-4 py-2 text-xs text-keep-text/90">
      <span>
        Please verify your email to secure your account. {resendControl}
        {error ? <span className="ml-2 text-keep-accent">{error}</span> : null}
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="shrink-0 rounded px-2 py-0.5 text-keep-muted hover:text-keep-text"
        aria-label="Dismiss"
        title="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
