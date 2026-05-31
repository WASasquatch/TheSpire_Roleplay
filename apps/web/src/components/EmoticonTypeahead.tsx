import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { UNICODE_EMOJI_FLAT } from "@thekeep/shared";
import { useEmoticons } from "../state/emoticons.js";
import { EmoticonSprite } from "./EmoticonSprite.js";

/**
 * Inline `:emoji-name` typeahead for chat composers.
 *
 * Wraps an existing `<textarea>` (passed by ref) and watches its input
 * stream for the `:` trigger. When the caret sits at the end of a
 * `:queryword` run (where the colon is at a word boundary so URL-like
 * `http:`, time-like `12:30`, or the legacy `:slug:idx:` token don't
 * fire false positives), a floating suggestion list opens beneath the
 * caret offering up to 10 matching emoji.
 *
 * The suggestion blend mixes Unicode emoji (catalog from
 * `@thekeep/shared/unicodeEmoji.ts`) with sheet emoticons currently
 * loaded into the emoticon store. Picking Unicode inserts the raw
 * character (browser-native rendering); picking a sheet entry inserts
 * the `:slug:idx:` token the existing inline-emoticon renderer
 * already handles.
 *
 * Keyboard contract while the popup is open:
 *   - Up / Down  → move selection
 *   - Enter / Tab → accept the selected suggestion
 *   - Escape     → dismiss the popup (the typed `:query` text stays)
 *
 * All four keys call `event.preventDefault()` + `event.stopPropagation()`
 * so they don't fall through to the composer's own handler (which would
 * otherwise interpret Enter as "send", Tab as "accept mention", etc.).
 *
 * The component renders no visible UI when the popup is closed; the
 * trigger detection runs on every selection / input change via
 * onSelect / onInput listeners attached to the textarea element.
 *
 * Mount this beside the `<textarea>` and pass the ref + value + onChange
 * setter — the same triple the parent already uses for its own typing
 * pipeline. The hook coordinates the cursor position via `selectionStart`
 * so the parent's `onChange` model stays canonical.
 */

const MAX_SUGGESTIONS = 10;
// Length-cap on the query word to keep the regex check cheap and to
// avoid pathological input ("::::::longstring::::::") triggering
// repeated catalog scans.
const MAX_QUERY_LEN = 32;

interface SheetSuggestion {
  kind: "sheet";
  /** Display label — the sheet cell's label (e.g. "smile_big"). */
  name: string;
  /** Insertion token. The composer renders `:slug:N:` as the sheet
   *  sprite via the existing inline-emoticon path. */
  token: string;
  /** For the popup preview thumbnail. */
  sheetSlug: string;
  cellIndex: number;
}

interface UnicodeSuggestion {
  kind: "unicode";
  /** Display label (e.g. "smile", "joy"). */
  name: string;
  /** Insertion text — the raw Unicode codepoint(s). */
  char: string;
}

type Suggestion = SheetSuggestion | UnicodeSuggestion;

interface ActiveTrigger {
  /** Index of the `:` in the textarea value. The popup replaces text
   *  from here through the caret. */
  start: number;
  /** Caret position when the trigger was last computed. */
  end: number;
  /** The lowercase query (chars between `:` and the caret). Empty
   *  string when only `:` has been typed — we still surface a small
   *  default suggestion set so the popup hints at usefulness. */
  query: string;
}

/**
 * Best-effort regex that detects a `:trigger` at the end of the text
 * preceding the caret. The trigger only fires when the `:` is
 * preceded by start-of-string, whitespace, or another newline — so
 * `http:` doesn't trigger, `12:30` doesn't trigger, and the legacy
 * `:slug:idx:` token typed by the picker doesn't accidentally
 * recurse (the `:idx:` half starts with a digit run after `:`, not
 * a letter).
 */
const TRIGGER_RE = /(?:^|\s)(:([a-z0-9_+-]{0,32}))$/i;

export function EmoticonTypeahead({
  textareaRef,
  value,
  onChange,
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
}) {
  const sheets = useEmoticons((s) => s.sheets);
  const [active, setActive] = useState<ActiveTrigger | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  // `pos` is the absolute pixel position to render the popup at
  // (relative to the document). Measured after each trigger event
  // so the popup tracks the caret as the user types or scrolls.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Build an index of the sheet emoticons just once per sheet-store
  // snapshot. Each entry carries the same shape as the Unicode flat
  // catalog so the search loop below can match both sources uniformly.
  const sheetIndex = useMemo<SheetSuggestion[]>(() => {
    const out: SheetSuggestion[] = [];
    for (const sheet of sheets) {
      sheet.cells.forEach((label, i) => {
        const trimmed = (label ?? "").trim();
        if (!trimmed) return;
        out.push({
          kind: "sheet",
          name: trimmed,
          token: `:${sheet.slug}:${i}:`,
          sheetSlug: sheet.slug,
          cellIndex: i,
        });
      });
    }
    return out;
  }, [sheets]);

  // Resolve the suggestion list for the current query. Empty query
  // shows a small default sampler (first 6 Unicode emoji + first 4
  // sheet emoticons if any) so a bare `:` is informative rather than
  // empty.
  const suggestions = useMemo<Suggestion[]>(() => {
    if (!active) return [];
    const q = active.query.toLowerCase();
    if (q.length === 0) {
      // Bare-`:` sampler — surfaces the picker's intent without
      // forcing the user to type a query.
      const sample: Suggestion[] = [];
      for (const e of UNICODE_EMOJI_FLAT.slice(0, 6)) {
        sample.push({ kind: "unicode", name: e.name, char: e.char });
      }
      for (const s of sheetIndex.slice(0, 4)) sample.push(s);
      return sample;
    }
    // Score: prefix matches rank above substring matches; tag matches
    // count below name matches. Cap before sort so the work stays
    // bounded on large catalogs.
    const scored: Array<{ score: number; suggestion: Suggestion }> = [];
    for (const e of UNICODE_EMOJI_FLAT) {
      const nameMatch = e.name.indexOf(q);
      if (nameMatch >= 0) {
        scored.push({
          score: nameMatch === 0 ? 0 : 10 + nameMatch,
          suggestion: { kind: "unicode", name: e.name, char: e.char },
        });
        continue;
      }
      if (e.tags?.some((t) => t.includes(q))) {
        scored.push({
          score: 100,
          suggestion: { kind: "unicode", name: e.name, char: e.char },
        });
      }
    }
    for (const s of sheetIndex) {
      const idx = s.name.toLowerCase().indexOf(q);
      if (idx >= 0) {
        scored.push({ score: idx === 0 ? 5 : 15 + idx, suggestion: s });
      }
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, MAX_SUGGESTIONS).map((s) => s.suggestion);
  }, [active, sheetIndex]);

  // Detect the `:trigger` at the current caret position. Called on
  // every input + selection event so the popup tracks the caret in
  // real time (including back-arrow / mouse-click placements).
  const checkTrigger = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? 0;
    // Only consider triggers if there's no selection (a selected
    // range would conflict with the "replace `:query` text" pick
    // semantics).
    if (el.selectionStart !== el.selectionEnd) {
      setActive(null);
      return;
    }
    const upto = value.slice(0, caret);
    const m = TRIGGER_RE.exec(upto);
    if (!m) {
      setActive(null);
      return;
    }
    const triggerText = m[1]!; // includes the leading `:`
    if (triggerText.length > MAX_QUERY_LEN + 1) {
      setActive(null);
      return;
    }
    const start = caret - triggerText.length;
    const query = (m[2] ?? "").toLowerCase();
    setActive({ start, end: caret, query });
    setSelectedIdx(0);
  }, [textareaRef, value]);

  // Re-position the popup whenever the trigger appears or moves. We
  // use the textarea's bounding rect + a measured caret offset to
  // place the popup directly beneath the caret line. Falls back to
  // anchoring at the textarea's bottom-left when caret measurement
  // isn't available (older browsers).
  useLayoutEffect(() => {
    if (!active) {
      setPos(null);
      return;
    }
    const el = textareaRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Caret position approximated via a mirror element. Browsers
    // don't expose a direct API for "give me the caret's pixel
    // coordinates inside a <textarea>" so we measure by copying the
    // textarea's text + styles into a hidden <div> and reading the
    // offset of a sentinel span placed at the caret index. Cheap
    // enough at chat-input sizes; not in a tight loop because we
    // only run it on trigger changes.
    const caretOffset = measureCaretOffset(el, active.end);
    const top = rect.top + caretOffset.top + caretOffset.lineHeight + 4;
    const left = rect.left + caretOffset.left;
    setPos({ top, left });
  }, [active, textareaRef, value]);

  // Wire selection/input listeners. We mount these once per textarea
  // ref; the dependency array intentionally only includes the
  // textareaRef identity (callbacks themselves rebuild but the
  // effect re-runs cheaply).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const handler = () => checkTrigger();
    el.addEventListener("input", handler);
    el.addEventListener("click", handler);
    el.addEventListener("keyup", handler);
    document.addEventListener("selectionchange", handler);
    return () => {
      el.removeEventListener("input", handler);
      el.removeEventListener("click", handler);
      el.removeEventListener("keyup", handler);
      document.removeEventListener("selectionchange", handler);
    };
  }, [textareaRef, checkTrigger]);

  // Accept a suggestion: replace `:query` text with the suggestion's
  // insertion content, advance the caret past it.
  const accept = useCallback(
    (suggestion: Suggestion) => {
      if (!active) return;
      const el = textareaRef.current;
      if (!el) return;
      const insert = suggestion.kind === "unicode" ? suggestion.char : suggestion.token;
      const next = value.slice(0, active.start) + insert + value.slice(active.end);
      onChange(next);
      const caret = active.start + insert.length;
      // Schedule the caret move after onChange flushes; setSelectionRange
      // before React re-renders would get clobbered.
      requestAnimationFrame(() => {
        const el2 = textareaRef.current;
        if (!el2) return;
        el2.focus();
        el2.setSelectionRange(caret, caret);
      });
      setActive(null);
      setSelectedIdx(0);
    },
    [active, onChange, textareaRef, value],
  );

  // Key handler bound directly to the textarea via keydown capture so
  // it runs ahead of the composer's own onKeyDown (Enter=send,
  // Tab=mention-accept, etc.). When the popup is closed every key
  // falls through unchanged.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (!active || suggestions.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx((i) => (i + 1) % suggestions.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        const pick = suggestions[selectedIdx] ?? suggestions[0];
        if (pick) accept(pick);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setActive(null);
      }
    };
    // Capture phase so we run BEFORE the textarea's own keydown
    // (which routes Enter to submit). React attaches its
    // synthetic handlers in bubble phase so we win.
    el.addEventListener("keydown", handler, true);
    return () => el.removeEventListener("keydown", handler, true);
  }, [active, suggestions, selectedIdx, accept, textareaRef]);

  if (!active || suggestions.length === 0 || !pos) return null;
  if (typeof document === "undefined") return null;

  // Clamp the popup inside the viewport so it doesn't render
  // off-screen when the caret is near the right edge.
  const POPUP_WIDTH = 240;
  const left = Math.max(8, Math.min(pos.left, window.innerWidth - POPUP_WIDTH - 8));
  return createPortal(
    <ul
      role="listbox"
      aria-label="Emoji suggestions"
      // `keep-panel` matches the rest of the floating chrome
      // (mentions popup, history popup) so the typeahead reads as
      // first-class.
      className="keep-panel pointer-events-auto fixed z-[210] max-h-64 w-60 overflow-y-auto rounded-lg border border-keep-rule shadow-xl"
      style={{ top: pos.top, left }}
      // Stop mousedown so clicking a suggestion doesn't steal focus
      // from the textarea — the caret needs to stay where it is so
      // setSelectionRange in `accept` lands correctly.
      onMouseDown={(e) => e.preventDefault()}
    >
      {suggestions.map((s, i) => (
        <li
          key={s.kind === "unicode" ? `u:${s.char}:${s.name}` : `s:${s.token}`}
          role="option"
          aria-selected={i === selectedIdx}
          onMouseEnter={() => setSelectedIdx(i)}
          onClick={() => accept(s)}
          className={`flex cursor-pointer items-center gap-2 px-2 py-1 text-xs ${
            i === selectedIdx ? "bg-keep-action/15 text-keep-action" : "hover:bg-keep-banner/40"
          }`}
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center text-xl leading-none">
            {s.kind === "unicode" ? s.char : (
              <EmoticonSprite sheetSlug={s.sheetSlug} cellIndex={s.cellIndex} size={22} />
            )}
          </span>
          <span className="flex-1 truncate font-mono">:{s.name}:</span>
          <span className="text-[9px] uppercase tracking-widest text-keep-muted">
            {s.kind === "unicode" ? "emoji" : "sheet"}
          </span>
        </li>
      ))}
      <li className="border-t border-keep-rule/60 px-2 py-1 text-[10px] italic text-keep-muted">
        ↑↓ navigate · enter / tab to insert · esc to dismiss
      </li>
    </ul>,
    document.body,
  );
}

/* =============================================================
 * Caret-pixel-position measurement
 *
 * Browsers expose `selectionStart` but not the pixel coordinates of
 * the caret inside a <textarea>. The standard workaround is to mount
 * a hidden mirror <div> with the same text + styles up to the caret
 * index, drop a zero-width sentinel span there, and read the span's
 * offset. The mirror is reused across calls — we just reset its
 * content per measurement.
 * ============================================================= */
let mirrorEl: HTMLDivElement | null = null;
let sentinelEl: HTMLSpanElement | null = null;

function ensureMirror(): { mirror: HTMLDivElement; sentinel: HTMLSpanElement } {
  if (mirrorEl && sentinelEl) return { mirror: mirrorEl, sentinel: sentinelEl };
  const mirror = document.createElement("div");
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  const sentinel = document.createElement("span");
  sentinel.textContent = "​"; // zero-width space for height stability
  mirror.appendChild(sentinel);
  document.body.appendChild(mirror);
  mirrorEl = mirror;
  sentinelEl = sentinel;
  return { mirror, sentinel };
}

const COPIED_STYLES = [
  "boxSizing",
  "width",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "textTransform",
  "textIndent",
  "padding",
  "border",
  "lineHeight",
  "tabSize",
] as const;

function measureCaretOffset(
  textarea: HTMLTextAreaElement,
  caretIndex: number,
): { top: number; left: number; lineHeight: number } {
  const { mirror, sentinel } = ensureMirror();
  const cs = window.getComputedStyle(textarea);
  for (const k of COPIED_STYLES) {
    // The cast is safe because COPIED_STYLES is hand-picked from
    // CSSStyleDeclaration's writable subset.
    (mirror.style as unknown as Record<string, string>)[k] = cs[k];
  }
  // Reset content and rebuild up to the caret. We leave the sentinel
  // as the last child so its rect IS the caret position.
  mirror.textContent = textarea.value.slice(0, caretIndex);
  mirror.appendChild(sentinel);
  const mirrorRect = mirror.getBoundingClientRect();
  const sentinelRect = sentinel.getBoundingClientRect();
  const lineHeight = parseFloat(cs.lineHeight || "16") || 16;
  return {
    top: sentinelRect.top - mirrorRect.top,
    left: sentinelRect.left - mirrorRect.left,
    lineHeight,
  };
}

/**
 * Unused export to keep the file tree-shakable — components that
 * mount the typeahead should also clean up the global mirror on
 * teardown if they're the last mount. In practice the mirror is
 * cheap to keep around (one hidden div per page).
 */
export function _disposeTypeaheadMirror(): void {
  if (mirrorEl) {
    mirrorEl.remove();
    mirrorEl = null;
    sentinelEl = null;
  }
}

// Re-export the KeyboardEvent type so the dispatcher cast above
// stays in one place if it ever needs adjusting.
export type _KeyboardEvent = KeyboardEvent;
