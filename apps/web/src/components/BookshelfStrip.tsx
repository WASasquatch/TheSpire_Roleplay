import { useEffect, useRef, useState } from "react";
import type { StoryCard } from "@thekeep/shared";
import { ratingRequiresAuth, STORY_RATING_INFO } from "@thekeep/shared";
import { useChat } from "../state/store.js";

interface Props {
  onNavigate: (path: string) => void;
}

/**
 * Splash bookshelf, replaces the old FeaturedStoriesStrip card grid
 * with a 3D library shelf. Each volume rests upright on the shelf
 * showing its spine; hovering or focusing a book draws it out and
 * rotates the cover toward the viewer. Click on a drawn book opens
 * the story (anonymous users can read up to R; NC-17 reroutes through
 * /login).
 *
 * Always renders at least MIN_BOOKS volumes, empty slots are filled
 * with a "Write Your Story" placeholder that points to /register. So
 * a fresh install with zero stories still presents a full shelf and
 * an invitation, rather than a sad single volume.
 *
 * Theme integration:
 *   - The wood, brass trim, and brass bookends use the active theme's
 *     panel + accent ramps blended with a constant medieval-brown so
 *     the chrome feels antique on every palette.
 *   - Spine colors come from a small curated library palette (oxblood,
 *     forest, navy, ember, ochre, slate, royal, coal) so the shelf
 *     reads as a varied row of books without the colors clashing with
 *     the surrounding theme.
 *   - Spine titles and brass bands use `--keep-accent` (the theme
 *     accent) so the brand colour still tracks through.
 */

const MIN_BOOKS = 8;

/** Per-spine HSL pair, dark-theme jewel-tone vs light-theme pastel.
 *  CSS `light-dark()` at render time picks the right entry based on
 *  the document's `color-scheme`, so the same book renders as
 *  saturated oxblood on a dark theme and a soft rose pastel on a
 *  light theme without re-rendering the React tree. The dark-red
 *  spine title (theme accent on Parchment etc.) then has high
 *  contrast against the light pastel where it previously sat as
 *  dark-red-on-dark-navy and was barely legible. */
interface SpineHsl { sat: number; light: number }
interface SpinePalette {
  hue: number;
  dark: SpineHsl;
  light: SpineHsl;
}
const SPINE_PALETTE: SpinePalette[] = [
  { hue: 354, dark: { sat: 55, light: 32 }, light: { sat: 50, light: 78 } }, // oxblood → rose
  { hue: 145, dark: { sat: 45, light: 30 }, light: { sat: 42, light: 76 } }, // forest → sage
  { hue: 220, dark: { sat: 55, light: 34 }, light: { sat: 50, light: 78 } }, // navy → sky
  { hue: 8,   dark: { sat: 65, light: 36 }, light: { sat: 55, light: 80 } }, // ember → peach
  { hue: 35,  dark: { sat: 55, light: 40 }, light: { sat: 50, light: 82 } }, // ochre → wheat
  { hue: 195, dark: { sat: 50, light: 30 }, light: { sat: 45, light: 76 } }, // slate → ice
  { hue: 290, dark: { sat: 40, light: 34 }, light: { sat: 35, light: 80 } }, // royal → lilac
  { hue: 30,  dark: { sat: 15, light: 28 }, light: { sat: 22, light: 75 } }, // coal → sand
];

/** Build the four book color CSS vars (spine, cover top/bottom,
 *  back) from a SpinePalette entry. Each value is a `light-dark()`
 *  pair so the rendered color flips with the active color-scheme. */
function bookColorVars(p: SpinePalette): Record<string, string> {
  const mk = (s: SpineHsl, lightDelta: number): string =>
    `hsl(${p.hue}, ${s.sat}%, ${Math.max(0, Math.min(100, s.light + lightDelta))}%)`;
  return {
    "--book-spine-color":     `light-dark(${mk(p.light, 0)},  ${mk(p.dark, 0)})`,
    "--book-cover-color-top": `light-dark(${mk(p.light, 4)},  ${mk(p.dark, 4)})`,
    "--book-cover-color-bot": `light-dark(${mk(p.light, -6)}, ${mk(p.dark, -6)})`,
    "--book-back-color":      `light-dark(${mk(p.light, -10)},${mk(p.dark, -10)})`,
  };
}

/** Placeholder palette, a warm tan on light themes (so the
 *  dark-red spine title reads cleanly against it) and a muted
 *  neutral gray on dark themes (so empty slots clearly recede
 *  behind real story spines). */
const PLACEHOLDER_PALETTE: SpinePalette = {
  hue: 35,
  dark:  { sat: 8,  light: 42 },
  light: { sat: 32, light: 80 },
};

const LEAN_PATTERN = ["", "lean-l", "", "lean-r", "lean-l", "", "lean-r", ""];

// Deterministic hash → palette index / drift offset, so the same
// story always gets the same spine color across reloads. djb2-style
// integer hash; cheap and stable.
function strHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// A tiny set of medieval/library glyphs the cover face uses when the
// story has no cover image. Each is an inline SVG path string; the
// component frames it inside a square box and inherits stroke colour
// from `currentColor` (= the spine accent).
const GLYPHS: ReadonlyArray<{ paths: string[]; fills?: string[] }> = [
  // Star compass
  { paths: ["M30 8 L34 30 L30 52 L26 30 Z", "M8 30 L30 26 L52 30 L30 34 Z"], fills: ["M30 8 L34 30 L30 52 L26 30 Z"] },
  // Tower (the Spire)
  { paths: ["M22 52 L22 26 L30 14 L38 26 L38 52 Z", "M22 26 L38 26", "M28 34 L32 34", "M28 42 L32 42"] },
  // Quill on parchment
  { paths: ["M14 46 L36 24 Q42 18 46 22 Q42 26 36 32 L18 50 Z", "M14 46 L22 38", "M28 32 L40 20"] },
  // Open book
  { paths: ["M8 18 Q20 12 30 18 Q40 12 52 18 L52 46 Q40 40 30 46 Q20 40 8 46 Z", "M30 18 L30 46"] },
  // Crescent moon + stars
  { paths: ["M42 30 A14 14 0 1 1 28 16 A11 11 0 1 0 42 30 Z", "M14 14 L16 18 L20 16 L18 20 L20 24 L16 22 L14 24 L15 20 L12 18 L16 18 Z"] },
  // Key
  { paths: ["M18 30 A6 6 0 1 1 18 31 Z", "M22 30 L48 30", "M44 30 L44 36", "M40 30 L40 36"] },
  // Trefoil
  { paths: ["M30 14 Q22 18 22 26 Q22 32 30 32 Q38 32 38 26 Q38 18 30 14 Z", "M18 32 Q14 38 18 44 Q22 50 30 48 Q34 38 30 32 Z", "M42 32 Q46 38 42 44 Q38 50 30 48 Q26 38 30 32 Z"] },
  // Lantern
  { paths: ["M26 14 L34 14", "M28 14 L28 18 L32 18 L32 14", "M22 22 L38 22 L38 44 L22 44 Z", "M22 22 L38 44", "M38 22 L22 44"] },
];

function pickGlyph(seed: string) {
  return GLYPHS[strHash(seed) % GLYPHS.length]!;
}

interface Slot {
  kind: "story" | "placeholder";
  card?: StoryCard;
}

export function BookshelfStrip({ onNavigate }: Props) {
  const [items, setItems] = useState<StoryCard[] | null>(null);
  // Touch-device pull-out state. On desktop (hover-capable pointer)
  // the CSS `:hover` rules handle the cover-reveal and a click goes
  // straight to the story. On touch devices there's no hover, so
  // the user needs a way to PREVIEW a cover before committing to a
  // navigation, first tap pulls the book; second tap on the same
  // book opens it; tap elsewhere puts it back. `pulledId` is the
  // book currently flying forward (null when none).
  const [pulledId, setPulledId] = useState<string | null>(null);
  // `hoverCapableRef` decides which path a tap takes. We cache the
  // matchMedia result on first mount; a stale value just means the
  // wrong tap path for one session, which is acceptable for the
  // rare desktop-to-tablet hot-swap case.
  //
  // The detection deliberately AND's `(hover: hover)` with
  // `(pointer: fine)`. Chrome on Android lies about `hover: hover`
  // for legacy-site compatibility, many older sites broke when
  // mobile reported `hover: none`, so Android Chrome opted to keep
  // the `hover: hover` answer even though no actual hover exists.
  // `(pointer: fine)` is the honest signal: it's `coarse` on any
  // touch-primary device. Both true → real mouse / trackpad. Either
  // false → treat as touch and engage the first-tap-pull state
  // machine.
  const hoverCapableRef = useRef<boolean>(true);
  useEffect(() => {
    if (typeof window === "undefined") return;
    hoverCapableRef.current = window.matchMedia(
      "(hover: hover) and (pointer: fine)",
    ).matches;
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/stories/splash?limit=${MIN_BOOKS}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ entries: StoryCard[] }>) : null))
      .then((j) => { if (!cancelled) setItems(j?.entries ?? []); })
      .catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, []);

  // Tap-outside dismissal. When a book is pulled and the user taps
  // anywhere that isn't the pulled book itself (another book, the
  // shelf wood, off the shelf entirely), put the book back. Listens
  // on the capture phase so a tap on a SIBLING book triggers
  // dismissal BEFORE that sibling's own `onTap` handler runs to
  // pull it forward, net effect of tap-on-other-book is "swap
  // which one is pulled" rather than "two pulled at once for a
  // frame."
  useEffect(() => {
    if (pulledId === null) return;
    function dismiss(e: Event) {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest('.bookshelf-book[data-pulled="true"]')) return;
      setPulledId(null);
    }
    window.addEventListener("mousedown", dismiss, true);
    window.addEventListener("touchstart", dismiss, true);
    return () => {
      window.removeEventListener("mousedown", dismiss, true);
      window.removeEventListener("touchstart", dismiss, true);
    };
  }, [pulledId]);

  // Centralized two-tap dispatch. Desktop bypasses the pull state
  // (the CSS hover already previews the cover; a click should
  // commit). Touch users go through the state machine.
  function handleBookTap(id: string, openFn: () => void) {
    if (hoverCapableRef.current) {
      setPulledId(null);
      openFn();
      return;
    }
    if (pulledId === id) {
      setPulledId(null);
      openFn();
      return;
    }
    setPulledId(id);
  }

  // Pad with placeholders so the shelf always feels full. We don't
  // want a single lonely volume sitting on a wide plank.
  const stories = items ?? [];
  const slots: Slot[] = [];
  for (const c of stories.slice(0, MIN_BOOKS)) slots.push({ kind: "story", card: c });
  while (slots.length < MIN_BOOKS) slots.push({ kind: "placeholder" });

  function openStory(card: StoryCard) {
    if (ratingRequiresAuth(card.rating)) {
      onNavigate(`/login?story=${encodeURIComponent(card.id)}`);
      return;
    }
    const handle = card.author.masterUsername;
    onNavigate(`/scriptorium/@${encodeURIComponent(handle)}/${encodeURIComponent(card.slug)}`);
  }

  // Loading skeleton, keep the silhouette so the visual weight of
  // the splash doesn't pop after the fetch resolves.
  if (items === null) {
    return (
      <section aria-label="Featured stories" className="bookshelf bookshelf-loading">
        <BookshelfHeader onBrowse={() => onNavigate("/scriptorium")} />
        <div className="bookshelf-stage" aria-hidden>
          <div className="bookshelf-shelf">
            <div className="bookshelf-board" />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Featured stories" className="bookshelf">
      <BookshelfHeader onBrowse={() => onNavigate("/scriptorium")} />

      <div className="bookshelf-stage">
        <div className="bookshelf-shelf">
          <div className="bookshelf-books">
            <Bookend side="left" />
            {slots.map((slot, i) => {
              if (slot.kind === "placeholder") {
                const placeholderId = `placeholder-${i}`;
                return (
                  <PlaceholderBook
                    key={`p-${i}`}
                    lean={LEAN_PATTERN[i % LEAN_PATTERN.length]!}
                    index={i}
                    isPulled={pulledId === placeholderId}
                    onTap={() => handleBookTap(placeholderId, () => onNavigate("/register"))}
                  />
                );
              }
              return (
                <StoryBook
                  key={slot.card!.id}
                  card={slot.card!}
                  lean={LEAN_PATTERN[i % LEAN_PATTERN.length]!}
                  index={i}
                  isPulled={pulledId === slot.card!.id}
                  onTap={() => handleBookTap(slot.card!.id, () => openStory(slot.card!))}
                />
              );
            })}
            <Bookend side="right" />
          </div>
          <div className="bookshelf-board" aria-hidden />
        </div>
      </div>
    </section>
  );
}

function BookshelfHeader({ onBrowse }: { onBrowse: () => void }) {
  return (
    <header className="bookshelf-header">
      <div className="bookshelf-rule" aria-hidden>
        <span className="line" />
        <span className="diamond" />
        <span className="line" />
      </div>
      <h3 className="bookshelf-title font-action">From the Scriptorium</h3>
      <p className="bookshelf-subtitle">hover or tap a volume to draw it from the shelf</p>
      <button type="button" onClick={onBrowse} className="bookshelf-browse">
        Browse the catalog →
      </button>
    </header>
  );
}

interface BookProps {
  lean: string;
  index: number;
}

function StoryBook({
  card,
  lean,
  index,
  isPulled,
  onTap,
}: BookProps & { card: StoryCard; isPulled: boolean; onTap: () => void }) {
  const palette = SPINE_PALETTE[strHash(card.id) % SPINE_PALETTE.length]!;
  const driftDur = 5 + ((strHash(card.id + ":d") % 30) / 10); // 5.0 .. 7.9s
  const driftDelay = -((strHash(card.id + ":x") % 30) / 10); // -0.0 .. -2.9s
  const ratingInfo = STORY_RATING_INFO[card.rating];
  // Anonymous viewers see NC-17 books in the bookshelf (the splash
  // endpoint surfaces every rating now), but tapping one reroutes
  // through the login prompt because the body is gated. Paint a
  // lock badge on the cover so the gate is visible BEFORE the click
  // instead of being a surprise redirect.
  const me = useChat((s) => s.me);
  const lockedForAnon = !me && ratingRequiresAuth(card.rating);
  const styleVars = {
    ...bookColorVars(palette),
    "--drift-dur": `${driftDur}s`,
    "--drift-delay": `${driftDelay}s`,
    animationDelay: `${200 + index * 90}ms`,
  } as React.CSSProperties;
  const author = card.author.characterName ?? card.author.masterUsername;
  return (
    <button
      type="button"
      onClick={onTap}
      // `data-pulled` is what the CSS reads to fire the pull-out
      // transform on touch devices (no `:hover` available). On
      // desktop the existing `:hover` / `:focus-visible` paths still
      // win and this attr stays undefined.
      data-pulled={isPulled ? "true" : undefined}
      // The two outermost books open partly past the shelf frame; `data-edge`
      // pans them inward (toward center) while drawn so the cover is fully in
      // view instead of clipped at the edge. Middle books need no shift.
      data-edge={index === 0 ? "l" : index === MIN_BOOKS - 1 ? "r" : undefined}
      className={`bookshelf-book ${lean}`}
      style={styleVars}
      tabIndex={0}
      aria-label={`${card.title} by ${author}, ${ratingInfo.short}${isPulled ? " (tap again to open)" : ""}`}
    >
      <span className="float-wrap">
        <span className="book-3d">
          <span className="face back" />
          <span className="face cover">
            <span className="cover-content">
              <span className="cover-art" aria-hidden>
                {card.coverImageUrl ? (
                  <img
                    src={card.coverImageUrl}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    draggable={false}
                  />
                ) : (
                  <GlyphArt seed={card.id} />
                )}
              </span>
              <span className="cover-meta">
                <span className="cover-title font-action">{card.title}</span>
                <span className="cover-author">{author}</span>
                <span className="cover-rating" title={ratingInfo.short}>{card.rating}</span>
              </span>
              {lockedForAnon ? (
                <span
                  className="cover-lock"
                  aria-hidden
                  title="Log in or register to read"
                >
                  🔒
                </span>
              ) : null}
            </span>
          </span>
          <span className="face pages" />
          <span className="face top-edge" />
          <span className="face spine">
            <span className="spine-title font-action">{card.title}</span>
          </span>
        </span>
      </span>
      <span className="book-shadow" aria-hidden />
    </button>
  );
}

function PlaceholderBook({
  lean,
  index,
  isPulled,
  onTap,
}: BookProps & { isPulled: boolean; onTap: () => void }) {
  // Mirrors StoryBook's structure exactly, same markup, same classes,
  // same chip slot. Only the text + click handler differ. Title is
  // intentionally short ("Your Story") so it lays out like a real
  // story title (e.g. "TIGERLORD") on the cover face instead of
  // wrapping awkwardly across three lines. The bookshelf spine still
  // carries the longer "Write Your Story" string because the spine
  // axis has room to spare.
  //
  // The placeholder palette is a dark NEUTRAL gray, low saturation
  // + low lightness, so empty slots clearly recede behind the
  // colored real story spines on both light and dark themes. The
  // earlier ochre/tan picked up on the antique scroll motif but
  // looked too warm against the dark BG.
  const styleVars = {
    ...bookColorVars(PLACEHOLDER_PALETTE),
    "--drift-dur": `${6 + (index % 3)}s`,
    "--drift-delay": `-${(index * 0.4).toFixed(1)}s`,
    animationDelay: `${200 + index * 90}ms`,
  } as React.CSSProperties;
  return (
    <button
      type="button"
      onClick={onTap}
      // Placeholders follow the same touch-state pull-out as
      // StoryBook so mobile users get a consistent two-tap rhythm
      // across the whole shelf: first tap pulls the book forward,
      // second tap on the same book navigates (to /register here).
      // On desktop the hover-capable check short-circuits straight
      // to navigation, same as StoryBook.
      data-pulled={isPulled ? "true" : undefined}
      data-edge={index === 0 ? "l" : index === MIN_BOOKS - 1 ? "r" : undefined}
      className={`bookshelf-book ${lean}`}
      style={styleVars}
      tabIndex={0}
      aria-label={`Write your story, sign in or register${isPulled ? " (tap again to register)" : ""}`}
    >
      <span className="float-wrap">
        <span className="book-3d">
          <span className="face back" />
          <span className="face cover">
            <span className="cover-content">
              <span className="cover-art" aria-hidden>
                <GlyphArt seed={`placeholder-${index}`} />
              </span>
              <span className="cover-meta">
                <span className="cover-title font-action">Your Story</span>
                <span className="cover-author">register</span>
                <span className="cover-rating" title="Register or sign in to write">NEW</span>
              </span>
            </span>
          </span>
          <span className="face pages" />
          <span className="face top-edge" />
          <span className="face spine">
            <span className="spine-title font-action">Write Your Story</span>
          </span>
        </span>
      </span>
      <span className="book-shadow" aria-hidden />
    </button>
  );
}

function GlyphArt({ seed }: { seed: string }) {
  const g = pickGlyph(seed);
  return (
    <svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">
      {g.paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
      {g.fills?.map((d, i) => (
        <path key={`f-${i}`} d={d} className="fill" />
      ))}
    </svg>
  );
}

function Bookend({ side }: { side: "left" | "right" }) {
  // Spire-silhouette bookend, mirrors the BG art. The body is
  // dark stone (panel-500 + warm shadow) and the peak/cross at
  // the top glows with the theme accent via an SVG Gaussian blur
  // halo, so the bookend reads as "spire on the horizon at dusk"
  // rather than a solid bright brand-color column.
  const stoneId = `bookend-stone-${side}`;
  const glowId = `bookend-glow-${side}`;
  return (
    <span className={`bookshelf-bookend bookshelf-bookend-${side}`} aria-hidden>
      <svg viewBox="0 0 48 380" preserveAspectRatio="xMidYMax meet" xmlns="http://www.w3.org/2000/svg">
        <defs>
          {/* Stone gradient, slight cylinder shading so the spire
           *  isn't a flat silhouette. CSS vars on the parent feed
           *  the stop colors so the bookend retones with the theme. */}
          <linearGradient id={stoneId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%"   style={{ stopColor: "var(--bookend-stone-deep)" }} />
            <stop offset="35%"  style={{ stopColor: "var(--bookend-stone-mid)" }} />
            <stop offset="55%"  style={{ stopColor: "var(--bookend-stone-light)" }} />
            <stop offset="85%"  style={{ stopColor: "var(--bookend-stone-mid)" }} />
            <stop offset="100%" style={{ stopColor: "var(--bookend-stone-deep)" }} />
          </linearGradient>
          {/* Peak glow, Gaussian blur of the source rendered
           *  underneath the source itself, producing an accent
           *  halo around the cross + spire tip only. */}
          <filter id={glowId} x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="2.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Foot / plinth (dark stone) */}
        <path d="M 2 380 L 2 372 L 6 364 L 42 364 L 46 372 L 46 380 Z" fill={`url(#${stoneId})`} />
        <rect x="6" y="358" width="36" height="6" fill={`url(#${stoneId})`} />
        <rect x="10" y="354" width="28" height="4" fill={`url(#${stoneId})`} />

        {/* Main shaft (dark stone with central recess) */}
        <path d="M 14 354 L 14 60 L 16 50 L 32 50 L 34 60 L 34 354 Z" fill={`url(#${stoneId})`} />
        <rect x="22" y="80" width="4" height="260" fill="rgba(0,0,0,0.55)" />

        {/* Trefoil cutouts, punched holes in the stone */}
        {[110, 200, 290].map((y) => (
          <g key={y} transform={`translate(24 ${y})`} fill="rgba(0,0,0,0.7)">
            <circle cx="0"  cy="-4" r="3" />
            <circle cx="-3" cy="2"  r="3" />
            <circle cx="3"  cy="2"  r="3" />
          </g>
        ))}

        {/* Quatrefoil near the top, punched hole */}
        <g transform="translate(24 70)" fill="rgba(0,0,0,0.7)">
          <circle cx="0"  cy="-5" r="3.2" />
          <circle cx="0"  cy="5"  r="3.2" />
          <circle cx="-5" cy="0"  r="3.2" />
          <circle cx="5"  cy="0"  r="3.2" />
          <rect x="-2" y="-2" width="4" height="4" />
        </g>

        {/* Pointed arch finial cap (dark stone) */}
        <path d="M 16 50 L 16 38 Q 16 30 24 22 Q 32 30 32 38 L 32 50 Z" fill={`url(#${stoneId})`} />

        {/* GLOWING PEAK, the only accent-colored elements. The
            spire blade, the orb directly below the cross, and the
            cross itself all sit inside the glow filter so they
            radiate the accent like the spire's tip in the BG art. */}
        <g filter={`url(#${glowId})`}>
          <path d="M 24 22 L 22 12 L 24 4 L 26 12 Z" fill="currentColor" />
          <circle cx="24" cy="13" r="2" fill="currentColor" />
          <rect x="23" y="0" width="2" height="6" fill="currentColor" />
          <rect x="21" y="2" width="6" height="1.5" fill="currentColor" />
        </g>

        {/* Subtle accent ribbon down the shaft, a thin line of
            accent so the bookend still ties to the theme without
            shouting. Much fainter than before. */}
        <rect x="23.5" y="60" width="1" height="294" fill="currentColor" opacity="0.22" />

        {/* Decorative crossbars, dark stone, faint accent rim */}
        {[148, 238, 328].map((y) => (
          <rect
            key={y}
            x="10"
            y={y}
            width="28"
            height="4"
            fill={`url(#${stoneId})`}
            stroke="currentColor"
            strokeOpacity="0.18"
            strokeWidth="0.5"
          />
        ))}
      </svg>
    </span>
  );
}
