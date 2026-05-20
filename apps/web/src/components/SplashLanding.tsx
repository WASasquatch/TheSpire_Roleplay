import { useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { VERSION } from "@thekeep/shared";
import { isDarkPalette } from "@thekeep/shared";
import { useChat } from "../state/store.js";
import { resolveSplashTheme, splashBgUrl, themeStyle } from "../lib/theme.js";
import { AffiliatesCarousel } from "./AffiliatesCarousel.js";
import { FeaturedWorldsCarousel } from "./FeaturedWorldsCarousel.js";

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
    // Honor cmd/ctrl/middle-click for "open in new tab" — the browser's
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
      {/* Background art — mirrors SplashShell so the visual identity stays
          consistent between the landing and the auth pages. Same dark-
          mode swap (resolved palette → bg image variant + corner glows). */}
      <div
        aria-hidden
        className="absolute inset-0 bg-cover bg-[position:-175px_center] md:bg-center"
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

      {/* Card. Wider than the AuthGate card (680px vs 560px) so the
          three-pillar grid below the hero has room to breathe. Same
          right-anchored desktop positioning so the spire artwork on the
          left stays visible. */}
      <div className="relative flex min-h-screen items-center justify-center lg:block">
        <div
          className="
            mx-4 my-8
            w-[min(680px,92vw)]
            max-h-[calc(100vh-4rem)] overflow-y-auto
            lg:absolute lg:top-1/2 lg:right-[max(2rem,calc(25%-21rem))] lg:my-0 lg:mx-0 lg:-translate-y-1/2
            lg:max-h-[calc(100vh-2rem)]
            rounded-md border
            bg-keep-bg/55 backdrop-blur-xl border-keep-border/60
            ring-1 ring-keep-bg/40 ring-inset
            lg:bg-keep-bg/95 lg:backdrop-blur-sm lg:border-keep-border lg:ring-0
            shadow-[0_20px_60px_-15px_rgba(0,0,0,0.45)]
          "
        >
          <div
            aria-hidden
            className="h-0.5 w-full rounded-t-md"
            style={{ background: "linear-gradient(90deg, transparent, #3fa5a0 30%, #3fa5a0 70%, transparent)" }}
          />

          <div className="px-6 py-8 sm:px-10 sm:py-10">
            {/* HERO — site name + value prop. The h1 carries the SEO weight;
                the subhead spells out what the site actually does in
                keyword-rich plain English so crawlers and humans both
                get the pitch in one glance. */}
            <header className="text-center">
              <h1
                style={logoStyle}
                className="font-action text-4xl tracking-wide text-keep-text sm:text-5xl"
              >
                {branding.logoUrl ? (
                  // Image logo (default install ships /thespire-logo.png,
                  // admins can replace via /admin/settings or upload).
                  // The <h1> stays for SEO + screen-readers; alt is the
                  // siteName so the brand string is still indexable.
                  // The splash gets a generous max-height since the card
                  // has the vertical room — matches the size used in
                  // AuthGate's hero so the splash + login feel of one
                  // piece.
                  <img
                    src={branding.logoUrl}
                    alt={siteName}
                    className="mx-auto max-h-24 w-auto select-none sm:max-h-28"
                    draggable={false}
                  />
                ) : (
                  siteName
                )}
              </h1>
              <p className="mt-3 text-base text-keep-text/80 sm:text-lg">
                Build characters. Tell stories. Find your circle.
              </p>
              <p className="mt-2 text-xs uppercase tracking-[0.3em] text-keep-muted">
                a sanctuary for collaborative roleplay
              </p>
            </header>

            {/* PILLARS — three feature highlights. Concrete and skimmable;
                each one names a thing the visitor can do here and why it
                matters. Uses <h2> so they show up as section headings to
                crawlers. */}
            <section className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Pillar
                icon="✦"
                title="Characters"
                body="Build a persona with bios, portraits, and stats. Switch between them as your stories shift."
              />
              <Pillar
                icon="◈"
                title="Worlds"
                body="Author the settings you play in. Public worlds anyone can join, private ones for your circle."
              />
              <Pillar
                icon="✎"
                title="Forums"
                body="Long-form topics that persist between sessions. Pick up a thread weeks later, right where you left it."
              />
            </section>

            {/* PRIMARY CTA + secondary link. The CTA promotes registration
                — the most valuable action a visitor can take. Login is a
                quieter text link below for returning users; bookmarkable
                separately at /login so frequent visitors aren't nagged
                with the CTA on every sign-in. */}
            <div className="mt-8 flex flex-col items-center gap-3">
              {branding.registrationOpen ? (
                <a
                  href="/register"
                  onClick={(e) => go(e, "/register")}
                  className="
                    inline-flex items-center justify-center gap-2
                    rounded-md border border-keep-action
                    bg-keep-action px-6 py-2.5
                    text-base font-semibold uppercase tracking-widest
                    text-keep-bg
                    shadow-[0_4px_14px_-4px_rgba(0,0,0,0.45)]
                    transition hover:brightness-110 active:brightness-95
                  "
                >
                  Create your character
                </a>
              ) : (
                <div className="rounded border border-keep-rule/50 bg-keep-bg/40 px-4 py-2 text-center text-xs text-keep-muted">
                  Registration is currently closed. Returning members can sign in below.
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

            {/* OPTIONAL LIVE SIGNALS — each clause is independently
                gated by its own toggle. The writers/online line stays
                in its existing inline-paragraph treatment because the
                marketing copy reads conversationally. The 24h-message
                count gets its own HERO block (big tabular number,
                uppercase label beneath) because admins surfacing chat
                volume want it to anchor the eye, not get lost in a
                muted paragraph. When both are on the hero sits above
                the conversational line so the headline reads first. */}
            {branding.splashMessages24hEnabled && stats && typeof stats.messages24h === "number" ? (
              <div className="mt-6 text-center">
                <div
                  className={`text-3xl font-bold tabular-nums leading-none sm:text-4xl ${
                    stats.messages24h > 0 ? "text-keep-action" : "text-keep-text"
                  }`}
                >
                  {stats.messages24h.toLocaleString()}
                </div>
                <div className="mt-1.5 text-[10px] uppercase tracking-[0.2em] text-keep-muted">
                  {stats.messages24h === 1 ? "message" : "messages"} in the last 24h
                </div>
              </div>
            ) : null}
            {branding.activityFeedsEnabled && stats ? (
              <p
                className={`text-center text-xs text-keep-muted ${
                  branding.splashMessages24hEnabled && typeof stats.messages24h === "number"
                    ? "mt-3"
                    : "mt-6"
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

            {/* ADMIN WELCOME — only renders when set. Surfaces the
                site's own voice / lore beat between the static pillars
                and the social-proof carousels. */}
            {branding.welcomeHtml.trim() ? (
              <div
                className="prose prose-sm mx-auto mt-6 max-w-none border-t border-keep-rule/50 pt-5 text-keep-text/90"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(branding.welcomeHtml) }}
              />
            ) : null}
          </div>

          {/* SOCIAL PROOF CAROUSELS — both honor their admin toggles
              and render nothing when empty. Below the CTA so they
              support the pitch rather than competing with it. */}
          {branding.featuredWorldsEnabled ? <FeaturedWorldsCarousel /> : null}
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

function Pillar({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="rounded border border-keep-rule/40 bg-keep-bg/40 p-3 text-center">
      <div className="text-2xl text-keep-action" aria-hidden>{icon}</div>
      <h2 className="mt-1 font-action text-lg text-keep-text">{title}</h2>
      <p className="mt-1 text-xs leading-snug text-keep-text/75">{body}</p>
    </div>
  );
}
