import { useEffect, useRef, useState, type FormEvent } from "react";
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
      if (!r.ok) throw new Error("Something went wrong. Please try again.");
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SplashShell footer={<button type="button" className={linkBtn} onClick={() => onNavigate("/login")}>Back to sign in</button>}>
      {sent ? (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wide">Check your email</h2>
          <div className={noticeBox}>
            If an account exists for that email, a password reset link is on its way. It expires in 1 hour — check your inbox (and spam folder).
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wide">Reset your password</h2>
          <p className="text-xs text-keep-muted">Enter your account email and we'll send you a link to choose a new password.</p>
          <Field label="Email" value={email} onChange={setEmail} type="email" autoComplete="email" />
          {error ? <div className={errorBox}>{error}</div> : null}
          <button type="submit" disabled={busy || !email.trim()} className={primaryBtn}>
            {busy ? "Sending..." : "Send reset link"}
          </button>
        </form>
      )}
    </SplashShell>
  );
}

export function ResetPasswordPage({ onNavigate }: { onNavigate: (p: string) => void }) {
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
        throw new Error((j as { error?: string }).error || "Could not reset your password.");
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset your password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SplashShell footer={<button type="button" className={linkBtn} onClick={() => onNavigate("/login")}>Back to sign in</button>}>
      {!token ? (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wide">Invalid link</h2>
          <div className={errorBox}>This reset link is missing its token. Request a new one from the sign-in page.</div>
        </div>
      ) : done ? (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wide">Password updated</h2>
          <div className={noticeBox}>Your password has been changed. You can now sign in with your new password.</div>
          <button type="button" className={primaryBtn} onClick={() => onNavigate("/login")}>Go to sign in</button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wide">Choose a new password</h2>
          <Field label="New password" value={password} onChange={setPassword} type="password" autoComplete="new-password" />
          <Field label="Confirm password" value={confirm} onChange={setConfirm} type="password" autoComplete="new-password" />
          {mismatch ? <div className="text-[10px] text-keep-accent">Passwords don't match yet.</div> : null}
          {password.length > 0 && password.length < 8 ? <div className="text-[10px] text-keep-muted">At least 8 characters.</div> : null}
          {error ? <div className={errorBox}>{error}</div> : null}
          <button type="submit" disabled={!canSubmit} className={primaryBtn}>
            {busy ? "Updating..." : "Update password"}
          </button>
        </form>
      )}
    </SplashShell>
  );
}

export function VerifyEmailPage({ onNavigate }: { onNavigate: (p: string) => void }) {
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
      setError("This confirmation link is missing its token.");
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
          throw new Error((j as { error?: string }).error || "This confirmation link is invalid or has expired.");
        }
        setStatus("ok");
      } catch (err) {
        setStatus("fail");
        setError(err instanceof Error ? err.message : "Could not confirm your email.");
      }
    })();
  }, []);

  return (
    <SplashShell footer={<button type="button" className={linkBtn} onClick={() => onNavigate("/login")}>Continue to sign in</button>}>
      <div className="space-y-3">
        <h2 className="text-sm font-semibold tracking-wide">Email verification</h2>
        {status === "checking" ? (
          <div className={noticeBox}>Confirming your email…</div>
        ) : status === "ok" ? (
          <>
            <div className={noticeBox}>Your email is confirmed. Thanks! You can sign in and start writing.</div>
            <button type="button" className={primaryBtn} onClick={() => onNavigate("/login")}>Go to sign in</button>
          </>
        ) : (
          <div className={errorBox}>{error}</div>
        )}
      </div>
    </SplashShell>
  );
}
