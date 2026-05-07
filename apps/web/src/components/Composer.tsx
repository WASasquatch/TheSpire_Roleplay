import { useEffect, useRef, type FormEvent } from "react";

interface Props {
  value: string;
  onChange: (text: string) => void;
  onSend: (text: string) => void;
  /** Mobile-only: open the rooms drawer. Hidden on md+. */
  onOpenRail?: () => void;
}

/**
 * Controlled composer. The parent owns the text so it can inject prefixes
 * like "/whisper Bob " when a name is clicked elsewhere in the UI.
 *
 * When the value changes from outside (parent sets it), we re-focus and
 * place the caret at the end so the user can keep typing immediately.
 */
export function Composer({ value, onChange, onSend, onOpenRail }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lastValueRef = useRef(value);

  useEffect(() => {
    if (value !== lastValueRef.current) {
      lastValueRef.current = value;
      const el = inputRef.current;
      if (el && document.activeElement !== el) {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    }
  }, [value]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const t = value.trim();
    if (!t) return;
    onSend(t);
    onChange("");
  }

  return (
    <form
      onSubmit={submit}
      className="flex items-center gap-2 border-t border-keep-rule bg-keep-banner/50 p-2"
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
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Type a message..."
        // text-base on mobile prevents iOS Safari from auto-zooming on focus
        // (anything below 16px triggers zoom). md+ keeps our compact size.
        className="flex-1 rounded border border-keep-rule bg-keep-bg px-3 py-2 text-base outline-none focus:border-keep-action md:py-1 md:text-sm"
        autoFocus
      />
      <button
        type="submit"
        className="shrink-0 rounded border border-keep-rule bg-keep-bg px-4 py-2 text-sm hover:bg-keep-banner md:py-1"
      >
        Send
      </button>
    </form>
  );
}
