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
import type { CommandDoc, RoomOccupant, ThreadCategory } from "@thekeep/shared";
import { CompleterPopup, type CompletionItem } from "./CompleterPopup.js";
import { SynonymPopup } from "./SynonymPopup.js";
import { useChat } from "../state/store.js";

interface Props {
  value: string;
  onChange: (text: string) => void;
  /**
   * Submit handler. The forum-mode options route through the same
   * socket payload extensions: `threadTitle` starts a new topic,
   * `replyToId` posts a reply under one. `threadCategoryId` is the
   * legacy carrier for the topic's bucket; the server now also reads
   * it from any new top-level send.
   */
  onSend: (
    text: string,
    opts?: { threadCategoryId?: string | null; threadTitle?: string; replyToId?: string },
  ) => void;
  /** Current room occupants - used to populate @-mention autocomplete. */
  occupants?: RoomOccupant[];
  /** Mobile-only: open the rooms drawer. Hidden on md+. */
  onOpenRail?: () => void;
  /** Current room id; used as the localStorage key for last-used category. */
  roomId?: string | null;
  /**
   * Available thread categories for the current room. Undefined when the
   * room isn't nested or the list hasn't loaded yet; empty array means
   * "nested but no categories defined" — the picker is hidden in both
   * cases since there's nothing to choose.
   */
  threadCategories?: ThreadCategory[];
  /**
   * Forum-mode controls. When the host room is nested-mode the composer
   * is one of three states:
   *   - `isForumRoom && !activeTopic && !topicCreateMode` → DISABLED,
   *     with a hint + "New Topic" button.
   *   - `isForumRoom && topicCreateMode` → title input + body + category;
   *     submit calls onSend with `threadTitle`.
   *   - `isForumRoom && activeTopic` → reply mode; submit calls onSend
   *     with `replyToId`.
   * In flat-chat rooms `isForumRoom` is false and these props are
   * ignored — the composer behaves like the historic chat input.
   */
  isForumRoom?: boolean;
  /**
   * Active topic the user is reading / replying to. Passed in as the
   * topic message itself (we need `title` + `id` to render the
   * "Replying to" indicator). `locked` mirrors the server-side
   * `messages.locked_at` state — when true the composer renders a
   * "topic locked" notice and disables the textarea instead of the
   * usual reply indicator. Null = no topic selected.
   */
  activeTopic?: { id: string; title: string | null; body: string; locked: boolean } | null;
  /** True iff the user clicked "New Topic" and the composer is in topic-create mode. */
  topicCreateMode?: boolean;
  /** Open the topic-create form (toggles topicCreateMode on at the App level). */
  onStartTopicCreate?: () => void;
  /** Cancel topic-create mode (revert to the disabled/active-topic state). */
  onCancelTopicCreate?: () => void;
  /** Clear the active topic (leave the thread). */
  onLeaveThread?: () => void;
  /**
   * Override the textarea placeholder. When unset, the composer picks a
   * sensible contextual default (forum-disabled hint / "Reply to ..." /
   * "Type a message..."). Set this when embedding the composer in a
   * context where the contextual defaults don't fit — e.g. the focused
   * thread modal, which is itself the reply context and wants its own
   * "Reply to <topic>..." prompt instead of the chat default.
   */
  placeholder?: string;
  /**
   * Viewer is a moderator (role mod or admin). Moderators bypass the
   * locked-topic input disable — they can still post in locked
   * threads to leave verdicts / notices, matching the server's
   * mod-bypass on the reply gate. The composer renders a distinct
   * "🔒 Locked — replying as moderator" hint when this is true and
   * the active topic is locked.
   */
  canModerate?: boolean;
  /**
   * Parent-supplied "preferred category for the next new topic" signal,
   * typically wired to the forum view's last-clicked section. Tristate:
   *   - `undefined` (or omitted) → no signal, the dropdown reads its
   *     own persisted localStorage default
   *   - `null` → user nominated the Uncategorized bucket
   *   - `string` → user nominated the given category id
   * Each *change* to this prop syncs the dropdown to the new value (and
   * persists it). Steady-state re-renders with an unchanged value do
   * nothing, so a manual select-dropdown override still wins until the
   * user clicks another section.
   */
  preferredCategoryId?: string | null;
}

const MAX_VISIBLE_LINES = 6;
const MAX_COMPLETIONS = 8;
const HISTORY_MAX = 50;

/** Short label for the "Replying to" indicator: title if present, else a body excerpt. */
function topicLabel(t: { title: string | null; body: string }): string {
  const title = t.title?.trim();
  if (title) return title;
  const body = t.body.trim();
  if (body.length <= 60) return body || "(untitled topic)";
  return `${body.slice(0, 60)}…`;
}

interface Trigger {
  kind: "/" | "@" | "whisper-target";
  /** Character offset where the trigger token starts (the `/` or `@` itself,
   *  or for whisper-target, the first char of the username being typed). */
  tokenStart: number;
  /** Lower-cased query (everything after the trigger char up to the caret). */
  query: string;
}

/**
 * Slash commands whose first positional argument is a username — when the
 * user is typing the name, we open the same occupant picker we use for
 * `@`-mentions. Matches the server-side `whisper` command's `aliases`
 * list (see apps/server/src/commands/builtins/whisper.ts) so any alias
 * the dispatcher accepts also lights up the picker.
 */
const WHISPER_CMDS = new Set([
  "whisper", "w", "wh", "to", "msg", "message", "pm",
]);

/**
 * NBSP-aware "word char" check used to walk back to a token boundary.
 * `/\s/` matches NBSP (U+00A0) — but NBSP is a legal username character,
 * so we treat it as part of the same token to keep names like
 * `The[NBSP]Watcher` whole.
 */
function isWordChar(ch: string): boolean {
  if (ch === " ") return true;
  return !/\s/.test(ch);
}

/**
 * Detect whether the caret sits inside an active completion trigger:
 *   - `/word` — only when the slash is at the start of the message (matches
 *     the dispatcher, which treats slash commands as the *first* token only).
 *   - `@word` — anywhere; mentions can appear mid-message.
 *   - whisper-target: when the caret is in the first positional argument
 *     of a /whisper-alias command, show the same occupant picker (the
 *     name is what the recipient resolves against on the server, so the
 *     picker streamlines what was previously typed-by-hand).
 *
 * Returns null when no trigger is active (e.g. caret in plain text, or after
 * a space).
 */
function detectTrigger(text: string, caret: number): Trigger | null {
  // Whisper-target check first — we want it to win over the @-mention
  // path when the user types `/w foo` (the `foo` part is a bare name,
  // not an @mention). The check looks at the WHOLE line because the
  // trigger boundary isn't a single delimiter char.
  if (text.startsWith("/")) {
    // Find the space that separates the command word from its args. We
    // skip the NBSP-as-whitespace trap here by looking for an ASCII
    // space specifically (NBSP can never appear inside a command name,
    // so the first U+0020 cleanly divides cmd from rest).
    const firstSpace = text.indexOf(" ");
    if (firstSpace > 0 && caret > firstSpace) {
      const cmd = text.slice(1, firstSpace).toLowerCase();
      if (WHISPER_CMDS.has(cmd)) {
        const argStart = firstSpace + 1;
        const argSoFar = text.slice(argStart, caret);
        // Bail out once the caret moves past the first arg — at that
        // point the user is typing the message body, not picking a
        // recipient. NBSP is intentionally NOT counted as whitespace
        // here so `/w The[NBSP]Watcher` keeps the picker open while
        // the name is being typed.
        const pastNameBoundary = /[ \t]/.test(argSoFar);
        if (!pastNameBoundary) {
          return {
            kind: "whisper-target",
            tokenStart: argStart,
            query: argSoFar.toLowerCase(),
          };
        }
      }
    }
  }

  // Walk back from the caret to the previous whitespace or start-of-string.
  let s = caret;
  while (s > 0 && isWordChar(text[s - 1]!)) s--;
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
export function Composer({
  value,
  onChange,
  onSend,
  occupants,
  onOpenRail,
  roomId,
  threadCategories,
  isForumRoom,
  activeTopic,
  topicCreateMode,
  onStartTopicCreate,
  onCancelTopicCreate,
  onLeaveThread,
  placeholder,
  canModerate,
  preferredCategoryId,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastValueRef = useRef(value);

  // Input history. Each successful send pushes its trimmed body onto a ring
  // buffer (deduped against the most recent entry). ArrowUp/ArrowDown walk
  // the buffer when the value is single-line and the autocomplete popup
  // isn't active, mimicking the IRC / terminal convention. The draft you
  // had typed before entering history mode is restored when ArrowDown
  // takes you past the newest entry, so casually browsing history doesn't
  // cost you in-progress text.
  //
  // Refs (not state) since none of this affects rendering directly — the
  // visible text already lives in the parent's `value`. Lives for the
  // Composer's lifetime; logging out unmounts the chat and clears it.
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const draftBeforeHistoryRef = useRef<string>("");

  // Thread-category picker state. Only meaningful for nested-mode rooms
  // with at least one category. `selectedCategoryId === null` ==
  // "Uncategorized". Persisted per-room in localStorage so repeat
  // posters in the same bucket don't re-pick on every send.
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  // Topic-title draft used only while topicCreateMode is on. Cleared
  // whenever the composer leaves create mode so a half-typed title
  // doesn't leak into the next new-topic session.
  const [topicTitle, setTopicTitle] = useState("");
  useEffect(() => {
    if (!topicCreateMode) setTopicTitle("");
  }, [topicCreateMode]);

  useEffect(() => {
    if (!roomId) {
      setSelectedCategoryId(null);
      return;
    }
    try {
      const saved = window.localStorage.getItem(`thespire.thread-cat.${roomId}`);
      // Saved id may have been removed by an admin since last visit; we
      // validate against the current categories list on render and silently
      // ignore stale values, so a missing-category id just falls back to
      // "Uncategorized" without erroring.
      setSelectedCategoryId(saved && saved !== "" ? saved : null);
    } catch { /* storage may be disabled */ }
  }, [roomId]);

  function setAndPersistCategory(catId: string | null) {
    setSelectedCategoryId(catId);
    if (!roomId) return;
    try {
      if (catId) window.localStorage.setItem(`thespire.thread-cat.${roomId}`, catId);
      else window.localStorage.removeItem(`thespire.thread-cat.${roomId}`);
    } catch { /* ignore */ }
  }

  // Sync the dropdown to the parent's "preferred" signal when (and only
  // when) it changes. Ref-guarded so an unchanged prop on re-renders
  // doesn't repeatedly clobber a manual select-dropdown override the
  // user made after their last section click. `undefined` means "no
  // signal" — distinct from `null` (Uncategorized).
  const prevPreferredRef = useRef(preferredCategoryId);
  useEffect(() => {
    if (preferredCategoryId === prevPreferredRef.current) return;
    prevPreferredRef.current = preferredCategoryId;
    if (preferredCategoryId === undefined) return;
    setAndPersistCategory(preferredCategoryId);
  // setAndPersistCategory closes over roomId and state setters which
  // are stable; including only the prop keeps the deps list honest.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferredCategoryId]);

  // Hide the picker for replies/whispers — they inherit the parent
  // thread's category implicitly server-side. Also hide for any slash
  // command (the picker only governs plain-say top-level messages).
  const isTopLevelSay = !value.trimStart().startsWith("/");
  const showCategoryPicker =
    isTopLevelSay && threadCategories !== undefined && threadCategories.length > 0;

  // Validate the persisted id against the current list; if the admin
  // deleted the category since last visit we silently null it.
  const effectiveCategoryId =
    selectedCategoryId && threadCategories?.some((c) => c.id === selectedCategoryId)
      ? selectedCategoryId
      : null;

  // Cache the command list. Fetched per mount + whenever
  // `commandsVersion` bumps (the App-level socket listener bumps it
  // on `commands:updated` from the server, fired by every admin
  // custom-command edit). Without the version key, a brand-new
  // command would stay invisible in the autocomplete until the user
  // reloaded their tab.
  const [commands, setCommands] = useState<CommandDoc[] | null>(null);
  const commandsVersion = useChat((s) => s.commandsVersion);
  useEffect(() => {
    let cancelled = false;
    fetch("/commands", { credentials: "include" })
      .then((r) => (r.ok ? r.json() as Promise<{ commands: CommandDoc[] }> : null))
      .then((j) => { if (!cancelled && j) setCommands(j.commands); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [commandsVersion]);

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
    // @-mention OR whisper-target: filter occupants by displayName prefix.
    // The two share the same item source — the only difference is whether
    // the inserted text carries an `@` prefix (mid-message mention) or
    // not (a bare username after `/whisper`).
    if (!occupants) return [];
    const out: CompletionItem[] = [];
    const wantAt = trigger.kind === "@";
    for (const o of occupants) {
      if (o.displayName.toLowerCase().startsWith(trigger.query)) {
        out.push({
          value: wantAt ? `@${o.displayName}` : o.displayName,
          label: wantAt ? `@${o.displayName}` : o.displayName,
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
  //
  // The explicit `minHeight` floor closes a cross-browser inconsistency:
  // some browsers fold CSS min-height into scrollHeight after the
  // `style.height = "auto"` reset, others don't. Reading the computed
  // min-height back and flooring the inline style here guarantees the
  // textarea never collapses below its CSS floor — important for the
  // mobile layout where the floor is sized to match the ↵+Send right
  // column so the row has no dead space below the input.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const cs = window.getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const minHeight = parseFloat(cs.minHeight) || 0;
    const maxHeight = lineHeight * MAX_VISIBLE_LINES + padTop + padBottom;
    const target = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
    el.style.height = `${target}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [value]);

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const t = value.trim();
    if (!t) return;
    const buf = historyRef.current;
    if (buf[buf.length - 1] !== t) {
      buf.push(t);
      if (buf.length > HISTORY_MAX) buf.shift();
    }
    historyIndexRef.current = null;
    draftBeforeHistoryRef.current = "";

    // Forum-mode routing. Server enforces these structurally; here we
    // just pick the right payload shape based on which UI mode we're
    // in. Both modes still need the body (`t`) — a topic with no body
    // is treated as the first post AND the topic anchor, same row.
    if (isForumRoom && topicCreateMode) {
      const title = topicTitle.trim();
      if (!title) return; // submit-button is disabled in this case too
      onSend(t, {
        threadTitle: title,
        threadCategoryId: effectiveCategoryId,
      });
      onChange("");
      setTopicTitle("");
      setCaret(0);
      return;
    }
    if (isForumRoom && activeTopic) {
      onSend(t, { replyToId: activeTopic.id });
      onChange("");
      setCaret(0);
      return;
    }

    // Flat-room / non-forum path. threadCategoryId only forwards when
    // the picker is visible (i.e. a categorized nested room before the
    // forum rewrite; defensively kept for installs in flat mode).
    onSend(t, showCategoryPicker ? { threadCategoryId: effectiveCategoryId } : undefined);
    onChange("");
    setCaret(0);
  }

  // Replace the composer text with a recalled (or restored) value and park
  // the caret at the end. Used by ArrowUp/ArrowDown history navigation.
  // requestAnimationFrame waits for the controlled value to flush before
  // we reposition the caret — same pattern acceptItem uses.
  const recallText = useCallback((text: string) => {
    onChange(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
      setCaret(len);
    });
  }, [onChange]);

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

    // History navigation. Only kicks in for single-line input so it
    // doesn't fight cursor movement inside a multi-line draft, and only
    // when no modifier keys are held (Shift+Arrow selects, Ctrl/Alt+Arrow
    // word-jumps - both should pass through). The popup branch above has
    // already returned for its own arrow handling.
    if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !value.includes("\n")) {
      if (e.key === "ArrowUp") {
        const buf = historyRef.current;
        if (buf.length === 0) return; // nothing to recall - let the key through
        e.preventDefault();
        const cur = historyIndexRef.current;
        if (cur === null) {
          // Entering history mode - stash whatever was being typed so
          // ArrowDown past the newest entry can restore it.
          draftBeforeHistoryRef.current = value;
          historyIndexRef.current = 0;
        } else {
          historyIndexRef.current = Math.min(cur + 1, buf.length - 1);
        }
        recallText(buf[buf.length - 1 - historyIndexRef.current]!);
        return;
      }
      if (e.key === "ArrowDown" && historyIndexRef.current !== null) {
        e.preventDefault();
        const buf = historyRef.current;
        const next = historyIndexRef.current - 1;
        if (next < 0) {
          // Past the newest entry - exit history mode and restore the
          // draft the user had typed before they started browsing.
          const draft = draftBeforeHistoryRef.current;
          historyIndexRef.current = null;
          draftBeforeHistoryRef.current = "";
          recallText(draft);
        } else {
          historyIndexRef.current = next;
          recallText(buf[buf.length - 1 - next]!);
        }
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

  // Mobile newline insertion. On-screen keyboards don't have Shift+Enter,
  // and the Enter key on most mobile keyboards is bound to submit — so
  // multi-line posters need an explicit button. Inserts at the caret (or
  // replaces the selection) and restores the caret one char past the
  // inserted newline. Visible only on mobile via `md:hidden`.
  function insertNewline() {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    const next = value.slice(0, start) + "\n" + value.slice(end);
    onChange(next);
    const newCaret = start + 1;
    requestAnimationFrame(() => {
      const el2 = inputRef.current;
      if (!el2) return;
      el2.focus();
      el2.setSelectionRange(newCaret, newCaret);
      setCaret(newCaret);
    });
  }

  /**
   * Wrap the current selection with `before` / `after` markers. If no
   * selection, insert `before + placeholder + after` and place the
   * caret around the placeholder so the user can immediately type
   * over it. Used by the formatting buttons (Bold / Italic / etc).
   */
  function wrapSelection(before: string, after: string, placeholder: string = "text"): void {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    const selected = value.slice(start, end);
    const content = selected || placeholder;
    const inserted = `${before}${content}${after}`;
    const next = value.slice(0, start) + inserted + value.slice(end);
    onChange(next);
    // Caret placement: if we used the placeholder (no original
    // selection), select the placeholder text so the user can type
    // straight over it. If we wrapped a real selection, place the
    // caret right after the closing marker.
    const selStart = start + before.length;
    const selEnd = selStart + content.length;
    requestAnimationFrame(() => {
      const el2 = inputRef.current;
      if (!el2) return;
      el2.focus();
      if (selected) {
        el2.setSelectionRange(selEnd, selEnd);
        setCaret(selEnd);
      } else {
        el2.setSelectionRange(selStart, selEnd);
        setCaret(selEnd);
      }
    });
  }

  /**
   * Prefix every line of the current selection (or the current line
   * if no selection) with `prefix`. Used by the Quote button: turns
   * a multi-line selection into a `> ` blockquote.
   */
  function prefixLines(prefix: string): void {
    const el = inputRef.current;
    if (!el) return;
    let start = el.selectionStart ?? value.length;
    let end = el.selectionEnd ?? start;
    // Snap selection to whole lines so the prefix applies cleanly.
    while (start > 0 && value[start - 1] !== "\n") start--;
    while (end < value.length && value[end] !== "\n") end++;
    const block = value.slice(start, end);
    const next = value.slice(0, start)
      + block.split("\n").map((l) => `${prefix}${l}`).join("\n")
      + value.slice(end);
    onChange(next);
    const newCaret = end + (block.split("\n").length * prefix.length);
    requestAnimationFrame(() => {
      const el2 = inputRef.current;
      if (!el2) return;
      el2.focus();
      el2.setSelectionRange(newCaret, newCaret);
      setCaret(newCaret);
    });
  }

  /**
   * Link / image insertion: prompts for a URL (rejects empty),
   * wraps the selection (or a placeholder) as `[text](url)` or
   * `![alt](url)` depending on `kind`. Reuses `wrapSelection`'s
   * before/after model, then patches the URL into the suffix.
   */
  function insertLinkOrImage(kind: "link" | "image"): void {
    const url = window.prompt(kind === "image" ? "Image URL (http:// or https://):" : "Link URL (http:// or https://):");
    if (!url) return;
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      window.alert("URL must start with http:// or https://");
      return;
    }
    const before = kind === "image" ? "![" : "[";
    const after = `](${trimmed})`;
    wrapSelection(before, after, kind === "image" ? "alt" : "link text");
  }

  // Forum-mode state derivations. The composer has four distinct
  // shapes in a forum room: disabled (no topic), topic-create, reply,
  // and locked (topic exists but won't accept replies from this
  // viewer). Flat rooms ignore all of this and fall through to the
  // chat composer.
  //
  // Moderators bypass the locked-state input disable — they can still
  // post moderation notes in locked threads. `forumReplying` covers
  // both the "topic isn't locked" and "topic IS locked but I'm a mod"
  // cases so the textarea behaves identically; the indicator strip
  // changes copy when locked + canModerate to make the override
  // visible.
  const forumDisabled = !!isForumRoom && !topicCreateMode && !activeTopic;
  const forumLockedForViewer =
    !!isForumRoom && !!activeTopic && activeTopic.locked && !topicCreateMode && !canModerate;
  const forumLockedModOverride =
    !!isForumRoom && !!activeTopic && activeTopic.locked && !topicCreateMode && !!canModerate;
  const forumReplying =
    !!isForumRoom && !!activeTopic && !topicCreateMode && !forumLockedForViewer;
  const forumCreating = !!isForumRoom && !!topicCreateMode;
  // Textarea / Send are inert when the surrounding context can't
  // accept input. Locked threads block sending for non-mods; the
  // server is authoritative and re-rejects on submit anyway.
  const inputDisabled = forumDisabled || forumLockedForViewer;
  const submitDisabled =
    inputDisabled ||
    (forumCreating && !topicTitle.trim()) ||
    !value.trim();

  return (
    <form
      onSubmit={submit}
      // `min-h-[5.25rem]` + `justify-end` keep the composer wrapper the
      // same height as the right-rail's bottom strip (identity-button +
      // Tools-trigger stacked), so the two bottom rails align visually
      // at the chat's lower edge instead of the composer hovering an
      // inch above. Extra rows the composer renders in forum / reply
      // modes still grow it past the minimum; the floor only matters
      // in the simple "send a chat message" state.
      className="keep-composer flex min-h-[5.25rem] flex-col justify-end gap-1 border-t border-keep-rule bg-keep-banner/50 p-2"
    >
      {/* Forum-mode disabled state — composer is locked until the user
          picks a topic or starts a new one. The "New Topic" button is
          the primary call-to-action in this state. */}
      {forumDisabled ? (
        <div className="flex items-center justify-between gap-2 rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-1 text-xs text-keep-muted">
          {/* `min-w-0 flex-1` lets the long hint shrink + wrap on narrow
              viewports instead of pushing the "+ New Topic" button off
              the right edge. Default flex items have `min-width: auto`
              which means "as wide as the intrinsic content" — and a
              one-line sentence in English has no good wrap point, so
              without this it forces horizontal overflow on mobile. */}
          <span className="min-w-0 flex-1">This room is a forum — pick a topic to reply, or start a new one.</span>
          {onStartTopicCreate ? (
            <button
              type="button"
              onClick={onStartTopicCreate}
              className="shrink-0 rounded border border-keep-action/60 bg-keep-action/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/20"
            >
              + New Topic
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Forum-mode "locked, can't reply" indicator. The viewer has an
          active topic but it's been locked AND they aren't a mod, so
          input is disabled. Leave-thread is still offered so they can
          back out and pick another topic. */}
      {forumLockedForViewer ? (
        <div className="flex items-center justify-between gap-2 rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-1 text-xs text-keep-muted">
          <span className="min-w-0 truncate">
            <span className="mr-1" aria-hidden>🔒</span>
            <b>{topicLabel(activeTopic!)}</b> is locked — no new replies.
          </span>
          {onLeaveThread ? (
            <button
              type="button"
              onClick={onLeaveThread}
              className="keep-button shrink-0 rounded border border-keep-rule/60 bg-keep-bg px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:bg-keep-banner hover:text-keep-text"
              title="Leave this topic"
            >
              Leave thread
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Forum-mode "replying" indicator. Two variants:
            - normal:  active topic is unlocked — standard accent strip.
            - mod override: active topic is locked but the viewer is a
              moderator. Input stays enabled so they can post a verdict
              or notice, but the strip swaps to a muted-amber lock
              indicator so the override is unmistakable. */}
      {forumReplying ? (
        forumLockedModOverride ? (
          <div className="flex items-center justify-between gap-2 rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">
            <span className="min-w-0 truncate">
              <span className="mr-1" aria-hidden>🔒</span>
              <span className="mr-1 text-[10px] uppercase tracking-widest opacity-70">Locked — replying as moderator</span>
              <b>{topicLabel(activeTopic!)}</b>
            </span>
            {onLeaveThread ? (
              <button
                type="button"
                onClick={onLeaveThread}
                className="keep-button shrink-0 rounded border border-keep-rule/60 bg-keep-bg px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:bg-keep-banner hover:text-keep-text"
                title="Leave this topic"
              >
                Leave thread
              </button>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 rounded border border-keep-action/40 bg-keep-action/10 px-2 py-1 text-xs text-keep-action">
            <span className="min-w-0 truncate">
              <span className="mr-1 text-[10px] uppercase tracking-widest opacity-70">Replying to</span>
              <b>{topicLabel(activeTopic!)}</b>
            </span>
            {onLeaveThread ? (
              <button
                type="button"
                onClick={onLeaveThread}
                className="keep-button shrink-0 rounded border border-keep-rule/60 bg-keep-bg px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:bg-keep-banner hover:text-keep-text"
                title="Stop replying to this topic"
              >
                Leave thread
              </button>
            ) : null}
          </div>
        )
      ) : null}

      {/* Forum-mode "create topic" form — title input + category select
          stacked above the body textarea below. */}
      {forumCreating ? (
        <div className="flex flex-col gap-1 rounded border border-keep-action/40 bg-keep-action/5 p-2">
          <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-widest text-keep-action">
            <span>New topic</span>
            {onCancelTopicCreate ? (
              <button
                type="button"
                onClick={onCancelTopicCreate}
                // Tap-target sizing: comfortable 32px height on mobile
                // so the cancel-out path is easy to hit; md+ stays
                // compact since pointer precision is higher.
                className="keep-button flex h-8 items-center rounded border border-keep-rule/60 bg-keep-bg px-3 normal-case tracking-normal text-keep-muted hover:bg-keep-banner hover:text-keep-text md:h-6 md:px-2"
              >
                Cancel
              </button>
            ) : null}
          </div>
          <input
            type="text"
            value={topicTitle}
            onChange={(e) => setTopicTitle(e.target.value)}
            maxLength={120}
            placeholder="Topic title"
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
          />
          {threadCategories && threadCategories.length > 0 ? (
            <label className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-keep-muted">
              <span>Category:</span>
              <select
                value={effectiveCategoryId ?? ""}
                onChange={(e) => setAndPersistCategory(e.target.value || null)}
                className="rounded border border-keep-rule bg-keep-bg px-1 py-0.5 normal-case tracking-normal text-keep-text"
              >
                <option value="">Uncategorized</option>
                {threadCategories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}

      {/* Legacy thread-category picker for FLAT rooms that still have
          categories defined (a nested room that was flipped back, or
          a flat room with stale category rows). In nested rooms the
          picker now lives inside the topic-create form above; here
          it only renders for the legacy / flat case. */}
      {!isForumRoom && showCategoryPicker ? (
        <label className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-keep-muted">
          <span aria-hidden>🧵</span>
          <span>Thread:</span>
          <select
            value={effectiveCategoryId ?? ""}
            onChange={(e) => setAndPersistCategory(e.target.value || null)}
            className="rounded border border-keep-rule bg-keep-bg px-1 py-0.5 normal-case tracking-normal text-keep-text"
          >
            <option value="">Uncategorized</option>
            {threadCategories!.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
      ) : null}

      {/* Formatting toolbar. Compact icon row above the textarea —
          each button wraps the current selection with the relevant
          markdown markers, or inserts the markers around a placeholder
          when nothing is selected. Hidden when the input is disabled
          (forum-locked-for-viewer or no-active-topic states) since
          formatting a blocked compose makes no sense. */}
      {!inputDisabled ? (
        // Compact toolbar row. On mobile the rooms-drawer trigger (💬)
        // lives at the LEFT of this row with a thin vertical divider
        // after it, freeing the input row below from a 40px-wide
        // shrink-0 column — that column was eating into the textarea's
        // width and limiting how much of a long message could be
        // visible. md+ has the rail always visible, so the 💬 + divider
        // are hidden and the toolbar's first item is the Bold button.
        <div className="flex flex-wrap items-center gap-0.5 text-xs">
          {onOpenRail ? (
            <>
              {/* Sizing mirrors FmtButton (`h-8 w-8 text-sm leading-none`)
                  so the rooms toggle sits flush with the format buttons
                  to its right — different fixed-height classes were the
                  source of the misaligned bottom edge. */}
              <button
                type="button"
                onClick={onOpenRail}
                aria-label="Open rooms"
                title="Rooms"
                className="keep-button mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded border border-keep-rule/60 bg-keep-bg/60 text-sm leading-none hover:bg-keep-banner md:hidden"
              >
                💬
              </button>
              <span aria-hidden className="mr-1 h-5 w-px shrink-0 bg-keep-rule/60 md:hidden" />
            </>
          ) : null}
          <FmtButton title="Bold (Ctrl+B)" onClick={() => wrapSelection("**", "**", "bold")}>
            <b>B</b>
          </FmtButton>
          <FmtButton title="Italic (Ctrl+I)" onClick={() => wrapSelection("*", "*", "italic")}>
            <i>I</i>
          </FmtButton>
          {/* Underline has no markdown equivalent (CommonMark reserves
              `__` for bold-alt), so we wrap selection in literal <u>…</u>
              and the inline parser recognizes the HTML tag as an alias.
              Same render path as the markdown buttons; the stored body
              just happens to keep the tag. */}
          <FmtButton title="Underline" onClick={() => wrapSelection("<u>", "</u>", "underline")}>
            <u>U</u>
          </FmtButton>
          <FmtButton title="Strikethrough" onClick={() => wrapSelection("~~", "~~", "strikethrough")}>
            <s>S</s>
          </FmtButton>
          <FmtButton title="Inline code" onClick={() => wrapSelection("`", "`", "code")}>
            <span className="font-mono">{"<>"}</span>
          </FmtButton>
          <FmtButton title="Spoiler (click to reveal)" onClick={() => wrapSelection("||", "||", "spoiler")}>
            <span aria-hidden>👁</span>
          </FmtButton>
          <FmtButton title="Blockquote — prefixes selected lines with '> '" onClick={() => prefixLines("> ")}>
            <span aria-hidden>❝</span>
          </FmtButton>
          <FmtButton title="Link — wraps selection as [text](url)" onClick={() => insertLinkOrImage("link")}>
            <span aria-hidden>🔗</span>
          </FmtButton>
          <FmtButton title="Image — inserts ![alt](url)" onClick={() => insertLinkOrImage("image")}>
            <span aria-hidden>🖼</span>
          </FmtButton>
        </div>
      ) : null}

      {/* The rooms-drawer trigger (💬) used to live here as a leading
          shrink-0 button. It's been relocated into the formatting
          toolbar row on mobile (md+ never had it), which gives the
          textarea full row-width and lets longer messages show more
          lines without scrolling. */}
      <div className="flex items-stretch gap-2">
      <div className="relative flex-1">
        {/* The popup positions itself above the textarea via bottom-full. */}
        <CompleterPopup
          items={items}
          selectedIndex={selectedIndex}
          onSelect={setSelectedIndex}
          onAccept={acceptItem}
        />
        {/* Thesaurus popup. Same anchor strategy as CompleterPopup
            (absolute, bottom-full) so highlighting a word in chat /
            forum messages pops a list of synonyms above the
            textarea — Enter or click swaps the highlighted word for
            the chosen synonym. */}
        <SynonymPopup inputRef={inputRef} value={value} onChange={onChange} />
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
          // enterKeyHint relabels the on-screen keyboard's return key to
          // "Send" so mobile users see the right affordance — Enter
          // submits, the dedicated ↵ button (mobile-only) inserts a
          // newline.
          enterKeyHint="send"
          disabled={inputDisabled}
          placeholder={
            placeholder ??
            (forumDisabled
              ? "Pick a topic or start a new one to post."
              : forumLockedForViewer
                ? "This topic is locked — no new replies."
                : forumCreating
                  ? "First post of the new topic..."
                  : forumLockedModOverride
                    ? `Post a moderator reply to "${topicLabel(activeTopic!)}"...`
                    : forumReplying
                      ? `Reply to "${topicLabel(activeTopic!)}"...`
                      : "Type a message... (Shift+Enter for a new line)")
          }
          // text-base on mobile prevents iOS Safari from auto-zooming on focus
          // (anything below 16px triggers zoom). md+ keeps our compact size.
          // resize-none + auto-grow effect manages height; leading-snug keeps
          // line spacing tight so multi-line posts don't waste vertical room.
          //
          // Mobile min-height (`min-h-[68px]`) is tuned to match the right
          // column's natural height — ↵ (h-6 = 24px) + gap-1 (4px) + Send
          // (h-10 = 40px) — so a single-line empty textarea sits flush with
          // the column instead of leaving dead space below it. md+ keeps
          // the tight `min-h-8` because the ↵ button is hidden and Send
          // alone is only 32px tall. The auto-grow effect respects this
          // min via `el.style.height = "auto"` → scrollHeight measurement,
          // which folds min-height into the natural metric.
          className="block min-h-[68px] w-full resize-none rounded border border-keep-rule bg-keep-bg px-3 py-2 text-base leading-snug outline-none focus:border-keep-action disabled:cursor-not-allowed disabled:opacity-50 md:min-h-8 md:py-1 md:text-sm"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
        />
      </div>
      {/* Right column. On mobile the ↵ (newline) button stacks compact
          on top of Send so the two share a single vertical strip,
          freeing the textarea to fill the entire row width AND grow
          taller (the column's total height pushes the items-stretch
          textarea past its 40px floor for longer messages). On md+
          the ↵ is hidden (Shift+Enter works on a real keyboard) and
          the column collapses to just Send.
          `justify-end` pins both buttons to the bottom of the column
          so that when the textarea auto-grows to multiple lines the
          buttons stay near the keyboard / cursor line instead of
          floating up at the top of an oversized strip. */}
      <div className="flex shrink-0 flex-col justify-end gap-1">
        <button
          type="button"
          onClick={insertNewline}
          disabled={inputDisabled}
          aria-label="Insert line break"
          title="Insert line break"
          className="keep-button flex h-6 items-center justify-center rounded border border-keep-rule bg-keep-bg px-2 text-sm hover:bg-keep-banner disabled:cursor-not-allowed disabled:opacity-50 md:hidden"
        >
          ↵
        </button>
        <button
          type="submit"
          disabled={submitDisabled}
          // h-10 mobile / md:h-8 desktop. The mobile column is now
          // ↵ (h-6) + gap (4px) + Send (h-10) = 68px total, which
          // becomes the row's natural height via items-stretch — the
          // textarea grows to match, giving longer messages noticeably
          // more visible space.
          className="keep-button h-10 shrink-0 rounded border border-keep-rule bg-keep-bg px-4 text-sm hover:bg-keep-banner disabled:cursor-not-allowed disabled:opacity-50 md:h-8"
        >
          {forumCreating ? "Post topic" : forumReplying ? "Reply" : "Send"}
        </button>
      </div>
      </div>
    </form>
  );
}

/**
 * Compact formatting-button helper for the Composer toolbar. Matches
 * the visual weight of the rail toggle / Send button (subtle border +
 * banner-tinted hover) so the strip reads as part of the same input.
 * onMouseDown.preventDefault keeps focus on the textarea — without it,
 * clicking a button would steal focus and the selection would
 * disappear before the wrap-handler runs.
 */
function FmtButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      // Square `h-8 w-8` (32px) — previously `h-7 min-w-7 px-1.5`,
      // which let the `<>` button stretch wider than the single-char
      // buttons and let emoji glyphs (👁 ❝ 🔗 🖼) inflate the visual
      // bounds inconsistently across single-char text labels (B I S).
      // Forcing equal dimensions + `text-sm leading-none` normalizes
      // the row on mobile (which is where the misalignment was most
      // visible, because mobile renders emoji and text with bigger
      // baseline differences than desktop).
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-keep-rule/60 bg-keep-bg/60 text-sm leading-none text-keep-muted hover:bg-keep-banner hover:text-keep-text"
    >
      {children}
    </button>
  );
}
