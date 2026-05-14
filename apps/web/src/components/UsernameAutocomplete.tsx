import { useEffect, useRef, useState } from "react";

interface Suggestion {
  username: string;
  /** Active character name when the user is currently in-character, else null. */
  characterName: string | null;
  avatarUrl: string | null;
  online: boolean;
}

/**
 * Lightweight username autocomplete for the Messages modal's add-friend
 * and compose-to-non-friend inputs.
 *
 * Why a new component instead of reusing the main composer's
 * CompleterPopup? CompleterPopup is tied to the textarea + caret-
 * position model used by `@mentions` mid-message. The Messenger inputs
 * are single-purpose username entry fields where the WHOLE value is
 * the username — caret slicing isn't applicable. A tighter, focused
 * component reads more clearly than bending the chat completer.
 *
 * Behavior:
 *   - Debounced fetch (~150ms) to `/users?q=<value>&limit=8` after
 *     the user has typed at least one character.
 *   - Arrow keys navigate the list, Enter picks the highlighted
 *     suggestion (and submits the parent form via the input's normal
 *     enterKeyHint flow if no suggestion is picked).
 *   - Click also picks. Esc closes the popup without picking.
 *   - Picking writes the canonical *master username* back into the
 *     input — that's what /friend / DM lookups resolve, even when a
 *     character is currently active.
 */
export function UsernameAutocomplete({
  value,
  onChange,
  onPick,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Called when the user explicitly picks a suggestion. Receives the master username. */
  onPick: (username: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [highlightedIdx, setHighlightedIdx] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Track the request that's currently in flight so an older response
  // doesn't overwrite a newer one (the user typed past it).
  const reqIdRef = useRef(0);

  // Debounced fetch. Bare-minimum debounce (150ms) is enough for the
  // typing latency to settle without making the dropdown feel laggy.
  useEffect(() => {
    const q = value.trim();
    if (q.length < 1) { setSuggestions([]); return; }
    const myReqId = ++reqIdRef.current;
    const t = window.setTimeout(() => {
      fetch(`/users?q=${encodeURIComponent(q)}&limit=8`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (myReqId !== reqIdRef.current) return; // stale
          if (!j || !Array.isArray(j.users)) { setSuggestions([]); return; }
          const next: Suggestion[] = j.users.map((u: {
            username: string;
            avatarUrl: string | null;
            online: boolean;
            characters?: Array<{ id: string; name: string }>;
            activeCharacterId?: string | null;
          }) => {
            // Show the user's active character name when they're in-
            // character — matches how the rest of the app refers to them.
            const activeChar = u.activeCharacterId && u.characters
              ? u.characters.find((c) => c.id === u.activeCharacterId)
              : undefined;
            return {
              username: u.username,
              characterName: activeChar ? activeChar.name : null,
              avatarUrl: u.avatarUrl,
              online: u.online,
            };
          });
          setSuggestions(next);
          setHighlightedIdx(0);
          setOpen(true);
        })
        .catch(() => { if (myReqId === reqIdRef.current) setSuggestions([]); });
    }, 150);
    return () => window.clearTimeout(t);
  }, [value]);

  function pick(s: Suggestion) {
    onChange(s.username);
    setOpen(false);
    setSuggestions([]);
    onPick(s.username);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      // Prefer the highlighted suggestion if the dropdown is open. The
      // parent form's submit still fires for the raw typed value if the
      // dropdown is closed (or empty), so power users who already know
      // the exact name can keep typing + Enter without ever opening
      // the suggestions.
      const s = suggestions[highlightedIdx];
      if (s) {
        e.preventDefault();
        pick(s);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="relative min-w-0 flex-1">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onKeyDown={onKeyDown}
        onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
        // `onBlur` deferred by a tick so a click on a suggestion in the
        // dropdown fires its onMouseDown handler before we tear the list
        // down. Without the timeout the click would resolve into a blur
        // → close → empty pointer target.
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action disabled:opacity-50"
        autoComplete="off"
      />
      {open && suggestions.length > 0 ? (
        <ul
          role="listbox"
          className="absolute bottom-full left-0 z-30 mb-1 max-h-52 w-full overflow-y-auto rounded border border-keep-rule bg-keep-bg shadow-2xl"
        >
          {suggestions.map((s, i) => (
            <li key={s.username}>
              <button
                type="button"
                // onMouseDown so the click lands BEFORE the input's blur
                // closes the list. onClick would race with the deferred
                // onBlur in some browsers (Safari particularly).
                onMouseDown={(e) => { e.preventDefault(); pick(s); }}
                onMouseEnter={() => setHighlightedIdx(i)}
                className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs ${
                  i === highlightedIdx ? "bg-keep-banner/60" : "hover:bg-keep-banner/40"
                }`}
              >
                {s.avatarUrl ? (
                  <img
                    src={s.avatarUrl}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="h-6 w-6 shrink-0 rounded border border-keep-rule object-cover"
                  />
                ) : (
                  <span className="h-6 w-6 shrink-0 rounded border border-keep-rule bg-keep-banner" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-semibold text-keep-text">{s.username}</span>
                  {s.characterName ? (
                    <span className="ml-1 text-keep-muted">as {s.characterName}</span>
                  ) : null}
                </span>
                {s.online ? (
                  <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" title="online" />
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
