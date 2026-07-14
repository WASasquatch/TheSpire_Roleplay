import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Eye, EyeOff } from "lucide-react";
import DOMPurify from "dompurify";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { VERSION, isDarkPalette, type Role } from "@thekeep/shared";
import { useChat, type AuthMe } from "../state/store.js";
import { setSessionToken } from "../lib/http.js";
import { markLoginIntent } from "../lib/socket.js";
import { formatNumber } from "../lib/intlFormat.js";
import { resolveSplashTheme, splashBgClass, themeStyle } from "../lib/theme.js";
import { GoogleFinishSignup } from "./GoogleFinishSignup.js";
import { SplashLanguagePicker } from "./marketing/SplashLanguagePicker.js";
import { readReturnForum } from "./forums/ForumPublicLanding.js";
import { readPendingInvite } from "./servers/ServerInviteLanding.js";

/**
 * The marketing-namespace `t` shape, for the plain-function helpers below
 * (they can't use the hook, so callers pass the hook's `t` in). Typed as the
 * real TFunction so it stays assignable under exactOptionalPropertyTypes.
 */
type Translate = TFunction<"marketing">;

const PROJECT_URL = "https://github.com/WASasquatch/TheSpire_Roleplay";

interface SiteStats {
  online: number;
  /** Total registered accounts (excluding the system sentinel). Optional for forward-compat with older servers. */
  totalRegistered?: number;
  rooms: { public: number; private: number; total: number };
  /** Rolling 24-hour chat message count. Optional for forward-compat with older servers. */
  messages24h?: number;
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
  const { t } = useTranslation("marketing");
  const branding = useChat((s) => s.branding);
  const [stats, setStats] = useState<SiteStats | null>(null);

  // Live stats so visitors see the chat is alive before they log in.
  // /stats is unauthenticated; we refresh every 30s to track ebb and
  // flow. Skipped entirely when BOTH the activity-feed master toggle
  // and the 24h-message sub-toggle are off, the splash has nothing
  // to surface and the fetch would be wasted (cold-start posture so
  // empty counters don't telegraph "dead community" to first visitors).
  // Either toggle being on is enough to start polling; the render path
  // decides which sections actually render based on each toggle.
  const statsEnabled =
    branding.activityFeedsEnabled || branding.splashMessages24hEnabled;
  useEffect(() => {
    if (!statsEnabled) {
      setStats(null);
      return;
    }
    let cancelled = false;
    function load() {
      fetch("/stats")
        .then((r) => (r.ok ? (r.json() as Promise<SiteStats>) : null))
        .then((j) => {
          // Shape-check before trusting the payload. During a dev boot (and
          // any proxy hiccup) this fetch can win a race against the API and
          // resolve with a 200 whose JSON isn't the stats shape; rendering
          // `rooms.public` off that crashed the whole splash through the
          // error boundary. Treat a malformed payload like no payload: keep
          // the placeholder and let the 30s poll heal once the API answers.
          if (!cancelled && j && j.rooms && typeof j.rooms.public === "number") setStats(j);
        })
        .catch(() => {});
    }
    load();
    const id = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [statsEnabled]);

  // Logo text styling mirrors the in-app banner so the brand stays
  // consistent. Both color and font fall back to the theme when unset.
  const logoStyle: React.CSSProperties = {};
  if (branding.logoColor) logoStyle.color = branding.logoColor;
  if (branding.logoFont) logoStyle.fontFamily = branding.logoFont;

  const splashTheme = resolveSplashTheme(branding);
  const splashIsDark = isDarkPalette(splashTheme);
  return (
    // Inline `themeStyle(splashTheme)` scopes the splash to the
    // resolved palette: admin's explicit default → user's last-active
    // (cached) → system prefers-color-scheme → Parchment fallback.
    // This decouples the splash from whatever CSS vars a previously-
    // logged-in user left on documentElement, and lets a dark-mode
    // user land on the Darkness palette automatically.
    <div
      style={themeStyle(splashTheme)}
      className="relative min-h-screen w-full overflow-hidden text-keep-text"
    >
      {/* Language picker (shared with SplashLanding) — visitors pick
          their language BEFORE registering, so the whole sign-up flow
          reads in it. */}
      <SplashLanguagePicker />
      {/* Background art, portaled to <body> so it is a TRUE viewport-fixed
          layer (mirrors SplashLanding). `position: fixed` only resolves against
          the viewport when NO ancestor establishes a containing block; a
          `transform`/`filter`/`will-change`/`backdrop-filter` anywhere up the
          tree (a theme design's glass treatment, the struck-shake animation,
          etc.) silently re-anchors a plain `fixed` child to that ancestor —
          which is what left the login wallpaper blank/white. Rendering it on
          <body> guarantees it ignores page height and always fills the window;
          themeStyle is re-applied here because the portal lives outside this
          subtree's CSS-var scope.

          z-index MUST be 0 (not -1): a `position:fixed` element escapes to the
          ROOT stacking context, and a NEGATIVE z there is painted BEFORE the
          <body> box — so body's own opaque `background-color: --keep-bg`
          (styles.css `html, body {…}`) paints right over it and the wallpaper
          stays blank. z-index:0 paints it ABOVE the body background; the splash
          foreground below is lifted to `z-10` so the card still sits on top.
          The negative-x offset (-175px) centers the spire on portrait mobile;
          md+ uses the natural cover-center. */}
      {createPortal(
        <div aria-hidden style={{ ...themeStyle(splashTheme), position: "fixed", inset: 0, zIndex: 0 }}>
          <div className={`absolute inset-0 bg-cover bg-[position:-175px_center] md:bg-center ${splashBgClass(splashTheme)}`} />
          {/* Right-side veil so the card sits on a calm background; lighter on
              mobile where the glass card wants the artwork showing through. */}
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-keep-bg/30 md:to-keep-bg/70" />
          {/* Dark-mode corner glows (cyan star halo / moonlit ridge), only when
              the resolved splash palette reads as dark. */}
          {splashIsDark ? (
            <>
              <div
                className="pointer-events-none absolute -left-32 -top-32 h-[28rem] w-[28rem]"
                style={{ background: "radial-gradient(circle, rgba(63,165,160,0.35) 0%, rgba(63,165,160,0.12) 35%, transparent 70%)" }}
              />
              <div
                className="pointer-events-none absolute -bottom-32 -right-32 h-[32rem] w-[32rem]"
                style={{ background: "radial-gradient(circle, rgba(220,230,255,0.22) 0%, rgba(220,230,255,0.08) 40%, transparent 75%)" }}
              />
            </>
          ) : null}
        </div>,
        document.body,
      )}

      {/*
        Card position. On wide desktops (lg+) we visually center the
        card in the right third of the viewport (its center sits at
        ~75% horizontal), so it floats over the parchment-fade side of
        the bg image while the spire art stays clear on the left. The
        `right` offset is computed as `max(2rem, 25% - 17.5rem)`,
        17.5rem is half the 560px card width, and the floor of 2rem
        keeps the card from clipping when 25% of the viewport would
        otherwise leave no room. Below lg, portrait phones, landscape
        phones, small tablets, we fall back to centered flex layout
        (with a 2-column landscape-phone grid handled by the card's
        own classes). The previous `md:left-[75%]` math clipped at
        landscape-phone widths because half the card extended past the
        viewport; this max(...) replaces that without losing the
        intentional "card centered in the right third" desktop feel.
      */}
      <div className="relative z-10 flex min-h-screen items-center justify-center">
        <div
          // Mobile vs desktop card treatment:
          //   - <lg (default): glass / frosted treatment. The card is
          //     translucent (~55% parchment) with a strong backdrop blur
          //     so the spire artwork shows through softly without
          //     distracting from the form. Lighter border + ring give it
          //     a subtle "pane of glass" edge.
          //   - lg+ (wide desktop): centered card (no longer
          //     right-anchored) so the login / register page sits at
          //     the same focal point as the splash. The card grows to
          //     a comfortable max but never wider than the viewport.
          // The outer container is `overflow-hidden` (so the bg image
          // can't bleed outside the viewport when the artwork is taller
          // than the available space). That clips anything growing past
          // the viewport - including the Roleplay Communities
          // section below the form. Cap the card's
          // height to the viewport (less margin) and let the card scroll
          // internally so additional sections stay reachable on shorter
          // screens.
          className="
            mx-4 my-8
            w-[min(720px,92vw)]
            max-lg:landscape:w-[min(900px,96vw)] max-lg:landscape:mx-2 max-lg:landscape:my-2
            max-h-[calc(100vh-4rem)] overflow-y-auto
            max-lg:landscape:max-h-[calc(100vh-1rem)]
            lg:my-6 lg:max-h-[calc(100vh-3rem)]
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
            {/* INFO COLUMN, title, stats, meta, welcome blurb. Stays
                left in landscape phones; stacks above the form in
                portrait / wide-desktop layouts. */}
            <div className="max-lg:landscape:min-w-0">
              {/* Header - site name, theme-tinted */}
              <div className="mb-3 text-center max-lg:landscape:mb-1">
                {/* Brass-diamond rule above the wordmark, matches
                    the splash + bookshelf chrome so the antique
                    library motif carries through the sign-in
                    journey. Hidden on landscape phones where every
                    pixel of vertical space matters. */}
                <div className="mx-auto mb-3 flex w-[min(280px,80%)] items-center gap-3 opacity-80 max-lg:landscape:hidden" aria-hidden>
                  <span className="h-px flex-1" style={{ background: "linear-gradient(90deg, transparent, rgb(var(--keep-accent) / 0.55), transparent)" }} />
                  <span className="block h-[7px] w-[7px] rotate-45" style={{ background: "rgb(var(--keep-accent))", boxShadow: "0 0 10px rgb(var(--keep-accent) / 0.55)" }} />
                  <span className="h-px flex-1" style={{ background: "linear-gradient(90deg, transparent, rgb(var(--keep-accent) / 0.55), transparent)" }} />
                </div>
                <h1
                  style={logoStyle}
                  className="font-action text-3xl tracking-wide text-keep-text sm:text-4xl max-lg:landscape:text-2xl"
                >
                  {branding.logoUrl ? (
                    // The splash gets a larger logo than the banner,
                    // welcome card has the vertical real estate. `mx-auto`
                    // keeps it centered inside the text-aligned <h1>;
                    // alt = siteName so screen-readers + SEO still see
                    // the brand string.
                    <img
                      src={branding.logoUrl}
                      alt={branding.siteName}
                      className="mx-auto max-h-20 w-auto select-none sm:max-h-24 max-lg:landscape:max-h-16"
                      draggable={false}
                    />
                  ) : (
                    branding.siteName
                  )}
                </h1>
                <div className="mt-1 text-[10px] uppercase tracking-[0.3em] text-keep-muted">
                  {t("shell.tagline")}
                </div>
              </div>

              {/* Live stats strip, omitted entirely when neither activity
                  toggle is on, so the splash sells the IDEA of the place
                  rather than its (potentially empty) current activity.
                  Either toggle being on is enough to mount the strip;
                  SplashStats itself picks which sections render. */}
              {statsEnabled ? <SplashStats stats={stats} /> : null}

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
                  className="prose prose-xl mb-5 mt-4 max-w-none border-y border-keep-rule/50 py-3 text-keep-text/90 max-lg:landscape:mb-0 max-lg:landscape:mt-2 max-lg:landscape:border-t-0 max-lg:landscape:pt-2"
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(branding.welcomeHtml) }}
                />
              ) : (
                <div className="my-5 border-t border-keep-rule/50 max-lg:landscape:hidden" />
              )}
            </div>

            {/* FORM COLUMN, the actual sign-in / register UI. Right
                column in landscape phones; below the info in other
                layouts. */}
            <div className="max-lg:landscape:min-w-0">
              {/* Body content (form or "checking session..." indicator) */}
              <div>{children}</div>

              {footer ? <div className="mt-4">{footer}</div> : null}
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
              {t("shell.projectCredit", { version: VERSION })}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function SplashStats({ stats }: { stats: SiteStats | null }) {
  const { t } = useTranslation("marketing");
  // Use the admin-configured site name in flavor copy so "the keep" (the
  // codename) doesn't leak through to users on a rebranded install.
  const siteName = useChat((s) => s.branding.siteName);
  // Two independent toggles. `activityFeedsEnabled` gates the
  // online/registered/room cluster (the original chip-row). The
  // 24h-message toggle gates a separate HERO block, large number
  // with an uppercase label below, because admins surfacing chat
  // volume want it to anchor the eye, not get lost in a stat row.
  // When both are on, the hero sits above the chip row so the
  // headline reads first and the smaller numbers contextualize it.
  // SplashShell gates the mount so at least one toggle is truthy
  // by the time this renders.
  const showActivity = useChat((s) => s.branding.activityFeedsEnabled);
  const showMessages24h = useChat((s) => s.branding.splashMessages24hEnabled);
  if (!stats) {
    return (
      <div className="my-2 flex items-center justify-center gap-2 text-xs text-keep-muted">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-keep-muted/40" />
        <span>{t("shell.checking", { siteName })}</span>
      </div>
    );
  }
  // Only surface the 24h count when (a) the admin opted in AND (b) the
  // server populated the field (forward-compat with old servers that
  // didn't ship `messages24h`). A zero value still renders, it's a
  // real "no activity in the window" signal, not a missing-data case,
  // and the admin already opted into seeing it.
  const renderMessages24h =
    showMessages24h && typeof stats.messages24h === "number";
  // Belt-and-braces beside the fetch-time shape check: never dereference
  // `rooms` raw. Every other field here already has a forward-compat guard;
  // this was the one unguarded read, and it converted a malformed payload
  // into a full-app error-boundary crash.
  const publicRooms = stats.rooms?.public ?? 0;
  const privateRooms = stats.rooms?.private ?? 0;
  return (
    <div className="my-3">
      {renderMessages24h ? (
        <Messages24hHero count={stats.messages24h as number} />
      ) : null}
      {showActivity ? (
        <div
          className={`flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-keep-muted ${
            renderMessages24h ? "mt-3" : ""
          }`}
        >
          {typeof stats.totalRegistered === "number" ? (
            <span className="inline-flex items-baseline gap-1">
              {/* When the server reports the registered-account total, render
                  the online stat with TWO emphasised numbers (e.g. "0 users
                  online out of 2") so the total matches the bold/tabular-nums
                  styling of the other counts. Falls back to the single-number
                  Stat helper for older servers without the field. */}
              <Trans
                t={t}
                i18nKey="shell.stats.onlineOutOf"
                count={stats.online}
                values={{ total: stats.totalRegistered }}
              >
                <span
                  className={`text-base font-semibold tabular-nums ${
                    stats.online > 0 ? "text-keep-action" : "text-keep-text"
                  }`}
                >
                  {"{{count}}"}
                </span>
                <span>{"users online out of"}</span>
                <span className="text-base font-semibold tabular-nums text-keep-text">
                  {"{{total}}"}
                </span>
              </Trans>
            </span>
          ) : (
            <Stat
              label={t("shell.stats.usersOnline", { count: stats.online })}
              value={stats.online}
              emphasised={stats.online > 0}
            />
          )}
          <span aria-hidden className="text-keep-rule">·</span>
          <Stat label={t("shell.stats.publicRooms", { count: publicRooms })} value={publicRooms} />
          {privateRooms > 0 ? (
            <>
              <span aria-hidden className="text-keep-rule">·</span>
              <Stat label={t("shell.stats.privateChambers", { count: privateRooms })} value={privateRooms} />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Hero treatment for the rolling 24h message count, the prominent
 * splash stat the admin opted into via Settings → Activity feeds →
 * Messages in last 24h. Centered, large tabular-nums number with a
 * small uppercase label below; brand color when there's activity in
 * the window, neutral text when the count is zero. Tasteful rather
 * than loud, sized to anchor the eye without elbowing past the logo
 * + title above it.
 */
function Messages24hHero({ count }: { count: number }) {
  const { t } = useTranslation("marketing");
  return (
    <div className="text-center">
      <div
        className={`text-3xl font-bold tabular-nums leading-none sm:text-4xl ${
          count > 0 ? "text-keep-action" : "text-keep-text"
        }`}
      >
        {formatNumber(count)}
      </div>
      <div className="mt-1.5 text-[10px] uppercase tracking-[0.2em] text-keep-muted">
        {t("stats.messages24hLabel", { count })}
      </div>
    </div>
  );
}

/**
 * Format a millisecond duration for human-facing splash copy. Picks the
 * largest natural unit ("30 days" beats "720 hours") and pluralizes
 * appropriately. 0 maps to "indefinitely" - only meaningful for retention.
 */
function formatHumanDuration(t: Translate, ms: number): string {
  if (ms <= 0) return t("duration.indefinitely");
  const day = 86_400_000;
  const hour = 3_600_000;
  const minute = 60_000;
  if (ms % day === 0) {
    return t("duration.days", { count: ms / day });
  }
  if (ms % hour === 0) {
    return t("duration.hours", { count: ms / hour });
  }
  if (ms % minute === 0) {
    return t("duration.minutes", { count: ms / minute });
  }
  return t("duration.seconds", { seconds: Math.round(ms / 1000) });
}

/**
 * Retention + session TTL strip rendered below the live stats. Both numbers
 * come from admin settings via /site so they always reflect the live policy.
 * Worded conversationally because this is a marketing-adjacent surface, not
 * the admin's terse "30d" formatting.
 */
function SplashMeta() {
  const { t } = useTranslation("marketing");
  const retentionMs = useChat((s) => s.branding.messageRetentionMs);
  const sessionMs = useChat((s) => s.branding.sessionTtlMs);
  const retentionWord = retentionMs === 0
    ? t("shell.meta.retentionIndefinite")
    : t("shell.meta.retention", { duration: formatHumanDuration(t, retentionMs) });
  const sessionWord = t("shell.meta.sessionIdle", { duration: formatHumanDuration(t, sessionMs) });
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

/**
 * The auth bundle returned by /auth/login, /auth/register, and the two
 * Google endpoints (/auth/google/exchange + /auth/google/finish). All four
 * hand back the same shape, so one applier keeps the token-store + setMe
 * mapping in a single place instead of re-typing the ~9-field map at every
 * call site. Fields mirror what the login branch reads below.
 */
type SetMe = (me: AuthMe | null) => void;

/**
 * Persist the session token, mark the login as intentional (so the socket
 * fires the "X has connected." broadcast on its next handshake), and flip
 * `me` from the returned bundle. Shared by the password forms AND the Google
 * exchange/finish landings so every entry path lands in chat identically.
 */
function applyAuthBundle(bundle: unknown, setMe: SetMe): void {
  const j = (bundle ?? {}) as {
    sessionToken?: unknown;
    id?: string;
    username?: string;
    role?: string;
    permissions?: unknown;
    incognitoMode?: unknown;
    incognitoAlias?: unknown;
    incognitoCharacterId?: unknown;
    emailVerifiedAt?: unknown;
    emailVerificationEnabled?: unknown;
    emailVerificationMode?: unknown;
  };
  // Persist the per-tab bearer token before flipping `me`: the moment
  // AuthGate unmounts, the chat shell fires its mount-time /me/* fetches
  // and they need the Authorization header already in place.
  if (typeof j.sessionToken === "string") setSessionToken(j.sessionToken);
  markLoginIntent();
  setMe({
    id: j.id as string,
    username: j.username as string,
    // The server returns role:"masteradmin" for the first registrant
    // (bootstrap). Trust it so the Admin button appears without a reload.
    role: (j.role ?? "user") as Role,
    permissions: Array.isArray(j.permissions) ? (j.permissions as AuthMe["permissions"]) : [],
    incognitoMode: j.incognitoMode === true,
    incognitoAlias: typeof j.incognitoAlias === "string" ? j.incognitoAlias : null,
    incognitoCharacterId: typeof j.incognitoCharacterId === "string" ? j.incognitoCharacterId : null,
    emailVerifiedAt: typeof j.emailVerifiedAt === "number" ? j.emailVerifiedAt : null,
    emailVerificationEnabled: j.emailVerificationEnabled === true,
    emailVerificationMode: j.emailVerificationMode === "block" ? "block" : "nudge",
  });
}

/**
 * Google's four-color "G" glyph, inline SVG so it renders under the prod CSP
 * (no external image request) and stays crisp at any size. Marked aria-hidden;
 * the button carries the accessible label.
 */
function GoogleGlyph() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4 shrink-0" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/**
 * "Continue with Google" button + an "or" rule. Rendered on both the login
 * and register views when the admin has Google sign-in enabled. This is a
 * full-page redirect (NOT a fetch): OAuth is a browser navigation round-trip
 * to Google's consent screen and back, not an XHR. `mode` distinguishes a
 * fresh login/signup from a link-existing-account flow so the server can
 * branch its callback.
 */
export function GoogleAuthButton({ mode }: { mode: "login" | "link" }) {
  const { t } = useTranslation("marketing");
  return (
    <>
      <div className="my-3 flex items-center gap-3 text-[10px] uppercase tracking-[0.25em] text-keep-muted">
        <span className="h-px flex-1 bg-keep-rule/60" />
        {t("auth.or")}
        <span className="h-px flex-1 bg-keep-rule/60" />
      </div>
      <button
        type="button"
        onClick={() => { window.location.href = `/auth/google/start?mode=${mode}`; }}
        aria-label={t("auth.continueWithGoogle")}
        className="flex w-full items-center justify-center gap-2 rounded border border-keep-border bg-keep-bg py-2 text-sm font-semibold tracking-wide text-keep-text hover:bg-keep-panel"
      >
        <GoogleGlyph />
        {t("auth.continueWithGoogle")}
      </button>
    </>
  );
}

/**
 * Classify the current URL against the three Google OAuth client landings.
 * Returns null for every other URL (the common case) so callers cheaply skip.
 *   - /auth/google/done?code=…   → exchange the code, sign straight in
 *   - /auth/google/finish?code=… → show the finish-signup screen (new user)
 */
export function readGoogleLanding(): { kind: "done" | "finish"; code: string } | null {
  if (typeof window === "undefined") return null;
  const { pathname, search } = window.location;
  const kind =
    pathname === "/auth/google/done" ? "done" :
    pathname === "/auth/google/finish" ? "finish" :
    null;
  if (!kind) return null;
  const code = new URLSearchParams(search).get("code");
  if (!code) return null;
  return { kind, code };
}

/** Strip the Google landing path (+ its `code`) from the address bar so a
 *  refresh can't replay a now-consumed single-use code. Resets to "/". */
function clearGoogleLandingUrl(): void {
  if (typeof window === "undefined") return;
  window.history.replaceState(null, "", "/");
}

export function AuthGate({ pendingProfileHint, pendingWorldHint, initialMode = "login", onNavigate }: AuthGateProps = {}) {
  const { t } = useTranslation("marketing");
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
   * Show/hide toggle for the single password field. Unmasking lets users
   * catch typos themselves, which is why we dropped the separate confirm
   * field (it drove the bulk of signup abandonment).
   */
  const [showPassword, setShowPassword] = useState(false);
  /**
   * Acceptance of the registration disclaimer. Required for /auth/register
   * (server enforces a literal `true`). Reset whenever mode toggles so a
   * stale tick from a prior session doesn't carry over.
   */
  const [accepted, setAccepted] = useState(false);
  /**
   * Date of birth, register-mode only (replaces the old 18+ checkbox —
   * age-restriction plan Phase 0). ISO YYYY-MM-DD straight from the native
   * date input; "" = not entered yet. The server stores it and enforces
   * the minimum age; the form pre-checks so a too-young date gets a
   * friendly inline message instead of a round-trip. Reset on mode switch
   * (same posture as the disclaimer checkbox).
   */
  const [birthdate, setBirthdate] = useState("");
  /**
   * Minor isolation opt-in (age plan Phase 5), revealed only when the
   * entered date of birth is under 18. Optional; can be changed later in
   * the profile editor's Privacy tab. Reset with the other register-only
   * fields on mode switch.
   */
  const [isolatePref, setIsolatePref] = useState(false);
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
  // Forum-bound visitor (came from a /f/<slug> landing's Log in /
  // Register buttons). Read once on mount; the key itself stays in
  // storage — the authed boot consumes it to reopen the forum.
  const [returnForum] = useState(() => readReturnForum());
  // Invite-bound visitor (came from an /i/<code> landing's CTAs). The code
  // rides the register POST as `inviteCode` so the server joins the invited
  // community at signup; a plain LOGIN leaves the key in storage for the
  // authed boot to redeem. `slug` holds the invite CODE.
  const [pendingInviteDest] = useState(() => readPendingInvite());
  // When the admin closes registration, snap any stale "register" mode back
  // to "login" so the form can't show fields that the server will reject.
  if (!branding.registrationOpen && mode === "register") setMode("login");

  // Google OAuth client landing, classified once from the URL. Two shapes
  // arrive after Google returns and the server hands back a single-use code:
  //   - "done"   → an existing/linked account: exchange the code straight
  //                for a session (no user input needed) and enter chat.
  //   - "finish" → a brand-new Google user: render the finish-signup screen
  //                (username + disclaimers) which redeems the code itself.
  // Read via lazy init so it's captured before any replaceState we do below.
  const [googleLanding] = useState(() => readGoogleLanding());
  // Guards the one-shot exchange so React 18 StrictMode's double-invoke (or a
  // re-render) can't POST a single-use code twice. A ref, not state, so it
  // flips synchronously before the async fetch is even in flight.
  const exchangeStartedRef = useRef(false);

  // "done" landing: POST the code to /auth/google/exchange and, on success,
  // run the same token-store + setMe handoff the login form uses. On failure
  // strip the URL and drop the user on the login form with an explanation
  // (the code is single-use, so there's nothing to retry in place).
  useEffect(() => {
    if (googleLanding?.kind !== "done") return;
    if (exchangeStartedRef.current) return;
    exchangeStartedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/auth/google/exchange", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: googleLanding.code }),
        });
        if (!res.ok) {
          const body = await res.json().catch(
            () => ({} as { error?: string; issues?: Array<{ path?: string; message: string }> }),
          );
          const firstIssue = body.issues?.[0];
          throw new Error(
            (firstIssue ? firstIssue.message : null) ?? body.error ?? t("auth.googleFailed"),
          );
        }
        const bundle = await res.json();
        if (cancelled) return;
        // Strip the single-use code from the URL BEFORE applyAuthBundle flips
        // `me` (which unmounts this gate), so a refresh can't replay it.
        clearGoogleLandingUrl();
        setKickReason(null);
        applyAuthBundle(bundle, setMe);
      } catch (err) {
        if (cancelled) return;
        clearGoogleLandingUrl();
        setError(err instanceof Error ? err.message : t("auth.googleFailed"));
      }
    })();
    return () => { cancelled = true; };
  }, [googleLanding, setMe, setKickReason]);

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
        if (!accepted) {
          throw new Error(t("auth.rulesRequired"));
        }
        if (!birthdate) {
          throw new Error(t("auth.dobRequired"));
        }
        // Friendly pre-check so an under-age date gets an inline message
        // instead of a round-trip. Same copy the server returns; the
        // server stays authoritative.
        const minAge = branding.minimumSignupAge ?? 18;
        const enteredAge = isoAgeUtc(birthdate);
        if (enteredAge === null || enteredAge < minAge) {
          throw new Error(t("auth.minAgeError", { minAge }));
        }
        if (!captcha || !captchaAnswer.trim()) {
          throw new Error(t("auth.captchaRequired"));
        }
        // Backstop for the inline username hints (Enter-key submits can slip
        // past a disabled button in some browsers). Friendly copy only.
        if (!usernameLocalValid) {
          throw new Error(t(usernameHasSpace ? "auth.usernameSpaceWarning" : "auth.usernameInvalid"));
        }
        // Only under-18 signups carry the isolation opt-in; the checkbox is
        // only shown to them, and the server clamps it to minors anyway.
        const registeringAsMinor = enteredAge !== null && enteredAge < 18;
        const res = await fetch("/auth/register", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            username: usernameTrimmed,
            password,
            acceptDisclaimer: true,
            birthdate,
            ...(registeringAsMinor && isolatePref ? { isolateFromAdults: true } : {}),
            // Server invite carry-through: the account auto-joins the
            // inviting community (server-side gates decide) and lands there.
            ...(pendingInviteDest ? { inviteCode: pendingInviteDest.slug } : {}),
            captchaId: captcha.id,
            captchaAnswer: captchaAnswer.trim(),
            hp,
          }),
        });
        if (!res.ok) {
          // Zod validation failures arrive as `{ error: "validation",
          // issues: [{ path, message }] }`. Surfacing just `error` left
          // the user staring at the word "validation" with no idea
          // which field failed, prefer the first issue's message.
          const body = await res.json().catch(() => ({} as { error?: string; code?: string; issues?: Array<{ path?: string; message: string }> }));
          // The server now verifies the captcha LAST, so field problems and
          // the name-in-use conflict no longer consume the token — keep the
          // current challenge on those failures (fix the field, resubmit).
          // Only an actual captcha failure (`code: "CAPTCHA"`) burns it, so
          // only then do we fetch a fresh one.
          if (body.code === "CAPTCHA") refreshCaptcha();
          const firstIssue = body.issues?.[0];
          const detail = firstIssue
            ? `${firstIssue.path ? `${firstIssue.path}: ` : ""}${firstIssue.message}`
            : null;
          throw new Error(detail ?? body.error ?? t("auth.registerFailed"));
        }
        // Persist the token, mark the login intentional (so the socket
        // fires "X has connected." on its next handshake), and flip `me`.
        // Shared with login + the Google landings via applyAuthBundle.
        applyAuthBundle(await res.json(), setMe);
      } else {
        const res = await fetch("/auth/login", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: email || username, password }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({} as { error?: string; issues?: Array<{ path?: string; message: string }> }));
          const firstIssue = body.issues?.[0];
          const detail = firstIssue
            ? `${firstIssue.path ? `${firstIssue.path}: ` : ""}${firstIssue.message}`
            : null;
          throw new Error(detail ?? body.error ?? t("auth.loginFailed"));
        }
        // Same token-store + setMe handoff as the register branch above.
        applyAuthBundle(await res.json(), setMe);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errorFallback"));
    } finally {
      setSubmitting(false);
    }
  }

  function setModeAndReset(next: "login" | "register") {
    // Reset register-only fields when leaving register mode so a stale tick
    // doesn't linger after the user backs out and returns later. (Empty
    // disclaimer text means there's nothing to agree to; that case is
    // handled separately below.) Re-mask the password on any mode switch so
    // an unmasked value from register mode isn't left visible on login.
    setShowPassword(false);
    if (next !== "register") {
      setAccepted(false);
      setBirthdate("");
      setIsolatePref(false);
      setCaptcha(null);
      setCaptchaAnswer("");
      setHp("");
    }
    setMode(next);
    // Reflect the toggle in the address bar so /login and /register are
    // both bookmarkable and the back button rewinds between them. Only
    // when a parent supplied a navigator, internal callers (deep-link
    // gates) that don't pass one keep the legacy state-only behavior.
    if (onNavigate) {
      onNavigate(next === "register" ? "/register" : "/login");
    }
  }

  // Registrants must always agree to the house rules (plus the disclaimer when
  // the admin has set one) — the checkbox is shown in register mode either way.
  // Server enforces `accepted` too; this is the UX gate.
  const disclaimerText = branding.registerDisclaimerHtml.trim();
  const needsAcceptance = mode === "register";
  // Friendly client-side username pre-check (register only). Mirrors the
  // server's allow-list — letters, numbers, _ - ' . ` and the invisible
  // non-breaking space — WITHOUT surfacing any of that as copy: the space
  // warning + one-click underscore fix (same steering CreateCharacterModal
  // gives character names) covers the case people actually hit. The server
  // stays authoritative; this just saves a round-trip.
  // Validated value = SUBMITTED value (the register POST sends
  // `usernameTrimmed`), so the pre-check can never bless a name the server
  // then rejects. Only ASCII edge whitespace is stripped — NBSP is part of
  // the allow-list and must survive wherever the user put it.
  const usernameTrimmed = username.normalize("NFC").replace(/^[ \t]+|[ \t]+$/g, "");
  const usernameHasSpace = mode === "register" && /[ \t]/.test(usernameTrimmed);
  const usernameLocalValid =
    usernameTrimmed.length >= 2 &&
    usernameTrimmed.length <= 40 &&
    // eslint-disable-next-line no-irregular-whitespace -- NBSP (U+00A0) mirrors the server allow-list
    /^[a-zA-Z0-9_\-'.` ]+$/.test(usernameTrimmed);
  const canSubmit = !submitting && (
    mode === "login"
      ? true
      : accepted && birthdate !== "" && !!captcha && captchaAnswer.trim() !== "" && usernameLocalValid
  );

  // "finish" landing: hand off to the dedicated finish-signup screen (it
  // renders its own SplashShell). Collects the username + disclaimers and
  // redeems the pending code, then runs the same bundle handoff on success.
  // Placed here (after every hook) so the early return doesn't sit between
  // hook calls, keeping hook order stable across renders. `googleLanding` is
  // captured once at mount and never mutated, so this branch is consistent.
  if (googleLanding?.kind === "finish") {
    return (
      <GoogleFinishSignup
        code={googleLanding.code}
        onAuthenticated={(bundle) => {
          clearGoogleLandingUrl();
          setKickReason(null);
          applyAuthBundle(bundle, setMe);
        }}
      />
    );
  }

  // "done" landing in flight: the exchange effect above is redeeming the
  // code. Show a calm "signing you in" indicator instead of the login form
  // (which would flash confusingly). On success `me` flips and this gate
  // unmounts; on failure `error` is set and we fall through to the form so
  // the message renders in its usual slot with a retry path.
  if (googleLanding?.kind === "done" && !error) {
    return (
      <SplashShell>
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-keep-muted">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-keep-muted/40" />
          <span>{t("auth.googleSigningIn")}</span>
        </div>
      </SplashShell>
    );
  }

  return (
    <SplashShell
      footer={
        branding.registrationOpen ? (
          <button
            type="button"
            className="w-full text-xs text-keep-muted hover:text-keep-text"
            onClick={() => setModeAndReset(mode === "login" ? "register" : "login")}
          >
            {mode === "login" ? t("auth.needAccount") : t("auth.alreadyHaveOne")}
          </button>
        ) : (
          <div className="text-center text-xs italic text-keep-muted">
            {t("auth.registrationClosed")}
          </div>
        )
      }
    >
      <form onSubmit={submit} className="space-y-3">
        <div className="text-center text-[10px] uppercase tracking-[0.25em] text-keep-muted">
          {mode === "login" ? t("auth.enterHeading") : t("auth.registerHeading")}
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
              <Trans t={t} i18nKey="auth.profilePrivate" values={{ name: pendingProfileHint.name }}>
                <b>{"{{name}}"}</b>
                {"'s profile is "}
                <b>private</b>
                {". Please sign in or register to view it."}
              </Trans>
            ) : (
              <Trans t={t} i18nKey="auth.profileView" values={{ name: pendingProfileHint.name }}>
                {"You're trying to view "}
                <b>{"{{name}}"}</b>
                {"'s profile. Sign in or register to continue."}
              </Trans>
            )}
          </div>
        ) : null}

        {pendingWorldHint ? (
          <div className="rounded border border-keep-action/40 bg-keep-action/10 px-3 py-2 text-xs text-keep-text/90">
            <Trans t={t} i18nKey="auth.worldPrivate" values={{ name: pendingWorldHint.name }}>
              <b>{"{{name}}"}</b>
              {" is a "}
              <b>private</b>
              {" world. Please sign in or register to view it."}
            </Trans>
          </div>
        ) : null}

        {kickReason ? (
          <div className="flex items-start justify-between gap-2 rounded border border-keep-action/40 bg-keep-action/10 px-3 py-2 text-xs text-keep-text/90">
            <span>{kickReason}</span>
            <button
              type="button"
              onClick={() => setKickReason(null)}
              aria-label={t("dismiss")}
              className="shrink-0 text-keep-muted hover:text-keep-text"
            >
              ✕
            </button>
          </div>
        ) : null}

        {/* Forum-bound visitor: say plainly what this account is for and
            that they'll land back on the forum afterward. */}
        {returnForum ? (
          <div className="rounded border border-keep-accent/40 bg-keep-accent/10 px-3 py-2 text-xs text-keep-text/90">
            {mode === "register" ? (
              <Trans
                t={t}
                i18nKey="auth.returnForumRegister"
                values={{
                  siteName: branding.siteName || "The Spire",
                  forum: returnForum.name ?? `/f/${returnForum.slug}`,
                }}
              >
                {"You're creating an account on "}
                <b>{"{{siteName}}"}</b>
                {" to access the forum "}
                <b>{"{{forum}}"}</b>
                {". Once you've registered, we'll take you straight back to it."}
              </Trans>
            ) : (
              <Trans
                t={t}
                i18nKey="auth.returnForumLogin"
                values={{ forum: returnForum.name ?? `/f/${returnForum.slug}` }}
              >
                {"After you sign in, we'll return you to the forum "}
                <b>{"{{forum}}"}</b>
                {"."}
              </Trans>
            )}
          </div>
        ) : null}

        {/* Invite-bound visitor: name the community the account is for and
            promise the landing. Same banner idiom as the forum return hint. */}
        {pendingInviteDest ? (
          <div className="rounded border border-keep-accent/40 bg-keep-accent/10 px-3 py-2 text-xs text-keep-text/90">
            {mode === "register" ? (
              <Trans
                t={t}
                i18nKey="auth.inviteRegister"
                values={{
                  siteName: branding.siteName || "The Spire",
                  community: pendingInviteDest.name ?? t("auth.inviteCommunityFallback"),
                }}
              >
                {"You're creating an account on "}
                <b>{"{{siteName}}"}</b>
                {" to join "}
                <b>{"{{community}}"}</b>
                {". Once you've registered, we'll take you straight there."}
              </Trans>
            ) : (
              <Trans
                t={t}
                i18nKey="auth.inviteLogin"
                values={{ community: pendingInviteDest.name ?? t("auth.inviteCommunityFallback") }}
              >
                {"After you sign in, we'll take you to "}
                <b>{"{{community}}"}</b>
                {"."}
              </Trans>
            )}
          </div>
        ) : null}

        {mode === "register" ? (
          <>
            <Field
              label={t("auth.email")}
              value={email}
              onChange={setEmail}
              type="email"
              autoComplete="email"
              // Drop focus straight into the first field so mobile keyboards
              // open immediately on the register screen.
              autoFocus
            />
            <Field label={t("auth.masterUsername")} value={username} onChange={setUsername} autoComplete="username" />
            {/* Friendly username pre-validation. Same space-steering the
                character creator has: spaces break name-taking commands, so
                offer the one-click underscore fix instead of a server
                round-trip that would also have burned the captcha. Plain
                language only — the server's rule copy is the backstop. */}
            {usernameHasSpace ? (
              <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-[11px] text-keep-accent">
                {t("auth.usernameSpaceWarning")}
                <button
                  type="button"
                  onClick={() => setUsername((n) => n.trim().replace(/[ \t]+/g, "_"))}
                  className="ml-1 rounded border border-keep-accent/50 px-1.5 py-0.5 font-semibold uppercase tracking-wide hover:bg-keep-accent/20"
                >
                  {t("auth.usernameUseUnderscores")}
                </button>
              </div>
            ) : usernameTrimmed.length >= 2 && !usernameLocalValid ? (
              <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-[11px] text-keep-accent">
                {t("auth.usernameInvalid")}
              </div>
            ) : null}
          </>
        ) : (
          <Field
            label={t("auth.emailOrUsername")}
            value={email}
            onChange={setEmail}
            autoComplete="username"
          />
        )}
        <Field
          label={t("auth.password")}
          value={password}
          onChange={setPassword}
          type={showPassword ? "text" : "password"}
          autoComplete={mode === "register" ? "new-password" : "current-password"}
          trailing={
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? t("auth.hidePassword") : t("auth.showPassword")}
              title={showPassword ? t("auth.hidePassword") : t("auth.showPassword")}
              aria-pressed={showPassword}
              className="absolute inset-y-0 right-0 flex items-center px-2 text-keep-muted hover:text-keep-text"
            >
              {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
            </button>
          }
        />
        {mode === "login" ? (
          <div className="text-right">
            <button
              type="button"
              className="text-[11px] text-keep-muted underline underline-offset-2 hover:text-keep-action"
              onClick={() => onNavigate?.("/forgot-password")}
            >
              {t("auth.forgotPassword")}
            </button>
          </div>
        ) : null}
        {mode === "register" ? (
          <div className="space-y-2 rounded border border-keep-border/50 bg-keep-bg/25 px-3 py-2 text-keep-muted">
            {/* Admin-set disclaimer, shown above the agreement checkbox when
                present. When there's none, the checkbox alone carries the
                (always-required) house-rules agreement. */}
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
                  {/* stopPropagation so opening the rules to REVIEW them doesn't
                      also toggle the checkbox via the wrapping label. */}
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
        ) : null}

        {mode === "register" ? (
          <>
            {/* Date of birth (replaces the old 18+ checkbox). The server
                stores it and enforces the minimum; the `max` on the input
                plus the submit pre-check are courtesy only. */}
            <Field
              label={t("auth.dateOfBirth")}
              value={birthdate}
              onChange={setBirthdate}
              type="date"
              autoComplete="bday"
              min={earliestAllowedBirthdate()}
              max={latestAllowedBirthdate(branding.minimumSignupAge ?? 18)}
              helper={t("auth.dobHelper", {
                minAge: branding.minimumSignupAge ?? 18,
                siteName: branding.siteName || "The Spire",
              })}
            />

            {/* Minor isolation opt-in (age plan Phase 5): revealed only when
                the entered birth date is under 18 AND the signup floor
                actually admits minors — while the floor is 18 an under-18
                date can't create an account, so the checkbox would tease a
                state that can't exist right under the "must be at least 18"
                helper. Optional; the profile editor's Privacy tab can change
                it later, and the server clamps it to minor accounts anyway. */}
            {(() => {
              if ((branding.minimumSignupAge ?? 18) >= 18) return null;
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

            {/* In-house basic CAPTCHA. The question is server-issued and
                single-use; if the answer is wrong or stale, we re-fetch
                automatically on the next render. */}
            <div className="space-y-1 rounded border border-keep-border/50 bg-keep-bg/25 px-3 py-2 text-[11px] text-keep-muted">
              <div className="text-[10px] uppercase tracking-[0.25em] text-keep-muted">
                {t("auth.captchaHeading")}
              </div>
              <div className="flex items-center gap-2">
                <span className="font-semibold tabular-nums text-keep-text">
                  {captcha?.question ?? t("auth.captchaLoading")}
                </span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={captchaAnswer}
                  onChange={(e) => setCaptchaAnswer(e.target.value)}
                  placeholder={t("auth.captchaPlaceholder")}
                  className="w-24 rounded border border-keep-border bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
                  disabled={!captcha}
                />
                <button
                  type="button"
                  onClick={refreshCaptcha}
                  className="text-[10px] text-keep-muted underline-offset-2 hover:text-keep-action hover:underline"
                  title={t("auth.captchaNewTitle")}
                >
                  {t("auth.captchaNew")}
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
              ? t("auth.tickBoxTitle")
              : undefined
          }
          className="w-full rounded border border-keep-border bg-keep-panel py-2 text-sm font-semibold tracking-wide hover:bg-keep-panel/80 disabled:opacity-50"
        >
          {submitting
            ? mode === "login" ? t("auth.loggingIn") : t("auth.registering")
            : mode === "login" ? t("auth.logIn") : t("auth.register")}
        </button>

        {/* Google sign-in, on BOTH the login and register views when the
            admin has it enabled. Always mode=login for the browser round-trip:
            the server's callback routes an unknown Google account to the
            finish-signup screen and a known one straight into a session, so a
            single entry covers "already have an account" and "new here" alike.
            A full-page redirect (see GoogleAuthButton), not a fetch. */}
        {branding.googleAuthEnabled ? <GoogleAuthButton mode="login" /> : null}

      </form>
    </SplashShell>
  );
}

export function Field({
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  autoFocus,
  /**
   * Optional element rendered inside the input box, absolutely positioned
   * against the field wrapper (used for the password show/hide eye toggle).
   * When present the input gets extra right padding so typed text doesn't
   * slide under it.
   */
  trailing,
  /** Native `min`/`max` attributes (used by the date-of-birth field). */
  min,
  max,
  /** Small muted helper line rendered under the input. */
  helper,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  trailing?: ReactNode;
  min?: string;
  max?: string;
  helper?: string;
}) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block uppercase tracking-widest text-keep-muted">{label}</span>
      <div className="relative">
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          min={min}
          max={max}
          // text-base on mobile prevents iOS auto-zoom (anything <16px triggers
          // a zoom on focus); md+ keeps the compact density.
          className={`w-full rounded border border-keep-border bg-keep-bg px-2 py-2 text-base outline-none focus:border-keep-action md:py-1 md:text-sm ${
            trailing ? "pr-9" : ""
          }`}
        />
        {trailing}
      </div>
      {helper ? <span className="mt-1 block text-[10px] text-keep-muted">{helper}</span> : null}
    </label>
  );
}

/**
 * Full years of age for an ISO YYYY-MM-DD date, date-only in UTC — mirrors
 * the server's ageGate math so the register forms' courtesy pre-check and
 * the authoritative server check can never disagree. Null = not a usable
 * date (the server would reject it too).
 */
export function isoAgeUtc(iso: string, now: Date = new Date()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) age -= 1;
  return age;
}

/**
 * The latest birthdate that still satisfies the signup floor (someone born
 * exactly `minAge` years ago today is old enough), for the date input's
 * `max`. Courtesy only — the server re-validates. A Feb-29 anniversary in
 * a common year rolls to Mar 1 via Date.UTC, which is fine for a hint.
 */
export function latestAllowedBirthdate(minAge: number, now: Date = new Date()): string {
  const t = new Date(Date.UTC(now.getUTCFullYear() - minAge, now.getUTCMonth(), now.getUTCDate()));
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${t.getUTCFullYear()}-${mm}-${dd}`;
}

/**
 * The earliest plausible birthdate (130 years back — the server's
 * MAX_PLAUSIBLE_AGE ceiling), for the date input's `min`. Courtesy only,
 * the server re-validates; it exists to catch century typos (1911 for
 * 2011) before they silently produce an adult-classified account.
 */
export function earliestAllowedBirthdate(now: Date = new Date()): string {
  const t = new Date(Date.UTC(now.getUTCFullYear() - 130, now.getUTCMonth(), now.getUTCDate()));
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${t.getUTCFullYear()}-${mm}-${dd}`;
}
