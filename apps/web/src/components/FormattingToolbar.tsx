import { useRef, type RefObject } from "react";
import {
  Bold,
  Code,
  Eye,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  Palette,
  Quote,
  Strikethrough,
  Underline,
} from "lucide-react";
import { EmoticonPickerButton } from "./EmoticonPickerButton.js";

/**
 * Compact bar of formatting buttons that sits above a chat / DM input.
 *
 * Every button mutates the input's value by wrapping (or inserting) a
 * markdown construct around the current selection, then restores focus
 * and positions the cursor sensibly so the user can keep typing.
 *
 * Why a shared component? Both the main Composer and the DM
 * ThreadPane want the same affordance, and the cursor / selection
 * math is annoying enough that a single implementation pays for
 * itself the second time it would otherwise have been copy-pasted.
 *
 * Markdown formats produced match what `parseInline` already renders
 * everywhere in the app (room chat, forum replies, DMs, profile/world
 * mention links), so what you see while typing matches what other
 * users see on receive.
 */
export function FormattingToolbar({
  inputRef,
  value,
  onChange,
  /** Optional override of the disabled state for the whole row. */
  disabled,
  /** When set, renders a right-aligned `length / max` counter on the
   *  toolbar so the user can see how close they are to the cap. The
   *  caller is also responsible for blocking submit when over the
   *  cap (this component is presentational only, it doesn't gate
   *  the input). */
  maxLength,
}: {
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  maxLength?: number;
}) {
  /**
   * Core mutation: wrap whatever's selected (or insert at the caret
   * when nothing is selected) with the given prefix + suffix.
   *
   * `placeholder` is the literal that lands between the delimiters
   * when the user clicked a button without selecting anything. We
   * highlight it in the new selection so the user can immediately
   * type to replace it.
   */
  function wrap(prefix: string, suffix: string, placeholder = "") {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    const selected = value.slice(start, end);
    const after = value.slice(end);
    const inner = selected.length > 0 ? selected : placeholder;
    const next = before + prefix + inner + suffix + after;
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const innerStart = start + prefix.length;
      const innerEnd = innerStart + inner.length;
      el.setSelectionRange(innerStart, innerEnd);
    });
  }

  /**
   * Text color. A hidden native `<input type="color">` provides the picker
   * (the OS color wheel; works on desktop + mobile, no extra UI to build).
   * We snapshot the textarea selection BEFORE opening it, because the
   * picker dialog blurs the input — then on pick we wrap that selection in
   * `<font color="#hex">…</font>`, the same construct `parseInline` renders
   * for everyone. No selection → wraps a "text" placeholder, left selected
   * so the user can type over it.
   */
  const colorInputRef = useRef<HTMLInputElement>(null);
  const colorSelRef = useRef<{ start: number; end: number } | null>(null);
  function openColorPicker() {
    const el = inputRef.current;
    if (el) colorSelRef.current = { start: el.selectionStart ?? value.length, end: el.selectionEnd ?? value.length };
    const picker = colorInputRef.current;
    if (!picker) return;
    // Open via `showPicker()` — Firefox silently ignores a programmatic
    // `.click()` on this hidden (zero-size / pointer-events:none) color
    // input, so the button did nothing there. `.click()` stays as the
    // fallback for engines without showPicker. Local cast so we don't
    // depend on the ambient lib.dom version typing showPicker.
    const withPicker = picker as HTMLInputElement & { showPicker?: () => void };
    try {
      if (typeof withPicker.showPicker === "function") withPicker.showPicker();
      else picker.click();
    } catch {
      picker.click();
    }
  }
  function applyColor(hex: string) {
    const el = inputRef.current;
    if (!el) return;
    const sel = colorSelRef.current ?? { start: value.length, end: value.length };
    const before = value.slice(0, sel.start);
    const selected = value.slice(sel.start, sel.end);
    const after = value.slice(sel.end);
    const inner = selected.length > 0 ? selected : "text";
    const open = `<font color="${hex}">`;
    const next = `${before}${open}${inner}</font>${after}`;
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const innerStart = sel.start + open.length;
      el.setSelectionRange(innerStart, innerStart + inner.length);
    });
  }

  /**
   * Link / image inserters prompt for the URL (and alt text for image)
   * via the native window.prompt. Not pretty but it's the standard
   * pattern for one-shot URL entry; a modal would be overkill for a
   * single field and would interrupt the typing flow more than the
   * prompt does.
   */
  function insertLink() {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const selected = value.slice(start, end);
    const url = window.prompt("Link URL (https://…)", "https://");
    if (!url) return;
    const text = selected.length > 0 ? selected : (window.prompt("Link text", "") ?? "");
    if (!text) {
      // No text → just paste the bare URL. parseInline auto-links it.
      const next = value.slice(0, start) + url + value.slice(end);
      onChange(next);
      return;
    }
    const md = `[${text}](${url})`;
    const next = value.slice(0, start) + md + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + md.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function insertImage() {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? value.length;
    const url = window.prompt("Image URL (https://… ending in .png/.jpg/.webp/etc.)", "https://");
    if (!url) return;
    const alt = window.prompt("Alt text (optional)", "") ?? "";
    const md = `![${alt}](${url})`;
    const next = value.slice(0, start) + md + value.slice(start);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + md.length;
      el.setSelectionRange(pos, pos);
    });
  }

  /**
   * Blockquote: prefix every line in the current selection with "> ".
   * No selection → snap to the current line. Matches the room-chat
   * composer's Quote button.
   */
  /**
   * Insert a literal string at the caret position (replacing any
   * current selection). Used for inline emoticon tokens, no
   * wrapping, just paste-and-advance-the-caret.
   */
  function insertAtCursor(literal: string) {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + literal + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + literal.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function prefixLines(prefix: string) {
    const el = inputRef.current;
    if (!el) return;
    let start = el.selectionStart ?? value.length;
    let end = el.selectionEnd ?? start;
    while (start > 0 && value[start - 1] !== "\n") start--;
    while (end < value.length && value[end] !== "\n") end++;
    const block = value.slice(start, end);
    const next = value.slice(0, start)
      + block.split("\n").map((l) => `${prefix}${l}`).join("\n")
      + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const newCaret = end + (block.split("\n").length * prefix.length);
      el.setSelectionRange(newCaret, newCaret);
    });
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-0.5 text-keep-muted">
      {/* Lucide icons (uniform stroke set) replaced the old letter + emoji
          mix; FmtBtn supplies the title/aria-label so the icons stay
          self-describing on hover and to screen readers. */}
      <FmtBtn label="Bold (**text**)" onClick={() => wrap("**", "**", "bold")} disabled={disabled}>
        <Bold className="h-3.5 w-3.5" aria-hidden="true" />
      </FmtBtn>
      <FmtBtn label="Italic (*text*)" onClick={() => wrap("*", "*", "italic")} disabled={disabled}>
        <Italic className="h-3.5 w-3.5" aria-hidden="true" />
      </FmtBtn>
      {/* Underline has no CommonMark equivalent (markdown reserves `__`
          for bold-alternate) so we wrap with literal <u>…</u>; the
          inline parser recognises the tag as an alias. Stored body
          keeps the tag, same as the room-chat composer. */}
      <FmtBtn label="Underline" onClick={() => wrap("<u>", "</u>", "underline")} disabled={disabled}>
        <Underline className="h-3.5 w-3.5" aria-hidden="true" />
      </FmtBtn>
      <FmtBtn label="Strikethrough (~~text~~)" onClick={() => wrap("~~", "~~", "strike")} disabled={disabled}>
        <Strikethrough className="h-3.5 w-3.5" aria-hidden="true" />
      </FmtBtn>
      {/* Text color: opens the OS color picker, wraps the selection in
          <font color="#hex">. The input is visually hidden but focusable
          via openColorPicker()'s programmatic click. */}
      <FmtBtn label="Color selected text" onClick={openColorPicker} disabled={disabled}>
        <Palette className="h-3.5 w-3.5" aria-hidden="true" />
      </FmtBtn>
      <input
        ref={colorInputRef}
        type="color"
        defaultValue="#ff5555"
        aria-hidden="true"
        tabIndex={-1}
        className="pointer-events-none absolute h-0 w-0 opacity-0"
        onChange={(e) => applyColor(e.target.value)}
      />
      <FmtBtn label="Inline code (`text`)" onClick={() => wrap("`", "`", "code")} disabled={disabled}>
        <Code className="h-3.5 w-3.5" aria-hidden="true" />
      </FmtBtn>
      <FmtBtn label="Spoiler (||text||, click to reveal)" onClick={() => wrap("||", "||", "spoiler")} disabled={disabled}>
        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
      </FmtBtn>
      <FmtBtn label="Blockquote, prefixes selected lines with '> '" onClick={() => prefixLines("> ")} disabled={disabled}>
        <Quote className="h-3.5 w-3.5" aria-hidden="true" />
      </FmtBtn>
      <span aria-hidden className="mx-1 h-3 w-px bg-keep-rule/60" />
      <FmtBtn label="Link, [text](url)" onClick={insertLink} disabled={disabled}>
        <LinkIcon className="h-3.5 w-3.5" aria-hidden="true" />
      </FmtBtn>
      <FmtBtn label="Image, ![alt](url)" onClick={insertImage} disabled={disabled}>
        <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />
      </FmtBtn>
      <span aria-hidden className="mx-1 h-3 w-px bg-keep-rule/60" />
      {/* Inline emoticon: opens the picker anchored to the button;
       *  on pick, inserts the `:slug:idx:` token at the caret so the
       *  rendered message body shows the sprite inline. */}
      <EmoticonPickerButton
        disabled={disabled}
        onPick={(slug, idx) => insertAtCursor(`:${slug}:${idx}:`)}
        onPickUnicode={(char) => insertAtCursor(char)}
      />
      {maxLength !== undefined ? (
        <CharCount length={value.trimEnd().length} max={maxLength} />
      ) : null}
    </div>
  );
}

/** Right-aligned character counter rendered at the end of the
 *  formatting row. Three-tier tint mirrors the chat Composer's
 *  ComposerCharCount: muted at rest, amber past 80% of cap, accent
 *  + bold when over the cap. Presentational only, submit gating
 *  is the caller's responsibility. */
function CharCount({ length, max }: { length: number; max: number }) {
  const over = length > max;
  const near = !over && length > max * 0.8;
  const tint = over
    ? "text-keep-accent font-semibold"
    : near
      ? "text-amber-500"
      : "text-keep-muted";
  return (
    <span
      aria-live="polite"
      aria-label={`Character count: ${length} of ${max}`}
      title={`${length} / ${max} characters`}
      className={`ml-auto select-none whitespace-nowrap text-[11px] tabular-nums ${tint}`}
    >
      {length} / {max}
      <span className="ml-1 hidden lg:inline">Chars</span>
    </span>
  );
}

/** Single toolbar button. Tabular sizing so different glyph widths
 *  don't make the row dance. */
function FmtBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  // `boolean | undefined` (not `boolean?: …`) so callers can forward
  // an optional outer prop without tripping exactOptionalPropertyTypes.
  disabled: boolean | undefined;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      // `onMouseDown preventDefault` stops the button from stealing
      // focus from the input, without it, the caret jumps and the
      // selection math we set in setSelectionRange gets overwritten
      // by the browser refocusing the form after the button blurs.
      onMouseDown={(e) => e.preventDefault()}
      className="inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded border border-transparent px-1 text-xs leading-none hover:border-keep-rule hover:bg-keep-banner/40 disabled:opacity-40"
    >
      {children}
    </button>
  );
}
