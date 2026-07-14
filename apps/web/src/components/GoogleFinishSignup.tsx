import { useState, type FormEvent } from "react";
import DOMPurify from "dompurify";
import { Trans, useTranslation } from "react-i18next";
import { useChat } from "../state/store.js";
import { Field, SplashShell, earliestAllowedBirthdate, isoAgeUtc, latestAllowedBirthdate } from "./AuthGate.js";
import { readPendingInvite } from "./servers/ServerInviteLanding.js";

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
  const { t } = useTranslation("marketing");
  const branding = useChat((s) => s.branding);
  const [username, setUsername] = useState("");
  // Same agreements + age signal the email/password register form
  // collects: the site-rules box is always required (the admin-set
  // disclaimer, when present, rides along above it), and the date of
  // birth replaces the old 18+ checkbox (age-restriction plan Phase 0).
  const [accepted, setAccepted] = useState(false);
  const [birthdate, setBirthdate] = useState("");
  /**
   * Minor isolation opt-in (age plan Phase 5), revealed only when the
   * entered date of birth is under 18 — same optional checkbox as the
   * register form; changeable later in the profile editor's Privacy tab.
   */
  const [isolatePref, setIsolatePref] = useState(false);
  // Server invite carry-through: a code from an /i/<code> landing survives
  // the OAuth round-trip in localStorage; ride it on the finish POST so the
  // fresh account auto-joins the inviting community. `slug` holds the code.
  const [pendingInvite] = useState(() => readPendingInvite());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const disclaimerText = branding.registerDisclaimerHtml.trim();
  const minAge = branding.minimumSignupAge ?? 18;
  const canSubmit =
    !submitting && username.trim() !== "" && accepted && birthdate !== "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!accepted) {
      setError(t("googleFinish.rulesRequired"));
      return;
    }
    if (!birthdate) {
      setError(t("auth.dobRequired"));
      return;
    }
    // Courtesy pre-check with the same copy the server returns; the server
    // stays authoritative.
    const enteredAge = isoAgeUtc(birthdate);
    if (enteredAge === null || enteredAge < minAge) {
      setError(t("auth.minAgeError", { minAge }));
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
          // Server's finishBody wants these TOP-LEVEL, exactly like
          // /auth/register (NOT nested under `disclaimers`).
          acceptDisclaimer: true,
          birthdate,
          // Only under-18 signups carry the isolation opt-in; the server
          // clamps it to minor accounts regardless.
          ...(enteredAge < 18 && isolatePref ? { isolateFromAdults: true } : {}),
          // Invite carry-through — the server joins the invited community
          // (through its gates) alongside the normal default enrollment.
          ...(pendingInvite ? { inviteCode: pendingInvite.slug } : {}),
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
        throw new Error(detail ?? body.error ?? t("googleFinish.finishFailed"));
      }
      const bundle = await res.json();
      onAuthenticated(bundle);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errorFallback"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SplashShell>
      <form onSubmit={submit} className="space-y-3">
        <div className="text-center text-[10px] uppercase tracking-[0.25em] text-keep-muted">
          {t("googleFinish.heading")}
        </div>

        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 px-3 py-2 text-xs text-keep-text/90">
          <Trans
            t={t}
            i18nKey="googleFinish.intro"
            values={{ siteName: branding.siteName || "The Spire" }}
          >
            {"You're signing in with "}
            <b>Google</b>
            {". Pick a username and agree to the house rules to finish creating your account on "}
            <b>{"{{siteName}}"}</b>
            {"."}
          </Trans>
        </div>

        {/* Invite-bound signup: same banner idiom as the password register
            form — name the community and promise the landing. */}
        {pendingInvite ? (
          <div className="rounded border border-keep-accent/40 bg-keep-accent/10 px-3 py-2 text-xs text-keep-text/90">
            <Trans
              t={t}
              i18nKey="auth.inviteRegister"
              values={{
                siteName: branding.siteName || "The Spire",
                community: pendingInvite.name ?? t("auth.inviteCommunityFallback"),
              }}
            >
              {"You're creating an account on "}
              <b>{"{{siteName}}"}</b>
              {" to join "}
              <b>{"{{community}}"}</b>
              {". Once you've registered, we'll take you straight there."}
            </Trans>
          </div>
        ) : null}

        <Field
          label={t("auth.masterUsername")}
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
                {t("auth.beforeYouRegister")}
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
              <Trans
                t={t}
                i18nKey="auth.rulesAgreement"
                values={{ siteName: branding.siteName || "The Spire" }}
              >
                {"I understand {{siteName}} hosts user written stories and roleplay, and some areas are for adults only. I agree to the "}
                <a
                  href="/rules"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="underline underline-offset-2 hover:text-keep-action"
                >
                  site rules
                </a>
                {"."}
              </Trans>
            </span>
          </label>
        </div>

        {/* Date of birth — same field + posture as the register form (the
            server stores it and enforces the minimum age). */}
        <Field
          label={t("auth.dateOfBirth")}
          value={birthdate}
          onChange={setBirthdate}
          type="date"
          autoComplete="bday"
          min={earliestAllowedBirthdate()}
          max={latestAllowedBirthdate(minAge)}
          helper={t("auth.dobHelper", { minAge, siteName: branding.siteName || "The Spire" })}
        />

        {/* Minor isolation opt-in (age plan Phase 5): revealed only when
            the entered birth date is under 18 AND the signup floor admits
            minors, exactly like the register form (with an 18 floor the
            checkbox would tease an account state that can't exist).
            Optional either way. */}
        {(() => {
          if (minAge >= 18) return null;
          const enteredAge = birthdate ? isoAgeUtc(birthdate) : null;
          if (enteredAge === null || enteredAge >= 18) return null;
          return (
            <label className="flex items-start gap-2 rounded border border-keep-border/50 bg-keep-bg/25 px-3 py-2 text-[11px] text-keep-muted">
              <input
                type="checkbox"
                checked={isolatePref}
                onChange={(e) => setIsolatePref(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                {t("auth.minorIsolation")}
              </span>
            </label>
          );
        })()}

        {error ? (
          <div className="rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">
            {error}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={!canSubmit}
          title={!accepted ? t("auth.tickBoxTitle") : undefined}
          className="w-full rounded border border-keep-border bg-keep-panel py-2 text-sm font-semibold tracking-wide hover:bg-keep-panel/80 disabled:opacity-50"
        >
          {submitting ? t("googleFinish.finishing") : t("googleFinish.finishCta")}
        </button>
      </form>
    </SplashShell>
  );
}
