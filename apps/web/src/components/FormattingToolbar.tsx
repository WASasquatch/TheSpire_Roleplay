import type { RefObject } from "react";

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
}: {
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
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
      <FmtBtn label="Bold (**text**)" onClick={() => wrap("**", "**", "bold")} disabled={disabled}>
        <b>B</b>
      </FmtBtn>
      <FmtBtn label="Italic (*text*)" onClick={() => wrap("*", "*", "italic")} disabled={disabled}>
        <i>I</i>
      </FmtBtn>
      {/* Underline has no CommonMark equivalent (markdown reserves `__`
          for bold-alternate) so we wrap with literal <u>…</u>; the
          inline parser recognises the tag as an alias. Stored body
          keeps the tag, same as the room-chat composer. */}
      <FmtBtn label="Underline" onClick={() => wrap("<u>", "</u>", "underline")} disabled={disabled}>
        <u>U</u>
      </FmtBtn>
      <FmtBtn label="Strikethrough (~~text~~)" onClick={() => wrap("~~", "~~", "strike")} disabled={disabled}>
        <s>S</s>
      </FmtBtn>
      <FmtBtn label="Inline code (`text`)" onClick={() => wrap("`", "`", "code")} disabled={disabled}>
        <span className="font-mono">{`<>`}</span>
      </FmtBtn>
      <FmtBtn label="Spoiler (||text|| — click to reveal)" onClick={() => wrap("||", "||", "spoiler")} disabled={disabled}>
        <span aria-hidden>👁</span>
      </FmtBtn>
      <FmtBtn label="Blockquote — prefixes selected lines with '> '" onClick={() => prefixLines("> ")} disabled={disabled}>
        <span aria-hidden>❝</span>
      </FmtBtn>
      <span aria-hidden className="mx-1 h-3 w-px bg-keep-rule/60" />
      <FmtBtn label="Link — [text](url)" onClick={insertLink} disabled={disabled}>
        🔗
      </FmtBtn>
      <FmtBtn label="Image — ![alt](url)" onClick={insertImage} disabled={disabled}>
        🖼
      </FmtBtn>
    </div>
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
      // focus from the input — without it, the caret jumps and the
      // selection math we set in setSelectionRange gets overwritten
      // by the browser refocusing the form after the button blurs.
      onMouseDown={(e) => e.preventDefault()}
      className="inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded border border-transparent px-1 text-xs leading-none hover:border-keep-rule hover:bg-keep-banner/40 disabled:opacity-40"
    >
      {children}
    </button>
  );
}
