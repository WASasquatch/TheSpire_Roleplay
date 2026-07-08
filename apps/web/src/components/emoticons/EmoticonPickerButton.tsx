import { useRef, useState } from "react";
import { Smile } from "lucide-react";
import { EmoticonPicker } from "./EmoticonPicker.js";
import { recordEmoticonPick } from "../../lib/recentEmoticons.js";

/**
 * Toolbar button that opens the emoticon picker and, on pick, hands
 * back the (sheetSlug, cellIndex) pair so the caller can insert the
 * inline-emoticon token (`:slug:idx:`) at the input's cursor.
 *
 * Lives in its own component so the chat composer, the DM composer,
 * and the shared FormattingToolbar can all mount the same trigger
 * without each re-implementing the picker open/close + anchor refs.
 */
export function EmoticonPickerButton({
  onPick,
  onPickUnicode,
  disabled,
  className = "inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded border border-transparent px-1 text-xs leading-none hover:border-keep-rule hover:bg-keep-banner/40 disabled:opacity-40",
  title = "Insert emoticon",
}: {
  onPick: (sheetSlug: string, cellIndex: number) => void;
  /** Optional, when provided the picker surfaces a Unicode tab and
   *  this callback receives the raw character (e.g. "😀") for
   *  insertion at the caret. Call sites that only support sheet-based
   *  tokens omit it. */
  onPickUnicode?: (char: string) => void;
  // `boolean | undefined` (not `disabled?: boolean`) so callers using
  // exactOptionalPropertyTypes can forward an optional outer prop
  // without tripping the strict assignability check.
  disabled?: boolean | undefined;
  /** Override the trigger's class string. Defaults to the same shape
   *  the surrounding formatting buttons use so the row reads as one
   *  cohesive toolbar regardless of where it's mounted. */
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        title={title}
        aria-label={title}
        // `onMouseDown preventDefault` so the click doesn't steal focus
        // from the input, the picker's onPick callback can then act on
        // the input's current selection without the browser refocusing
        // first and resetting the caret.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className={className}
      >
        <Smile className="h-4 w-4" aria-hidden="true" />
      </button>
      {open ? (
        <EmoticonPicker
          anchor={buttonRef.current}
          onClose={() => setOpen(false)}
          onPick={(slug, idx) => {
            setOpen(false);
            // Bump the local recents so composing with an emoticon feeds the
            // "Recent" row (frequency-sorted) the same way reacting does — the
            // more you use one, the higher it climbs. Reactions record via
            // toggleReaction; this is the missing compose/insert side. (The
            // reaction picker uses EmoticonPicker directly, not this button,
            // so there's no double-count.)
            recordEmoticonPick(slug, idx);
            onPick(slug, idx);
          }}
          {...(onPickUnicode
            ? {
                onPickUnicode: (char: string) => {
                  setOpen(false);
                  onPickUnicode(char);
                },
              }
            : {})}
        />
      ) : null}
    </>
  );
}
