import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useChat } from "../state/store.js";
import { clearSessionToken } from "../lib/http.js";
import { isEmailBlockGate } from "../lib/emailGate.js";

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
  const { t } = useTranslation("marketing");
  const me = useChat((s) => s.me);
  const setMe = useChat((s) => s.setMe);
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [notYet, setNotYet] = useState(false);

  if (!me || !me.emailVerificationEnabled || me.emailVerifiedAt != null) return null;
  // Block determination is centralized in isEmailBlockGate (shared with the
  // chat-feed + forum gates). Staff are never hard-blocked — mirrors the
  // server chat:input exemption — so an unverified admin can't be locked out
  // of the settings that turn block mode off. They still get the nudge banner.
  const mode = isEmailBlockGate(me) ? "block" : "nudge";

  async function resend() {
    setSending(true);
    setError(null);
    try {
      const r = await fetch("/auth/resend-verification", { method: "POST" });
      if (!r.ok) throw new Error(t("verifyGate.sendFailed"));
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("verifyGate.tryLater"));
    } finally {
      setSending(false);
    }
  }

  // "I've verified" — re-read /auth/me on demand so the user isn't stuck
  // behind a stale gate. The verify link is redeemed in another tab (or on a
  // phone), so this tab doesn't know it's verified until it re-reads. On
  // success emailVerifiedAt flips non-null and this whole banner unmounts (the
  // guard at the top); if it's still null we tell them the link isn't clicked
  // yet. This is the manual companion to the automatic tab-focus refresh in
  // App.tsx, for webviews where focus events are unreliable.
  async function recheck() {
    setChecking(true);
    setNotYet(false);
    try {
      const r = await fetch("/auth/me");
      if (!r.ok) throw new Error();
      const j = (await r.json()) as { emailVerifiedAt?: number | null };
      const cur = useChat.getState().me;
      if (cur) {
        const verifiedAt = typeof j.emailVerifiedAt === "number" ? j.emailVerifiedAt : null;
        // Only emailVerifiedAt matters for the gate; the spread keeps every
        // other me field (enabled/mode/permissions) as-is.
        setMe({ ...cur, emailVerifiedAt: verifiedAt });
        if (verifiedAt == null) setNotYet(true);
      }
    } catch {
      setNotYet(true);
    } finally {
      setChecking(false);
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

  // The control's LABEL travels through the sentence keys as {{resendLabel}}
  // so the surrounding copy can be reworded per-locale around it; the element
  // itself (span once sent, button otherwise) is cloned in place by <Trans>.
  const resendLabel = sent
    ? t("verifyGate.sent")
    : sending
      ? t("verifyGate.sending")
      : t("verifyGate.resend");
  const resendControl = sent ? (
    <span className="text-keep-muted">{"{{resendLabel}}"}</span>
  ) : (
    <button
      type="button"
      onClick={resend}
      disabled={sending}
      className="font-semibold underline underline-offset-2 hover:text-keep-action disabled:opacity-50"
    >
      {"{{resendLabel}}"}
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
            <Trans
              t={t}
              i18nKey="verifyGate.block"
              values={{
                refreshLabel: checking ? t("verifyGate.checking") : t("verifyGate.refreshCta"),
                resendLabel,
              }}
            >
              <b>Verify your email to chat.</b>
              {" Click the link we sent, then "}
              <button
                type="button"
                onClick={recheck}
                disabled={checking}
                className="font-semibold underline underline-offset-2 hover:text-keep-action disabled:opacity-50"
              >
                {"{{refreshLabel}}"}
              </button>
              {". Don't see it? Check your "}
              <b>spam</b>
              {" folder, then "}
              {resendControl}
              {" · "}
              <button
                type="button"
                onClick={signOut}
                className="underline underline-offset-2 hover:text-keep-action"
              >
                wrong email?
              </button>
            </Trans>
            {notYet ? (
              <span className="ml-2 text-keep-accent">
                {t("verifyGate.notYet")}
              </span>
            ) : null}
          </>
        ) : (
          <Trans t={t} i18nKey="verifyGate.nudge" values={{ resendLabel }}>
            {"Please verify your email to secure your account. "}
            {resendControl}
          </Trans>
        )}
        {error ? <span className="ml-2 text-keep-accent">{error}</span> : null}
      </span>
      {!isBlock ? (
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded px-2 py-0.5 text-keep-muted hover:text-keep-text"
          aria-label={t("dismiss")}
          title={t("dismiss")}
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}
