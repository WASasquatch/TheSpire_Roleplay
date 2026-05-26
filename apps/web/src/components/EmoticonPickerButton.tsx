import { useRef, useState } from "react";
import { EmoticonPicker } from "./EmoticonPicker.js";

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
  disabled,
  className = "inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded border border-transparent px-1 text-xs leading-none hover:border-keep-rule hover:bg-keep-banner/40 disabled:opacity-40",
  title = "Insert emoticon",
}: {
  onPick: (sheetSlug: string, cellIndex: number) => void;
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
        // from the input — the picker's onPick callback can then act on
        // the input's current selection without the browser refocusing
        // first and resetting the caret.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className={className}
      >
        <span aria-hidden>😊</span>
      </button>
      {open ? (
        <EmoticonPicker
          anchor={buttonRef.current}
          onClose={() => setOpen(false)}
          onPick={(slug, idx) => {
            setOpen(false);
            onPick(slug, idx);
          }}
        />
      ) : null}
    </>
  );
}
