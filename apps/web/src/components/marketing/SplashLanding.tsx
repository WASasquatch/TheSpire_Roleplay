import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { VERSION } from "@thekeep/shared";
import { isDarkPalette } from "@thekeep/shared";
import {
  Check,
  DoorOpen,
  Feather,
  Globe,
  Landmark,
  LogIn,
  MessagesSquare,
  Radio,
  Server,
  ShieldCheck,
  UserPlus,
  Users,
  VenetianMask,
  type LucideIcon,
} from "lucide-react";
import { useChat } from "../../state/store.js";
import { resolveSplashTheme, splashBgClass, themeStyle } from "../../lib/theme.js";
import { SPLASH_GLOW, SPLASH_PANEL, SPLASH_PANEL_HOVER } from "../../lib/splashPanel.js";
import { SplashNav, type SplashTab } from "./SplashNav.js";
import { BookshelfStrip } from "../scriptorium/BookshelfStrip.js";
import { FeatureShowcase } from "./FeatureShowcase.js";
import { FeaturedWorldCards } from "./FeaturedWorldCards.js";
import { PopularCommunities } from "./PopularCommunities.js";
import { RoleplayCommunities } from "./RoleplayCommunities.js";
import { SplashFaq } from "./SplashFaq.js";

const PROJECT_URL = "https://github.com/WASasquatch/TheSpire_Roleplay";

/**
 * Marketing splash for `/`, the community portal page. Wide
 * (~80vw) two-column layout that runs the FULL height of the card:
 * the main column (primary CTA + live-signal tiles + feature showcase
 * + forums-hosting pitch + closing CTA) owns the left ~70-75%, while a
 * right-hand meta column carries the featured-worlds card carousel
 * and the Scriptorium bookshelf. Keeping the CTA + signals inside the
 * main column (rather than as a full-width band above the split) means
 * the page reads as one consistent two-column template instead of a
 * full-width header clashing with a two-column body. Below ~1400px the
 * meta column reflows under the main column (side-by-side on tablets,
 * stacked on phones).
 *
 * Distinct from AuthGate (which lives at /login and /register) so a
 * visitor who's bookmarked the login page doesn't get harassed by a
 * marketing CTA every time they sign in.
 *
 * Admin gating honored throughout:
 *   - splashMessages24hEnabled / activityFeedsEnabled gate the stat tiles
 *   - featuredWorldsEnabled gates the worlds carousel
 *   - registrationOpen gates every register-bound CTA
 *   - welcomeHtml renders only when set
 */
interface SiteStats {
  online: number;
  totalRegistered?: number;
  rooms: { public: number; private: number; total: number };
  /** Rolling 24-hour chat message count. Optional for forward-compat with older servers. */
  messages24h?: number;
}

interface Props {
  /** Client-side navigation helper. Calls history.pushState + emits popstate so the parent re-routes without a full page reload. */
  onNavigate: (path: string) => void;
}

/** The multi-colour Google "G" mark for the inline "Sign in with Google" splash
 *  button. Kept local (a copy of AuthGate's glyph) so the lean anonymous splash
 *  bundle never has to pull in AuthGate for one icon. */
function GoogleGlyph() {
  return (
    <svg viewBox="0 0 48 48" className="h-5 w-5 shrink-0" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export function SplashLanding({ onNavigate }: Props) {
  const branding = useChat((s) => s.branding);
  const [stats, setStats] = useState<SiteStats | null>(null);

  // Match SplashShell's stats polling so the landing can show live
  // numbers when admin has enabled either activity surface. Skipped
  // entirely when BOTH toggles are off (cold-start posture).
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
        .then((j) => { if (!cancelled && j) setStats(j); })
        .catch(() => {});
    }
    load();
    const id = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [statsEnabled]);

  const logoStyle: React.CSSProperties = {};
  if (branding.logoColor) logoStyle.color = branding.logoColor;
  if (branding.logoFont) logoStyle.fontFamily = branding.logoFont;

  const siteName = branding.siteName?.trim() || "The Spire";

  // Anchor-style internal nav. pushState + manual popstate keeps the
  // bundle warm and preserves theme/state across the transition while
  // still honoring cmd/ctrl/middle-click "open in new tab".
  function go(e: React.MouseEvent, path: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onNavigate(path);
  }

  // Admin-gated stat tiles. Built as a list so the band renders only
  // the tiles whose gates are open and centers whatever remains.
  const tiles: Array<{ key: string; icon: LucideIcon; value: string; label: string }> = [];
  if (branding.splashMessages24hEnabled && stats && typeof stats.messages24h === "number") {
    tiles.push({
      key: "messages",
      icon: MessagesSquare,
      value: stats.messages24h.toLocaleString(),
      label: stats.messages24h === 1 ? "message in the last 24h" : "messages in the last 24h",
    });
  }
  if (branding.activityFeedsEnabled && stats) {
    if (typeof stats.totalRegistered === "number") {
      tiles.push({
        key: "writers",
        icon: Users,
        value: stats.totalRegistered.toLocaleString(),
        label: stats.totalRegistered === 1 ? "writer has stepped in" : "writers have stepped in",
      });
    }
    tiles.push({
      key: "online",
      icon: Radio,
      value: stats.online.toLocaleString(),
      label: "online right now",
    });
    tiles.push({
      key: "rooms",
      icon: DoorOpen,
      value: stats.rooms.public.toLocaleString(),
      label: stats.rooms.public === 1 ? "public room open" : "public rooms open",
    });
  }

  // Hero live-count proof (B4): a single honest "N roleplayers online now"
  // line beside the primary CTA. Same cold-start posture as the stat tiles —
  // only when activity feeds are on AND the number is truly > 0, never a
  // dead "0 online" to a first visitor.
  const liveOnline =
    branding.activityFeedsEnabled && stats && stats.online > 0 ? stats.online : null;

  // Evergreen credibility strip (B4): ALWAYS-shown, non-numeric trust points
  // so a cold-start install still reads as credible without any live activity.
  const credibilityPoints: Array<{ key: string; icon: LucideIcon; label: string }> = [
    { key: "free", icon: Feather, label: "Free and open source" },
    { key: "rules", icon: ShieldCheck, label: "Your community, your rules" },
    { key: "longform", icon: MessagesSquare, label: "Built for long-lived roleplay groups" },
    { key: "browser", icon: Globe, label: "Play right in your browser" },
  ];

  // "Features at a glance" band: the evergreen trust points plus any live-stat
  // tiles, rendered as ONE even grid (not a ragged centered wrap). On phones it
  // collapses to a single row with a toggle to reveal the rest; sm+ always shows
  // the full grid.
  const [featuresExpanded, setFeaturesExpanded] = useState(false);
  const FEATURES_MOBILE_ROW = 2; // one row of the 2-col mobile grid
  const featureChips: Array<{ key: string; icon: LucideIcon; accent: boolean; node: ReactNode }> = [
    ...credibilityPoints.map((p) => ({ key: p.key, icon: p.icon, accent: false, node: p.label as ReactNode })),
    ...tiles.map((t) => ({
      key: t.key,
      icon: t.icon,
      accent: true,
      node: (
        <>
          <span className="font-semibold tabular-nums text-keep-action">{t.value}</span> {t.label}
        </>
      ) as ReactNode,
    })),
  ];

  const splashTheme = resolveSplashTheme(branding);
  const splashIsDark = isDarkPalette(splashTheme);

  // Sticky anchor/route tab bar (SplashNav). Anchors scroll to on-page sections
  // (and flash them); routes hand off to other pages. "Communities" only appears
  // when servers are on (the Popular section it targets is server-gated).
  const splashTabs: SplashTab[] = [
    { label: "Join", kind: "anchor", id: "join" },
    { label: "Host", kind: "anchor", id: "host" },
    ...(branding.serversEnabled
      ? [{ label: "Communities", kind: "anchor", id: "popular" } as SplashTab]
      : []),
    { label: "Features", kind: "anchor", id: "features" },
    { label: "FAQ", kind: "anchor", id: "faq" },
    { label: "Rules", kind: "route", href: "/rules" },
    { label: "Forums", kind: "route", href: "/f/spire" },
    { label: "Top Communities", kind: "route", href: "/top-communities" },
  ];
  return (
    <div
      style={themeStyle(splashTheme)}
      // `overflow-clip` (not `hidden`): clips the same, but does NOT create a
      // scroll container, so the sticky SplashNav can pin to the viewport top
      // instead of scrolling away with this wrapper.
      className="relative min-h-screen w-full overflow-clip text-keep-text"
    >
      {/* Background art, portaled to <body> so it is a TRUE viewport-fixed
          layer: `position: fixed` only resolves against the viewport when no
          ancestor establishes a containing block (a `transform`/`filter`/
          `will-change` anywhere up the tree — e.g. the struck-shake or a
          design's backdrop-filter — silently re-anchors it to that ancestor,
          which is what made the art scroll away). Rendering it on <body>
          guarantees it ignores page height and always fills the window;
          themeStyle is re-applied here because the portal lives outside this
          subtree's CSS-var scope.

          z-index MUST be 0 (not -1): a `position:fixed` element escapes to the
          ROOT stacking context, where a NEGATIVE z is painted BEFORE the <body>
          box — so body's own opaque `background-color: --keep-bg` (styles.css
          `html, body {…}`) paints over it and the art stays blank. z-index:0
          paints it ABOVE the body background; the foreground below is lifted to
          `z-10` so the hero + card still sit on top. */}
      {createPortal(
        <div aria-hidden className="splash-bg-fixed" style={{ ...themeStyle(splashTheme), zIndex: 0 }}>
          <div className={`absolute inset-0 bg-cover bg-[position:-175px_center] md:bg-center ${splashBgClass(splashTheme)}`} />
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-keep-bg/30 md:to-keep-bg/70" />
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

      <div className="relative z-10 flex min-h-screen flex-col items-center justify-start py-8 lg:py-10">
        {/* HERO, over the spire BG, ABOVE the card. The wordmark
            reads as the page banner this way instead of feeling
            tucked into the card content. */}
        <header className="splash-hero-outside mx-4 mb-6 w-[min(2400px,94vw)] text-center lg:mb-8 xl:w-[min(2400px,84vw)]">
          <div className="splash-rule mx-auto mb-4 flex w-[min(360px,80%)] items-center gap-3 opacity-85" aria-hidden>
            <span className="line h-px flex-1" style={{ background: "linear-gradient(90deg, transparent, rgb(var(--keep-accent) / 0.6), transparent)" }} />
            <span className="diamond block h-[7px] w-[7px] rotate-45" style={{ background: "rgb(var(--keep-accent))", boxShadow: "0 0 10px rgb(var(--keep-accent) / 0.6)" }} />
            <span className="line h-px flex-1" style={{ background: "linear-gradient(90deg, transparent, rgb(var(--keep-accent) / 0.6), transparent)" }} />
          </div>
          {/* The hero sits over the spire BG image. Subtitle/tagline
              text is white on both palettes with a strong dark shadow
              so it reads against the cloudy parchment AND the dark
              sky variant; the logo image gets a luminous teal glow on
              light themes via `light-dark(...)`. */}
          <h1
            style={{
              ...logoStyle,
              textShadow:
                "0 2px 8px light-dark(rgba(134, 192, 185, 0.85), rgba(0, 0, 0, 0.65))",
            }}
            className="font-action text-4xl tracking-wide text-keep-text sm:text-5xl"
          >
            {branding.logoUrl ? (
              <img
                src={branding.logoUrl}
                alt={siteName}
                className="mx-auto max-h-24 w-auto select-none sm:max-h-28"
                draggable={false}
                style={{
                  filter:
                    "drop-shadow(0 0 18px light-dark(rgba(134, 192, 185, 0.85), rgba(0, 0, 0, 0.5))) drop-shadow(0 4px 10px light-dark(rgba(134, 192, 185, 0.4), rgba(0, 0, 0, 0.55)))",
                }}
              />
            ) : (
              siteName
            )}
          </h1>
          <p
            className="mt-3 text-base sm:text-lg"
            style={{
              color: "rgba(255, 255, 255, 0.95)",
              textShadow:
                "0 2px 8px rgba(0, 0, 0, 0.85), 0 0 4px rgba(0, 0, 0, 0.6)",
            }}
          >
            Where stories and communities live.
          </p>
        </header>

        <div
          className="
            mx-4
            w-[min(2400px,94vw)]
            xl:w-[min(2400px,84vw)]
            rounded-md border
            bg-keep-bg/55 backdrop-blur-xl border-keep-border/60
            ring-1 ring-keep-bg/40 ring-inset
            lg:bg-keep-bg/60 lg:backdrop-blur-md lg:border-keep-border/80 lg:ring-1 lg:ring-keep-bg/30 lg:ring-inset
            shadow-[0_24px_70px_-18px_rgba(0,0,0,0.55)]
          "
        >
          <div
            aria-hidden
            className="h-0.5 w-full rounded-t-md"
            style={{ background: "linear-gradient(90deg, transparent, #3fa5a0 30%, #3fa5a0 70%, transparent)" }}
          />

          <SplashNav tabs={splashTabs} onNavigate={onNavigate} />

          <div className="px-5 py-6 sm:px-8 sm:py-8 lg:px-10 lg:py-10">
            {/* TWO-COLUMN BODY. Everything from the primary CTA down lives
                inside this grid so the meta rail (worlds + bookshelf) runs
                alongside the WHOLE page. Previously the CTA + live-signal
                band spanned the full card width and only the content below
                split into two columns, which read as two clashing layouts
                stacked on top of each other. Now the card is one consistent
                [main | 540px meta] split for its full height; below 1400px
                the meta rail reflows under the main column as before. */}
            <div className="grid gap-8 min-[1400px]:grid-cols-[minmax(0,1fr)_540px] min-[1400px]:gap-10">
              <div className="min-w-0 space-y-8">
                {/* AUDIENCE SPLIT, the two paths this platform serves: join the
                    native roleplay community, or host your own. Co-equal cards
                    so an organizer sees themselves in the first screen, not just
                    a player. Login sits quietly beneath both. */}
                <div className="grid gap-4 sm:grid-cols-2">
                  {/* PLAY — teal-themed twin of the gold HOST card. The two
                      brand colors distinguish the paths; neither reads as drab. */}
                  <div
                    id="join"
                    className={`flex scroll-mt-24 flex-col rounded-md border border-keep-action/50 p-5 ${SPLASH_GLOW}`}
                    style={{
                      background:
                        "linear-gradient(120deg, rgb(var(--keep-action) / 0.12), rgb(var(--keep-panel) / 0.25) 55%, rgb(var(--keep-accent) / 0.1))",
                    }}
                  >
                    <div className="mb-2 flex items-center gap-2.5">
                      <div
                        aria-hidden
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-keep-action/40 bg-keep-bg/40"
                      >
                        <VenetianMask className="h-5 w-5 text-keep-action" aria-hidden />
                      </div>
                      <h2 className="font-action text-xl text-keep-text">Join the story</h2>
                    </div>
                    <p className="flex-1 text-sm leading-relaxed text-keep-text/85 lg:text-base">
                      Step into live roleplay rooms, build a cast of characters, explore
                      shared worlds, and write alongside a whole community.
                    </p>
                    <div className="mt-4 flex flex-col gap-2">
                      {branding.registrationOpen ? (
                        <>
                          {/* PRIMARY CTA (Q2): the single filled, highest-contrast
                              button on the page. First-person + reality-aligned
                              (Q3a): /register creates an account, so the label
                              says so instead of promising a character step. */}
                          <a
                            href="/register"
                            onClick={(e) => go(e, "/register")}
                            className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-keep-action bg-keep-action px-6 py-3 text-sm font-semibold uppercase tracking-widest text-keep-bg shadow-[0_4px_14px_-4px_rgba(0,0,0,0.45)] transition hover:brightness-110 active:brightness-95"
                          >
                            <UserPlus className="h-5 w-5" aria-hidden />
                            Create my free account
                          </a>
                          {/* Reassurance microcopy (Q5): honest, no fake
                              urgency, directly under the primary CTA. */}
                          <p className="text-center text-xs leading-relaxed text-keep-text/70">
                            Free forever. No download, no card. Jump into a room
                            in under a minute.
                          </p>
                          {/* Live proof (B4): honest "N online now" beside the
                              primary CTA. Cold-start posture — only shown when
                              activity feeds are on AND online > 0, never a dead
                              "0 online" to a first visitor. */}
                          {liveOnline !== null ? (
                            <p className="flex items-center justify-center gap-1.5 text-center text-xs font-medium text-keep-action">
                              <Radio className="h-3.5 w-3.5" aria-hidden />
                              <span>
                                <span className="tabular-nums font-semibold">
                                  {liveOnline.toLocaleString()}
                                </span>{" "}
                                {liveOnline === 1 ? "roleplayer" : "roleplayers"} online now
                              </span>
                            </p>
                          ) : null}
                          {/* Log in: a full-width SECONDARY (outline) button so
                              returning users get a strong, obvious path, while the
                              filled "Create my free account" above stays the single
                              dominant CTA. (A persistent Log in / Sign up also lives
                              in SplashNav.) */}
                          {branding.googleAuthEnabled ? (
                            <div className="flex w-full items-stretch gap-2">
                              <button
                                type="button"
                                onClick={() => { window.location.href = "/auth/google/start?mode=login"; }}
                                aria-label="Sign in with Google"
                                className="inline-flex flex-1 items-center justify-center gap-2 rounded-md border border-keep-rule/70 bg-keep-bg/40 px-4 py-3 text-sm font-semibold uppercase tracking-widest text-keep-text transition hover:border-keep-action hover:text-keep-action"
                              >
                                <GoogleGlyph />
                                Google
                              </button>
                              <a
                                href="/login"
                                onClick={(e) => go(e, "/login")}
                                className="inline-flex flex-1 items-center justify-center gap-2 rounded-md border border-keep-rule/70 bg-keep-bg/40 px-4 py-3 text-sm font-semibold uppercase tracking-widest text-keep-text transition hover:border-keep-action hover:text-keep-action"
                              >
                                <LogIn className="h-5 w-5" aria-hidden />
                                Log in
                              </a>
                            </div>
                          ) : (
                            <a
                              href="/login"
                              onClick={(e) => go(e, "/login")}
                              className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-keep-rule/70 bg-keep-bg/40 px-6 py-3 text-sm font-semibold uppercase tracking-widest text-keep-text transition hover:border-keep-action hover:text-keep-action"
                            >
                              <LogIn className="h-5 w-5" aria-hidden />
                              Log in
                            </a>
                          )}
                        </>
                      ) : (
                        <div className="rounded border border-keep-rule/50 bg-keep-bg/40 px-4 py-2 text-center text-xs text-keep-muted">
                          Registration is currently closed.
                        </div>
                      )}
                    </div>
                  </div>
                  {/* HOST */}
                  <div
                    id="host"
                    className={`flex scroll-mt-24 flex-col rounded-md border border-keep-accent/50 p-5 ${SPLASH_GLOW}`}
                    style={{
                      background:
                        "linear-gradient(120deg, rgb(var(--keep-accent) / 0.12), rgb(var(--keep-panel) / 0.25) 55%, rgb(var(--keep-action) / 0.1))",
                    }}
                  >
                    <div className="mb-2 flex items-center gap-2.5">
                      <div
                        aria-hidden
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-keep-accent/40 bg-keep-bg/40"
                      >
                        <Server className="h-5 w-5 text-keep-accent" aria-hidden />
                      </div>
                      <h2 className="font-action text-xl text-keep-text">Host your own community</h2>
                    </div>
                    <p className="flex-1 text-sm leading-relaxed text-keep-text/85 lg:text-base">
                      Run your own chat community and forums, with your own rooms, members,
                      roles, and moderation. Free to start, right in your browser.
                    </p>
                    <div className="mt-4 flex flex-col gap-2">
                      {branding.registrationOpen ? (
                        <a
                          href="/register"
                          onClick={(e) => go(e, "/register")}
                          className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-keep-accent/60 bg-keep-bg/40 px-6 py-3 text-sm font-semibold uppercase tracking-widest text-keep-text transition hover:border-keep-accent hover:text-keep-action"
                        >
                          <Server className="h-5 w-5" aria-hidden />
                          Start a community
                        </a>
                      ) : null}
                      <a
                        href="/f/spire"
                        onClick={(e) => go(e, "/f/spire")}
                        className="text-center text-sm text-keep-text/75 underline-offset-4 hover:text-keep-action hover:underline"
                      >
                        See a live forum →
                      </a>
                    </div>
                  </div>
                </div>
                {/* FEATURE TOUR + pitches ("Everything Your Story Needs" — the
                    CTA marquee), the rest of the main column. */}
                <div id="features" className="scroll-mt-24 rounded-md">
                  <FeatureShowcase
                    onNavigate={onNavigate}
                    registrationOpen={branding.registrationOpen}
                  />
                </div>

                {/* POPULAR CHAT SERVERS, social proof + a browse hook: the site's
                    own most-popular public chat servers. Sits BELOW the feature
                    marquee. Self-hides when none are public yet; only mounted when
                    servers are on. */}
                {branding.serversEnabled ? (
                  <div id="popular" className="scroll-mt-24 rounded-md">
                    <PopularCommunities onNavigate={onNavigate} />
                  </div>
                ) : null}

                {/* HOST DETAIL, what you actually get when you host here: a
                    live chat community and threaded forums, side by side, plus
                    a live forum to look at before committing. Reinforces the
                    hero's Host card with specifics. */}
                <section
                  aria-label="Host your own community"
                  className={`rounded-md border border-keep-accent/40 p-5 sm:p-6 ${SPLASH_GLOW}`}
                  style={{
                    background:
                      "linear-gradient(120deg, rgb(var(--keep-accent) / 0.12), rgb(var(--keep-panel) / 0.25) 55%, rgb(var(--keep-action) / 0.1))",
                  }}
                >
                  <h2 className="font-action text-xl text-keep-text sm:text-2xl">
                    Bring your community to {siteName}
                  </h2>
                  <p className="mt-1.5 text-base leading-relaxed text-keep-text/85 lg:text-lg">
                    Give your game, guild, or fandom a real home, free, with the tools
                    to run it your way.
                  </p>
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <div className="rounded-md border border-keep-border/50 bg-keep-bg/40 p-4">
                      <div className="flex items-center gap-2">
                        <Server className="h-5 w-5 shrink-0 text-keep-accent" aria-hidden />
                        <h3 className="font-action text-lg text-keep-text">Your own chat community</h3>
                      </div>
                      <ul className="mt-2 space-y-1 text-sm text-keep-text/85">
                        <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-keep-accent" aria-hidden /><span>Live rooms for real-time roleplay</span></li>
                        <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-keep-accent" aria-hidden /><span>Members, roles, and invites</span></li>
                        <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-keep-accent" aria-hidden /><span>Its own economy and cosmetics</span></li>
                        <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-keep-accent" aria-hidden /><span>Moderation tools you control</span></li>
                      </ul>
                    </div>
                    <div className="rounded-md border border-keep-border/50 bg-keep-bg/40 p-4">
                      <div className="flex items-center gap-2">
                        <Landmark className="h-5 w-5 shrink-0 text-keep-accent" aria-hidden />
                        <h3 className="font-action text-lg text-keep-text">Your own forums</h3>
                      </div>
                      <ul className="mt-2 space-y-1 text-sm text-keep-text/85">
                        <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-keep-accent" aria-hidden /><span>Boards for play-by-post and discussion</span></li>
                        <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-keep-accent" aria-hidden /><span>A moderator team and membership rules</span></li>
                        <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-keep-accent" aria-hidden /><span>A public page you can share anywhere</span></li>
                        <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-keep-accent" aria-hidden /><span>Threaded topics that last for weeks</span></li>
                      </ul>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-col gap-2.5 sm:flex-row sm:items-center">
                    <a
                      href="/f/spire"
                      onClick={(e) => go(e, "/f/spire")}
                      className="inline-flex items-center justify-center gap-2 rounded-md border border-keep-accent/60 bg-keep-bg/40 px-5 py-2.5 text-sm font-semibold uppercase tracking-widest text-keep-text transition hover:border-keep-accent hover:text-keep-action"
                    >
                      <MessagesSquare className="h-4 w-4" aria-hidden />
                      Visit {siteName} Forums
                    </a>
                    {branding.registrationOpen ? (
                      <a
                        href="/register"
                        onClick={(e) => go(e, "/register")}
                        className="text-center text-sm text-keep-text/75 underline-offset-4 hover:text-keep-action hover:underline sm:text-left"
                      >
                        Start your own community →
                      </a>
                    ) : null}
                  </div>
                </section>

                {/* FAQ, static + crawlable. Answers common visitor questions
                    (free? host my own? is it safe?) and adds indexable Q&A
                    text; mirrors the starter set seeded into /faqs. */}
                <div id="faq" className="scroll-mt-24 rounded-md">
                  <SplashFaq onNavigate={onNavigate} />
                </div>

                {/* CLOSING CTA. The visitor has just read the feature
                    tour; close the loop with one big register push
                    (or a login push when registration is closed) plus
                    a no-commitment path into the Scriptorium. Also
                    balances the main column's height against the
                    taller meta rail. */}
                <section
                  aria-label="Join"
                  className={`rounded-md border border-keep-border/50 bg-keep-panel/30 p-6 text-center sm:p-10 ${SPLASH_PANEL_HOVER}`}
                >
                  <h3 className="font-action text-2xl text-keep-text sm:text-3xl">
                    Your first scene is waiting
                  </h3>
                  <p className="mx-auto mt-3 max-w-2xl text-base leading-relaxed text-keep-text/85 sm:text-lg">
                    Registration takes a minute. Build a character, step into a
                    public room, and start writing tonight.
                  </p>
                  <div className="mt-5">
                    {branding.registrationOpen ? (
                      <a
                        href="/register"
                        onClick={(e) => go(e, "/register")}
                        className="inline-flex items-center justify-center gap-2 rounded-md border border-keep-action bg-keep-action px-8 py-3 text-sm font-semibold uppercase tracking-widest text-keep-bg shadow-[0_4px_14px_-4px_rgba(0,0,0,0.45)] transition hover:brightness-110 active:brightness-95 sm:text-base"
                      >
                        <UserPlus className="h-5 w-5" aria-hidden />
                        Create my free account
                      </a>
                    ) : (
                      branding.googleAuthEnabled ? (
                        <div className="flex items-stretch justify-center gap-2">
                          <button
                            type="button"
                            onClick={() => { window.location.href = "/auth/google/start?mode=login"; }}
                            aria-label="Sign in with Google"
                            className="inline-flex items-center justify-center gap-2 rounded-md border border-keep-accent/60 bg-keep-bg/40 px-6 py-3 text-sm font-semibold uppercase tracking-widest text-keep-text transition hover:border-keep-accent hover:text-keep-action sm:text-base"
                          >
                            <GoogleGlyph />
                            Google
                          </button>
                          <a
                            href="/login"
                            onClick={(e) => go(e, "/login")}
                            className="inline-flex items-center justify-center gap-2 rounded-md border border-keep-accent/60 bg-keep-bg/40 px-6 py-3 text-sm font-semibold uppercase tracking-widest text-keep-text transition hover:border-keep-accent hover:text-keep-action sm:text-base"
                          >
                            <LogIn className="h-5 w-5" aria-hidden />
                            Log in
                          </a>
                        </div>
                      ) : (
                        <a
                          href="/login"
                          onClick={(e) => go(e, "/login")}
                          className="inline-flex items-center justify-center gap-2 rounded-md border border-keep-accent/60 bg-keep-bg/40 px-8 py-3 text-sm font-semibold uppercase tracking-widest text-keep-text transition hover:border-keep-accent hover:text-keep-action sm:text-base"
                        >
                          <LogIn className="h-5 w-5" aria-hidden />
                          Log in
                        </a>
                      )
                    )}
                  </div>
                  <p className="mt-4 text-sm text-keep-muted lg:text-base">
                    Just browsing?{" "}
                    <a
                      href="/scriptorium"
                      onClick={(e) => go(e, "/scriptorium")}
                      className="text-keep-text/80 underline underline-offset-4 hover:text-keep-action"
                    >
                      Read stories in the Scriptorium
                    </a>
                    , no account needed.
                  </p>
                </section>
              </div>

              {/* META COLUMN, worlds + bookshelf. Fixed 540px at the
                  wide breakpoint; below that it reflows into the page
                  body. The `.bookshelf-fit` wrapper is a CSS size
                  container, the shelf's column-width shrink ladder in
                  styles.css keys off it so the books scale to the
                  column instead of the viewport. */}
              <aside
                // `min-w-0` so the worlds/bookshelf content can't force the
                // column wider than the viewport on a phone — that horizontal
                // overflow scrolled the whole page sideways and made the
                // centered CTA / login read as left-aligned. `space-y-8` stacks
                // Top Communities, then the worlds+bookshelf block, down the rail.
                className="min-w-0 space-y-8"
              >
                {/* TOP COMMUNITIES — the ranked topsite board preview, pinned to
                    the TOP of the meta rail so the leading communities head the
                    column. Sorted by traffic; full board at /top-communities. */}
                <RoleplayCommunities onNavigate={onNavigate} />

                {/* Worlds + Scriptorium keep their own grid: side-by-side on the
                    768–1400px reflow (rail runs full-width under the main
                    column), single column in the ≥1400px 540px rail. Kept in a
                    SEPARATE grid from Roleplay Communities — a col-span on a
                    1-col grid injects an implicit second column and shoves the
                    bookshelf sideways, which is what broke the rail. */}
                <div
                  className={`grid content-start gap-8 min-[1400px]:grid-cols-1 ${
                    branding.featuredWorldsEnabled ? "md:grid-cols-2" : ""
                  }`}
                >
                  {branding.featuredWorldsEnabled ? (
                    <FeaturedWorldCards onNavigate={onNavigate} />
                  ) : null}
                  <div className="bookshelf-fit">
                    <BookshelfStrip onNavigate={onNavigate} />
                  </div>
                </div>
              </aside>
            </div>
          </div>

          {/* Upstream project credit + version link. Distinct from the
              admin-configured `siteName` (which brands this *instance*);
              this footer always reads as the open-source project name so
              anyone landing on a self-hosted install can trace back to
              the source. Version comes from packages/shared/src/version.ts
              and bumps via `pnpm bump:<patch|minor|major>` (see scripts/
              bump.sh) so every release surfaces here. */}
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

        {/* FEATURES AT A GLANCE (B4): the always-shown, non-numeric trust points
            plus any admin-gated LIVE stat tiles (messages/24h, online, rooms,
            writers) appended INLINE as compact chips, each self-gated so the band
            still stands on its own when they're off. Its OWN container, moved
            BELOW the main card (was above the hero). */}
        <div
          className={`mx-4 mt-6 w-[min(2400px,94vw)] p-4 lg:mt-8 xl:w-[min(2400px,84vw)] sm:p-5 ${SPLASH_PANEL} ${SPLASH_PANEL_HOVER}`}
        >
          {/* Even grid, not a ragged centered wrap: 2 cols on phones, 3 on
              tablet, 4 on desktop, so chips line up in tidy columns/rows and
              stretch to equal widths. On phones only the first row shows until
              the toggle below is opened. */}
          <ul
            aria-label="What you get here"
            className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4"
          >
            {featureChips.map((c, i) => {
              const ChipIcon = c.icon;
              // Phone-only collapse: hide everything past the first row until
              // expanded; sm+ always shows all (sm:flex overrides the hide).
              const collapsedOnMobile = !featuresExpanded && i >= FEATURES_MOBILE_ROW;
              return (
                <li
                  key={c.key}
                  className={`${collapsedOnMobile ? "hidden sm:flex" : "flex"} items-center gap-2 rounded-md border ${
                    c.accent ? "border-keep-accent/40" : "border-keep-border/50"
                  } bg-keep-panel/30 px-3 py-2 text-xs text-keep-text/85 sm:px-4 sm:text-sm`}
                >
                  <ChipIcon className="h-4 w-4 shrink-0 text-keep-accent" aria-hidden />
                  <span>{c.node}</span>
                </li>
              );
            })}
          </ul>
          {/* Phone-only expand/collapse toggle. Hidden from sm+ (full grid shows
              there). Only rendered when there's more than the first row to show. */}
          {featureChips.length > FEATURES_MOBILE_ROW ? (
            <button
              type="button"
              onClick={() => setFeaturesExpanded((v) => !v)}
              aria-expanded={featuresExpanded}
              className="mt-2.5 w-full rounded-md border border-keep-rule/60 bg-keep-panel/40 px-3 py-1.5 text-xs font-medium text-keep-muted transition hover:text-keep-text sm:hidden"
            >
              {featuresExpanded ? "Show less" : `Show ${featureChips.length - FEATURES_MOBILE_ROW} more`}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
