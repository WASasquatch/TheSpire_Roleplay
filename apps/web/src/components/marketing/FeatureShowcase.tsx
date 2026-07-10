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
    pointCount: 3,
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
    pointCount: 3,
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
  const active = isIntro ? null : FEATURES[index - 1]!;
  const Icon = active?.icon;
  const showCta = !!active?.cta && (!active.ctaNeedsRegistration || registrationOpen);

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
            Keyed on the slide so the slide-in replays on every advance. */}
        {isIntro ? (
          <div key="overview" className="feature-panel-in overflow-hidden">
            {/* Themed headline above the screenshot (the baked-in image text
                didn't match the palette). */}
            <h3 className="font-action mb-4 text-center text-2xl uppercase tracking-[0.12em] text-keep-text sm:text-3xl lg:text-4xl">
              {t("features.introHeading")}
            </h3>
            {/* Explicit intrinsic size + aspect-ratio reserves the slot before
                the image loads so it can't shove the layout (CLS). The image is
                fluid-width (w-full h-auto), so aspect-ratio does the real
                reserving; the width/height attributes are the fallback. */}
            <img
              src="/spire_screenshots.png"
              alt={t("features.introAlt")}
              width={2605}
              height={969}
              className="h-auto w-full select-none rounded"
              style={{ aspectRatio: "2605 / 969" }}
              draggable={false}
            />
          </div>
        ) : (
          <div
            key={active!.key}
            className="feature-panel-in"
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
                {Icon ? <Icon className="h-6 w-6 text-keep-accent sm:h-7 sm:w-7" aria-hidden /> : null}
              </div>
              <div className="min-w-0">
                <h3 className="font-action text-xl text-keep-text sm:text-2xl">
                  {t(`features.items.${active!.key}.title`)}
                </h3>
                <p className="text-xs uppercase tracking-[0.2em] text-keep-accent sm:text-sm">
                  {t(`features.items.${active!.key}.tagline`)}
                </p>
              </div>
            </div>

            {/* Copy + highlight bullets. Two columns on wide panels so the
                line length stays readable. */}
            <div className="gap-8 lg:grid lg:grid-cols-[3fr_2fr]">
              <div className="min-w-0">
                <p className="text-base leading-relaxed text-keep-text/85 lg:text-lg">
                  {t(`features.items.${active!.key}.desc`)}
                </p>
                {showCta ? (
                  <a
                    href={active!.cta!.path}
                    onClick={(e) => go(e, active!.cta!.path)}
                    className="mt-5 inline-flex items-center gap-1 text-base font-semibold text-keep-action underline-offset-4 hover:underline lg:text-lg"
                  >
                    {t(`features.items.${active!.key}.ctaLabel`)} →
                  </a>
                ) : null}
              </div>
              <ul className="mt-4 space-y-2.5 lg:mt-0">
                {Array.from({ length: active!.pointCount }, (_, i) =>
                  t(`features.items.${active!.key}.points.${i}`),
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
        )}
      </div>
    </section>
  );
}
