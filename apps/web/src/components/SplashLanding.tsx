import { useEffect, useState } from "react";
import { VERSION } from "@thekeep/shared";
import { isDarkPalette } from "@thekeep/shared";
import {
  DoorOpen,
  Landmark,
  LogIn,
  MessagesSquare,
  Radio,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useChat } from "../state/store.js";
import { resolveSplashTheme, splashBgUrl, themeStyle } from "../lib/theme.js";
import { AffiliatesCarousel } from "./AffiliatesCarousel.js";
import { BookshelfStrip } from "./BookshelfStrip.js";
import { FeatureShowcase } from "./FeatureShowcase.js";
import { FeaturedWorldCards } from "./FeaturedWorldCards.js";

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
          the viewport rather than the full (taller) document. */}
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

      <div className="relative flex min-h-screen flex-col items-center justify-start py-8 lg:py-10">
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
                {/* PRIMARY CTA, button + login link inline so the action
                    stack reads as one tight block at the top of the column. */}
                <div className="flex flex-col items-center gap-2 sm:flex-row sm:justify-center sm:gap-5">
                  {branding.registrationOpen ? (
                    <a
                      href="/register"
                      onClick={(e) => go(e, "/register")}
                      className="
                        inline-flex items-center justify-center gap-2
                        rounded-md border border-keep-action
                        bg-keep-action px-7 py-3
                        text-sm font-semibold uppercase tracking-widest sm:text-base
                        text-keep-bg
                        shadow-[0_4px_14px_-4px_rgba(0,0,0,0.45)]
                        transition hover:brightness-110 active:brightness-95
                      "
                    >
                      <UserPlus className="h-5 w-5" aria-hidden />
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
                    className="inline-flex items-center gap-1.5 text-base text-keep-text/80 underline-offset-4 hover:text-keep-action hover:underline"
                  >
                    <LogIn className="h-4 w-4" aria-hidden />
                    Already have an account? <span className="font-semibold">Log in</span>
                  </a>
                </div>

                {/* LIVE SIGNALS, admin-gated stat tiles. Only the tiles
                    whose toggles are on render; the band disappears
                    entirely on a cold-start install. */}
                {tiles.length > 0 ? (
                  // Mobile: a uniform two-column, half-scale grid (the old
                  // flex-wrap broke one tile per line and sized them unevenly).
                  // sm+ has room to spread the tiles in a centered row again.
                  <div className="grid grid-cols-2 gap-2.5 sm:flex sm:flex-wrap sm:justify-center sm:gap-3">
                    {tiles.map((t) => {
                      const TileIcon = t.icon;
                      return (
                        <div
                          key={t.key}
                          className="rounded-md border border-keep-border/50 bg-keep-panel/30 px-3 py-3 text-center sm:min-w-[170px] sm:px-6 sm:py-4"
                        >
                          <TileIcon className="mx-auto h-4 w-4 text-keep-accent sm:h-5 sm:w-5" aria-hidden />
                          <div className="mt-1 text-xl font-bold tabular-nums leading-none text-keep-action sm:mt-1.5 sm:text-3xl">
                            {t.value}
                          </div>
                          <div className="mt-1 text-[10px] uppercase tracking-[0.12em] text-keep-muted sm:mt-1.5 sm:text-[11px] sm:tracking-[0.15em]">
                            {t.label}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                {/* FEATURE TOUR + pitches, the rest of the main column. */}
                <FeatureShowcase
                  onNavigate={onNavigate}
                  registrationOpen={branding.registrationOpen}
                />

                {/* FORUMS HOSTING, secondary call to action. Links to
                    the seeded system forum's public page so visitors
                    can see a live forum before committing. */}
                <section
                  aria-label="Host your forums here"
                  className="rounded-md border border-keep-accent/40 p-5 sm:p-6"
                  style={{
                    background:
                      "linear-gradient(120deg, rgb(var(--keep-accent) / 0.12), rgb(var(--keep-panel) / 0.25) 55%, rgb(var(--keep-action) / 0.1))",
                  }}
                >
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                    {/* Icon stays inline with the title + copy at every width
                        (the old flex-col stacked it above the heading on
                        mobile). Buttons drop below on phones, beside on sm+. */}
                    <div className="flex min-w-0 flex-1 items-start gap-4 sm:items-center">
                      <div
                        aria-hidden
                        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-keep-accent/40 bg-keep-bg/40 sm:h-14 sm:w-14"
                      >
                        <Landmark className="h-6 w-6 text-keep-accent sm:h-7 sm:w-7" aria-hidden />
                      </div>
                      <div className="min-w-0">
                        <h3 className="font-action text-xl text-keep-text sm:text-2xl">
                          Bring your community to {siteName}
                        </h3>
                        <p className="mt-1.5 text-base leading-relaxed text-keep-text/85 lg:text-lg">
                          Host forums for your game, guild, or fandom, with your own
                          boards, a moderator team, membership rules, and a public
                          landing page you can share anywhere.
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col gap-2.5">
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
                          className="text-center text-sm text-keep-text/75 underline-offset-4 hover:text-keep-action hover:underline"
                        >
                          Start your own forum →
                        </a>
                      ) : null}
                    </div>
                  </div>
                </section>

                {/* CLOSING CTA. The visitor has just read the feature
                    tour; close the loop with one big register push
                    (or a login push when registration is closed) plus
                    a no-commitment path into the Scriptorium. Also
                    balances the main column's height against the
                    taller meta rail. */}
                <section
                  aria-label="Join"
                  className="rounded-md border border-keep-border/50 bg-keep-panel/30 p-6 text-center sm:p-10"
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
                        Create your account
                      </a>
                    ) : (
                      <a
                        href="/login"
                        onClick={(e) => go(e, "/login")}
                        className="inline-flex items-center justify-center gap-2 rounded-md border border-keep-accent/60 bg-keep-bg/40 px-8 py-3 text-sm font-semibold uppercase tracking-widest text-keep-text transition hover:border-keep-accent hover:text-keep-action sm:text-base"
                      >
                        <LogIn className="h-5 w-5" aria-hidden />
                        Log in
                      </a>
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
              </aside>
            </div>
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
