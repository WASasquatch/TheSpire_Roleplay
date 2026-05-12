import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import DOMPurify from "dompurify";
import { VERSION } from "@thekeep/shared";
import { useChat } from "../state/store.js";
import { themeStyle } from "../lib/theme.js";
import { AffiliatesCarousel } from "./AffiliatesCarousel.js";
import { FeaturedWorldsCarousel } from "./FeaturedWorldsCarousel.js";

const PROJECT_URL = "https://github.com/WASasquatch/TheSpire_Roleplay";

interface SiteStats {
  online: number;
  /** Total registered accounts (excluding the system sentinel). Optional for forward-compat with older servers. */
  totalRegistered?: number;
  rooms: { public: number; private: number; total: number };
}

/**
 * Splash shell - shared layout for the unauthenticated experience.
 *
 * Visual structure:
 *   - Full-viewport background image (the_spire_bg.jpg) with the spire on
 *     the left and a parchment-fade on the right.
 *   - A centered card pinned to the *right* third of the page so the spire
 *     remains visible. On narrow viewports we drop to a centered layout
 *     because there's no room for the side-aligned variant.
 *   - The card itself shows: site name → admin-configured welcome HTML →
 *     live "users online" stat → the children passed in (login form, or
 *     "checking session..." indicator from BootSplash).
 *
 * Both AuthGate and the BootSplash mount this shell so the visual language
 * stays consistent through the login → checking-session → chat handoff.
 */
export function SplashShell({
  children,
  /** Optional footer rendered below the children (e.g. login/register toggle). */
  footer,
}: {
  children: ReactNode;
  footer?: ReactNode;
}) {
  const branding = useChat((s) => s.branding);
  const [stats, setStats] = useState<SiteStats | null>(null);

  // Live stats so visitors see the chat is alive before they log in. /stats
  // is unauthenticated; we refresh every 30s to track ebb and flow. Skipped
  // entirely when the admin has disabled activity feeds (cold-start posture
  // so empty counters don't telegraph "dead community" to first visitors).
  useEffect(() => {
    if (!branding.activityFeedsEnabled) {
      setStats(null);
      return;
    }
    let cancelled = false;
    function load() {
      fetch("/stats")
        .then((r) => (r.ok ? (r.json() as Promise<SiteStats>) : null))
        .then((j) => { if (!cancelled && j) setStats(j); })
        .catch(() => {});
    }
    load();
    const id = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [branding.activityFeedsEnabled]);

  // Logo text styling mirrors the in-app banner so the brand stays
  // consistent. Both color and font fall back to the theme when unset.
  const logoStyle: React.CSSProperties = {};
  if (branding.logoColor) logoStyle.color = branding.logoColor;
  if (branding.logoFont) logoStyle.fontFamily = branding.logoFont;

  return (
    // Inline `themeStyle(...)` scopes the site's default theme to the splash
    // subtree. This isolates us from whatever CSS vars a previously-logged-in
    // user left on documentElement - the splash should always render in the
    // admin-configured palette (which the parchment bg image is paired with),
    // not in a leftover Twilight or Forest theme.
    <div
      style={themeStyle(branding.defaultTheme)}
      className="relative min-h-screen w-full overflow-hidden bg-keep-bg text-keep-text"
    >
      {/*
        Background layer - absolute so the card sits above it without
        affecting its sizing. Cover keeps the spire fully visible on common
        16:9 / 16:10 viewports; the image's right edge fades to parchment
        which blends into the modal seamlessly. A subtle parchment overlay
        on the right boosts modal legibility on smaller / wider viewports
        where the natural fade isn't quite enough.
      */}
      <div
        aria-hidden
        // On portrait mobile the artwork is much wider than the viewport.
        // `bg-center` would crop both edges and show the boring middle;
        // pinning to `bg-left` shifts the spire too far right within the
        // visible frame. The negative-x offset (-175px) splits the
        // difference - the spire sits roughly centered in the viewport
        // with mountains trailing below. On md+ the viewport is wide
        // enough that the natural cover-center works.
        className="absolute inset-0 bg-cover bg-[position:-175px_center] md:bg-center"
        style={{ backgroundImage: "url(/the_spire_bg.jpg)" }}
      />
      <div
        aria-hidden
        // Right-side parchment veil so the desktop card sits on a calm
        // background even where the bg image itself has detail. On mobile
        // the card switches to a translucent glass treatment (see below)
        // and we WANT the artwork showing through, so the veil is much
        // lighter - just enough to keep the right edge of the screen
        // from competing with the card.
        className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-keep-bg/30 md:to-keep-bg/70"
      />

      {/*
        Card position. On wide desktops (lg+) we visually center the
        card in the right third of the viewport (its center sits at
        ~75% horizontal), so it floats over the parchment-fade side of
        the bg image while the spire art stays clear on the left. The
        `right` offset is computed as `max(2rem, 25% - 17.5rem)` —
        17.5rem is half the 560px card width, and the floor of 2rem
        keeps the card from clipping when 25% of the viewport would
        otherwise leave no room. Below lg — portrait phones, landscape
        phones, small tablets — we fall back to centered flex layout
        (with a 2-column landscape-phone grid handled by the card's
        own classes). The previous `md:left-[75%]` math clipped at
        landscape-phone widths because half the card extended past the
        viewport; this max(...) replaces that without losing the
        intentional "card centered in the right third" desktop feel.
      */}
      <div className="relative flex min-h-screen items-center justify-center lg:block">
        <div
          // Mobile vs desktop card treatment:
          //   - <lg (default): glass / frosted treatment. The card is
          //     translucent (~55% parchment) with a strong backdrop blur
          //     so the spire artwork shows through softly without
          //     distracting from the form. Lighter border + ring give it
          //     a subtle "pane of glass" edge.
          //   - lg+ (wide desktop): the card sits anchored to the right
          //     where the bg already fades to parchment, so we go
          //     opaque-ish (95%) for maximum legibility and only a hint
          //     of blur. The artwork stays visible to the *left* of the
          //     card; we don't need it showing through the card itself.
          // The outer container is `overflow-hidden` (so the bg image
          // can't bleed outside the viewport when the artwork is taller
          // than the available space). That clips anything growing past
          // the viewport - including the optional FeaturedWorldsCarousel
          // and AffiliatesCarousel rows below the form. Cap the card's
          // height to the viewport (less margin) and let the card scroll
          // internally so additional sections stay reachable on shorter
          // screens.
          className="
            mx-4 my-8
            w-[min(560px,92vw)]
            max-lg:landscape:w-[min(900px,96vw)] max-lg:landscape:mx-2 max-lg:landscape:my-2
            max-h-[calc(100vh-4rem)] overflow-y-auto
            max-lg:landscape:max-h-[calc(100vh-1rem)]
            lg:absolute lg:top-1/2 lg:right-[max(2rem,calc(25%-17.5rem))] lg:my-0 lg:mx-0 lg:-translate-y-1/2
            lg:max-h-[calc(100vh-2rem)]
            rounded-md border
            bg-keep-bg/55 backdrop-blur-xl border-keep-border/60
            ring-1 ring-keep-bg/40 ring-inset
            lg:bg-keep-bg/95 lg:backdrop-blur-sm lg:border-keep-border lg:ring-0
            shadow-[0_20px_60px_-15px_rgba(0,0,0,0.45)]
          "
        >
          {/* Accent bar - echoes the teal magical light from the spire on
              the bg, anchoring the card visually to the artwork. */}
          <div
            aria-hidden
            className="h-0.5 w-full rounded-t-md"
            style={{ background: "linear-gradient(90deg, transparent, #3fa5a0 30%, #3fa5a0 70%, transparent)" }}
          />

          <div className="px-6 py-6 sm:px-8 sm:py-8 max-lg:landscape:p-4 max-lg:landscape:grid max-lg:landscape:grid-cols-2 max-lg:landscape:gap-x-6 max-lg:landscape:gap-y-2">
            {/* INFO COLUMN — title, stats, meta, welcome blurb. Stays
                left in landscape phones; stacks above the form in
                portrait / wide-desktop layouts. */}
            <div className="max-lg:landscape:min-w-0">
              {/* Header - site name, theme-tinted */}
              <div className="mb-3 text-center max-lg:landscape:mb-1">
                <h1
                  style={logoStyle}
                  className="font-action text-3xl tracking-wide text-keep-text sm:text-4xl max-lg:landscape:text-2xl"
                >
                  {branding.siteName}
                </h1>
                <div className="mt-1 text-[10px] uppercase tracking-[0.3em] text-keep-muted">
                  a chat sanctuary
                </div>
              </div>

              {/* Live stats strip - omitted entirely when the admin toggle is
                  off, so the splash sells the IDEA of the place rather than its
                  (potentially empty) current activity. */}
              {branding.activityFeedsEnabled ? <SplashStats stats={stats} /> : null}

              {/* Retention + session TTL - admin-configured, surfaced so
                  visitors know what they're committing to before registering. */}
              <SplashMeta />

              {/* Admin-configurable welcome - only renders when set. The
                  horizontal dividers separate it visually in the stacked
                  layout; in landscape 2-col we drop the top divider so
                  the welcome flows from the meta strip above without a
                  hard rule. */}
              {branding.welcomeHtml.trim() ? (
                <div
                  className="prose prose-sm mb-5 mt-4 max-w-none border-y border-keep-rule/50 py-3 text-keep-text/90 max-lg:landscape:mb-0 max-lg:landscape:mt-2 max-lg:landscape:border-t-0 max-lg:landscape:pt-2"
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(branding.welcomeHtml) }}
                />
              ) : (
                <div className="my-5 border-t border-keep-rule/50 max-lg:landscape:hidden" />
              )}
            </div>

            {/* FORM COLUMN — the actual sign-in / register UI. Right
                column in landscape phones; below the info in other
                layouts. */}
            <div className="max-lg:landscape:min-w-0">
              {/* Body content (form or "checking session..." indicator) */}
              <div>{children}</div>

              {footer ? <div className="mt-4">{footer}</div> : null}
            </div>

            {/* Featured-worlds + Affiliates carousels span the full
                card width when present (col-span-2 in the landscape
                grid). Both honor their admin toggles; carousels render
                nothing when empty so empty installs don't show a strip
                of blank rows. */}
            {branding.featuredWorldsEnabled ? (
              <div className="max-lg:landscape:col-span-2">
                <FeaturedWorldsCarousel />
              </div>
            ) : null}
            <div className="max-lg:landscape:col-span-2">
              <AffiliatesCarousel />
            </div>
          </div>

          {/* Upstream project credit + version link. Always the project
              name (not the admin-configured site name) so self-hosted
              installs trace back to source. Version single-sourced from
              packages/shared/src/version.ts. */}
          <div className="border-t border-keep-rule/60 bg-keep-panel/40 px-6 py-2 text-center text-[10px] uppercase tracking-widest text-keep-muted">
            <a
              href={PROJECT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-keep-action"
            >
              The Spire Roleplay Chat v{VERSION}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function SplashStats({ stats }: { stats: SiteStats | null }) {
  // Use the admin-configured site name in flavor copy so "the keep" (the
  // codename) doesn't leak through to users on a rebranded install.
  const siteName = useChat((s) => s.branding.siteName);
  if (!stats) {
    return (
      <div className="my-2 flex items-center justify-center gap-2 text-xs text-keep-muted">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-keep-muted/40" />
        <span>checking {siteName}...</span>
      </div>
    );
  }
  // When the server reports the registered-account total, render the online
  // stat with TWO emphasised numbers (e.g. "0 users online out of 2") so the
  // total matches the bold/tabular-nums styling of the other counts. Falls
  // back to the single-number Stat helper for older servers without the field.
  const onlineNoun = stats.online === 1 ? "user online" : "users online";
  return (
    <div className="my-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-keep-muted">
      {typeof stats.totalRegistered === "number" ? (
        <span className="inline-flex items-baseline gap-1">
          <span
            className={`text-base font-semibold tabular-nums ${
              stats.online > 0 ? "text-keep-action" : "text-keep-text"
            }`}
          >
            {stats.online}
          </span>
          <span>{onlineNoun} out of</span>
          <span className="text-base font-semibold tabular-nums text-keep-text">
            {stats.totalRegistered}
          </span>
        </span>
      ) : (
        <Stat label={onlineNoun} value={stats.online} emphasised={stats.online > 0} />
      )}
      <span aria-hidden className="text-keep-rule">·</span>
      <Stat label={stats.rooms.public === 1 ? "public room" : "public rooms"} value={stats.rooms.public} />
      {stats.rooms.private > 0 ? (
        <>
          <span aria-hidden className="text-keep-rule">·</span>
          <Stat label={stats.rooms.private === 1 ? "private chamber" : "private chambers"} value={stats.rooms.private} />
        </>
      ) : null}
    </div>
  );
}

/**
 * Format a millisecond duration for human-facing splash copy. Picks the
 * largest natural unit ("30 days" beats "720 hours") and pluralizes
 * appropriately. 0 maps to "indefinitely" - only meaningful for retention.
 */
function formatHumanDuration(ms: number): string {
  if (ms <= 0) return "indefinitely";
  const day = 86_400_000;
  const hour = 3_600_000;
  const minute = 60_000;
  if (ms % day === 0) {
    const n = ms / day;
    return n === 1 ? "1 day" : `${n} days`;
  }
  if (ms % hour === 0) {
    const n = ms / hour;
    return n === 1 ? "1 hour" : `${n} hours`;
  }
  if (ms % minute === 0) {
    const n = ms / minute;
    return n === 1 ? "1 minute" : `${n} minutes`;
  }
  return `${Math.round(ms / 1000)} seconds`;
}

/**
 * Retention + session TTL strip rendered below the live stats. Both numbers
 * come from admin settings via /site so they always reflect the live policy.
 * Worded conversationally because this is a marketing-adjacent surface, not
 * the admin's terse "30d" formatting.
 */
function SplashMeta() {
  const retentionMs = useChat((s) => s.branding.messageRetentionMs);
  const sessionMs = useChat((s) => s.branding.sessionTtlMs);
  const retentionWord = retentionMs === 0
    ? "Messages are kept indefinitely"
    : `Messages are kept for ${formatHumanDuration(retentionMs)}`;
  const sessionWord = `sessions log out after ${formatHumanDuration(sessionMs)} idle`;
  return (
    <div className="my-1 text-center text-[10px] text-keep-muted/80">
      {retentionWord} <span aria-hidden className="text-keep-rule">·</span> {sessionWord}
    </div>
  );
}

function Stat({ label, value, emphasised }: { label: string; value: number; emphasised?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span
        className={`text-base font-semibold tabular-nums ${
          emphasised ? "text-keep-action" : "text-keep-text"
        }`}
      >
        {value}
      </span>
      <span>{label}</span>
    </span>
  );
}

interface AuthGateProps {
  /**
   * When the user landed via /p/<username> deep-link, parent passes this
   * so the splash can tell them which profile they're trying to view and
   * adjust the copy for public-vs-private.
   */
  pendingProfileHint?: { name: string; isPrivate: boolean };
  /**
   * Symmetric hint for /w/<slug> deep-links to private worlds. Public
   * worlds open in the standalone PublicViewerShell instead and don't
   * fall through to the gate, so we only need a "private" variant here.
   */
  pendingWorldHint?: { name: string; slug: string };
  /**
   * Initial form mode. The parent picks this off the URL so /login mounts
   * the login form and /register mounts the registration form, each
   * bookmarkable as its own page. Defaults to "login" for callers that
   * don't care (deep-link gates, legacy routes).
   */
  initialMode?: "login" | "register";
  /**
   * Optional SPA-style navigation helper. When set, mode-toggling
   * (the "Need an account? Register." / "Already have one? Log in."
   * links) updates the address bar via pushState + popstate instead of
   * just flipping local state. Lets a user bookmark whichever form
   * they end up on and have the back button rewind through it.
   */
  onNavigate?: (path: string) => void;
}

export function AuthGate({ pendingProfileHint, pendingWorldHint, initialMode = "login", onNavigate }: AuthGateProps = {}) {
  const [mode, setMode] = useState<"login" | "register">(initialMode);
  // Keep local mode in sync with `initialMode` so a popstate-driven URL
  // change (back/forward between /login and /register) flips the form
  // without re-mounting the component.
  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  /**
   * Confirm-password field, register-mode only. Pure client-side typo guard:
   * the server never sees it. Without this a user could mistype their
   * password during registration and lock themselves out before they ever
   * logged in.
   */
  const [passwordConfirm, setPasswordConfirm] = useState("");
  /**
   * Acceptance of the registration disclaimer. Required for /auth/register
   * (server enforces a literal `true`). Reset whenever mode toggles so a
   * stale tick from a prior session doesn't carry over.
   */
  const [accepted, setAccepted] = useState(false);
  /**
   * Age + mature-content acknowledgment, register-mode only. Server
   * enforces a literal `true`; this checkbox is the UX surface. Reset on
   * mode switch (same posture as the disclaimer checkbox).
   */
  const [acceptedAgeMature, setAcceptedAgeMature] = useState(false);
  /**
   * In-house basic CAPTCHA: a single-digit math question issued by
   * GET /auth/captcha. The id is single-use server-side; if the user
   * submits a wrong answer or lets the 5-minute TTL expire, we re-fetch.
   */
  const [captcha, setCaptcha] = useState<{ id: string; question: string } | null>(null);
  const [captchaAnswer, setCaptchaAnswer] = useState("");
  /**
   * Honeypot. Real users never see this field (display:none in the form);
   * bots that auto-fill every input land here and we silently 400 them
   * server-side.
   */
  const [hp, setHp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const setMe = useChat((s) => s.setMe);
  const branding = useChat((s) => s.branding);
  const kickReason = useChat((s) => s.kickReason);
  const setKickReason = useChat((s) => s.setKickReason);
  // When the admin closes registration, snap any stale "register" mode back
  // to "login" so the form can't show fields that the server will reject.
  if (!branding.registrationOpen && mode === "register") setMode("login");

  // Fetch a fresh captcha when entering register mode (or after a failed
  // submit consumed the previous one). Tokens are single-use server-side,
  // so refetching is the right behavior whenever we don't have a current
  // one cached.
  useEffect(() => {
    if (mode !== "register") return;
    if (captcha) return;
    let cancelled = false;
    fetch("/auth/captcha")
      .then((r) => (r.ok ? (r.json() as Promise<{ id: string; question: string }>) : null))
      .then((j) => { if (!cancelled && j) setCaptcha(j); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [mode, captcha]);

  /** Re-fetch a captcha after a submit attempt consumed the current one. */
  function refreshCaptcha() {
    setCaptcha(null);
    setCaptchaAnswer("");
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // Successful submit clears the "session expired" banner so it doesn't
      // linger after a fresh login.
      setKickReason(null);
      if (mode === "register") {
        if (password !== passwordConfirm) {
          throw new Error("Passwords don't match. Please retype them.");
        }
        if (!accepted) {
          throw new Error("Please accept the disclaimer to register.");
        }
        if (!acceptedAgeMature) {
          throw new Error("Please confirm you are 18+ and understand this site may contain mature content.");
        }
        if (!captcha || !captchaAnswer.trim()) {
          throw new Error("Please answer the verification question.");
        }
        const res = await fetch("/auth/register", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            username,
            password,
            acceptDisclaimer: true,
            acceptAgeMature: true,
            captchaId: captcha.id,
            captchaAnswer: captchaAnswer.trim(),
            hp,
          }),
        });
        if (!res.ok) {
          // The captcha is single-use server-side, so any failed submit
          // (wrong answer, dup username, expired token, etc.) leaves the
          // current id consumed. Drop it so the next render re-fetches.
          refreshCaptcha();
          throw new Error((await res.json()).error ?? "register failed");
        }
        const j = await res.json();
        // The server returns role:"admin" for the very first registrant
        // (bootstrap path). Trust the server response so the Admin button
        // appears immediately without requiring a page reload.
        setMe({ id: j.id, username: j.username, role: j.role ?? "user" });
      } else {
        const res = await fetch("/auth/login", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: email || username, password }),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? "login failed");
        const j = await res.json();
        setMe({ id: j.id, username: j.username, role: j.role });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "error");
    } finally {
      setSubmitting(false);
    }
  }

  function setModeAndReset(next: "login" | "register") {
    // Reset register-only fields when leaving register mode so a stale tick
    // or stale confirm-password value doesn't linger after the user backs
    // out and returns later. (Empty disclaimer text means there's nothing
    // to agree to; that case is handled separately below.)
    if (next !== "register") {
      setAccepted(false);
      setAcceptedAgeMature(false);
      setPasswordConfirm("");
      setCaptcha(null);
      setCaptchaAnswer("");
      setHp("");
    }
    setMode(next);
    // Reflect the toggle in the address bar so /login and /register are
    // both bookmarkable and the back button rewinds between them. Only
    // when a parent supplied a navigator — internal callers (deep-link
    // gates) that don't pass one keep the legacy state-only behavior.
    if (onNavigate) {
      onNavigate(next === "register" ? "/register" : "/login");
    }
  }

  // Server enforces this too; the gate here is UX. Empty disclaimer text =
  // nothing to agree to, so we don't block the user behind a meaningless tick.
  const disclaimerText = branding.registerDisclaimerHtml.trim();
  const needsAcceptance = mode === "register" && disclaimerText !== "";
  const canSubmit = !submitting && (
    mode === "login"
      ? true
      : (!needsAcceptance || accepted) && acceptedAgeMature && !!captcha && captchaAnswer.trim() !== ""
  );

  return (
    <SplashShell
      footer={
        branding.registrationOpen ? (
          <button
            type="button"
            className="w-full text-xs text-keep-muted hover:text-keep-text"
            onClick={() => setModeAndReset(mode === "login" ? "register" : "login")}
          >
            {mode === "login" ? "Need an account? Register." : "Already have one? Log in."}
          </button>
        ) : (
          <div className="text-center text-xs italic text-keep-muted">
            Registration is currently closed.
          </div>
        )
      }
    >
      <form onSubmit={submit} className="space-y-3">
        <div className="text-center text-[10px] uppercase tracking-[0.25em] text-keep-muted">
          {mode === "login" ? "enter the spire" : "create a vessel"}
        </div>

        {/* Deep-link hint: when the visitor arrived via /p/<username>, tell
            them which profile they're trying to view. The copy varies
            depending on whether the profile is private (the user explicitly
            asked for "this profile is private, please sign in or register"
            wording) or just a regular public profile (just "you're trying
            to view X"). After login the modal opens automatically. */}
        {pendingProfileHint ? (
          <div className="rounded border border-keep-action/40 bg-keep-action/10 px-3 py-2 text-xs text-keep-text/90">
            {pendingProfileHint.isPrivate ? (
              <>
                <b>{pendingProfileHint.name}</b>'s profile is <b>private</b>. Please sign in or
                register to view it.
              </>
            ) : (
              <>
                You're trying to view <b>{pendingProfileHint.name}</b>'s profile. Sign in or
                register to continue.
              </>
            )}
          </div>
        ) : null}

        {pendingWorldHint ? (
          <div className="rounded border border-keep-action/40 bg-keep-action/10 px-3 py-2 text-xs text-keep-text/90">
            <b>{pendingWorldHint.name}</b> is a <b>private</b> world. Please sign in or register
            to view it.
          </div>
        ) : null}

        {kickReason ? (
          <div className="flex items-start justify-between gap-2 rounded border border-keep-action/40 bg-keep-action/10 px-3 py-2 text-xs text-keep-text/90">
            <span>{kickReason}</span>
            <button
              type="button"
              onClick={() => setKickReason(null)}
              aria-label="Dismiss"
              className="shrink-0 text-keep-muted hover:text-keep-text"
            >
              ✕
            </button>
          </div>
        ) : null}

        {mode === "register" ? (
          <>
            <Field label="Email" value={email} onChange={setEmail} type="email" autoComplete="email" />
            <Field label="Master username" value={username} onChange={setUsername} autoComplete="username" />
          </>
        ) : (
          <Field
            label="Email or username"
            value={email}
            onChange={setEmail}
            autoComplete="username"
          />
        )}
        <Field
          label="Password"
          value={password}
          onChange={setPassword}
          type="password"
          autoComplete={mode === "register" ? "new-password" : "current-password"}
        />
        {mode === "register" ? (
          <div>
            <Field
              label="Confirm password"
              value={passwordConfirm}
              onChange={setPasswordConfirm}
              type="password"
              autoComplete="new-password"
            />
            {/*
              Inline mismatch hint - only fires once the user has typed in the
              confirm field, otherwise the empty initial state would shout at
              them before they even start. Deliberately doesn't block the
              submit button (matching is verified on submit) so the keyboard
              flow stays uninterrupted; the message is just a visual cue.
            */}
            {passwordConfirm && password !== passwordConfirm ? (
              <div className="mt-1 text-[10px] text-keep-accent">
                Passwords don't match yet.
              </div>
            ) : null}
          </div>
        ) : null}

        {needsAcceptance ? (
          <div className="space-y-2 rounded border border-keep-border/60 bg-keep-bg/40 px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.25em] text-keep-muted">
              before you register
            </div>
            <div
              className="prose prose-sm max-h-48 max-w-none overflow-y-auto pr-1 text-xs text-keep-text/90"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(disclaimerText) }}
            />
            <label className="flex cursor-pointer items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                I have read and accept the disclaimer above and the house rules.
              </span>
            </label>
          </div>
        ) : null}

        {mode === "register" ? (
          <>
            {/* Age + mature content acknowledgment. Always required (not
                admin-toggleable) since it's a baseline content-rating
                gate, not site-specific policy. */}
            <label className="flex cursor-pointer items-start gap-2 rounded border border-keep-border/60 bg-keep-bg/40 px-3 py-2 text-xs">
              <input
                type="checkbox"
                checked={acceptedAgeMature}
                onChange={(e) => setAcceptedAgeMature(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                I am <b>18 years or older</b>, and I understand this site may contain mature
                content (in user profiles, room descriptions, and roleplay).
              </span>
            </label>

            {/* In-house basic CAPTCHA. The question is server-issued and
                single-use; if the answer is wrong or stale, we re-fetch
                automatically on the next render. */}
            <div className="space-y-1 rounded border border-keep-border/60 bg-keep-bg/40 px-3 py-2 text-xs">
              <div className="text-[10px] uppercase tracking-[0.25em] text-keep-muted">
                Quick check (anti-bot)
              </div>
              <div className="flex items-center gap-2">
                <span className="font-semibold tabular-nums">
                  {captcha?.question ?? "loading..."}
                </span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={captchaAnswer}
                  onChange={(e) => setCaptchaAnswer(e.target.value)}
                  placeholder="answer"
                  className="w-24 rounded border border-keep-border bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
                  disabled={!captcha}
                />
                <button
                  type="button"
                  onClick={refreshCaptcha}
                  className="text-[10px] text-keep-muted underline-offset-2 hover:text-keep-action hover:underline"
                  title="Get a different question"
                >
                  new question
                </button>
              </div>
            </div>

            {/* Honeypot. Hidden from sighted + assistive users; bots that
                fill every input land here and we silently reject the form
                server-side. Tabindex=-1 keeps keyboard users from focusing
                it accidentally. */}
            <input
              type="text"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              value={hp}
              onChange={(e) => setHp(e.target.value)}
              style={{ position: "absolute", left: "-10000px", width: "1px", height: "1px", opacity: 0 }}
            />
          </>
        ) : null}

        {error ? (
          <div className="rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">
            {error}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={!canSubmit}
          title={
            needsAcceptance && !accepted
              ? "Tick the box above to confirm you accept the disclaimer."
              : undefined
          }
          className="w-full rounded border border-keep-border bg-keep-panel py-2 text-sm font-semibold tracking-wide hover:bg-keep-panel/80 disabled:opacity-50"
        >
          {submitting
            ? mode === "login" ? "Logging in..." : "Registering..."
            : mode === "login" ? "Log in" : "Register"}
        </button>
      </form>
    </SplashShell>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block uppercase tracking-widest text-keep-muted">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        // text-base on mobile prevents iOS auto-zoom (anything <16px triggers
        // a zoom on focus); md+ keeps the compact density.
        className="w-full rounded border border-keep-border bg-keep-bg px-2 py-2 text-base outline-none focus:border-keep-action md:py-1 md:text-sm"
      />
    </label>
  );
}
