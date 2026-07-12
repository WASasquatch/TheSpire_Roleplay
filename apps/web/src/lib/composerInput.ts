/**
 * Editor-agnostic input surface the composer popups (SynonymPopup,
 * EmoticonTypeahead) drive. The chat composer's rich editor implements
 * it over ProseMirror in PLAIN-TEXT coordinates (the document's
 * visible text, lines joined with \n) so trigger detection and range
 * replacement behave exactly like they did against the old textarea's
 * selectionStart/selectionEnd. Textarea-backed surfaces (the DM
 * composer) keep their existing ref-based wiring and never touch this.
 */
export interface ComposerInputAdapter {
  /** The focusable editing root (for activeElement checks). */
  getElement(): HTMLElement | null;
  /** Visible text with \n between lines — marks are invisible. */
  getPlainText(): string;
  /** Selection in plain-text coordinates; null when unavailable. */
  getSelection(): { start: number; end: number } | null;
  setSelection(start: number, end: number): void;
  /** Replace [start,end) with literal text; caret lands after it. */
  replaceRange(start: number, end: number, text: string): void;
  focus(): void;
  isFocused(): boolean;
  /** Caret x offset relative to the composer's positioned wrapper —
   *  drives the emoticon typeahead's caret-anchored popup. */
  caretLeftInWrapper(): number | null;
}
