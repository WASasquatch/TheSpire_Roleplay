import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type { CommandDoc, RoomOccupant } from "@thekeep/shared";
import { CompleterPopup, type CompletionItem } from "./CompleterPopup.js";

interface Props {
  value: string;
  onChange: (text: string) => void;
  onSend: (text: string) => void;
  /** Current room occupants - used to populate @-mention autocomplete. */
  occupants?: RoomOccupant[];
  /** Mobile-only: open the rooms drawer. Hidden on md+. */
  onOpenRail?: () => void;
}

const MAX_VISIBLE_LINES = 6;
const MAX_COMPLETIONS = 8;

interface Trigger {
  kind: "/" | "@";
  /** Character offset where the trigger token starts (the `/` or `@` itself). */
  tokenStart: number;
  /** Lower-cased query (everything after the trigger char up to the caret). */
  query: string;
}

/**
 * Detect whether the caret sits inside an active completion trigger:
 *   - `/word` — only when the slash is at the start of the message (matches
 *     the dispatcher, which treats slash commands as the *first* token only).
 *   - `@word` — anywhere; mentions can appear mid-message.
 *
 * Returns null when no trigger is active (e.g. caret in plain text, or after
 * a space).
 */
function detectTrigger(text: string, caret: number): Trigger | null {
  // Walk back from the caret to the previous whitespace or start-of-string.
  let s = caret;
  while (s > 0 && !/\s/.test(text[s - 1]!)) s--;
  const token = text.slice(s, caret);
  if (token.length === 0) return null;
  if (token.startsWith("/")) {
    if (s !== 0) return null; // slash commands only at position 0
    return { kind: "/", tokenStart: s, query: token.slice(1).toLowerCase() };
  }
  if (token.startsWith("@")) {
    return { kind: "@", tokenStart: s, query: token.slice(1).toLowerCase() };
  }
  return null;
}

/**
 * Controlled composer with multi-line input + slash/at autocomplete.
 *
 * Multi-line behaviour:
 *   - Enter submits (matches chat conventions on every other platform).
 *   - Shift+Enter inserts a newline so paragraph posters can write blocks.
 *   - The textarea auto-grows up to MAX_VISIBLE_LINES, then internally scrolls.
 *
 * Autocomplete:
 *   - Typing `/<chars>` at message start, or `@<chars>` anywhere, opens a
 *     popup of matching commands or current room occupants.
 *   - Up/Down navigates, Enter or Tab accepts, Esc dismisses.
 *   - Accept replaces the trigger token with the selection plus a trailing
 *     space, then restores the caret.
 *
 * When the value changes from outside (parent sets it), we re-focus and
 * place the caret at the end so the user can keep typing immediately.
 */
export function Composer({ value, onChange, onSend, occupants, onOpenRail }: Props) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastValueRef = useRef(value);

  // Cache the command list. Fetched once per session; HelpModal hits the
  // same endpoint when opened, but the duplicated cost is negligible.
  const [commands, setCommands] = useState<CommandDoc[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/commands", { credentials: "include" })
      .then((r) => (r.ok ? r.json() as Promise<{ commands: CommandDoc[] }> : null))
      .then((j) => { if (!cancelled && j) setCommands(j.commands); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Caret-driven trigger detection. We track caret separately because React's
  // value+onChange flow doesn't carry the caret position; we update it in a
  // selectionchange handler so popup state stays accurate while the user
  // navigates with arrow keys.
  const [caret, setCaret] = useState<number>(value.length);
  const trigger = useMemo(() => detectTrigger(value, caret), [value, caret]);

  // Build completion items from the current trigger + sources.
  const items: CompletionItem[] = useMemo(() => {
    if (!trigger) return [];
    if (trigger.kind === "/") {
      if (!commands) return [];
      const out: CompletionItem[] = [];
      for (const c of commands) {
        // Match against the canonical name and aliases. Show the canonical
        // name as the inserted value so aliases route to the same handler;
        // sublabel surfaces what the command does.
        const names = [c.name, ...c.aliases];
        if (names.some((n) => n.toLowerCase().startsWith(trigger.query))) {
          out.push({
            value: `/${c.name}`,
            label: `/${c.name}`,
            sublabel: c.description,
          });
        }
      }
      out.sort((a, b) => a.label.localeCompare(b.label));
      return out.slice(0, MAX_COMPLETIONS);
    }
    // @-mention: filter occupants by displayName prefix.
    if (!occupants) return [];
    const out: CompletionItem[] = [];
    for (const o of occupants) {
      if (o.displayName.toLowerCase().startsWith(trigger.query)) {
        out.push({
          value: `@${o.displayName}`,
          label: `@${o.displayName}`,
          ...(o.away ? { sublabel: "away" } : {}),
        });
      }
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out.slice(0, MAX_COMPLETIONS);
  }, [trigger, commands, occupants]);

  const [selectedIndex, setSelectedIndex] = useState(0);
  // Reset highlight when the active item set changes shape (e.g. user keeps
  // typing and the list shortens).
  useEffect(() => {
    setSelectedIndex(0);
  }, [items.length, trigger?.kind]);

  useEffect(() => {
    if (value !== lastValueRef.current) {
      lastValueRef.current = value;
      const el = inputRef.current;
      if (el && document.activeElement !== el) {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
        setCaret(len);
      }
    }
  }, [value]);

  // Auto-grow: re-measure scrollHeight on every value change, capped at the
  // configured max-height (computed from line-height to stay font-size-aware).
  // useLayoutEffect avoids a flicker where the textarea briefly shows the old
  // height before the resize lands.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const cs = window.getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const maxHeight = lineHeight * MAX_VISIBLE_LINES + padTop + padBottom;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [value]);

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const t = value.trim();
    if (!t) return;
    onSend(t);
    onChange("");
    setCaret(0);
  }

  // Replace the active trigger token with the chosen completion, append a
  // trailing space, and restore the caret right after the inserted text.
  const acceptItem = useCallback((item: CompletionItem) => {
    const t = trigger;
    if (!t) return;
    const inserted = `${item.value} `;
    const next = value.slice(0, t.tokenStart) + inserted + value.slice(caret);
    onChange(next);
    const newCaret = t.tokenStart + inserted.length;
    // setSelectionRange has to wait for the controlled value to flush, so
    // schedule it after the next paint.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(newCaret, newCaret);
      setCaret(newCaret);
    });
  }, [trigger, value, caret, onChange]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Popup-aware navigation comes first: if the popup has items and a
    // navigational key fires, intercept it.
    if (items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % items.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + items.length) % items.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.nativeEvent.isComposing)) {
        e.preventDefault();
        const item = items[selectedIndex];
        if (item) acceptItem(item);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Force-close the popup by snapping the caret to a position that has
        // no trigger. Setting caret to 0 (no preceding `@`/`/`) is the
        // simplest signal; subsequent typing re-opens it.
        setCaret(0);
        return;
      }
    }

    // No popup intercept - fall through to plain Enter/submit.
    if (e.key !== "Enter") return;
    if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.nativeEvent.isComposing) return;
    e.preventDefault();
    submit();
  }

  // Keep `caret` in sync with native selection changes (mouse clicks,
  // arrow-key navigation that doesn't pass through onKeyDown intercept,
  // keyboard shortcuts, etc.). Wired via the textarea's own events to scope
  // it tightly.
  function syncCaret() {
    const el = inputRef.current;
    if (!el) return;
    setCaret(el.selectionStart ?? value.length);
  }

  return (
    <form
      onSubmit={submit}
      className="flex items-end gap-2 border-t border-keep-rule bg-keep-banner/50 p-2"
    >
      {/* Mobile-only rooms drawer toggle. Hidden on md+ where the rail is
          always visible. */}
      {onOpenRail ? (
        <button
          type="button"
          onClick={onOpenRail}
          aria-label="Open rooms"
          title="Rooms"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-keep-rule bg-keep-bg text-base hover:bg-keep-banner md:hidden"
        >
          ☰
        </button>
      ) : null}
      <div className="relative flex-1">
        {/* The popup positions itself above the textarea via bottom-full. */}
        <CompleterPopup
          items={items}
          selectedIndex={selectedIndex}
          onSelect={setSelectedIndex}
          onAccept={acceptItem}
        />
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            // selectionStart updates synchronously on input, so this stays
            // in sync with the new value during typing.
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="Type a message... (Shift+Enter for a new line)"
          // text-base on mobile prevents iOS Safari from auto-zooming on focus
          // (anything below 16px triggers zoom). md+ keeps our compact size.
          // resize-none + auto-grow effect manages height; leading-snug keeps
          // line spacing tight so multi-line posts don't waste vertical room.
          className="block min-h-0 w-full resize-none rounded border border-keep-rule bg-keep-bg px-3 py-2 text-base leading-snug outline-none focus:border-keep-action md:py-1 md:text-sm"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
        />
      </div>
      <button
        type="submit"
        className="shrink-0 rounded border border-keep-rule bg-keep-bg px-4 py-2 text-sm hover:bg-keep-banner md:py-1"
      >
        Send
      </button>
    </form>
  );
}
