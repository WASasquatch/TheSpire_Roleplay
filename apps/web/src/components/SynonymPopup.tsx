import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChat } from "../state/store.js";
import { useReducedMotion } from "../lib/reducedMotion.js";
import type { ComposerInputAdapter } from "../lib/composerInput.js";

/**
 * Thesaurus popup that activates on text selection inside an input
 * or textarea. Same UX shape as the @ mention completer:
 *
 *   1. User highlights a word in any chat / DM / forum input.
 *   2. A small list of synonyms slides in above the input.
 *   3. ↑/↓ navigates, Enter/Tab accepts (replaces the selection),
 *      Esc dismisses. Click also accepts.
 *   4. Changing or clearing the selection refreshes / closes.
 *
 * Mount it as a *sibling* of the input inside a `position: relative`
 * wrapper so the absolute panel anchors to that wrapper's bounds.
 *
 * The component is fully self-contained: it owns its fetch lifecycle,
 * keyboard navigation, and DOM-event plumbing. Callers wire it up
 * once and forget it. The cost is a single passive listener on the
 * input plus one debounced fetch per stable selection.
 */
export function SynonymPopup({
  inputRef,
  adapter,
  value,
  onChange,
}: {
  /** Textarea/input mode (DM composer, forum inputs). */
  inputRef?: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  /** Rich-editor mode (main chat composer): selection reads and the
   *  replace go through the adapter in plain-text coordinates; `value`
   *  must then be the SAME plain text the adapter reports. */
  adapter?: ComposerInputAdapter | null;
  value: string;
  onChange?: (next: string) => void;
}) {
  const { t } = useTranslation("common");
  // Per-user opt-out, when set, this component does nothing: no
  // listeners, no fetches, no popup. Lives in the chat store so a
  // toggle in the profile editor takes effect immediately.
  const disableThesaurus = useChat((s) => s.inputPrefs.disableThesaurus);
  // Calm-mode ease: opens ABOVE the input (bottom-full) → slide up. Pure CSS
  // positioning, so the slide transform doesn't fight placement.
  const reduceMotion = useReducedMotion();
  const [synonyms, setSynonyms] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [highlightedIdx, setHighlightedIdx] = useState(0);
  // Selection bounds captured at the moment the popup last fetched.
  // Stored so a later click can replace the exact range even after
  // the input lost focus (clicking the popup blurs the input on
  // Safari, which collapses the selection to the caret position).
  const selRef = useRef<{ start: number; end: number; word: string } | null>(null);
  const reqIdRef = useRef(0);
  const fetchTimerRef = useRef<number | null>(null);

  /**
   * Word shape we'll look up: 2–40 chars, letters + apostrophe/hyphen.
   * Mirrors the server's WORD_RX exactly. Short or punctuation-heavy
   * selections silently no-op so users dragging through whitespace
   * don't trigger spurious popups.
   */
  const WORD_RX = /^[a-zA-Z][a-zA-Z'-]{1,39}$/;

  function readSelection(): { start: number; end: number; word: string } | null {
    let start: number;
    let end: number;
    if (adapter) {
      const el = adapter.getElement();
      if (!el || el !== document.activeElement) return null;
      const sel = adapter.getSelection();
      if (!sel) return null;
      start = sel.start;
      end = sel.end;
    } else {
      const el = inputRef?.current;
      if (!el || el !== document.activeElement) return null;
      start = el.selectionStart ?? 0;
      end = el.selectionEnd ?? 0;
    }
    if (start === end) return null;
    const slice = value.slice(start, end).trim();
    if (!WORD_RX.test(slice)) return null;
    return { start, end, word: slice };
  }

  // Watch for selection changes. The browser fires `selectionchange`
  // on `document` for any selection change anywhere, we filter to
  // selections inside our input. Debounce + a stable-selection check
  // avoid firing a network request for every keystroke while the user
  // drags a selection.
  useEffect(() => {
    // Opt-out: skip the listener entirely so dragging a selection
    // doesn't fire a /thesaurus request even silently. Also closes
    // any popup that was open at the moment the user flipped the
    // toggle on.
    if (disableThesaurus) {
      setOpen(false);
      setSynonyms([]);
      return;
    }
    function onSelectionChange() {
      const sel = readSelection();
      if (!sel) {
        // Selection collapsed or invalid → close popup. The reqIdRef
        // bump invalidates any in-flight request so its response can't
        // re-open us after the user clicked elsewhere.
        reqIdRef.current++;
        setSynonyms([]);
        setOpen(false);
        selRef.current = null;
        return;
      }
      // Same selection as last time? Don't refetch.
      const prev = selRef.current;
      if (prev && prev.start === sel.start && prev.end === sel.end && prev.word === sel.word) {
        return;
      }
      selRef.current = sel;
      if (fetchTimerRef.current != null) {
        window.clearTimeout(fetchTimerRef.current);
      }
      const myReqId = ++reqIdRef.current;
      fetchTimerRef.current = window.setTimeout(() => {
        fetch(`/thesaurus?word=${encodeURIComponent(sel.word)}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((j: { synonyms?: string[] } | null) => {
            if (myReqId !== reqIdRef.current) return; // stale
            const list = Array.isArray(j?.synonyms) ? j!.synonyms : [];
            setSynonyms(list);
            setHighlightedIdx(0);
            setOpen(list.length > 0);
          })
          .catch(() => {
            if (myReqId !== reqIdRef.current) return;
            setSynonyms([]);
            setOpen(false);
          });
      }, 200);
    }
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      if (fetchTimerRef.current != null) window.clearTimeout(fetchTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, inputRef, adapter, disableThesaurus]);

  // Keyboard navigation. Attached to the input via capture-phase
  // window listener so the popup can preempt the input's own
  // Enter/Tab handling, same trick the @ mention completer uses.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      const el = adapter ? adapter.getElement() : inputRef?.current;
      if (!el || el !== document.activeElement) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIdx((i) => Math.min(i + 1, synonyms.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        const s = synonyms[highlightedIdx];
        if (s) {
          e.preventDefault();
          accept(s);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        setSynonyms([]);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, synonyms, highlightedIdx, inputRef, adapter]);

  /**
   * Replace the captured selection with the chosen synonym. We read
   * from selRef rather than re-reading the live selection because
   * clicking the popup blurs the input on Safari (collapsing the
   * selection to a caret) before our onClick fires.
   */
  function accept(synonym: string) {
    const sel = selRef.current;
    if (!sel) return;
    if (adapter) {
      // Rich-editor path: one ranged replacement; the adapter restores
      // focus and parks the caret after the inserted word itself.
      adapter.replaceRange(sel.start, sel.end, synonym);
      setOpen(false);
      setSynonyms([]);
      selRef.current = null;
      return;
    }
    const el = inputRef?.current;
    if (!el) return;
    const before = value.slice(0, sel.start);
    const after = value.slice(sel.end);
    const next = before + synonym + after;
    onChange?.(next);
    setOpen(false);
    setSynonyms([]);
    selRef.current = null;
    // Restore focus + move caret to right after the inserted synonym.
    requestAnimationFrame(() => {
      el.focus();
      const pos = sel.start + synonym.length;
      el.setSelectionRange(pos, pos);
    });
  }

  if (!open || synonyms.length === 0) return null;

  return (
    <ul
      role="listbox"
      aria-label={t("synonyms.listAria")}
      // `bottom-full` anchors the popup to the top edge of the
      // relatively-positioned input wrapper, matching CompleterPopup's
      // placement. `mb-1` adds a tiny gap so the panel doesn't kiss
      // the input border.
      className={`absolute bottom-full left-0 z-30 mb-1 max-h-56 w-full overflow-y-auto rounded border border-keep-rule bg-keep-bg shadow-2xl${reduceMotion ? " tk-slide-up-in" : ""}`}
    >
      <li className="border-b border-keep-rule/40 bg-keep-banner/40 px-2 py-1 text-[10px] uppercase tracking-widest text-keep-muted">
        {t("synonyms.headerFor", { word: selRef.current?.word ?? "" })}
      </li>
      {synonyms.map((s, i) => (
        <li key={s + i}>
          <button
            type="button"
            // onMouseDown so the click lands before the input's blur
            // (Safari quirk, see the UsernameAutocomplete component
            // for the same trick).
            onMouseDown={(e) => { e.preventDefault(); accept(s); }}
            onMouseEnter={() => setHighlightedIdx(i)}
            className={`block w-full truncate px-2 py-1 text-left text-xs ${
              i === highlightedIdx
                ? "bg-keep-banner/60 text-keep-text"
                : "text-keep-text hover:bg-keep-banner/40"
            }`}
          >
            {s}
          </button>
        </li>
      ))}
    </ul>
  );
}
