import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  Check,
  Coins,
  Globe,
  HeartHandshake,
  Landmark,
  MessagesSquare,
  Palette,
  Server,
  VenetianMask,
  type LucideIcon,
} from "lucide-react";
import { SPLASH_PANEL, SPLASH_PANEL_HOVER } from "../../lib/splashPanel.js";

/**
 * Splash-page feature showcase. Replaces the animated parchment
 * scroll (SpireScroll) with a professional tabbed spotlight: a rail
 * of feature chips up top, one feature spotlighted below with its
 * description, highlight bullets, and (where the destination is
 * publicly reachable) a "see it" link.
 *
 * Auto-advances through the catalog every ROTATE_MS so an idle
 * visitor still gets the whole tour. The active chip carries a
 * filling progress bar and the panel slides in on every change so
 * the rotation is visibly a slideshow. Rotation pauses on
 * hover/focus and stops permanently once the visitor picks a chip
 * themselves, at that point they're reading, not watching a demo.
 */

const ROTATE_MS = 6000;

/** Raw `inert` attribute for inactive grid-stacked slides (React 18 has
 *  no typed prop for it; the DOM accepts the attribute fine). Inert
 *  blocks focus AND pointer events, so an invisible slide's CTA link
 *  can't be tabbed to or clicked. */
const INERT = { inert: "" } as unknown as React.HTMLAttributes<HTMLDivElement>;

/**
 * Feature catalog metadata. All user-facing copy (title / tagline / desc /
 * bullet points / CTA label) lives in the `marketing` catalog under
 * `features.items.<key>.*`, resolved with t() at render time so a language
 * switch re-renders the tour; only the non-copy config stays here.
 */
interface Feature {
  key: string;
  icon: LucideIcon;
  /** Number of highlight bullets under `features.items.<key>.points`. */
  pointCount: number;
  /** Optional public destination ("see it live"). Paths must be reachable
   *  anonymously. Label lives at `features.items.<key>.ctaLabel`. */
  cta?: { path: string };
  /** When true the cta only renders while registration is open. */
  ctaNeedsRegistration?: boolean;
}

const FEATURES: ReadonlyArray<Feature> = [
  {
    key: "characters",
    icon: VenetianMask,
    pointCount: 3,
    cta: { path: "/register" },
    ctaNeedsRegistration: true,
  },
  {
    key: "communities",
    icon: Server,
    pointCount: 4,
    cta: { path: "/register" },
    ctaNeedsRegistration: true,
  },
  {
    key: "rooms",
    icon: MessagesSquare,
    pointCount: 4,
  },
  {
    key: "worlds",
    icon: Globe,
    pointCount: 3,
  },
  {
    key: "forums",
    icon: Landmark,
    pointCount: 3,
    cta: { path: "/f/spire" },
  },
  {
    key: "scriptorium",
    icon: BookOpen,
    pointCount: 3,
    cta: { path: "/scriptorium" },
  },
  {
    key: "profiles",
    icon: Palette,
    pointCount: 4,
  },
  {
    key: "earning",
    icon: Coins,
    pointCount: 4,
  },
  {
    key: "community",
    icon: HeartHandshake,
    pointCount: 4,
  },
];

interface Props {
  onNavigate: (path: string) => void;
  /** Mirrors branding.registrationOpen; hides register-bound CTAs when closed. */
  registrationOpen: boolean;
}

export function FeatureShowcase({ onNavigate, registrationOpen }: Props) {
  const { t } = useTranslation("marketing");
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  // Once the visitor picks a chip themselves, stop the slideshow,
  // they're reading at their own pace now.
  const [pinned, setPinned] = useState(false);
  // Bumped on every unpause. The JS interval restarts with a full
  // ROTATE_MS window when `paused` flips off, so the chip's progress
  // bar (keyed on index + epoch) must restart from zero too or the
  // two drift apart and the bar hits 100% before the advance fires.
  const [epoch, setEpoch] = useState(0);

  // Slide 0 is the full-bleed product screenshot (no text); slides 1..N are
  // the features. The carousel starts on the screenshot and rotates through
  // the whole set.
  const SLIDE_COUNT = FEATURES.length + 1;

  useEffect(() => {
    if (paused || pinned) return;
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % SLIDE_COUNT);
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, [paused, pinned, SLIDE_COUNT]);

  function resume() {
    setPaused(false);
    setEpoch((e) => e + 1);
  }

  const isIntro = index === 0;

  function go(e: React.MouseEvent, path: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onNavigate(path);
  }

  return (
    <section
      aria-label={t("features.kicker")}
      onFocus={() => setPaused(true)}
      onBlur={resume}
      className={`${SPLASH_PANEL} ${SPLASH_PANEL_HOVER} p-5 sm:p-6`}
    >
      <header className="mb-5 text-center">
        <p className="text-[11px] uppercase tracking-[0.3em] text-keep-muted">
          {t("features.kicker")}
        </p>
        <h2 className="font-action mt-1 text-2xl text-keep-text sm:text-3xl">
          {t("features.heading")}
        </h2>
        {/* One-line greeting (replaces the old standalone welcome block that
            pushed the feature layout down). Welcomes everyone in a breath. */}
        <p className="mx-auto mt-2 max-w-xl text-sm text-keep-text/75 sm:text-base">
          {t("features.welcome")}
        </p>
      </header>

      {/* Hover-pause lives on the spotlight, not the whole section, so a
          cursor merely parked over the page doesn't freeze the slideshow. */}
      <div
        id="feature-spotlight"
        role="tabpanel"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={resume}
      >
        {/* Dot carousel — replaces the haphazardly-wrapping chip rail. Sits
            ABOVE the panel; only the dots live outside the container. The
            active dot stretches into a filling pill that mirrors the
            auto-advance countdown. */}
        <div
          role="tablist"
          aria-label={t("features.listAria")}
          className="mb-4 flex flex-wrap items-center justify-center gap-2"
        >
          {Array.from({ length: SLIDE_COUNT }, (_, i) => {
            const activeDot = i === index;
            // Slide 0 = the overview screenshot; 1..N = features.
            const label =
              i === 0 ? t("features.overview") : t(`features.items.${FEATURES[i - 1]!.key}.title`);
            return (
              <button
                key={i === 0 ? "overview" : FEATURES[i - 1]!.key}
                type="button"
                role="tab"
                aria-selected={activeDot}
                aria-controls="feature-spotlight"
                aria-label={label}
                title={label}
                onClick={() => { setIndex(i); setPinned(true); }}
                className={`relative h-2 overflow-hidden rounded-full transition-all ${
                  activeDot ? "w-8 bg-keep-accent/25" : "w-2 bg-keep-muted/40 hover:bg-keep-accent/60"
                }`}
              >
                {activeDot && !pinned ? (
                  <span
                    key={`${index}-${epoch}`}
                    className={`feature-dot-fill${paused ? " paused" : ""}`}
                    style={{ "--chip-fill-ms": `${ROTATE_MS}ms` } as React.CSSProperties}
                    aria-hidden
                  />
                ) : activeDot ? (
                  <span className="absolute inset-0 bg-keep-accent" aria-hidden />
                ) : null}
              </button>
            );
          })}
        </div>

        {/* Panel. Slide 0 is the full product screenshot (no text); every
            other slide is a feature (icon-inline header + copy + bullets).

            GRID-STACK: every slide stays mounted, all in the same grid
            cell (col-start-1 row-start-1), so the panel's height is the
            TALLEST slide's height at the current breakpoint/locale — the
            page never reflows as the rotation advances. (The old
            render-one-slide version resized the panel per slide, bouncing
            everything below it every 6 seconds.) Inactive slides are
            invisible + aria-hidden + `inert` (raw attribute — React 18
            has no typed prop for it) so their links can't be tabbed to
            or clicked while hidden. The slide-in animation replays when
            a slide GAINS the class on activation.

            `grid-cols-1` (not a bare `grid`): a bare grid's implicit column
            is max-content, so on a phone the 600px screenshot / long copy
            would set the column wider than the viewport and overflow.
            grid-cols-1 = minmax(0,1fr), which caps the column to the
            container and lets w-full / truncation resolve correctly. */}
        <div className="grid grid-cols-1">
          <div
            className={`col-start-1 row-start-1 flex flex-col justify-center ${isIntro ? "feature-panel-in" : "invisible"}`}
            aria-hidden={!isIntro}
            {...(isIntro ? {} : INERT)}
          >
            {/* Side-by-side, packed to the LEFT: screenshot then the
                header + browser-support blurb inline beside it (stacks on
                narrow). A stretched two-column grid shoved the image to
                the far-right edge and the text to the far-left, leaving a
                dead gulf between them; a left-aligned flex row keeps them
                together. The image is capped at 600px and shares the row
                rather than spanning full-width, so the intro slide isn't
                dramatically taller than the text slides (the grid-stack
                sizes the whole panel to the tallest slide, and a
                full-bleed screenshot made every other slide swim in dead
                space). */}
            <div className="lg:flex lg:items-center lg:justify-center lg:gap-6">
              {/* Explicit intrinsic size + aspect-ratio reserves the slot
                  before the image loads so it can't shove the layout (CLS).
                  Capped at 600px; shrinks if the row gets tight. */}
              <img
                src="/spire_screenshots.png"
                alt={t("features.introAlt")}
                width={2605}
                height={969}
                className="mx-auto h-auto w-full max-w-[600px] shrink select-none rounded lg:mx-0"
                style={{ aspectRatio: "2605 / 969" }}
                draggable={false}
              />
              <div className="mt-5 text-center lg:mt-0 lg:min-w-0 lg:text-left">
                <h3 className="font-action text-2xl uppercase tracking-[0.12em] text-keep-text sm:text-3xl">
                  {t("features.introHeading")}
                </h3>
                <p className="mx-auto mt-3 max-w-md text-base leading-relaxed text-keep-text/85 lg:mx-0 lg:text-lg">
                  {t("features.introSummary")}
                </p>
              </div>
            </div>
          </div>
          {FEATURES.map((f, fi) => {
            const isActive = index === fi + 1;
            const FIcon = f.icon;
            const showCta = !!f.cta && (!f.ctaNeedsRegistration || registrationOpen);
            return (
              <div
                key={f.key}
                className={`col-start-1 row-start-1 flex flex-col justify-center ${isActive ? "feature-panel-in" : "invisible"}`}
                aria-hidden={!isActive}
                {...(isActive ? {} : INERT)}
              >
                {/* Header: icon inline with the title + tagline. */}
                <div className="mb-4 flex items-center gap-3 sm:gap-4">
                  <div
                    aria-hidden
                    className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-keep-accent/40 sm:h-14 sm:w-14"
                    style={{
                      background:
                        "radial-gradient(circle at 30% 25%, rgb(var(--keep-accent) / 0.25), rgb(var(--keep-panel) / 0.4) 70%)",
                    }}
                  >
                    <FIcon className="h-6 w-6 text-keep-accent sm:h-7 sm:w-7" aria-hidden />
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-action text-xl text-keep-text sm:text-2xl">
                      {t(`features.items.${f.key}.title`)}
                    </h3>
                    <p className="text-xs uppercase tracking-[0.2em] text-keep-accent sm:text-sm">
                      {t(`features.items.${f.key}.tagline`)}
                    </p>
                  </div>
                </div>

                {/* Copy + highlight bullets. Two columns on wide panels so the
                    line length stays readable. */}
                <div className="gap-8 lg:grid lg:grid-cols-[3fr_2fr]">
                  <div className="min-w-0">
                    <p className="text-base leading-relaxed text-keep-text/85 lg:text-lg">
                      {t(`features.items.${f.key}.desc`)}
                    </p>
                    {showCta ? (
                      <a
                        href={f.cta!.path}
                        onClick={(e) => go(e, f.cta!.path)}
                        className="mt-5 inline-flex items-center gap-1 text-base font-semibold text-keep-action underline-offset-4 hover:underline lg:text-lg"
                      >
                        {t(`features.items.${f.key}.ctaLabel`)} →
                      </a>
                    ) : null}
                  </div>
                  <ul className="mt-4 space-y-2.5 lg:mt-0">
                    {Array.from({ length: f.pointCount }, (_, i) =>
                      t(`features.items.${f.key}.points.${i}`),
                    ).map((p) => (
                      <li
                        key={p}
                        className="flex items-start gap-2.5 text-[15px] text-keep-text/85 lg:text-base"
                      >
                        <Check className="mt-1 h-4 w-4 shrink-0 text-keep-accent lg:h-5 lg:w-5" aria-hidden />
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
