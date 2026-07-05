import { useState, type FormEvent } from "react";
import DOMPurify from "dompurify";
import { useChat } from "../state/store.js";
import { Field, SplashShell } from "./AuthGate.js";

/**
 * Finish-signup screen for the Google sign-in flow.
 *
 * A brand-new Google user has proven a real, email-verified account with
 * Google, but we still need a house username + the same agreements every
 * hand-typed registration collects before we mint an account. The OAuth
 * round-trip parked a single-use `code` on the client landing URL
 * (/auth/google/finish?code=…); this screen redeems it together with the
 * chosen username and the disclaimer acknowledgments.
 *
 * Deliberately NO password field (the account is Google-linked;
 * `users.hasPassword` starts false and the user can set one later from
 * Edit Profile) and NO captcha (Google already gates the bots — the
 * captcha exists only for the anonymous email/password register path).
 *
 * On success the parent-supplied `onAuthenticated` runs the exact same
 * token-store + setMe handoff the login/register paths use, so the app
 * boots into chat identically no matter how the session was minted.
 */
export function GoogleFinishSignup({
  code,
  onAuthenticated,
}: {
  code: string;
  /** Applies the returned auth bundle (setSessionToken + markLoginIntent + setMe). */
  onAuthenticated: (bundle: unknown) => void;
}) {
  const branding = useChat((s) => s.branding);
  const [username, setUsername] = useState("");
  // Same two agreements the email/password register form collects. The
  // house-rules box is always required; the admin-set disclaimer (when
  // present) rides along in the same checkbox copy. The age/mature box is
  // a baseline content-rating gate, not site-specific policy.
  const [accepted, setAccepted] = useState(false);
  const [acceptedAgeMature, setAcceptedAgeMature] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const disclaimerText = branding.registerDisclaimerHtml.trim();
  const canSubmit =
    !submitting && username.trim() !== "" && accepted && acceptedAgeMature;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!accepted) {
      setError("Please read and agree to the house rules to finish signing up.");
      return;
    }
    if (!acceptedAgeMature) {
      setError("Please confirm you are 18+ and understand this site may contain mature content.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/auth/google/finish", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          username: username.trim(),
          // Server's finishBody wants these TOP-LEVEL as literal-true, exactly
          // like /auth/register (NOT nested under `disclaimers`).
          acceptDisclaimer: true,
          acceptAgeMature: true,
        }),
      });
      if (!res.ok) {
        // Surface the first zod issue (e.g. "username: already taken")
        // over the bare "validation" code, same as the register form.
        const body = await res.json().catch(
          () => ({} as { error?: string; issues?: Array<{ path?: string; message: string }> }),
        );
        const firstIssue = body.issues?.[0];
        const detail = firstIssue
          ? `${firstIssue.path ? `${firstIssue.path}: ` : ""}${firstIssue.message}`
          : null;
        throw new Error(detail ?? body.error ?? "Couldn't finish signing up.");
      }
      const bundle = await res.json();
      onAuthenticated(bundle);
    } catch (err) {
      setError(err instanceof Error ? err.message : "error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SplashShell>
      <form onSubmit={submit} className="space-y-3">
        <div className="text-center text-[10px] uppercase tracking-[0.25em] text-keep-muted">
          finish your vessel
        </div>

        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 px-3 py-2 text-xs text-keep-text/90">
          You're signing in with <b>Google</b>. Pick a username and agree to the house
          rules to finish creating your account on <b>{branding.siteName || "The Spire"}</b>.
        </div>

        <Field
          label="Master username"
          value={username}
          onChange={setUsername}
          autoComplete="username"
          autoFocus
        />

        {/* House-rules agreement — mirrors AuthGate's register disclaimer
            block: optional admin-set disclaimer HTML above an always-required
            checkbox that links out to /rules. */}
        <div className="space-y-2 rounded border border-keep-border/50 bg-keep-bg/25 px-3 py-2 text-keep-muted">
          {disclaimerText ? (
            <>
              <div className="text-[10px] uppercase tracking-[0.25em] text-keep-muted">
                before you register
              </div>
              <div
                className="prose prose-sm max-h-48 max-w-none overflow-y-auto pr-1 text-xs text-keep-text/90"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(disclaimerText) }}
              />
            </>
          ) : null}
          <label className="flex cursor-pointer items-start gap-2 text-[11px] leading-snug">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              className="mt-0.5 scale-90"
            />
            <span>
              I have read and agree to the{" "}
              <a
                href="/rules"
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="underline underline-offset-2 hover:text-keep-action"
              >
                house rules
              </a>
              {disclaimerText ? " and the disclaimer above" : ""}.
            </span>
          </label>
        </div>

        {/* Age + mature content acknowledgment — same copy + posture as the
            register form's always-required gate. */}
        <label className="flex cursor-pointer items-start gap-2 rounded border border-keep-border/50 bg-keep-bg/25 px-3 py-2 text-[11px] leading-snug text-keep-muted">
          <input
            type="checkbox"
            checked={acceptedAgeMature}
            onChange={(e) => setAcceptedAgeMature(e.target.checked)}
            className="mt-0.5 scale-90"
          />
          <span>
            I am <b className="text-keep-text">18 years or older</b>, and I understand this
            site may contain mature content (in user profiles, room descriptions, and
            roleplay).
          </span>
        </label>

        {error ? (
          <div className="rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">
            {error}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={!canSubmit}
          title={!accepted ? "Tick the box to confirm you agree to the house rules." : undefined}
          className="w-full rounded border border-keep-border bg-keep-panel py-2 text-sm font-semibold tracking-wide hover:bg-keep-panel/80 disabled:opacity-50"
        >
          {submitting ? "Finishing…" : "Finish signing up"}
        </button>
      </form>
    </SplashShell>
  );
}
