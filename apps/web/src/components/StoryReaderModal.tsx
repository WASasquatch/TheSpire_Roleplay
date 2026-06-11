import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type {
  PrivateStoryStub,
  StoryApplauseState,
  StoryChapter,
  StoryChapterRef,
  StoryDetail,
  StoryGenre,
  StoryStatus,
  StorySubscriptionState,
} from "@thekeep/shared";
import { readError } from "../lib/http.js";
import { themeStyle } from "../lib/theme.js";
import { useChat } from "../state/store.js";
import { fetchStoryCopyState, buyStoryCopy, setStoryShowcase, type StoryCopyState } from "../lib/storyCopies.js";
import { Modal, MODAL_CARD_CONTENT } from "./Modal.js";
import { CloseButton } from "./CloseButton.js";
import { StoryReviewsPanel } from "./StoryReviewsPanel.js";
import { ScriptoriumReportButton } from "./ScriptoriumReportButton.js";
import { StoryCodexAppendix } from "./StoryCodexAppendix.js";
import { decorateMentionsIn, makeChipClickHandler } from "../lib/storyMentions.js";

interface Props {
  /** Story id (UUID) or slug. Both work via the /stories/:idOrSlug route. */
  storyId: string;
  /** Optional initial chapter index (0-based). Used by /story <slug> chapter <N>. */
  initialChapterIndex?: number;
  onClose: () => void;
  /** Author shortcut: open the editor from inside the reader. */
  onEdit?: () => void;
  /** When provided, the header shows a "← Back" affordance that calls
   *  this instead of just closing, used when the reader is stacked on
   *  top of the catalog so the user can return to browsing without
   *  collapsing the whole stack. */
  onBack?: () => void;
}

type ReadMode = "book" | "pageless";
type FontFamily = "serif" | "sans" | "dyslexic";
type ReaderScheme = "auto" | "light" | "sepia" | "dark";

const FONT_FAMILIES: Record<FontFamily, string> = {
  serif: '"Iowan Old Style", "Apple Garamond", Baskerville, Georgia, serif',
  sans: 'ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif',
  dyslexic: '"OpenDyslexic", "Atkinson Hyperlegible", "Comic Sans MS", sans-serif',
};

const FONT_SIZE_STEPS = [14, 16, 17, 18, 20, 22];
const LINE_HEIGHT_STEPS = [1.45, 1.55, 1.7, 1.85, 2];
const MAX_WIDTH_STEPS = [560, 640, 720, 820, 960];

/** First ancestor (inclusive) whose computed background-color is actually
 *  opaque enough to be what the eye sees behind `start`. Returns its [r,g,b],
 *  or null if none is found. Used by the reader's auto scheme to tone its text
 *  against the SURFACE the prose sits on (a `.keep-panel`), not the theme's
 *  `--keep-bg` variable — those can differ (light bg + dark panel), which would
 *  otherwise force same-on-same, unreadable text. */
function effectiveBgRgb(start: Element | null): [number, number, number] | null {
  let el: Element | null = start;
  while (el) {
    const m = getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/i);
    if (m) {
      const p = m[1]!.split(",").map((s) => Number.parseFloat(s.trim()));
      const a = p.length >= 4 ? p[3]! : 1;
      if (a > 0.5 && p.length >= 3 && p.slice(0, 3).every((n) => Number.isFinite(n))) {
        return [p[0]!, p[1]!, p[2]!];
      }
    }
    el = el.parentElement;
  }
  return null;
}

/** Fallback: the theme's `--keep-bg` triple ("R G B") read off an element. */
function keepBgVarRgb(el: Element): [number, number, number] | null {
  const raw = getComputedStyle(el).getPropertyValue("--keep-bg").trim();
  if (!raw) return null;
  const p = raw.split(/\s+/).map((s) => Number.parseFloat(s));
  if (p.length < 3 || p.some((n) => !Number.isFinite(n))) return null;
  return [p[0]!, p[1]!, p[2]!];
}

/**
 * Reader modal with two display modes, `book` (paginated, one chapter
 * at a time) and `pageless` (single-scroll with a floating chapter TOC).
 *
 * Reading position rides on `<p data-anchor="p-N">` markers the server
 * injects into the body HTML. As the reader scrolls, the topmost
 * paragraph that's crossed the top half of the viewport becomes the
 * current anchor; we debounce-write that to /stories/:id/reading-position
 * every 2s of inactivity.
 */
export function StoryReaderModal({ storyId, initialChapterIndex, onClose, onEdit, onBack }: Props) {
  const [detail, setDetail] = useState<StoryDetail | null>(null);
  const [stub, setStub] = useState<PrivateStoryStub | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useReaderPref<ReadMode>("scriptorium.readMode", "book");
  const [fontFamily, setFontFamily] = useReaderPref<FontFamily>("scriptorium.font", "serif");
  const [fontStep, setFontStep] = useReaderPref<number>("scriptorium.fontStep", 2);
  const [lineStep, setLineStep] = useReaderPref<number>("scriptorium.lineStep", 2);
  const [widthStep, setWidthStep] = useReaderPref<number>("scriptorium.widthStep", 2);
  const [scheme, setScheme] = useReaderPref<ReaderScheme>("scriptorium.scheme", "auto");

  const [typoOpen, setTypoOpen] = useState(false);
  // Mobile-only "Contents" drawer. The whole sidebar (info, Buy a Copy,
  // chapters, codex) is `hidden md:flex` on desktop, so on phones it has
  // no home; this slides the same panel in full-screen over the reader.
  const [navOpen, setNavOpen] = useState(false);
  const [chapterIdx, setChapterIdx] = useState<number>(initialChapterIndex ?? 0);
  const [chapterBodies, setChapterBodies] = useState<Record<string, StoryChapter>>({});
  // Bumped after a Buy-to-Read purchase to re-fetch the (now unlocked) detail.
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setStub(null);
    setDetail(null);
    fetch(`/stories/${storyId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        const j = await r.json();
        if (j && typeof j === "object" && (j as PrivateStoryStub).private === true) {
          if (cancelled) return;
          setStub(j as PrivateStoryStub);
          return;
        }
        if (cancelled) return;
        const d = j as StoryDetail;
        setDetail(d);
        if (initialChapterIndex == null && d.readingPosition?.lastChapterId) {
          const i = d.chapters.findIndex((c) => c.id === d.readingPosition!.lastChapterId);
          if (i >= 0) setChapterIdx(i);
        }
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "load failed"); });
    return () => { cancelled = true; };
  }, [storyId, initialChapterIndex, refreshKey]);

  const chapters = detail?.chapters ?? [];
  const currentChapter = chapters[chapterIdx] ?? null;
  // Buy-to-Read: this viewer must purchase to read past the first-chapter
  // sample. The server enforces it (the body endpoint only ships a sample);
  // here it swaps the reading pane for the locked view.
  const locked = !!detail?.locked;

  // Unlock after a purchase: drop the cached sample so chapter 1 re-fetches
  // in full, then re-pull the detail (now `locked: false`).
  const handleUnlocked = useCallback(() => {
    setChapterBodies({});
    setChapterIdx(0);
    setRefreshKey((k) => k + 1);
  }, []);

  // Fetch chapter bodies: when locked, only the first chapter (its sample);
  // otherwise current chapter in book mode, all chapters in pageless.
  useEffect(() => {
    if (!detail) return;
    const targets = locked
      ? (chapters[0] ? [chapters[0]] : [])
      : mode === "book" && currentChapter ? [currentChapter] : detail.chapters;
    targets.forEach((c) => {
      if (chapterBodies[c.id]) return;
      void fetch(`/stories/${detail.story.id}/chapters/${c.id}`)
        .then(async (r) => {
          if (!r.ok) throw new Error(await readError(r));
          return (await r.json()) as StoryChapter;
        })
        .then((full) => setChapterBodies((prev) => ({ ...prev, [c.id]: full })))
        .catch(() => { /* swallow */ });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, currentChapter?.id, detail?.story.id, locked]);

  // Reading-position sync. Scroll handler is on the article (the actual
  // scroll container), scroll events don't bubble, so a parent listener
  // wouldn't fire.
  const articleRef = useRef<HTMLElement | null>(null);
  const lastSent = useRef<{ chapterId: string | null; anchor: string | null; percent: number }>({
    chapterId: null, anchor: null, percent: 0,
  });
  const sendTimer = useRef<number | null>(null);

  const sendPosition = useCallback(() => {
    if (!detail) return;
    const root = articleRef.current;
    if (!root) return;
    const anchors = Array.from(root.querySelectorAll<HTMLElement>("[data-anchor]"));
    if (anchors.length === 0) return;
    const viewportMid = window.innerHeight / 2;
    let bestId: string | null = null;
    let chapterId: string | null = currentChapter?.id ?? null;
    for (const el of anchors) {
      const r = el.getBoundingClientRect();
      if (r.top > viewportMid) break;
      bestId = el.dataset.anchor ?? null;
      const owningChapter = el.closest<HTMLElement>("[data-chapter-id]");
      if (owningChapter) chapterId = owningChapter.dataset.chapterId ?? chapterId;
    }
    const owning = chapterId ? root.querySelector<HTMLElement>(`[data-chapter-id="${chapterId}"]`) : root;
    let percent = 0;
    if (owning) {
      const top = owning.getBoundingClientRect().top;
      const totalH = owning.scrollHeight || owning.clientHeight || 1;
      const scrolled = Math.max(0, Math.min(totalH, -top + window.innerHeight / 2));
      percent = Math.min(100, Math.max(0, (scrolled / totalH) * 100));
    }
    if (
      bestId === lastSent.current.anchor &&
      chapterId === lastSent.current.chapterId &&
      Math.abs(percent - lastSent.current.percent) < 1
    ) {
      return;
    }
    lastSent.current = { chapterId, anchor: bestId, percent };
    void fetch(`/stories/${detail.story.id}/reading-position`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lastChapterId: chapterId, lastAnchorId: bestId, percentThrough: percent }),
    }).catch(() => { /* best-effort */ });
  }, [detail, currentChapter?.id]);

  function scheduleSend() {
    if (sendTimer.current) window.clearTimeout(sendTimer.current);
    sendTimer.current = window.setTimeout(() => { sendPosition(); }, 2000);
  }

  // Clear pending timer on unmount so a closed-modal scroll doesn't fire a stale send.
  useEffect(() => {
    return () => {
      if (sendTimer.current) window.clearTimeout(sendTimer.current);
    };
  }, []);

  // Restore saved anchor once on first body mount.
  const restoredAnchorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!detail) return;
    const target = detail.readingPosition?.lastAnchorId;
    if (!target) return;
    if (restoredAnchorRef.current === target) return;
    const t = window.setTimeout(() => {
      const root = articleRef.current;
      if (!root) return;
      const el = root.querySelector<HTMLElement>(`[data-anchor="${target}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "auto", block: "center" });
        restoredAnchorRef.current = target;
      }
    }, 40);
    return () => window.clearTimeout(t);
  }, [detail, chapterIdx, chapterBodies]);

  const readerTheme = detail?.story.theme ?? null;
  const themeOverride = readerTheme ? themeStyle(readerTheme) : undefined;

  const typographyStyle: React.CSSProperties = {
    fontFamily: FONT_FAMILIES[fontFamily],
    fontSize: `${FONT_SIZE_STEPS[fontStep]}px`,
    lineHeight: LINE_HEIGHT_STEPS[lineStep],
    maxWidth: `${MAX_WIDTH_STEPS[widthStep]}px`,
  };

  const schemeBgClass =
    scheme === "light"  ? "bg-white text-stone-900" :
    scheme === "sepia"  ? "bg-[#f6efe2] text-stone-900" :
    scheme === "dark"   ? "bg-stone-900 text-stone-100" :
    "bg-keep-bg text-keep-text";

  // Auto-scheme bg-luminance probe. The legibility-nudged
  // `--keep-text` already targets WCAG 4.5:1 against `--keep-bg`,
  // but in practice some theme designs ship a text color that's only
  // *technically* contrast-passing and reads as washed-out, most
  // notably the scifi palette's dimmed accent-on-deep-navy. We solve
  // that by sampling the effective bg color from the reader-shell
  // element after mount and stamping a coarse `dark | light` tone
  // marker on it. CSS uses that marker to force a high-contrast text
  // override (near-white on dark, near-black on light) for the
  // prose / headings / muted notes inside the reader, overriding
  // whatever dim value the theme calibrated. Only applies under the
  // auto scheme; the manual light / sepia / dark schemes already pin
  // their own bg + text and don't need the probe.
  const readerShellRef = useRef<HTMLDivElement | null>(null);
  const [readerBgTone, setReaderBgTone] = useState<"dark" | "light">("dark");
  useLayoutEffect(() => {
    if (scheme !== "auto") return;
    const el = readerShellRef.current;
    if (!el) return;
    // Sample the ACTUAL painted background behind the prose — the reading
    // column sits on a `.keep-panel`, whose tone can differ from the theme's
    // `--keep-bg` (e.g. a light bg + dark panel, or a dim author theme). Tone
    // the text against what's really there; fall back to the `--keep-bg`
    // variable, then bail (a wrong tone is worse than the default).
    const surface = el.querySelector(".reader-main .keep-panel") ?? el;
    const rgb = effectiveBgRgb(surface) ?? keepBgVarRgb(el);
    if (!rgb) return;
    const [r, g, b] = rgb;
    const toLin = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    const luminance = 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
    setReaderBgTone(luminance < 0.45 ? "dark" : "light");
  }, [scheme, readerTheme, themeOverride, detail]);

  // Shared chapter jump, used by both the desktop sidebar and the mobile
  // drawer. In pageless mode we also scroll the article to the chapter
  // anchor. `closeNav` lets the mobile drawer dismiss itself after a tap
  // so the reader lands on the chosen chapter (desktop passes false).
  const jumpToChapter = useCallback((id: string, closeNav: boolean) => {
    const i = chapters.findIndex((c) => c.id === id);
    if (i < 0) return;
    setChapterIdx(i);
    if (closeNav) setNavOpen(false);
    if (mode === "pageless") {
      window.setTimeout(() => {
        articleRef.current
          ?.querySelector<HTMLElement>(`[data-chapter-id="${id}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 0);
    }
  }, [chapters, mode]);

  // Esc closes the drawer first (before the modal's own Esc-to-close).
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); setNavOpen(false); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [navOpen]);

  return (
    <Modal onClose={onClose} zIndex={50} variant="mobile-fullscreen">
      <div
        style={themeOverride}
        className={`${MODAL_CARD_CONTENT} keep-frame relative rounded bg-keep-bg text-keep-text`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-keep-rule bg-keep-banner px-3 py-2">
          {/* Mobile-only "Contents" trigger. Opens the drawer that holds
              the sidebar (info, Buy a Copy, chapters, codex) — all of
              which are desktop-only otherwise. Hidden once the drawer is
              open (the drawer has its own close control). */}
          {detail ? (
            <button
              type="button"
              onClick={() => setNavOpen(true)}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-base leading-none text-keep-muted hover:text-keep-text md:hidden"
              title="Contents: chapters, codex, buy a copy"
              aria-label="Open contents menu"
            >
              ☰
            </button>
          ) : null}
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-[11px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
              title="Back to Scriptorium"
            >
              <span className="md:hidden" aria-hidden>←</span>
              <span className="hidden md:inline">← Back</span>
            </button>
          ) : null}
          <h2 className="min-w-0 flex-1 truncate font-action text-lg">
            {detail ? detail.story.title : stub ? stub.title : "Loading..."}
          </h2>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => setMode("book")}
              className={`rounded border px-2 py-0.5 text-[11px] uppercase tracking-widest ${
                mode === "book" ? "border-keep-action text-keep-action" : "border-keep-rule text-keep-muted"
              }`}>Book</button>
            <button type="button" onClick={() => setMode("pageless")}
              className={`rounded border px-2 py-0.5 text-[11px] uppercase tracking-widest ${
                mode === "pageless" ? "border-keep-action text-keep-action" : "border-keep-rule text-keep-muted"
              }`}>Pageless</button>
            <button type="button" onClick={() => setTypoOpen((v) => !v)}
              className="rounded border border-keep-rule px-2 py-0.5 text-[11px] uppercase tracking-widest text-keep-muted">
              Aa
            </button>
            {onEdit && detail?.viewerCanEdit ? (
              <button type="button" onClick={onEdit}
                className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-[11px] uppercase tracking-widest text-keep-muted">
                Edit
              </button>
            ) : null}
          </div>
          <CloseButton onClick={onClose} />
        </header>

        {typoOpen ? (
          <div className="border-b border-keep-rule bg-keep-panel/30 px-3 py-2 text-xs">
            <TypoControls
              fontFamily={fontFamily} setFontFamily={setFontFamily}
              fontStep={fontStep} setFontStep={setFontStep}
              lineStep={lineStep} setLineStep={setLineStep}
              widthStep={widthStep} setWidthStep={setWidthStep}
              scheme={scheme} setScheme={setScheme}
            />
          </div>
        ) : null}

        {error ? (
          <div className="mx-4 mt-3 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
        ) : null}

        {stub ? (
          <PrivateStub stub={stub} onClose={onClose} />
        ) : !detail ? (
          <p className="p-6 italic text-keep-muted">Loading...</p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Moderator paywall-bypass warning. Shown only when full access
                comes solely from the bypass permission (not owning/authoring),
                so a mod knows the book is normally purchase-to-read. */}
            {detail.paywallBypassed ? (
              <div className="shrink-0 border-b border-amber-400/40 bg-amber-400/10 px-4 py-2 text-center text-xs text-amber-200">
                ⚠️ This book is marked <b>Buy to Read</b>. You're viewing it in full via moderator access — readers must buy a copy to read past a sample.
              </div>
            ) : null}
            <div
              ref={readerShellRef}
              data-reader-scheme={scheme === "auto" ? undefined : scheme}
              // Sampled bg luminance, only meaningful under the auto
              // scheme; the manual schemes pin their own contrast.
              data-reader-bg-tone={scheme === "auto" ? readerBgTone : undefined}
              className={`reader-shell flex min-h-0 flex-1 gap-3 p-3 ${schemeBgClass}`}
            >
            {/* Sidebar (left). `keep-panel` picks up the theme
                design's chrome (medieval filigree, modern soft
                gradient + shadow, scifi cyber border + corner
                brackets, glass frosted backdrop). The outer
                container also tints the modal area beneath via the
                gap + panel chrome contrast, so the sidebar reads as
                a distinct frame instead of merging with the bg.
                Hidden below md so the reading column gets the whole
                viewport on mobile. */}
            <aside className="keep-panel reader-sidebar hidden md:flex md:w-80 md:shrink-0 md:flex-col md:overflow-y-auto">
              <ReaderSidebar
                detail={detail}
                chapters={chapters}
                currentChapterId={currentChapter?.id ?? null}
                mode={mode}
                onJumpChapter={(id) => jumpToChapter(id, false)}
              />
            </aside>

            {/* Main reading column, gets its own `keep-panel` so
                the chapter sits on a themed "page card." The gap-3
                on the parent + the two panels' independent chrome
                paint a visible seam between them in every design,
                while each design's distinct treatment (medieval
                parchment, modern gradient, scifi neon edge, glass
                frost) carries through to both panels. */}
            <div className="reader-main flex min-w-0 flex-1 flex-col">
              {locked ? (
                <LockedReadingPane
                  story={detail.story}
                  firstChapter={chapters[0] ?? null}
                  sampleBody={chapters[0] ? (chapterBodies[chapters[0].id] ?? null) : null}
                  chapterCount={chapters.length}
                  typographyStyle={typographyStyle}
                  onUnlocked={handleUnlocked}
                />
              ) : mode === "pageless" ? (
                <article
                  ref={(el) => { articleRef.current = el; }}
                  onScroll={scheduleSend}
                  className="keep-panel min-h-0 flex-1 overflow-y-auto"
                >
                  <div className="mx-auto w-full px-6 py-6" style={typographyStyle}>
                    <ReaderHeader detail={detail} />
                    {chapters.map((c) => (
                      <ChapterBlock key={c.id}
                        chapterRef={c}
                        full={chapterBodies[c.id] ?? null}
                      />
                    ))}
                    <ReaderFooter detail={detail} />
                  </div>
                </article>
              ) : (
                <BookPagedView
                  // Keyed on chapter id + typography so the paged view
                  // resets to page 0 whenever the chapter or text size
                  // changes. The internal page-count recompute also
                  // re-runs on resize.
                  key={`${currentChapter?.id ?? "empty"}:${fontStep}:${lineStep}:${widthStep}`}
                  articleRef={articleRef}
                  typographyStyle={typographyStyle}
                  fontStep={fontStep}
                  setFontStep={setFontStep}
                  hasPrevChapter={chapterIdx > 0}
                  hasNextChapter={chapterIdx < chapters.length - 1}
                  onPrevChapter={() => setChapterIdx(Math.max(0, chapterIdx - 1))}
                  onNextChapter={() => setChapterIdx(Math.min(chapters.length - 1, chapterIdx + 1))}
                >
                  {currentChapter ? (
                    <ChapterBlock
                      chapterRef={currentChapter}
                      full={chapterBodies[currentChapter.id] ?? null}
                    />
                  ) : (
                    <p className="italic text-keep-muted">This story has no published chapters yet.</p>
                  )}
                </BookPagedView>
              )}
            </div>
            </div>
          </div>
        )}

        {/* Mobile contents drawer. Full-screen panel (md:hidden) layered
            over the whole reader card so phone readers can reach book
            info, Buy a Copy, chapters, and the codex — all of which live
            in the desktop-only sidebar otherwise. Tapping a chapter jumps
            + closes; the codex expands inline so it stays readable here. */}
        {navOpen && detail ? (
          <div className="absolute inset-0 z-30 flex flex-col bg-keep-bg md:hidden">
            <header className="flex shrink-0 items-center gap-2 border-b border-keep-rule bg-keep-banner px-3 py-2">
              <h3 className="min-w-0 flex-1 truncate font-action text-base">Contents</h3>
              <button
                type="button"
                onClick={() => setNavOpen(false)}
                className="rounded border border-keep-rule bg-keep-bg px-3 py-0.5 text-[11px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
              >
                Done
              </button>
            </header>
            <div className="keep-panel min-h-0 flex-1 overflow-y-auto">
              <ReaderSidebar
                detail={detail}
                chapters={chapters}
                currentChapterId={currentChapter?.id ?? null}
                mode={mode}
                onJumpChapter={(id) => jumpToChapter(id, true)}
              />
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/* =============================================================
 *  BookPagedView, paginated reading surface for book mode
 * =============================================================
 *
 *  Wraps the chapter content in a fixed-height viewport and pages
 *  through it one screen at a time. Unlike pageless mode (which is
 *  free-scroll), book mode now feels like a real e-reader: each
 *  "page" is exactly the viewport's reading area; Prev / Next page
 *  buttons live at the top AND bottom; arrow keys (← / →) flip
 *  pages; a quick A- / A+ pair adjusts font size without opening
 *  the typography panel.
 *
 *  Behavior:
 *   - Renders content into an off-screen-positioned wrapper inside
 *     an `overflow: hidden` container.
 *   - Measures the wrapper's full height on mount, on resize, and
 *     whenever the typography props change (caller bumps `key` to
 *     force a remount-style reset of page 0).
 *   - totalPages = ceil(contentHeight / containerHeight).
 *   - currentPage clamped to [0, totalPages - 1].
 *   - Reaching past the last page calls `onNextChapter` (when
 *     available) so the reader flows from end-of-chapter into the
 *     next chapter without a manual button press. Same shape for
 *     prev.
 */
function BookPagedView({
  children,
  articleRef,
  typographyStyle,
  fontStep,
  setFontStep,
  hasPrevChapter,
  hasNextChapter,
  onPrevChapter,
  onNextChapter,
}: {
  children: ReactNode;
  articleRef: { current: HTMLElement | null };
  typographyStyle: React.CSSProperties;
  fontStep: number;
  setFontStep: (n: number) => void;
  hasPrevChapter: boolean;
  hasNextChapter: boolean;
  onPrevChapter: () => void;
  onNextChapter: () => void;
}) {
  /**
   * Pagination strategy: CSS multi-column layout. We set the inner
   * content's `column-width` equal to the visible container's width,
   * so the browser flows the chapter into multiple full-width columns
   * laid out left-to-right. The container is `overflow: hidden`; we
   * scroll horizontally by transforming the inner element by
   * `-pageIdx * (pageWidth + columnGap)`. Because the browser breaks
   * columns at natural line / element boundaries, text NEVER cuts
   * mid-line the way a raw viewport-height scroll did.
   *
   * Page count is `ceil((scrollWidth + columnGap) / (pageWidth + columnGap))`.
   * scrollWidth on a column-laid-out element equals the sum of all
   * columns' widths + the gaps between them.
   */
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [pageIdx, setPageIdx] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [pageWidth, setPageWidth] = useState(0);
  const COLUMN_GAP = 48;

  useLayoutEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    function recompute() {
      if (!container || !content) return;
      const w = container.clientWidth;
      if (w <= 0) return;
      setPageWidth(w);
      // After the column layout flows, scrollWidth holds the total
      // multi-column width including gaps. Round (not ceil) because
      // the last column may not fully fill its width allotment and a
      // strict ceil would invent a phantom page-after-end.
      const totalWidth = content.scrollWidth;
      const slot = w + COLUMN_GAP;
      const pages = Math.max(1, Math.round((totalWidth + COLUMN_GAP) / slot));
      setTotalPages(pages);
      setPageIdx((cur) => Math.min(cur, pages - 1));
    }
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(container);
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  const atFirstPage = pageIdx === 0;
  const atLastPage = pageIdx >= totalPages - 1;

  const goPrev = useCallback(() => {
    if (!atFirstPage) {
      setPageIdx((p) => Math.max(0, p - 1));
      return;
    }
    if (hasPrevChapter) onPrevChapter();
  }, [atFirstPage, hasPrevChapter, onPrevChapter]);

  const goNext = useCallback(() => {
    if (!atLastPage) {
      setPageIdx((p) => Math.min(totalPages - 1, p + 1));
      return;
    }
    if (hasNextChapter) onNextChapter();
  }, [atLastPage, totalPages, hasNextChapter, onNextChapter]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        goNext();
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        goPrev();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goNext, goPrev]);

  const minFont = 0;
  const maxFont = FONT_SIZE_STEPS.length - 1;

  // Center the reading column horizontally using the user's chosen
  // max-width step (typographyStyle.maxWidth). The column width is
  // bounded by maxWidth, leaving symmetric margins inside the
  // available pane. The container measures THIS centered element so
  // pageWidth equals the constrained reading width, not the full
  // pane width. `keep-panel` adopts the active theme design's chrome
  // (medieval / modern / scifi / glass) so the reader pane looks
  // like a "page" sitting on the modal's surface.
  return (
    <div className="keep-panel flex min-h-0 w-full flex-1 flex-col overflow-hidden">
      <PageNavBar
        position="top"
        pageIdx={pageIdx}
        totalPages={totalPages}
        atFirstPage={atFirstPage}
        atLastPage={atLastPage}
        hasPrevChapter={hasPrevChapter}
        hasNextChapter={hasNextChapter}
        onPrev={goPrev}
        onNext={goNext}
        fontStep={fontStep}
        setFontStep={setFontStep}
        minFont={minFont}
        maxFont={maxFont}
      />
      {/* Outer padding wrapper for visual breathing room. The
          inner `containerRef` div has ZERO padding so its
          clientWidth equals exactly the column-layout area we
          measure for pagination, using a padded container caused
          a progressive offset (translate stepped by clientWidth
          which included padding, but columns flowed inside
          clientWidth - padding, so every page drifted by the
          padding amount). */}
      <div className="mx-auto flex min-h-0 w-full flex-1 px-6 py-6" style={typographyStyle}>
        <div
          ref={containerRef}
          className="book-paged-container relative min-w-0 flex-1 overflow-hidden"
        >
          <div
            ref={(el) => { contentRef.current = el; articleRef.current = el as unknown as HTMLElement; }}
            className="book-paged-content"
            style={{
              columnWidth: pageWidth > 0 ? `${pageWidth}px` : undefined,
              columnGap: `${COLUMN_GAP}px`,
              columnFill: "auto",
              height: "100%",
              transform: `translateX(-${pageIdx * (pageWidth + COLUMN_GAP)}px)`,
              transition: "transform 260ms cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          >
            {children}
          </div>
        </div>
      </div>
      <PageNavBar
        position="bottom"
        pageIdx={pageIdx}
        totalPages={totalPages}
        atFirstPage={atFirstPage}
        atLastPage={atLastPage}
        hasPrevChapter={hasPrevChapter}
        hasNextChapter={hasNextChapter}
        onPrev={goPrev}
        onNext={goNext}
        fontStep={fontStep}
        setFontStep={setFontStep}
        minFont={minFont}
        maxFont={maxFont}
      />
    </div>
  );
}

function PageNavBar({
  position,
  pageIdx,
  totalPages,
  atFirstPage,
  atLastPage,
  hasPrevChapter,
  hasNextChapter,
  onPrev,
  onNext,
  fontStep,
  setFontStep,
  minFont,
  maxFont,
}: {
  position: "top" | "bottom";
  pageIdx: number;
  totalPages: number;
  atFirstPage: boolean;
  atLastPage: boolean;
  hasPrevChapter: boolean;
  hasNextChapter: boolean;
  onPrev: () => void;
  onNext: () => void;
  fontStep: number;
  setFontStep: (n: number) => void;
  minFont: number;
  maxFont: number;
}) {
  // Prev/Next labels adapt at chapter boundaries so the reader gets a
  // clear "you're flipping chapters now" signal instead of a button
  // that silently changes meaning.
  const prevLabel = atFirstPage && hasPrevChapter ? "← Prev chapter" : "← Page";
  const nextLabel = atLastPage && hasNextChapter ? "Next chapter →" : "Page →";
  const prevDisabled = atFirstPage && !hasPrevChapter;
  const nextDisabled = atLastPage && !hasNextChapter;
  const borderClass = position === "top"
    ? "border-b border-keep-rule/40"
    : "border-t border-keep-rule/40";
  return (
    <div className={`keep-section-header flex shrink-0 items-center gap-2 bg-keep-panel-200/40 px-3 py-2 text-xs ${borderClass}`}>
      <button
        type="button"
        onClick={onPrev}
        disabled={prevDisabled}
        className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-1 uppercase tracking-widest disabled:opacity-40"
      >
        {prevLabel}
      </button>
      <span className="tabular-nums text-keep-muted">
        Page {pageIdx + 1} of {totalPages}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={nextDisabled}
        className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-1 uppercase tracking-widest disabled:opacity-40"
      >
        {nextLabel}
      </button>
      <span className="flex-1" />
      {/* Quick zoom, same model the AA panel uses for fontStep, just
          surfaced here so the reader doesn't have to open the panel
          for the most common adjustment. Buttons clamp to the same
          step bounds the panel does. */}
      <button
        type="button"
        onClick={() => setFontStep(Math.max(minFont, fontStep - 1))}
        disabled={fontStep <= minFont}
        title="Smaller text"
        className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-1 text-[10px] uppercase tracking-widest disabled:opacity-40"
      >
        A−
      </button>
      <span className="tabular-nums text-[10px] text-keep-muted">{fontStep + 1}/{maxFont + 1}</span>
      <button
        type="button"
        onClick={() => setFontStep(Math.min(maxFont, fontStep + 1))}
        disabled={fontStep >= maxFont}
        title="Larger text"
        className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-1 text-[10px] uppercase tracking-widest disabled:opacity-40"
      >
        A+
      </button>
    </div>
  );
}

/* =============================================================
 *  ReaderSidebar, info + TOC + reviews + codex
 * =============================================================
 *
 *  Permanent left-rail companion to the reading column. Hosts the
 *  social / metadata surfaces that used to live inline below the
 *  chapter body (where they interrupted the read in book mode and
 *  pushed the actual story off the first screen in pageless mode).
 *
 *  Sections:
 *    - Story info: cover, title, byline, status chip, rating chip,
 *      genre, chapter/word counts, action row (applause / follow /
 *      report). Always visible.
 *    - Chapters: scrollable list, click to jump. In book mode this
 *      switches `chapterIdx`; in pageless mode it also scrolls the
 *      article to the right `data-chapter-id` anchor.
 *    - Reviews: collapsible `<details>`. Gated on `allowReviews`;
 *      omitted entirely when the author has reviews off.
 *    - Codex: collapsible `<details>`. The codex appendix is
 *      potentially long; default-closed so it doesn't dominate.
 */
function ReaderSidebar({
  detail,
  chapters,
  currentChapterId,
  mode,
  onJumpChapter,
}: {
  detail: StoryDetail;
  chapters: StoryChapterRef[];
  currentChapterId: string | null;
  mode: ReadMode;
  onJumpChapter: (chapterId: string) => void;
}) {
  const s = detail.story;
  const authorName = s.author.characterName ?? s.author.masterUsername;
  return (
    <div className="flex flex-col">
      {/* Story info, cover + title + byline + meta bar + action bar */}
      <section className="px-3 pt-3 pb-4">
        {s.coverImageUrl ? (
          <img
            src={s.coverImageUrl}
            alt=""
            referrerPolicy="no-referrer"
            className="mb-3 w-full rounded object-cover shadow-md"
            style={{ maxHeight: 220 }}
          />
        ) : null}
        <h2 className="font-action text-xl leading-tight">{s.title}</h2>
        <p className="mt-0.5 text-sm italic text-keep-muted">by {authorName}</p>
        {s.status === "in_progress" ? (
          <p className="mt-2">
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/60 bg-amber-400/15 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-widest text-amber-300">
              <span aria-hidden="true">✎</span>
              Still writing
            </span>
          </p>
        ) : null}
        {s.buyToRead ? (
          <p className="mt-2">
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/60 bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-widest text-amber-300" title="Readers buy a copy to read past a sample">
              <span aria-hidden="true">🔒</span>
              Buy to read
            </span>
          </p>
        ) : null}
        {s.summary ? (
          <p className="mt-3 text-sm leading-snug text-keep-text/90">{s.summary}</p>
        ) : null}
        {s.contentWarnings.length > 0 ? (
          <p className="mt-2 text-xs italic opacity-80">
            Content: {s.contentWarnings.join(", ")}
          </p>
        ) : null}

        {/* Meta bar, full-width segmented row of rating / genre /
            status / counts. Each segment fills equal width via
            `flex-1`; thin vertical dividers between segments read
            as a single bar instead of free-floating chips. */}
        <MetaBar
          segments={[
            { label: "Rating", value: s.rating },
            { label: "Genre", value: labelForGenre(s.genre) },
            ...(s.status !== "in_progress"
              ? [{ label: "Status", value: labelForStatus(s.status) }]
              : []),
            { label: "Length", value: `${s.totalChapters}ch · ${s.totalWords.toLocaleString()}w` },
          ]}
        />

        {/* Action bar, full-width segmented row of Applause /
            Follow / Report. Empty actions (when `allowApplause` is
            off) are omitted from the segment list so the remaining
            actions stretch to fill. */}
        <ActionBar
          storyId={s.id}
          allowApplause={s.allowApplause}
          applauseCount={s.applauseCount}
        />
      </section>

      {/* Chapters TOC, `keep-section-header` picks up the per-theme
          header treatment (scifi adds a glow underline, glass adds
          a frosted band, etc.). `keep-row` on each chapter gives
          the list theme-aware hover states. */}
      {chapters.length > 0 ? (
        <section>
          <header className="keep-section-header border-y border-keep-rule/40 bg-keep-panel-200/40 px-3 py-2 text-xs font-semibold uppercase tracking-widest text-keep-muted">
            Chapters
            <span className="ml-2 tabular-nums normal-case">({chapters.length})</span>
          </header>
          <ol className="text-sm">
            {chapters.map((c, i) => {
              const active = currentChapterId === c.id;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onJumpChapter(c.id)}
                    title={c.title || `Chapter ${i + 1}`}
                    data-active={active ? "true" : undefined}
                    className={`keep-row block w-full truncate border-b border-keep-rule/20 px-3 py-2 text-left ${
                      active ? "text-keep-action" : "text-keep-text/85 hover:text-keep-text"
                    }`}
                  >
                    <span className="mr-2 inline-block w-5 text-right tabular-nums text-keep-muted">{i + 1}.</span>
                    {c.title || `Chapter ${i + 1}`}
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      {/* Reviews, collapsible, only when the author allows reviews.
          `<details>` keeps the panel out of the way at rest;
          `keep-section-header` on the summary matches the chapter
          TOC header so the sidebar reads as a single themed unit. */}
      {s.allowReviews ? (
        <details className="group border-t border-keep-rule/40">
          <summary className="keep-section-header keep-row flex cursor-pointer items-center bg-keep-panel-200/40 px-3 py-2 text-xs font-semibold uppercase tracking-widest text-keep-muted">
            <span className="mr-2 text-keep-muted transition group-open:rotate-90">▶</span>
            Reviews
          </summary>
          <div className="px-3 pb-2 pt-1">
            <StoryReviewsPanel
              storyId={s.id}
              authorUserId={s.author.userId}
              allowReviews={s.allowReviews}
            />
          </div>
        </details>
      ) : null}

      {/* Codex appendix, collapsible, default closed. */}
      <details className="group border-y border-keep-rule/40">
        <summary className="keep-section-header keep-row flex cursor-pointer items-center bg-keep-panel-200/40 px-3 py-2 text-xs font-semibold uppercase tracking-widest text-keep-muted">
          <span className="mr-2 text-keep-muted transition group-open:rotate-90">▶</span>
          Codex
        </summary>
        <div className="px-3 pb-2 pt-1">
          <StoryCodexAppendix storyId={s.id} />
        </div>
      </details>

      {/* Reading-mode hint. Lives at the foot of the rail as quiet
          micro-copy so first-timers know about the keyboard nav. */}
      <p className="mt-auto px-3 pb-3 pt-3 text-xs italic text-keep-muted">
        {mode === "book"
          ? "Tip: ← / → flip pages."
          : "Tip: scroll to read; toggle Book mode for paged view."}
      </p>
    </div>
  );
}

/* =============================================================
 *  MetaBar, full-width segmented row of story metadata
 * =============================================================
 *
 *  Replaces the chip-cluster row that was floating loose under the
 *  byline. Each segment fills equal width via `flex-1`; thin
 *  borders between segments read as a single unified bar rather
 *  than free chips. Each segment shows a small label above the
 *  value so the bar self-explains (no need to know that "PG-13" is
 *  the rating column by inference).
 */
function MetaBar({ segments }: { segments: Array<{ label: string; value: string }> }) {
  return (
    <div className="mt-3 flex w-full overflow-hidden rounded-md border border-keep-rule bg-keep-panel-200/30">
      {segments.map((seg, i) => (
        <div
          key={seg.label}
          className={`flex min-w-0 flex-1 flex-col items-center justify-center px-1 py-1.5 text-center ${
            i > 0 ? "border-l border-keep-rule/60" : ""
          }`}
        >
          <span className="text-[9px] font-semibold uppercase tracking-widest text-keep-muted">
            {seg.label}
          </span>
          <span className="mt-0.5 truncate text-xs font-semibold text-keep-text">
            {seg.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/* =============================================================
 *  ActionBar, full-width segmented row of story actions
 * =============================================================
 *
 *  Replaces the loose row of ApplauseButton + FollowButton +
 *  ScriptoriumReportButton. Same fetch logic as the originals,
 *  inlined so each action renders as a `flex-1` segment of a
 *  single bar with vertical dividers between them. The bar reads
 *  as a unified control surface; Discord-style segmented action
 *  rows are the established pattern users recognize for "do
 *  things with this thing."
 *
 *  Push toggle on follow is rendered as a tiny inset button to the
 *  right of the Follow label so the parent segment still fills
 *  exactly one column.
 */
function ActionBar({
  storyId,
  allowApplause,
  applauseCount,
}: {
  storyId: string;
  allowApplause: boolean;
  applauseCount: number;
}) {
  return (
    <>
      <div className="mt-2 flex w-full overflow-hidden rounded-md border border-keep-action/40 bg-keep-action/10 shadow-inner">
        {allowApplause ? (
          <ActionSegment
            left
            right={false}
          >
            <ApplauseSegment storyId={storyId} initialCount={applauseCount} />
          </ActionSegment>
        ) : null}
        <ActionSegment left={allowApplause} right={false}>
          <FollowSegment storyId={storyId} />
        </ActionSegment>
        <ActionSegment left right>
          <ReportSegment storyId={storyId} />
        </ActionSegment>
      </div>
      {/* Buy-a-Copy / showcase is pulled OUT of the segmented row into its
          own full-width button: three lines of label crammed into a ~1/4
          column read as scrunched, and a full-width CTA also makes the
          purchase path more discoverable. Collapses to nothing when buying
          doesn't apply (author / unpublished / signed out & not owned). */}
      <BuyCopyBar storyId={storyId} />
    </>
  );
}

/* ---------- Buy-a-Copy bar (full width, below the action row) ---------- */
function BuyCopyBar({ storyId }: { storyId: string }) {
  const activeCharacterId = useChat((s) => s.activeCharacterId);
  const setNotice = useChat((s) => s.setNotice);
  const [state, setState] = useState<StoryCopyState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchStoryCopyState(storyId, activeCharacterId)
      .then((s) => { if (!cancelled) setState(s); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [storyId, activeCharacterId]);

  async function buy() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await buyStoryCopy(storyId, activeCharacterId);
      setState(await fetchStoryCopyState(storyId, activeCharacterId));
      setNotice({ code: "scriptorium_copy", message: `Copy added to your Library (−${res.price}).` });
    } catch (e) {
      setNotice({ code: "scriptorium_copy_err", message: e instanceof Error ? e.message : "Purchase failed." });
    } finally {
      setBusy(false);
    }
  }

  async function toggleShowcase() {
    if (busy || !state) return;
    setBusy(true);
    try {
      const r = await setStoryShowcase(storyId, activeCharacterId, !state.showcased);
      setState({ ...state, showcased: r.shown });
    } catch (e) {
      setNotice({ code: "scriptorium_showcase_err", message: e instanceof Error ? e.message : "Couldn't update your Library." });
    } finally {
      setBusy(false);
    }
  }

  // Collapse to nothing when buying doesn't apply (author, not published, not
  // logged in) and the viewer doesn't already own it.
  if (!state || state.isAuthor || (!state.canBuy && !state.owned)) return null;

  const owned = state.owned;
  const active = owned && state.showcased;
  return (
    <button
      type="button"
      onClick={owned ? toggleShowcase : buy}
      disabled={busy}
      title={owned
        ? (state.showcased
            ? "Showing on your profile — tap to hide"
            : "You own this — tap to show it on your profile")
        : `Buy a copy for ${state.price} (adds it to your profile Library)`}
      className={`mt-2 flex w-full items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-semibold uppercase tracking-widest shadow-inner transition disabled:opacity-50 ${
        active
          ? "border-keep-action bg-keep-action/20 text-keep-action hover:bg-keep-action/30"
          : "border-keep-action/40 bg-keep-action/10 text-keep-text hover:bg-keep-action/20"
      }`}
    >
      <span className="text-base leading-none" aria-hidden>{owned ? "📚" : "📖"}</span>
      <span>{owned ? (state.showcased ? "Showing on Profile" : "Show on Profile") : "Buy a Copy"}</span>
      {!owned ? (
        <span className="text-xs tabular-nums opacity-70 normal-case">· {state.price}</span>
      ) : state.showcased ? (
        <span className="text-xs opacity-80" aria-hidden>✓</span>
      ) : null}
    </button>
  );
}

function ActionSegment({
  children,
  left,
  right: _right,
}: {
  children: ReactNode;
  left: boolean;
  right: boolean;
}) {
  // Dividers between segments echo the bar's accent tint so the
  // partition stays visible against the bar's accent-tinted bg
  // (a neutral border-keep-rule washes out at this contrast level).
  return (
    <div className={`flex min-w-0 flex-1 items-stretch ${left ? "border-l border-keep-action/30" : ""}`}>
      {children}
    </div>
  );
}

/* ---------- Applause segment ---------- */
function ApplauseSegment({ storyId, initialCount }: { storyId: string; initialCount: number }) {
  const [count, setCount] = useState(initialCount);
  const [viewerApplauded, setViewerApplauded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/stories/${storyId}/applause`)
      .then((r) => (r.ok ? r.json() as Promise<StoryApplauseState> : null))
      .then((j) => {
        if (cancelled || !j) return;
        setCount(j.count);
        setViewerApplauded(j.viewerApplauded);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [storyId]);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/stories/${storyId}/applause`, { method: "POST" });
      if (!r.ok) return;
      const j = (await r.json()) as StoryApplauseState;
      setCount(j.count);
      setViewerApplauded(j.viewerApplauded);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      title={viewerApplauded ? "Remove your applause" : "Applaud this story"}
      className={`flex w-full flex-col items-center justify-center gap-0.5 px-2 py-2 text-center transition hover:bg-keep-action/10 ${
        viewerApplauded ? "text-keep-action" : "text-keep-text"
      } disabled:opacity-50`}
    >
      <span className="text-base leading-none" aria-hidden>👏</span>
      <span className="text-[10px] font-semibold uppercase tracking-widest">
        {viewerApplauded ? "Applauded" : "Applaud"}
      </span>
      {count > 0 ? <span className="text-xs tabular-nums opacity-70">{count}</span> : null}
    </button>
  );
}

/* ---------- Follow segment ---------- */
function FollowSegment({ storyId }: { storyId: string }) {
  const [state, setState] = useState<StorySubscriptionState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/stories/${storyId}/follow`)
      .then(async (r) => (r.ok ? ((await r.json()) as StorySubscriptionState) : null))
      .then((j) => { if (!cancelled && j) setState(j); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [storyId]);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/stories/${storyId}/follow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok) return;
      const j = (await r.json()) as StorySubscriptionState;
      setState(j);
    } finally {
      setBusy(false);
    }
  }

  const subscribed = !!state?.subscribed;
  const count = state?.subscriberCount ?? 0;
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy || !state}
      title={subscribed ? "You'll be notified when a new chapter publishes" : "Get notified when a new chapter publishes"}
      className={`flex w-full flex-col items-center justify-center gap-0.5 px-2 py-2 text-center transition hover:bg-keep-action/10 ${
        subscribed ? "text-keep-action" : "text-keep-text"
      } disabled:opacity-50`}
    >
      <span className="text-base leading-none" aria-hidden>{subscribed ? "✦" : "✧"}</span>
      <span className="text-[10px] font-semibold uppercase tracking-widest">
        {subscribed ? "Following" : "Follow"}
      </span>
      {count > 0 ? <span className="text-xs tabular-nums opacity-70">{count}</span> : null}
    </button>
  );
}

/* ---------- Report segment ---------- */
function ReportSegment({ storyId }: { storyId: string }) {
  const [busy, setBusy] = useState(false);

  async function report() {
    const reason = window.prompt("Why are you reporting this story? (optional)") ?? "";
    if (busy) return;
    setBusy(true);
    try {
      await fetch(`/stories/${storyId}/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetKind: "story", targetId: storyId, reason: reason.trim() }),
      });
      window.alert("Report submitted. Thanks for flagging it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={report}
      disabled={busy}
      title="Report this story to moderators"
      className="flex w-full flex-col items-center justify-center gap-0.5 px-2 py-2 text-center text-keep-muted transition hover:bg-keep-accent/10 hover:text-keep-accent disabled:opacity-50"
    >
      <span className="text-base leading-none" aria-hidden>🚩</span>
      <span className="text-[10px] font-semibold uppercase tracking-widest">Report</span>
    </button>
  );
}

/* =============================================================
 *  LockedReadingPane, the "Buy to Read" paywall view
 * =============================================================
 *
 *  Shown in place of the reading panes when `detail.locked` is true.
 *  Renders the server-sampled first chapter (already truncated server-
 *  side — we never receive the full text), masks its tail to a fade,
 *  and presents the Buy CTA. A successful purchase calls `onUnlocked`,
 *  which clears the cached sample and re-fetches the now-unlocked detail.
 */
function LockedReadingPane({
  story,
  firstChapter,
  sampleBody,
  chapterCount,
  typographyStyle,
  onUnlocked,
}: {
  story: StoryDetail["story"];
  firstChapter: StoryChapterRef | null;
  sampleBody: StoryChapter | null;
  chapterCount: number;
  typographyStyle: CSSProperties;
  onUnlocked: () => void;
}) {
  const activeCharacterId = useChat((s) => s.activeCharacterId);
  const setNotice = useChat((s) => s.setNotice);
  const me = useChat((s) => s.me);
  const [busy, setBusy] = useState(false);

  async function buy() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await buyStoryCopy(story.id, activeCharacterId);
      setNotice({ code: "scriptorium_copy", message: `Unlocked! Copy added to your Library (−${res.price}).` });
      onUnlocked();
    } catch (e) {
      setNotice({ code: "scriptorium_copy_err", message: e instanceof Error ? e.message : "Purchase failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="keep-panel min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full px-6 py-6" style={typographyStyle}>
        {/* Sampled first chapter. The mask fades the tail to transparent —
            scheme-agnostic (no bg-color match needed) and a true "fade out"
            of the text itself. */}
        <div
          style={{
            WebkitMaskImage: "linear-gradient(to bottom, #000 58%, transparent)",
            maskImage: "linear-gradient(to bottom, #000 58%, transparent)",
          }}
        >
          {firstChapter ? (
            <ChapterBlock chapterRef={firstChapter} full={sampleBody} />
          ) : (
            <p className="italic opacity-60">No preview available yet.</p>
          )}
        </div>

        {/* Paywall CTA */}
        <div className="mx-auto -mt-6 max-w-prose rounded-lg border border-keep-action/40 bg-keep-action/10 p-5 text-center shadow-inner">
          <div className="text-2xl" aria-hidden>🔒</div>
          <h3 className="mt-1 font-action text-lg text-keep-text">Buy to keep reading</h3>
          <p className="mt-1 text-sm text-keep-muted">
            This is a preview. Buy a copy to read all {chapterCount} {chapterCount === 1 ? "chapter" : "chapters"}
            {" "}— it's added to your Library and you can show it on your profile.
          </p>
          {me ? (
            <button
              type="button"
              onClick={buy}
              disabled={busy}
              className="mt-3 inline-flex items-center justify-center gap-2 rounded-md border border-keep-action bg-keep-action px-5 py-2 text-sm font-semibold uppercase tracking-widest text-keep-bg transition hover:brightness-110 disabled:opacity-50"
            >
              <span aria-hidden>📖</span> {busy ? "Unlocking…" : `Buy to read · ${story.copyPrice}`}
            </button>
          ) : (
            <a
              href="/login"
              className="mt-3 inline-block rounded-md border border-keep-action bg-keep-action px-5 py-2 text-sm font-semibold uppercase tracking-widest text-keep-bg hover:brightness-110"
            >
              Sign in to buy
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function ReaderHeader({ detail }: { detail: StoryDetail }) {
  const s = detail.story;
  const authorName = s.author.characterName ?? s.author.masterUsername;
  return (
    <header className="mx-auto mb-6 max-w-prose text-center" style={{ fontFamily: "inherit" }}>
      {s.coverImageUrl ? (
        <img src={s.coverImageUrl} alt="" referrerPolicy="no-referrer"
          className="mx-auto mb-4 max-h-72 w-full max-w-md rounded object-cover" />
      ) : null}
      <h1 className="font-action text-3xl leading-tight">{s.title}</h1>
      <p className="mt-1 text-sm italic">by {authorName}</p>
      {s.status === "in_progress" ? (
        <p className="mt-2">
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/60 bg-amber-400/15 px-3 py-0.5 text-[11px] font-semibold uppercase tracking-widest text-amber-300">
            <span aria-hidden="true">✎</span>
            Still writing
          </span>
        </p>
      ) : null}
      {s.summary ? <p className="mt-3 text-base leading-snug">{s.summary}</p> : null}
      {s.synopsisHtml ? (
        <div className="prose mx-auto mt-4 max-w-prose text-left"
          dangerouslySetInnerHTML={{ __html: s.synopsisHtml }} />
      ) : null}
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-[11px] uppercase tracking-widest opacity-80">
        <span>{s.rating}</span><span>·</span>
        <span>{labelForGenre(s.genre)}</span>
        {s.status !== "in_progress" ? (
          <>
            <span>·</span>
            <span>{labelForStatus(s.status)}</span>
          </>
        ) : null}
        <span>·</span>
        <span>{s.totalChapters} ch · {s.totalWords.toLocaleString()} w</span>
      </div>
      {s.contentWarnings.length > 0 ? (
        <p className="mt-2 text-xs italic opacity-80">
          Content: {s.contentWarnings.join(", ")}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        {s.allowApplause ? <ApplauseButton storyId={s.id} initialCount={s.applauseCount} /> : null}
        <FollowButton storyId={s.id} />
        <ScriptoriumReportButton storyId={s.id} targetKind="story" targetId={s.id} label="Report story" />
      </div>
    </header>
  );
}

/**
 * Subscribe / unsubscribe toggle. Self-hydrates viewer state so the
 * reader doesn't have to thread subscription props down. Mirror of the
 * ApplauseButton pattern.
 *
 * The author can subscribe to their own story (the server allows it
 * but no self-pings, the publish-fanout filters publishingUserId).
 */
function FollowButton({ storyId }: { storyId: string }) {
  const [state, setState] = useState<StorySubscriptionState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/stories/${storyId}/follow`)
      .then(async (r) => (r.ok ? ((await r.json()) as StorySubscriptionState) : null))
      .then((j) => { if (!cancelled && j) setState(j); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [storyId]);

  async function toggleFollow() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/stories/${storyId}/follow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok) return;
      const j = (await r.json()) as StorySubscriptionState;
      setState(j);
    } finally {
      setBusy(false);
    }
  }

  async function togglePush() {
    if (busy || !state?.subscribed) return;
    setBusy(true);
    try {
      const r = await fetch(`/stories/${storyId}/follow`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pushEnabled: !state.pushEnabled }),
      });
      if (!r.ok) return;
      const j = (await r.json()) as StorySubscriptionState;
      setState(j);
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={toggleFollow}
        disabled={busy}
        title={state.subscribed ? "You'll get an in-app notification on new chapters" : "Get notified when a new chapter publishes"}
        className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition ${
          state.subscribed
            ? "border-keep-action bg-keep-action/15 text-keep-action"
            : "border-keep-rule bg-keep-bg/40 hover:border-keep-action/60 hover:text-keep-action"
        }`}
      >
        <span aria-hidden>{state.subscribed ? "✦" : "✧"}</span>
        <span>{state.subscribed ? "Following" : "Follow"}</span>
        {state.subscriberCount > 0 ? (
          <span className="ml-1 tabular-nums text-xs opacity-70">{state.subscriberCount}</span>
        ) : null}
      </button>
      {state.subscribed ? (
        <button
          type="button"
          onClick={togglePush}
          disabled={busy}
          title={state.pushEnabled ? "Browser notifications are on for this story. Tap to turn them off." : "Also send a browser notification when a new chapter publishes."}
          className={`rounded-full border px-2 py-1 text-sm transition ${
            state.pushEnabled
              ? "border-keep-action bg-keep-action/15 text-keep-action"
              : "border-keep-rule bg-keep-bg/40 text-keep-muted hover:text-keep-text"
          }`}
        >
          {state.pushEnabled ? "🔔" : "🔕"}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Inline applause toggle. Owns its own state, the reader doesn't
 * thread applause props down. Author cannot see WHO applauded; we only
 * surface the rollup count.
 */
function ApplauseButton({ storyId, initialCount }: { storyId: string; initialCount: number }) {
  const [count, setCount] = useState(initialCount);
  const [viewerApplauded, setViewerApplauded] = useState(false);
  const [busy, setBusy] = useState(false);

  // Hydrate viewer state once on mount. The detail fetch doesn't carry
  // it (story-level vs per-reader split), so a follow-up call is the
  // cleanest seam.
  useEffect(() => {
    let cancelled = false;
    fetch(`/stories/${storyId}/applause`)
      .then(async (r) => (r.ok ? ((await r.json()) as StoryApplauseState) : null))
      .then((j) => {
        if (cancelled || !j) return;
        setCount(j.count);
        setViewerApplauded(j.viewerApplauded);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [storyId]);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/stories/${storyId}/applause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        // 401 → not signed in. Surface the unauth state silently; the
        // button stays clickable in case the user signs in elsewhere.
        return;
      }
      const j = (await r.json()) as StoryApplauseState;
      setCount(j.count);
      setViewerApplauded(j.viewerApplauded);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      title={viewerApplauded ? "Take back your applause" : "Applaud this story"}
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition ${
        viewerApplauded
          ? "border-amber-400 bg-amber-400/15 text-amber-300"
          : "border-keep-rule bg-keep-bg/40 hover:border-amber-400/60 hover:text-amber-300"
      }`}
    >
      <span aria-hidden>👏</span>
      <span className="tabular-nums">{count.toLocaleString()}</span>
    </button>
  );
}

function ReaderFooter({ detail: _detail }: { detail: StoryDetail }) {
  // In-progress signaling moved to the header chip, the footer just
  // marks the end of available reading.
  return (
    <footer className="mx-auto mt-10 max-w-prose border-t border-current/20 pt-4 text-center text-xs opacity-70">
      <p>· end ·</p>
    </footer>
  );
}

function ChapterBlock({ chapterRef, full }: { chapterRef: StoryChapterRef; full: StoryChapter | null }) {
  return (
    <section className="mx-auto mb-10 max-w-prose" data-chapter-id={chapterRef.id}>
      <h2 className="mb-4 font-action text-2xl">
        {chapterRef.title || `Chapter ${chapterRef.sortOrder + 1}`}
      </h2>
      {chapterRef.contentWarnings.length > 0 ? (
        <p className="mb-3 text-[11px] italic opacity-70">
          Chapter content: {chapterRef.contentWarnings.join(", ")}
        </p>
      ) : null}
      {full ? (
        <>
          <ChapterBody html={full.bodyHtml} />
          {hasVisibleContent(full.authorNotesHtml) ? (
            <div className="mt-6 border-t border-current/20 pt-3 text-sm opacity-80">
              <h4 className="mb-1 text-xs uppercase tracking-widest">Author's notes</h4>
              <div dangerouslySetInnerHTML={{ __html: full.authorNotesHtml }} />
            </div>
          ) : null}
        </>
      ) : (
        <p className="italic opacity-60">Loading chapter...</p>
      )}
    </section>
  );
}

/**
 * Chapter body wrapper that decorates `@world:slug` / `@char:slug`
 * mentions after mount and attaches a delegated click handler so the
 * chips dispatch to the right destination (world viewer / codex
 * appendix scroll).
 */
function ChapterBody({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    decorateMentionsIn(root);
    const onClick = makeChipClickHandler();
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [html]);
  return <div ref={ref} className="prose-reader" dangerouslySetInnerHTML={{ __html: html }} />;
}

function ChapterPager({
  chapters,
  index,
  onPrev,
  onNext,
  onJump,
}: {
  chapters: StoryChapterRef[];
  index: number;
  onPrev: () => void;
  onNext: () => void;
  onJump: (i: number) => void;
}) {
  if (chapters.length === 0) return null;
  return (
    <nav className="mx-auto mt-8 max-w-prose border-t border-current/20 pt-4">
      <div className="flex items-center justify-between text-sm">
        <button type="button" onClick={onPrev} disabled={index === 0}
          className="rounded border border-current/30 px-3 py-1 disabled:opacity-30">
          ← Prev
        </button>
        <select value={index} onChange={(e) => onJump(parseInt(e.target.value, 10))}
          className="rounded border border-current/30 bg-transparent px-2 py-1 text-sm">
          {chapters.map((c, i) => (
            <option key={c.id} value={i}>
              {i + 1}. {c.title || `Chapter ${i + 1}`}
            </option>
          ))}
        </select>
        <button type="button" onClick={onNext} disabled={index >= chapters.length - 1}
          className="rounded border border-current/30 px-3 py-1 disabled:opacity-30">
          Next →
        </button>
      </div>
    </nav>
  );
}

function PagelessTOC({
  chapters,
  activeChapterId,
  onJump,
}: {
  chapters: StoryChapterRef[];
  activeChapterId: string | null;
  onJump: (c: StoryChapterRef) => void;
}) {
  return (
    <div className="sticky top-0 max-h-full overflow-y-auto p-3">
      <h3 className="mb-2 text-[10px] uppercase tracking-widest text-keep-muted">Chapters</h3>
      <ol className="space-y-1 text-xs">
        {chapters.map((c, i) => (
          <li key={c.id}>
            <button type="button" onClick={() => onJump(c)}
              className={`block w-full truncate rounded px-2 py-1 text-left ${
                activeChapterId === c.id ? "bg-keep-action/15 text-keep-action" : "text-keep-muted hover:text-keep-text"
              }`}
              title={c.title || `Chapter ${i + 1}`}>
              {i + 1}. {c.title || `Chapter ${i + 1}`}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function TypoControls({
  fontFamily, setFontFamily,
  fontStep, setFontStep,
  lineStep, setLineStep,
  widthStep, setWidthStep,
  scheme, setScheme,
}: {
  fontFamily: FontFamily; setFontFamily: (f: FontFamily) => void;
  fontStep: number; setFontStep: (n: number) => void;
  lineStep: number; setLineStep: (n: number) => void;
  widthStep: number; setWidthStep: (n: number) => void;
  scheme: ReaderScheme; setScheme: (s: ReaderScheme) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <span className="text-[10px] uppercase tracking-widest text-keep-muted">Aa</span>
      <Stepper label="Family">
        {(["serif", "sans", "dyslexic"] as const).map((f) => (
          <SmallToggle key={f} active={fontFamily === f} onClick={() => setFontFamily(f)}>{f}</SmallToggle>
        ))}
      </Stepper>
      <Stepper label="Size">
        <StepButtons value={fontStep} setValue={setFontStep} max={FONT_SIZE_STEPS.length - 1} />
      </Stepper>
      <Stepper label="Line">
        <StepButtons value={lineStep} setValue={setLineStep} max={LINE_HEIGHT_STEPS.length - 1} />
      </Stepper>
      <Stepper label="Width">
        <StepButtons value={widthStep} setValue={setWidthStep} max={MAX_WIDTH_STEPS.length - 1} />
      </Stepper>
      <Stepper label="Theme">
        {(["auto", "light", "sepia", "dark"] as const).map((s) => (
          <SmallToggle key={s} active={scheme === s} onClick={() => setScheme(s)}>{s}</SmallToggle>
        ))}
      </Stepper>
    </div>
  );
}

function Stepper({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] uppercase tracking-widest text-keep-muted">{label}:</span>
      <div className="flex items-center gap-0.5">{children}</div>
    </div>
  );
}

function SmallToggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${
        active ? "border-keep-action text-keep-action" : "border-keep-rule text-keep-muted hover:text-keep-text"
      }`}>
      {children}
    </button>
  );
}

function StepButtons({ value, setValue, max }: { value: number; setValue: (n: number) => void; max: number }) {
  return (
    <>
      <SmallToggle active={false} onClick={() => setValue(Math.max(0, value - 1))}>−</SmallToggle>
      <span className="tabular-nums text-[10px] text-keep-muted">{value + 1}/{max + 1}</span>
      <SmallToggle active={false} onClick={() => setValue(Math.min(max, value + 1))}>+</SmallToggle>
    </>
  );
}

function PrivateStub({ stub, onClose }: { stub: PrivateStoryStub; onClose: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8 text-center">
      <div className="max-w-sm space-y-3">
        <h2 className="font-action text-2xl">{stub.title}</h2>
        <p className="text-sm italic text-keep-muted">
          {stub.reason === "rating"
            ? "This story carries a mature rating. Sign in to view stories marked R or NC-17."
            : "This story is private. Only the author can see it."}
        </p>
        <div className="flex justify-center gap-2">
          {stub.requiresAuth ? (
            <a href="/login" className="rounded border border-keep-action bg-keep-action px-4 py-1.5 text-sm font-semibold uppercase tracking-widest text-keep-bg">
              Sign in
            </a>
          ) : null}
          <button type="button" onClick={onClose}
            className="rounded border border-keep-rule bg-keep-bg px-4 py-1.5 text-sm">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/* =============================================================
 *  Helpers
 * ============================================================= */

function useReaderPref<T>(key: string, fallback: T): [T, (next: T) => void] {
  const [value, setValueLocal] = useState<T>(() => {
    if (typeof window === "undefined") return fallback;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  });
  const setValue = useCallback((next: T) => {
    setValueLocal(next);
    try { window.localStorage.setItem(key, JSON.stringify(next)); }
    catch { /* private-mode quota */ }
  }, [key]);
  return [value, setValue];
}

function labelForGenre(g: StoryGenre): string {
  if (g === "scifi") return "Sci-fi";
  if (g === "slice-of-life") return "Slice of life";
  return g.charAt(0).toUpperCase() + g.slice(1).replace(/-/g, " ");
}

function labelForStatus(s: StoryStatus): string {
  if (s === "in_progress") return "In progress";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * True only when an HTML string has actual readable content, strips
 * tags and whitespace, returns false for `""`, `"<p></p>"`, repeated
 * empty paragraphs from Tiptap, etc. Images and horizontal rules count
 * as visible even when there's no surrounding text.
 */
function hasVisibleContent(html: string | null | undefined): boolean {
  if (!html) return false;
  if (/<(?:img|hr|iframe)\b/i.test(html)) return true;
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim().length > 0;
}
