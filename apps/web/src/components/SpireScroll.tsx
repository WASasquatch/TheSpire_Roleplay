import { useEffect, useRef, useState } from "react";

/**
 * Splash-page "What Awaits You" scroll, an animated parchment
 * unfurled between two brass-capped wooden rods. The rods slide
 * apart, the parchment expands between them, then a quill flies
 * down the list typing out each feature in turn.
 *
 * Plays automatically on mount. A small "Replay" button beneath
 * lets a curious visitor watch the sequence again without a page
 * reload. The list itself is plain text after the animation
 * finishes, readable, copyable, and screen-reader friendly.
 *
 * Visual palette is intentionally fixed (antique parchment, deep
 * wood, brass) rather than themed, the scroll reads as a single
 * piece of medieval ephemera regardless of which theme the
 * visitor's system prefers (dark or light, modern or fantasy).
 */

/** Site features surfaced to a first-time visitor. Each title's
 *  first letter becomes a small drop cap that floats left, with
 *  the rest of the title and the description flowing around it
 *  as one paragraph (and wrapping cleanly below after the cap's
 *  height clears), classic illuminated-manuscript layout.
 *  Order: identity → setting → talk-channels → write →
 *  presence → economy. */
const FEATURES: ReadonlyArray<{ title: string; desc: string }> = [
  { title: "Characters",    desc: "Personas with bios, portraits, stats, and inventory." },
  { title: "Worlds",        desc: "Canonical settings with wikis and lore pages." },
  { title: "Public Rooms",  desc: "Open chambers for drop-in scenes, anyone can wander in." },
  { title: "Private Rooms", desc: "Invite-only chambers for tight RP circles, no random walk-ins." },
  { title: "Forums",        desc: "Long-form threads that persist between sessions." },
  { title: "Messages",      desc: "Per-character DMs keep IC and OOC strictly separate." },
  { title: "Scriptorium",   desc: "Stories and fanfiction with chapters, reviews, and a rich editor." },
  { title: "Profiles",      desc: "Mini-webpages with custom CSS, backgrounds, galleries, and links." },
  { title: "Items & Earn",  desc: "Shop, gift, and earn XP, ranks, and currency for active writers." },
  { title: "Commands",      desc: "Slash commands for /me, /whisper, emotes, dice rolls, and more." },
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function SpireScroll() {
  const [open, setOpen] = useState(false);
  const [contentOn, setContentOn] = useState(false);
  const [shownIdx, setShownIdx] = useState(-1);
  const [titles, setTitles] = useState<string[]>(() => Array(FEATURES.length).fill(""));
  const [typed, setTyped] = useState<string[]>(() => Array(FEATURES.length).fill(""));
  const [quill, setQuill] = useState<{ left: number; top: number; visible: boolean }>({ left: 0, top: 0, visible: false });
  const cancelRef = useRef(false);
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);
  const stageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    cancelRef.current = false;

    async function run() {
      // Reset to closed state so a replay always starts from zero.
      setOpen(false);
      setContentOn(false);
      setShownIdx(-1);
      setTitles(Array(FEATURES.length).fill(""));
      setTyped(Array(FEATURES.length).fill(""));
      setQuill({ left: 0, top: 0, visible: false });

      await sleep(80);
      if (cancelRef.current) return;
      setOpen(true);

      // Paper transition is 0.7s now (was 1s). Wait that long plus a
      // small settle so the content fade-in lands AFTER the rods
      // finish snapping into place.
      await sleep(720);
      if (cancelRef.current) return;
      setContentOn(true);

      // Short pause for the content fade-in to register before the
      // quill drops in. Sped up because the typing itself is now
      // the main beat, a long pre-typing hold dragged the splash.
      await sleep(220);
      if (cancelRef.current) return;

      for (let i = 0; i < FEATURES.length; i++) {
        if (cancelRef.current) return;
        setShownIdx(i);
        setTitles((prev) => {
          const next = prev.slice();
          next[i] = FEATURES[i]!.title;
          return next;
        });
        // Defer a frame so the item actually mounts before we read
        // its bounding box for the quill positioning.
        await sleep(16);
        moveQuillToCursor(i);
        await sleep(120);
        if (cancelRef.current) return;
        await typewrite(i, FEATURES[i]!.desc);
        if (cancelRef.current) return;
        await sleep(60);
      }

      setQuill((q) => ({ ...q, visible: false }));
    }

    void run();
    return () => { cancelRef.current = true; };
  }, []);

  async function typewrite(idx: number, text: string) {
    for (let j = 1; j <= text.length; j++) {
      if (cancelRef.current) return;
      setTyped((prev) => {
        const next = prev.slice();
        next[idx] = text.slice(0, j);
        return next;
      });
      // Wait one paint so the just-typed char is in the DOM, then
      // measure where its right edge lands and aim the quill nib
      // there, the quill follows the writing tip as it moves
      // across (and down) the paper.
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      moveQuillToCursor(idx);
      // Tight per-char delay with a touch of jitter, fast enough
      // to respect the "short attention span" ask but not so robotic
      // that it loses the handwritten cadence.
      await sleep(4 + Math.random() * 6);
    }
  }

  /** Position the quill so its tip (bottom-left of the SVG) lands
   *  just to the right of the last character typed into item `i`'s
   *  description. The desc span renders as TWO text nodes, the
   *  literal ", " prefix from the JSX and the typed content from
   *  `{typed[i]}`, so we can't just collapse a range at the end
   *  of `firstChild` (that lands at the boundary between them).
   *  `selectNodeContents` + `collapse(false)` collapses to the end
   *  of the LAST text node, which is always the typed cursor. */
  function moveQuillToCursor(i: number) {
    const item = itemRefs.current[i];
    const stage = stageRef.current;
    if (!item || !stage) return;
    const desc = item.querySelector(".scroll-feature-desc");
    if (!desc || !desc.lastChild) return;
    const range = document.createRange();
    range.selectNodeContents(desc);
    range.collapse(false); // → end of the typed text
    // A collapsed range at end-of-text usually returns a zero-width
    // rect that still has a valid top/right; some browsers prefer
    // measuring the last character itself, so as a fallback we walk
    // back one char and read THAT rect's right edge.
    let rect = range.getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) {
      const lastText = desc.lastChild;
      if (lastText && lastText.nodeType === Node.TEXT_NODE) {
        const len = lastText.textContent?.length ?? 0;
        if (len > 0) {
          try {
            range.setStart(lastText, len - 1);
            range.setEnd(lastText, len);
            rect = range.getBoundingClientRect();
          } catch {
            return;
          }
        }
      }
    }
    if (rect.height === 0 && rect.width === 0 && rect.top === 0) return;
    const stageRect = stage.getBoundingClientRect();
    // Quill nib offset, tuned empirically to land the visible
    // writing point exactly at the cursor. The bottom-left of the
    // SVG (where the path renders the nib) sits further from the
    // CSS element's edge than the viewBox math alone suggested,
    // so this needs a +14 push.
    setQuill({
      left: rect.right - stageRect.left + 14,
      top: rect.bottom - stageRect.top - 58,
      visible: true,
    });
  }

  return (
    <div className="spire-scroll-wrap">
      <div
        ref={stageRef}
        className={`scroll-stage${open ? " open" : ""}${contentOn ? " content-on" : ""}`}
      >
        <div className="scroll-rod scroll-rod-left" aria-hidden>
          <RodSvg id="L" />
        </div>
        <div className="scroll-rod scroll-rod-right" aria-hidden>
          <RodSvg id="R" />
        </div>
        <div className="scroll-paper">
          <div className="scroll-content">
            <header className="scroll-heading-wrap">
              <div className="scroll-heading-flourish" aria-hidden>
                <span className="ln" />
                <span className="dia" />
                <span className="ln" />
              </div>
              <p className="scroll-heading">What Awaits You</p>
            </header>
            <ul className="scroll-feature-list">
              {FEATURES.map((f, i) => {
                const cap = f.title.charAt(0);
                const titleRest = f.title.slice(1);
                const titleShown = i <= shownIdx;
                return (
                  <li
                    key={f.title}
                    ref={(el) => { itemRefs.current[i] = el; }}
                    className={`scroll-feature-item${titleShown ? " shown" : ""}`}
                  >
                    <p className="scroll-feature-body">
                      <span className="scroll-feature-cap" aria-hidden>{cap}</span>
                      <span className="scroll-feature-title">{titleShown ? titleRest : ""}</span>
                      {typed[i] ? (
                        <span className="scroll-feature-desc">, {typed[i]}</span>
                      ) : null}
                    </p>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
        <div
          className={`scroll-quill${quill.visible ? " flying" : ""}`}
          style={{ left: quill.left, top: quill.top }}
          aria-hidden
        >
          <QuillSvg />
        </div>
      </div>
    </div>
  );
}

/* ============================================================ *
 *  Rod SVG, wood shaft, brass collars, pommel knobs. Inlined as
 *  JSX so the gradient IDs are scoped to the React component
 *  rather than competing globally with another scroll. `id` prop
 *  postfixes the linearGradient IDs ("wood-L" / "wood-R") so two
 *  rods can coexist in the same document without colliding.
 * ============================================================ */
function RodSvg({ id }: { id: string }) {
  // Stroke colors driven by CSS vars so the rod outline darkens on
  // light themes and lightens on dark themes without us hardcoding
  // a single rim color. Wood + brass gradient stops likewise use
  // CSS vars so the rod follows the active theme (light wood/light
  // brass on light themes, dark wood/dark brass on dark themes).
  const woodFill = `url(#scroll-wood-${id})`;
  const brassFill = `url(#scroll-brass-${id})`;
  const brassVFill = `url(#scroll-brassV-${id})`;
  const rim = "var(--scroll-rim)";
  const woodRim = "var(--scroll-wood-rim)";
  const seamLight = "var(--scroll-brass-hi)";
  const seamDark = "var(--scroll-brass-deep)";
  const woodVein = "var(--scroll-wood-vein)";

  return (
    <svg viewBox="0 0 48 450" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id={`scroll-wood-${id}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"   style={{ stopColor: "var(--scroll-wood-deep)" }} />
          <stop offset="20%"  style={{ stopColor: "var(--scroll-wood-mid)" }} />
          <stop offset="50%"  style={{ stopColor: "var(--scroll-wood-hi)" }} />
          <stop offset="80%"  style={{ stopColor: "var(--scroll-wood-mid)" }} />
          <stop offset="100%" style={{ stopColor: "var(--scroll-wood-deep)" }} />
        </linearGradient>
        <linearGradient id={`scroll-brass-${id}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"   style={{ stopColor: "var(--scroll-brass-deep)" }} />
          <stop offset="20%"  style={{ stopColor: "var(--scroll-brass-mid)" }} />
          <stop offset="45%"  style={{ stopColor: "var(--scroll-brass-light)" }} />
          <stop offset="55%"  style={{ stopColor: "var(--scroll-brass-hi)" }} />
          <stop offset="75%"  style={{ stopColor: "var(--scroll-brass)" }} />
          <stop offset="100%" style={{ stopColor: "var(--scroll-brass-deep)" }} />
        </linearGradient>
        <linearGradient id={`scroll-brassV-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   style={{ stopColor: "var(--scroll-brass-deep)" }} />
          <stop offset="50%"  style={{ stopColor: "var(--scroll-brass)" }} />
          <stop offset="100%" style={{ stopColor: "var(--scroll-brass-deep)" }} />
        </linearGradient>
      </defs>

      {/* TOP DECORATIVE END (0..45), shorter than the MVP's 80px
       *  so the rod ends don't create dead vertical space above /
       *  below the parchment. */}
      <ellipse cx="24" cy="4" rx="10" ry="3" fill={brassFill} stroke={rim} strokeWidth="0.5" />
      <ellipse cx="24" cy="10" rx="14" ry="4" fill={brassFill} stroke={rim} strokeWidth="0.5" />
      <rect x="10" y="14" width="28" height="2" fill={brassVFill} stroke={rim} strokeWidth="0.3" />
      <rect x="6" y="16" width="36" height="10" fill={brassFill} stroke={rim} strokeWidth="0.5" />
      <rect x="6" y="16" width="36" height="1.5" fill={seamLight} opacity="0.55" />
      <rect x="6" y="24.5" width="36" height="1.5" fill={seamDark} opacity="0.55" />
      <line x1="6" y1="19" x2="42" y2="19" stroke={rim} strokeWidth="0.5" opacity="0.7" />
      <line x1="6" y1="22" x2="42" y2="22" stroke={rim} strokeWidth="0.5" opacity="0.7" />
      <rect x="10" y="26" width="28" height="11" fill={woodFill} stroke={woodRim} strokeWidth="0.4" />
      <path d="M 12 30 Q 24 32 36 30" stroke={woodVein} strokeWidth="0.3" fill="none" opacity="0.5" />
      <path d="M 12 34 Q 24 36 36 34" stroke={woodVein} strokeWidth="0.3" fill="none" opacity="0.5" />
      <rect x="8" y="37" width="32" height="6" fill={brassFill} stroke={rim} strokeWidth="0.4" />
      <line x1="8" y1="39" x2="40" y2="39" stroke={seamDark} strokeWidth="0.3" opacity="0.6" />
      <line x1="8" y1="41" x2="40" y2="41" stroke={seamDark} strokeWidth="0.3" opacity="0.6" />
      <rect x="14" y="43" width="20" height="2" fill={woodFill} stroke={woodRim} strokeWidth="0.3" />

      {/* MAIN SHAFT (45..405, h=360) */}
      <rect x="14" y="45" width="20" height="360" fill={woodFill} stroke={woodRim} strokeWidth="0.3" />
      <path d="M 16 80 Q 24 83 32 80" stroke={woodVein} strokeWidth="0.3" fill="none" opacity="0.5" />
      <path d="M 16 150 Q 24 153 32 150" stroke={woodVein} strokeWidth="0.3" fill="none" opacity="0.5" />
      <path d="M 16 220 Q 24 223 32 220" stroke={woodVein} strokeWidth="0.3" fill="none" opacity="0.5" />
      <path d="M 16 290 Q 24 293 32 290" stroke={woodVein} strokeWidth="0.3" fill="none" opacity="0.5" />
      <path d="M 16 360 Q 24 363 32 360" stroke={woodVein} strokeWidth="0.3" fill="none" opacity="0.5" />

      {/* BOTTOM DECORATIVE END (405..450, mirror of top) */}
      <rect x="14" y="405" width="20" height="2" fill={woodFill} stroke={woodRim} strokeWidth="0.3" />
      <rect x="8" y="407" width="32" height="6" fill={brassFill} stroke={rim} strokeWidth="0.4" />
      <line x1="8" y1="409" x2="40" y2="409" stroke={seamDark} strokeWidth="0.3" opacity="0.6" />
      <line x1="8" y1="411" x2="40" y2="411" stroke={seamDark} strokeWidth="0.3" opacity="0.6" />
      <rect x="10" y="413" width="28" height="11" fill={woodFill} stroke={woodRim} strokeWidth="0.4" />
      <path d="M 12 416 Q 24 418 36 416" stroke={woodVein} strokeWidth="0.3" fill="none" opacity="0.5" />
      <path d="M 12 420 Q 24 422 36 420" stroke={woodVein} strokeWidth="0.3" fill="none" opacity="0.5" />
      <rect x="6" y="424" width="36" height="10" fill={brassFill} stroke={rim} strokeWidth="0.5" />
      <rect x="6" y="424" width="36" height="1.5" fill={seamLight} opacity="0.55" />
      <rect x="6" y="432.5" width="36" height="1.5" fill={seamDark} opacity="0.55" />
      <line x1="6" y1="427" x2="42" y2="427" stroke={rim} strokeWidth="0.5" opacity="0.7" />
      <line x1="6" y1="430" x2="42" y2="430" stroke={rim} strokeWidth="0.5" opacity="0.7" />
      <rect x="10" y="434" width="28" height="2" fill={brassVFill} stroke={rim} strokeWidth="0.3" />
      <ellipse cx="24" cy="440" rx="14" ry="4" fill={brassFill} stroke={rim} strokeWidth="0.5" />
      <ellipse cx="24" cy="446" rx="10" ry="3" fill={brassFill} stroke={rim} strokeWidth="0.5" />
    </svg>
  );
}

function QuillSvg() {
  // All quill colors come from the scroll's brass CSS vars (which
  // are already theme-blended from the active accent + panel) and
  // a single dark "ink" tone built from the theme's panel ramp.
  // So a pink-accent theme yields a dusky pink quill, a gold-accent
  // theme yields a true gold one, etc.
  return (
    <svg viewBox="0 0 60 75" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="scroll-quill-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"   style={{ stopColor: "var(--scroll-brass-hi)" }} />
          <stop offset="50%"  style={{ stopColor: "var(--scroll-brass)" }} />
          <stop offset="100%" style={{ stopColor: "var(--scroll-brass-deep)" }} />
        </linearGradient>
      </defs>
      <path
        d="M 14 70 Q 22 52 30 38 Q 38 20 46 6 Q 42 18 38 28 Q 34 40 30 48 Q 24 60 18 68 Q 16 70 14 70 Z"
        fill="url(#scroll-quill-grad)"
        stroke="var(--scroll-brass-deep)"
        strokeWidth="0.5"
        opacity="0.95"
      />
      <path d="M 22 58 L 38 22" stroke="var(--scroll-brass-deep)" strokeWidth="0.4" opacity="0.5" fill="none" />
      <path d="M 24 62 L 40 24" stroke="var(--scroll-brass-deep)" strokeWidth="0.3" opacity="0.4" fill="none" />
      <path d="M 14 70 L 10 73 L 12 75 L 16 72 Z" fill="var(--scroll-wood-deep)" />
      <circle cx="11" cy="74" r="1.2" fill="rgb(var(--keep-panel-500))" />
    </svg>
  );
}
