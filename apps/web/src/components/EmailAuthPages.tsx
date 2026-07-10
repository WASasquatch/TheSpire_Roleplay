import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { SplashShell, Field } from "./AuthGate.js";

/**
 * Logged-out email flow pages, rendered by UnauthRouter:
 *   /forgot-password  - request a reset link
 *   /reset-password   - set a new password from a ?token= link
 *   /verify-email     - confirm an email from a ?token= link
 * All reuse SplashShell so they match the login screen's chrome.
 */

function tokenFromUrl(): string {
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

const noticeBox = "rounded border border-keep-action/40 bg-keep-action/10 px-3 py-2 text-xs text-keep-text/90";
const errorBox = "rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent";
const primaryBtn = "w-full rounded border border-keep-border bg-keep-panel py-2 text-sm font-semibold tracking-wide hover:bg-keep-panel/80 disabled:opacity-50";
const linkBtn = "w-full text-xs text-keep-muted hover:text-keep-text";

export function ForgotPasswordPage({ onNavigate }: { onNavigate: (p: string) => void }) {
  const { t } = useTranslation("marketing");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!r.ok) throw new Error(t("emailPages.genericError"));
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("emailPages.tryAgain"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SplashShell footer={<button type="button" className={linkBtn} onClick={() => onNavigate("/login")}>{t("emailPages.backToSignIn")}</button>}>
      {sent ? (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wide">{t("emailPages.checkEmail")}</h2>
          <div className={noticeBox}>
            {t("emailPages.resetSent")}
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wide">{t("emailPages.resetTitle")}</h2>
          <p className="text-xs text-keep-muted">{t("emailPages.resetIntro")}</p>
          <Field label={t("auth.email")} value={email} onChange={setEmail} type="email" autoComplete="email" />
          {error ? <div className={errorBox}>{error}</div> : null}
          <button type="submit" disabled={busy || !email.trim()} className={primaryBtn}>
            {busy ? t("emailPages.sending") : t("emailPages.sendResetLink")}
          </button>
        </form>
      )}
    </SplashShell>
  );
}

export function ResetPasswordPage({ onNavigate }: { onNavigate: (p: string) => void }) {
  const { t } = useTranslation("marketing");
  const [token] = useState(tokenFromUrl);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit = !busy && password.length >= 8 && password === confirm && token.length > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error || t("emailPages.resetFailed"));
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("emailPages.resetFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SplashShell footer={<button type="button" className={linkBtn} onClick={() => onNavigate("/login")}>{t("emailPages.backToSignIn")}</button>}>
      {!token ? (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wide">{t("emailPages.invalidLink")}</h2>
          <div className={errorBox}>{t("emailPages.resetMissingToken")}</div>
        </div>
      ) : done ? (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wide">{t("emailPages.passwordUpdated")}</h2>
          <div className={noticeBox}>{t("emailPages.passwordChanged")}</div>
          <button type="button" className={primaryBtn} onClick={() => onNavigate("/login")}>{t("emailPages.goToSignIn")}</button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wide">{t("emailPages.chooseNewPassword")}</h2>
          <Field label={t("emailPages.newPassword")} value={password} onChange={setPassword} type="password" autoComplete="new-password" />
          <Field label={t("emailPages.confirmPassword")} value={confirm} onChange={setConfirm} type="password" autoComplete="new-password" />
          {mismatch ? <div className="text-[10px] text-keep-accent">{t("emailPages.mismatch")}</div> : null}
          {password.length > 0 && password.length < 8 ? <div className="text-[10px] text-keep-muted">{t("emailPages.minChars")}</div> : null}
          {error ? <div className={errorBox}>{error}</div> : null}
          <button type="submit" disabled={!canSubmit} className={primaryBtn}>
            {busy ? t("emailPages.updating") : t("emailPages.updatePassword")}
          </button>
        </form>
      )}
    </SplashShell>
  );
}

export function VerifyEmailPage({ onNavigate }: { onNavigate: (p: string) => void }) {
  const { t } = useTranslation("marketing");
  const [status, setStatus] = useState<"checking" | "ok" | "fail">("checking");
  const [error, setError] = useState<string | null>(null);
  // StrictMode double-invokes effects in dev; the token is single-use, so a
  // second POST would 400. Guard so we only attempt once.
  const triedRef = useRef(false);

  useEffect(() => {
    if (triedRef.current) return;
    triedRef.current = true;
    const token = tokenFromUrl();
    if (!token) {
      setStatus("fail");
      setError(t("emailPages.verifyMissingToken"));
      return;
    }
    void (async () => {
      try {
        const r = await fetch("/auth/verify-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error((j as { error?: string }).error || t("emailPages.verifyInvalid"));
        }
        setStatus("ok");
      } catch (err) {
        setStatus("fail");
        setError(err instanceof Error ? err.message : t("emailPages.verifyFailed"));
      }
    })();
    // One-shot by design (triedRef); `t` is intentionally omitted so a
    // language flip can't re-POST the single-use token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <SplashShell footer={<button type="button" className={linkBtn} onClick={() => onNavigate("/login")}>{t("emailPages.continueToSignIn")}</button>}>
      <div className="space-y-3">
        <h2 className="text-sm font-semibold tracking-wide">{t("emailPages.verifyTitle")}</h2>
        {status === "checking" ? (
          <div className={noticeBox}>{t("emailPages.confirming")}</div>
        ) : status === "ok" ? (
          <>
            <div className={noticeBox}>{t("emailPages.confirmed")}</div>
            <button type="button" className={primaryBtn} onClick={() => onNavigate("/login")}>{t("emailPages.goToSignIn")}</button>
          </>
        ) : (
          <div className={errorBox}>{error}</div>
        )}
      </div>
    </SplashShell>
  );
}
