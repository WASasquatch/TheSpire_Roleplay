import { useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { VERSION } from "@thekeep/shared";
import { isDarkPalette } from "@thekeep/shared";
import { useChat } from "../state/store.js";
import { resolveSplashTheme, splashBgUrl, themeStyle } from "../lib/theme.js";
import { AffiliatesCarousel } from "./AffiliatesCarousel.js";
import { FeaturedWorldsCarousel } from "./FeaturedWorldsCarousel.js";
import { BookshelfStrip } from "./BookshelfStrip.js";
import { SpireScroll } from "./SpireScroll.js";

const PROJECT_URL = "https://github.com/WASasquatch/TheSpire_Roleplay";

/**
 * Marketing splash for `/`. Replaces the "log in / register" card that
 * used to sit at the entrance with a value-prop-led landing: hero, three
 * feature pillars, primary CTA to /register, secondary link to /login.
 *
 * Distinct from AuthGate (which now lives at /login and /register) so a
 * visitor who's bookmarked the login page doesn't get harassed by a
 * marketing CTA every time they sign in.
 *
 * Visual chrome (spire background image, parchment veil, theme scoping)
 * mirrors SplashShell so the entrance flow reads as one continuous
 * experience as the visitor moves from `/` → `/register` → first chat.
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

export function SplashLanding({ onNavigate }: Props) {
  const branding = useChat((s) => s.branding);
  const [stats, setStats] = useState<SiteStats | null>(null);

  // Match SplashShell's stats polling so the landing can show a live
  // counter when admin has enabled either activity surface. Skipped
  // entirely when BOTH toggles are off (cold-start posture). Either
  // toggle being on is enough to start polling; the render path below
  // decides which clauses actually surface.
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

  // Anchor-style internal nav. Plain <a href="..."> would full-page-
  // reload, which is fine but feels heavy when both ends are SPA-rendered.
  // pushState + manual popstate keeps the bundle warm and preserves
  // theme/state across the transition.
  function go(e: React.MouseEvent, path: string) {
    // Honor cmd/ctrl/middle-click for "open in new tab", the browser's
    // default handles that case; we only intercept the plain left-click.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onNavigate(path);
  }

  const splashTheme = resolveSplashTheme(branding);
  const splashIsDark = isDarkPalette(splashTheme);
  return (
    <div
      style={themeStyle(splashTheme)}
      className="relative min-h-screen w-full overflow-hidden bg-keep-bg text-keep-text"
    >
      {/* Background art, mirrors SplashShell so the visual identity stays
          consistent between the landing and the auth pages. Same dark-
          mode swap (resolved palette → bg image variant + corner glows).
          NB: `fixed inset-0` (not `absolute`) so `bg-cover` sizes against
          the viewport. The parent expands to fit the carousel + bookshelf
          + footer below the fold; absolute-positioned cover stretches the
          2.65:1 panoramic art over that taller box, scaling it up wildly
          and cropping out everything but a thin center band. Fixed pins
          the layer to the visible window so the artwork stays in proper
          aspect and parallax-scrolls under the content. */}
      <div
        aria-hidden
        className="fixed inset-0 bg-cover bg-[position:-175px_center] md:bg-center"
        style={{ backgroundImage: `url(${splashBgUrl(splashTheme)})` }}
      />
      <div
        aria-hidden
        className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-keep-bg/30 md:to-keep-bg/70"
      />
      {splashIsDark ? (
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute -left-32 -top-32 h-[28rem] w-[28rem]"
            style={{ background: "radial-gradient(circle, rgba(63,165,160,0.35) 0%, rgba(63,165,160,0.12) 35%, transparent 70%)" }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-32 -right-32 h-[32rem] w-[32rem]"
            style={{ background: "radial-gradient(circle, rgba(220,230,255,0.22) 0%, rgba(220,230,255,0.08) 40%, transparent 75%)" }}
          />
        </>
      ) : null}

      {/* Page-level flex column: hero lives OUTSIDE the card (over
          the BG image directly), card sits below with the action
          stack + scroll inside. The whole column scrolls with the
          window rather than the card scrolling internally. */}
      <div className="relative flex min-h-screen flex-col items-center justify-start py-8 lg:py-10">
        {/* HERO, over the spire BG, ABOVE the card. The wordmark
            reads as the page banner this way instead of feeling
            tucked into the card content. */}
        <header className="splash-hero-outside mx-4 mb-6 w-[min(1280px,92vw)] text-center lg:mb-8">
          <div className="splash-rule mx-auto mb-4 flex w-[min(360px,80%)] items-center gap-3 opacity-85" aria-hidden>
            <span className="line h-px flex-1" style={{ background: "linear-gradient(90deg, transparent, rgb(var(--keep-accent) / 0.6), transparent)" }} />
            <span className="diamond block h-[7px] w-[7px] rotate-45" style={{ background: "rgb(var(--keep-accent))", boxShadow: "0 0 10px rgb(var(--keep-accent) / 0.6)" }} />
            <span className="line h-px flex-1" style={{ background: "linear-gradient(90deg, transparent, rgb(var(--keep-accent) / 0.6), transparent)" }} />
          </div>
          {/* The hero sits over the spire BG image, which is light
              parchment on light themes and deep blue-black on dark
              themes. Subtitle/tagline text is white on both with a
              strong dark shadow so it reads against the cloudy
              parchment AND the dark sky variant. The logo image gets
              a luminous teal glow on light themes (where its own
              dark engraving blends into the parchment) and a black
              drop-shadow on dark themes (where the glowing star
              already pops). `light-dark(...)` in the filter color
              swaps the two without a JS re-render. */}
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
            Build characters. Tell stories. Find your circle.
          </p>
          <p
            className="mt-2 text-xs uppercase tracking-[0.3em]"
            style={{
              color: "rgba(255, 255, 255, 0.78)",
              textShadow:
                "0 1px 4px rgba(0, 0, 0, 0.85), 0 0 3px rgba(0, 0, 0, 0.6)",
            }}
          >
            a sanctuary for collaborative roleplay
          </p>
        </header>

        <div
          className="
            mx-4
            w-[min(1280px,92vw)]
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

          <div className="px-6 py-6 sm:px-10 sm:py-8 lg:px-14 lg:py-10">
            {/* CONDENSED CTA, button + login link inline so the
                action stack reads as one tight block at the top of
                the card. Stats + welcome live just below it and the
                scroll takes the full width beneath. */}
            <div className="flex flex-col items-center gap-2 sm:flex-row sm:justify-center sm:gap-5">
              {branding.registrationOpen ? (
                <a
                  href="/register"
                  onClick={(e) => go(e, "/register")}
                  className="
                    inline-flex items-center justify-center gap-2
                    rounded-md border border-keep-action
                    bg-keep-action px-5 py-2
                    text-sm font-semibold uppercase tracking-widest
                    text-keep-bg
                    shadow-[0_4px_14px_-4px_rgba(0,0,0,0.45)]
                    transition hover:brightness-110 active:brightness-95
                  "
                >
                  Create your character
                </a>
              ) : (
                <div className="rounded border border-keep-rule/50 bg-keep-bg/40 px-4 py-2 text-center text-xs text-keep-muted">
                  Registration is currently closed.
                </div>
              )}
              <a
                href="/login"
                onClick={(e) => go(e, "/login")}
                className="text-sm text-keep-text/80 underline-offset-4 hover:text-keep-action hover:underline"
              >
                Already have an account? <span className="font-semibold">Log in</span>
              </a>
            </div>

            {/* OPTIONAL LIVE SIGNALS, admin-gated stats. The 24h
                hero number is compact here (smaller than before)
                since the CTA above it owns the visual anchor. */}
            {branding.splashMessages24hEnabled && stats && typeof stats.messages24h === "number" ? (
              <div className="mt-5 text-center">
                <div
                  className={`text-2xl font-bold tabular-nums leading-none sm:text-3xl ${
                    stats.messages24h > 0 ? "text-keep-action" : "text-keep-text"
                  }`}
                >
                  {stats.messages24h.toLocaleString()}
                </div>
                <div className="mt-1 text-[10px] uppercase tracking-[0.2em] text-keep-muted">
                  {stats.messages24h === 1 ? "message" : "messages"} in the last 24h
                </div>
              </div>
            ) : null}
            {branding.activityFeedsEnabled && stats ? (
              <p
                className={`text-center text-xs text-keep-muted ${
                  branding.splashMessages24hEnabled && typeof stats.messages24h === "number"
                    ? "mt-2"
                    : "mt-4"
                }`}
              >
                {typeof stats.totalRegistered === "number" ? (
                  <>
                    <span className="font-semibold tabular-nums text-keep-text">
                      {stats.totalRegistered.toLocaleString()}
                    </span>{" "}
                    {stats.totalRegistered === 1 ? "writer" : "writers"} have stepped in
                    {stats.online > 0 ? (
                      <>
                        {" "}·{" "}
                        <span className="font-semibold tabular-nums text-keep-action">
                          {stats.online}
                        </span>{" "}
                        online right now
                      </>
                    ) : null}
                  </>
                ) : (
                  <>
                    <span className="font-semibold tabular-nums text-keep-text">{stats.online}</span>{" "}
                    {stats.online === 1 ? "writer" : "writers"} online right now
                  </>
                )}
              </p>
            ) : null}

            {/* ADMIN WELCOME, only renders when set. Centered text
                that spans the card so it doesn't sit as a narrow
                column inside the now-1280px-wide card. */}
            {branding.welcomeHtml.trim() ? (
              <div
                className="prose prose-xl mt-5 max-w-none text-center border-t border-keep-rule/50 pt-4 text-keep-text/90 [&_*]:text-center"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(branding.welcomeHtml) }}
              />
            ) : null}

            {/* SPIRE SCROLL, full container width below the CTA.
                With the wider canvas, descriptions fit on one line
                and the scroll's overall height is shorter. */}
            <div className="mt-8">
              <SpireScroll />
            </div>
          </div>

          {/* SOCIAL PROOF, worlds orb + bookshelf, side-by-side on
              wide viewports so a first-time visitor sees both the
              "play in these worlds" and "read these stories" pitches
              above the fold without needing to scroll. `auto-fit`
              with a 450px min collapses the layout to a single
              stacked column on narrower viewports (or when the
              orb is hidden because there are no featured worlds,
              the bookshelf naturally fills the row alone). Each
              child owns its own panel container so the segments
              read as distinct surfaces. */}
          <div
            className="mt-6 grid gap-4 px-2 pb-8 sm:px-6 lg:px-8"
            // `min(450px, 100%)` lets each column shrink below 450px
            // when the parent card itself is narrower than 450px
            // (every mobile viewport). The previous bare `minmax(450px, 1fr)`
            // forced a 450px floor on every column, on a 360px-wide
            // viewport the grid was 450px wide and the orb + bookshelf
            // both bled past the splash card's right edge, off-screen.
            // At >= 450px parent widths the `min()` resolves to the
            // 450px floor and the two-column side-by-side layout still
            // kicks in via `auto-fit` packing.
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(450px, 100%), 1fr))" }}
          >
            {branding.featuredWorldsEnabled ? <FeaturedWorldsCarousel onNavigate={onNavigate} /> : null}
            <BookshelfStrip onNavigate={onNavigate} />
          </div>
          <AffiliatesCarousel />

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
      </div>
    </div>
  );
}

