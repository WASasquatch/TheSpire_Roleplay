import { useEffect, useState } from "react";
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
import { SPLASH_PANEL, SPLASH_PANEL_HOVER } from "../lib/splashPanel.js";

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

const ROTATE_MS = 2500;

interface Feature {
  key: string;
  icon: LucideIcon;
  title: string;
  tagline: string;
  desc: string;
  points: string[];
  /** Optional public destination ("see it live"). Paths must be reachable anonymously. */
  cta?: { label: string; path: string };
  /** When true the cta only renders while registration is open. */
  ctaNeedsRegistration?: boolean;
}

const FEATURES: ReadonlyArray<Feature> = [
  {
    key: "characters",
    icon: VenetianMask,
    title: "Characters",
    tagline: "Play a whole cast, not just one face",
    desc: "Create up to 100 distinct characters on a single account, each with their own portrait, bio, stats, and inventory. Switch personas instantly, and join several games in different tabs at once.",
    points: [
      "Up to 100 characters per account",
      "Portraits, bios, stats & inventory",
      "Per-character account management",
    ],
    cta: { label: "Create your cast", path: "/register" },
    ctaNeedsRegistration: true,
  },
  {
    key: "communities",
    icon: Server,
    title: "Communities",
    tagline: "Host your own community, or join one",
    desc: "Beyond the native Spire, anyone can create their own community: a space with its own chat rooms, members, roles, economy, and moderation. Run it your way, or join communities other people have built.",
    points: [
      "Your own rooms, members & roles",
      "Per-community economy & cosmetics",
      "Moderation tools you control",
    ],
    cta: { label: "Start a community", path: "/register" },
    ctaNeedsRegistration: true,
  },
  {
    key: "rooms",
    icon: MessagesSquare,
    title: "Live Roleplay",
    tagline: "Real-time scenes, day or night",
    desc: "Write together in open public rooms, or private rooms. Set the scene, and use NPC speakers to bring characters to life. Dice rolls, whispers, emotes, and slash commands keep the scene moving.",
    points: [
      "Public & private password protected rooms",
      "Room descriptions, scenes, and NPC speakers to enrich storytelling",
      "Dice, actions, and whispers commands",
      "Emoticons and emote stickers + custom emotes",
    ],
  },
  {
    key: "worlds",
    icon: Globe,
    title: "Worlds & Wikis",
    tagline: "Build the setting, not just the scene",
    desc: "Give your game a permanent home: a world wiki with typed entries for locations, NPCs, items, and factions, a lore page tree, story arcs, and session logs, all cross-linked like a real knowledge base.",
    points: [
      "Typed entries: locations, NPCs, items, factions",
      "Lore pages, story arcs & session logs",
      "Vibe sliders show players what to expect",
    ],
  },
  {
    key: "forums",
    icon: Landmark,
    title: "Forums & PBP",
    tagline: "Join or host your own forums here",
    desc: "Join an existing forum hosting Play-by-Post games, or run a forum for your own games, guilds, or fandoms. You get your own boards, a moderator team, and membership rules.",
    points: [
      "Your own boards & moderator roles",
      "Open, application, or invite-only membership",
      "A public page at your own /f/ address",
    ],
    cta: { label: "Browse the community forums", path: "/f/spire" },
  },
  {
    key: "scriptorium",
    icon: BookOpen,
    title: "The Scriptorium",
    tagline: "Publish original fiction & fanfiction",
    desc: "Post your stories with chapters, content ratings, and reviews in a rich editor built for writers. Readers can shelve your books in their library, and you can even offer paid copies with in-app point currency.",
    points: [
      "Original fiction & fanfiction with chapters",
      "Reviews, ratings & reader libraries",
      "Earn gold, and offer paid copies of your work",
    ],
    cta: { label: "Browse the Scriptorium", path: "/scriptorium" },
  },
  {
    key: "profiles",
    icon: Palette,
    title: "Profiles",
    tagline: "A page that is truly yours",
    desc: "Every character gets a customizable profile page: custom CSS, backgrounds, image galleries, and links. Make it match your character, not a template.",
    points: [
      "Custom HTML, CSS & backgrounds",
      "Image galleries & links",
      "Distinct looks per character",
      "Show off item collections & pets"
    ],
  },
  {
    key: "earning",
    icon: Coins,
    title: "Earning & Rewards",
    tagline: "Progress that respects your time",
    desc: "Active writers earn XP, ranks, and currency just by playing. Spend it on cosmetics, name styles, room transitions, and gifts for friends. No decay, no daily chores.",
    points: [
      "XP, ranks & point currency for writing",
      "Shop with collectible items, gifts, throwables, and pets",
      "Customizable Name Styles, Border Frames, and more",
      "No grind required to keep your standing",
    ],
  },
  {
    key: "community",
    icon: HeartHandshake,
    title: "Find Your Circle",
    tagline: "Built for long-lived communities",
    desc: "Friends lists, per-character presence, and safety tools like blocking and ignores keep the community healthy. Themes from medieval to sci-fi make it feel like home.",
    points: [
      "Friends & online presence",
      "Blocking, ignore & moderation tools",
      "Light & dark themes for every taste + customize your own",
    ],
  },
];

interface Props {
  onNavigate: (path: string) => void;
  /** Mirrors branding.registrationOpen; hides register-bound CTAs when closed. */
  registrationOpen: boolean;
}

export function FeatureShowcase({ onNavigate, registrationOpen }: Props) {
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
      aria-label="What you can do here"
      onFocus={() => setPaused(true)}
      onBlur={resume}
      className={`${SPLASH_PANEL} ${SPLASH_PANEL_HOVER} p-5 sm:p-6`}
    >
      <header className="mb-5 text-center">
        <p className="text-[11px] uppercase tracking-[0.3em] text-keep-muted">
          What you can do here
        </p>
        <h2 className="font-action mt-1 text-2xl text-keep-text sm:text-3xl">
          Everything Your Story Needs
        </h2>
        {/* One-line greeting (replaces the old standalone welcome block that
            pushed the feature layout down). Welcomes everyone in a breath. */}
        <p className="mx-auto mt-2 max-w-xl text-sm text-keep-text/75 sm:text-base">
          Welcome, every writer, dreamer, and creature from all walks of life. There's a place for your stories here.
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
          aria-label="Feature list"
          className="mb-4 flex flex-wrap items-center justify-center gap-2"
        >
          {Array.from({ length: SLIDE_COUNT }, (_, i) => {
            const activeDot = i === index;
            // Slide 0 = the overview screenshot; 1..N = features.
            const label = i === 0 ? "Overview" : FEATURES[i - 1]!.title;
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
              Play and pick-up games on any device
            </h3>
            <img
              src="/spire_screenshots.png"
              alt="A look inside The Spire"
              className="h-auto w-full select-none rounded"
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
                  {active!.title}
                </h3>
                <p className="text-xs uppercase tracking-[0.2em] text-keep-accent sm:text-sm">
                  {active!.tagline}
                </p>
              </div>
            </div>

            {/* Copy + highlight bullets. Two columns on wide panels so the
                line length stays readable. */}
            <div className="gap-8 lg:grid lg:grid-cols-[3fr_2fr]">
              <div className="min-w-0">
                <p className="text-base leading-relaxed text-keep-text/85 lg:text-lg">
                  {active!.desc}
                </p>
                {showCta ? (
                  <a
                    href={active!.cta!.path}
                    onClick={(e) => go(e, active!.cta!.path)}
                    className="mt-5 inline-flex items-center gap-1 text-base font-semibold text-keep-action underline-offset-4 hover:underline lg:text-lg"
                  >
                    {active!.cta!.label} →
                  </a>
                ) : null}
              </div>
              <ul className="mt-4 space-y-2.5 lg:mt-0">
                {active!.points.map((p) => (
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
