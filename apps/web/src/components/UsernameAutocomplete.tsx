import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AvatarCrop } from "@thekeep/shared";
import { cropStyleFor } from "../lib/avatarCrop.js";
import { useReducedMotion } from "../lib/reducedMotion.js";

/**
 * Identity suggestion from `/identities/autocomplete`. Each entry is
 * its OWN account from the picker's perspective, character matches
 * are first-class rows, not nested under their owning master.
 *
 * `masterUsername` is intentionally NOT rendered on the suggestion
 * card: exposing it leaks the OOC ↔ character relationship the
 * partition contract is meant to hide. Kept on the wire only because
 * the form-submission path needs it for legacy text-input flows.
 */
interface Suggestion {
  kind: "user" | "character";
  userId: string;
  characterId: string | null;
  displayName: string;
  masterUsername: string;
  avatarUrl: string | null;
  avatarCrop: AvatarCrop;
  online: boolean;
}

/**
 * Identity autocomplete for the Messages modal's add-friend and
 * compose-to-non-friend inputs.
 *
 * Why a new component instead of reusing the main composer's
 * CompleterPopup? CompleterPopup is tied to the textarea + caret-
 * position model used by `@mentions` mid-message. The Messenger inputs
 * are single-purpose identity entry fields where the WHOLE value is
 * the target, caret slicing isn't applicable. A tighter, focused
 * component reads more clearly than bending the chat completer.
 *
 * Behavior:
 *   - Debounced fetch (~150ms) to `/identities/autocomplete?q=<value>&limit=8`.
 *   - Arrow keys navigate; Enter picks the highlighted suggestion.
 *   - Click also picks. Esc closes the popup.
 *   - Picking calls `onPick` with the FULL identity tuple so the
 *     caller can route to the right per-identity surface (DM thread,
 *     friend-request POST with explicit `targetCharacterId`, etc.)
 *     without a follow-up name-resolution round-trip.
 *   - The text input is updated to the picked identity's
 *     displayName as a visual confirmation (NOT used downstream,
 *     parents should route off the onPick identity, not the input
 *     value).
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
  /** Called when the user explicitly picks a suggestion. Carries the
   *  full identity tuple, kind, userId, characterId, displayName. */
  onPick: (identity: Suggestion) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation("common");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [highlightedIdx, setHighlightedIdx] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Calm-mode ease: opens ABOVE the input (bottom-full) → slide up. Pure CSS
  // positioning, so the slide transform is safe.
  const reduceMotion = useReducedMotion();
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
      fetch(`/identities/autocomplete?q=${encodeURIComponent(q)}&limit=8`, {
        credentials: "include",
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (myReqId !== reqIdRef.current) return; // stale
          if (!j || !Array.isArray(j.identities)) { setSuggestions([]); return; }
          setSuggestions(j.identities as Suggestion[]);
          setHighlightedIdx(0);
          setOpen(true);
        })
        .catch(() => { if (myReqId === reqIdRef.current) setSuggestions([]); });
    }, 150);
    return () => window.clearTimeout(t);
  }, [value]);

  function pick(s: Suggestion) {
    onChange(s.displayName);
    setOpen(false);
    setSuggestions([]);
    onPick(s);
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
          className={`absolute bottom-full left-0 z-30 mb-1 max-h-52 w-full overflow-y-auto rounded border border-keep-rule bg-keep-bg shadow-2xl${reduceMotion ? " tk-slide-up-in" : ""}`}
        >
          {suggestions.map((s, i) => {
            // Identity-correct key. Two suggestions can share a
            // displayName (the whole point of this refactor), so we
            // can't key on it alone, pair with the id tuple.
            const rowKey = `${s.kind}:${s.characterId ?? s.userId}`;
            const cropStyle = cropStyleFor(s.avatarCrop);
            return (
            <li key={rowKey}>
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
                  // Mask the zoomed image inside a fixed circular slot.
                  // Same overflow-hidden trick BorderedAvatar uses so
                  // `transform: scale()` on the inner img doesn't spill
                  // past the slot boundary.
                  <span className="block h-6 w-6 shrink-0 overflow-hidden rounded border border-keep-rule">
                    <img
                      src={s.avatarUrl}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover"
                      style={cropStyle}
                    />
                  </span>
                ) : (
                  <span className="h-6 w-6 shrink-0 rounded border border-keep-rule bg-keep-banner" aria-hidden />
                )}
                {/* Per the project's "characters are their own
                    accounts" contract, the suggestion shows ONLY the
                    identity's display name. No `as <master>` qualifier
                    even when the identity is a character, exposing
                    that label would leak the OOC/character relationship
                    a privacy-conscious user has every reason to keep
                    separate from public surfaces. */}
                <span className="min-w-0 flex-1 truncate font-semibold text-keep-text">
                  {s.displayName}
                </span>
                {s.online ? (
                  <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" title={t("presence.online")} />
                ) : null}
              </button>
            </li>
          );
          })}
        </ul>
      ) : null}
    </div>
  );
}
