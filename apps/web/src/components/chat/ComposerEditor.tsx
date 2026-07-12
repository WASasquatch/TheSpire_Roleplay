import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Blockquote from "@tiptap/extension-blockquote";
import ListItem from "@tiptap/extension-list-item";
import TextAlign from "@tiptap/extension-text-align";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { TextSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  FONT_SIZE_EM,
  RICH_SPOILER_CLASS,
  composerDocNeedsRichFormat,
  composerDocToRichHtml,
  cssColorToHex,
  htmlClipboardToComposerDoc,
  normalizeComposerDoc,
  parseChatMarkdown,
  resolveMessageColor,
  richFontSizeEmToBucket,
  serializeComposerDoc,
  type ComposerBlockFormat,
  type ComposerDoc,
  type ComposerInlineMark,
  type ComposerLine,
  type ComposerSpan,
  type ComposerTextSize,
} from "@thekeep/shared";
import type { ComposerInputAdapter } from "../../lib/composerInput.js";

/**
 * The chat composer's WYSIWYG editor: a Tiptap instance constrained to
 * exactly the marks the chat renderer (lib/markdown.tsx parseInline)
 * supports. The WIRE FORMAT DOES NOT CHANGE — every update serializes
 * the ProseMirror doc back to chat markdown via the shared
 * serializeComposerDoc, and external `value` changes (prefills,
 * history recall, compose-set chips, draft restores) hydrate through
 * parseChatMarkdown. Plain text — slash commands, identity tokens,
 * emoticon tokens, leading whitespace, NBSP names — round-trips
 * byte-identically, so the command pipeline never sees a difference.
 *
 * Popups (completer / synonym / emoticon typeahead / history) keep
 * working against PLAIN-TEXT coordinates via the ComposerInputAdapter
 * surface this component implements: plain text ⇄ ProseMirror position
 * mapping is exact because inline content is text-only (no atoms, no
 * hard breaks — Shift+Enter splits blocks, one block per line).
 *
 * Styling comes from static styles.css rules (`.keep-composer-editor`)
 * — Tiptap's runtime CSS injection is disabled because prod CSP drops
 * un-nonced <style> tags.
 */

export type ComposerToggleMark = ComposerInlineMark;

/** The four size buckets the toolbar's select offers. */
export type ComposerSizeChoice = ComposerTextSize | "normal";

/** Block-format dropdown choices (Normal / H1 / H2 / H3). */
export type ComposerBlockChoice = ComposerBlockFormat | "normal";

/** Alignment button choices. */
export type ComposerAlignChoice = "left" | "center" | "right";

export interface ComposerEditorHandle extends ComposerInputAdapter {
  toggleMark(mark: ComposerToggleMark): void;
  toggleQuote(): void;
  toggleBullet(): void;
  /** Wrap the (snapshotted) selection in a color mark, or insert a
   *  colored placeholder when the selection is empty. */
  applyColor(hex: string, sel: { start: number; end: number } | null, placeholder: string): void;
  /** Set the (snapshotted) selection's size bucket — "normal" clears
   *  the mark. Empty selection sets the typing style at the caret. */
  applySize(size: ComposerSizeChoice, sel: { start: number; end: number } | null): void;
  /** Link the current selection, or insert a linked placeholder. */
  applyLink(url: string, placeholder: string): void;
  /** Remove the link mark from the selection (or the link under the caret). */
  unsetLink(): void;
  /** Remove the color mark from the selection (or the run under the caret). */
  clearColor(): void;
  /** Insert literal text at the caret (emoticon tokens, image markdown). */
  insertText(text: string): void;
  /** Mobile ↵ button: new line (new bullet when inside a list). */
  insertNewline(): void;
  /** Set the caret's block format: Normal paragraph or heading 1-3. */
  applyBlock(block: ComposerBlockChoice): void;
  /** Set the caret block's text alignment. */
  applyAlign(align: ComposerAlignChoice): void;
  /**
   * Rich-HTML wire payload (format 'html'), or null when the document
   * is fully expressible as chat markdown — the caller then sends the
   * serialized `value` through the historic md pipeline instead.
   */
  getRichPayload(): string | null;
}

export interface ComposerEditorState {
  plainText: string;
  caretStart: number;
  caretEnd: number;
  active: Record<string, boolean>;
  /** Size bucket at the caret/selection — drives the toolbar select. */
  size: ComposerSizeChoice;
  /** Block format at the caret — drives the block-format select. */
  block: ComposerBlockChoice;
  /** Alignment of the caret's block — drives the align buttons. */
  align: ComposerAlignChoice;
}

interface Props {
  /** Serialized chat markdown — the wire truth the parent owns. */
  value: string;
  onChange: (md: string) => void;
  /** Plain text + caret + active-mark snapshot on every doc/selection change. */
  onStateChange: (s: ComposerEditorState) => void;
  /**
   * Composer-level key handling (completer nav, history popup,
   * Enter=send). Runs from ProseMirror's handleKeyDown, i.e. AFTER the
   * window-capture popup listeners and BEFORE ProseMirror keymaps.
   * "Handled" is signalled by calling preventDefault on the event.
   */
  onEditorKeyDown: (e: KeyboardEvent) => void;
  /** Fired on doc-changing updates — drives the typing indicator pulse. */
  onTyped: () => void;
  onBlur?: () => void;
  /** Mod+K shortcut → the toolbar's link prompt. */
  onRequestLink: () => void;
  handleRef: MutableRefObject<ComposerEditorHandle | null>;
  disabled?: boolean;
  /**
   * Whether the rich-HTML wire format is available for this surface
   * (flat chat rooms). When off — forum rooms, whose sends always ship
   * chat markdown — headings and alignment are removed from the SCHEMA
   * (input rules, shortcuts, paste mapping included), so "# " stays
   * literal text exactly as the plain textarea kept it; the toolbar
   * hides the matching controls on the same flag.
   */
  richEnabled?: boolean;
  placeholder: string;
  ariaLabel: string;
}

/* =============================================================
 * Plain-text offset ⇄ ProseMirror position mapping
 *
 * Inline content is text-only, so a textblock's content size equals
 * its text length; blocks join with one "\n" in the plain-text space.
 * ============================================================= */

function docPlainText(doc: PMNode): string {
  const parts: string[] = [];
  doc.descendants((node) => {
    if (node.isTextblock) {
      parts.push(node.textContent);
      return false;
    }
    return true;
  });
  return parts.join("\n");
}

function textOffsetOfPos(doc: PMNode, pos: number): number {
  let acc = 0;
  let first = true;
  let result: number | null = null;
  doc.descendants((node, p) => {
    if (result !== null) return false;
    if (!node.isTextblock) return true;
    if (!first) acc += 1;
    first = false;
    const start = p + 1;
    const end = start + node.content.size;
    if (pos < start) {
      result = acc;
      return false;
    }
    if (pos <= end) {
      result = acc + (pos - start);
      return false;
    }
    acc += node.content.size;
    return false;
  });
  return result ?? acc;
}

function posOfTextOffset(doc: PMNode, offset: number): number {
  let acc = 0;
  let first = true;
  let result: number | null = null;
  let lastEnd = 1;
  doc.descendants((node, p) => {
    if (result !== null) return false;
    if (!node.isTextblock) return true;
    if (!first) acc += 1;
    first = false;
    const start = p + 1;
    const len = node.content.size;
    if (offset >= acc && offset <= acc + len) {
      result = start + (offset - acc);
      return false;
    }
    acc += len;
    lastEnd = start + len;
    return false;
  });
  return result ?? lastEnd;
}

/* =============================================================
 * ProseMirror doc ⇄ shared ComposerDoc
 * ============================================================= */

function blockToLine(node: PMNode, kind: ComposerLine["kind"]): ComposerLine {
  const spans: ComposerSpan[] = [];
  node.forEach((child) => {
    if (!child.isText || !child.text) return;
    const span: ComposerSpan = { text: child.text };
    const marks: ComposerInlineMark[] = [];
    for (const m of child.marks) {
      switch (m.type.name) {
        case "bold": marks.push("bold"); break;
        case "italic": marks.push("italic"); break;
        case "underline": marks.push("underline"); break;
        case "strike": marks.push("strike"); break;
        case "spoiler": marks.push("spoiler"); break;
        case "code": marks.push("code"); break;
        case "link": {
          const href = m.attrs.href;
          if (typeof href === "string" && href) span.link = href;
          break;
        }
        case "textColor": {
          const color = m.attrs.color;
          if (typeof color === "string" && color) span.color = color;
          break;
        }
        case "textSize": {
          const size = m.attrs.size;
          if (size === "small" || size === "large" || size === "huge") span.size = size;
          break;
        }
        default: break;
      }
    }
    if (marks.length) span.marks = marks;
    spans.push(span);
  });
  const line: ComposerLine = { kind, spans };
  // Rich-only block metadata: heading level (plain text lines only —
  // quote/list context wins) and non-default alignment. Their presence
  // flips the send path to the rich-HTML wire format.
  if (kind === "text" && node.type.name === "heading") {
    const level = node.attrs.level;
    line.block = level === 1 ? "h1" : level === 2 ? "h2" : "h3";
  }
  const ta = node.attrs.textAlign;
  if (ta === "center" || ta === "right") line.align = ta;
  return line;
}

/** Flatten one block node into wire lines. The schema keeps quote/list
 *  content flat, but this still recurses so any nesting that slips
 *  through (extension changes, pathological pastes) degrades to visible
 *  lines instead of silently dropping text from the wire. */
function pushBlockLines(node: PMNode, kind: ComposerLine["kind"], lines: ComposerLine[]): void {
  if (node.isTextblock) {
    lines.push(blockToLine(node, kind));
    return;
  }
  switch (node.type.name) {
    case "blockquote":
      node.forEach((child) => pushBlockLines(child, "quote", lines));
      break;
    case "bulletList":
      node.forEach((li) => li.forEach((child) => pushBlockLines(child, "bullet", lines)));
      break;
    default:
      node.forEach((child) => pushBlockLines(child, kind, lines));
      break;
  }
}

export function pmToComposerDoc(doc: PMNode): ComposerDoc {
  const lines: ComposerLine[] = [];
  doc.forEach((block) => pushBlockLines(block, "text", lines));
  if (!lines.length) lines.push({ kind: "text", spans: [] });
  return { lines };
}

interface JsonNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: JsonNode[];
}

function spanToTextJson(span: ComposerSpan): JsonNode {
  const marks: Array<{ type: string; attrs?: Record<string, unknown> }> = [];
  for (const m of span.marks ?? []) {
    if (m === "bold" || m === "italic" || m === "underline" || m === "strike" || m === "spoiler" || m === "code") {
      marks.push({ type: m });
    }
  }
  if (span.link) marks.push({ type: "link", attrs: { href: span.link } });
  if (span.color) marks.push({ type: "textColor", attrs: { color: span.color } });
  if (span.size) marks.push({ type: "textSize", attrs: { size: span.size } });
  const node: JsonNode = { type: "text", text: span.text };
  if (marks.length) node.marks = marks;
  return node;
}

function lineToParagraphJson(line: ComposerLine): JsonNode {
  const content = line.spans.filter((s) => s.text.length > 0).map(spanToTextJson);
  const align = line.align === "center" || line.align === "right" ? line.align : null;
  if (line.kind === "text" && line.block) {
    const level = line.block === "h1" ? 1 : line.block === "h2" ? 2 : 3;
    return {
      type: "heading",
      attrs: { level, ...(align ? { textAlign: align } : {}) },
      ...(content.length ? { content } : {}),
    };
  }
  return {
    type: "paragraph",
    ...(align ? { attrs: { textAlign: align } } : {}),
    ...(content.length ? { content } : {}),
  };
}

function composerDocToPmJson(doc: ComposerDoc): JsonNode[] {
  const blocks: JsonNode[] = [];
  let i = 0;
  const lines = doc.lines.length ? doc.lines : [{ kind: "text" as const, spans: [] }];
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.kind === "quote") {
      const paras: JsonNode[] = [];
      while (i < lines.length && lines[i]!.kind === "quote") {
        paras.push(lineToParagraphJson(lines[i]!));
        i++;
      }
      blocks.push({ type: "blockquote", content: paras });
    } else if (line.kind === "bullet") {
      const items: JsonNode[] = [];
      while (i < lines.length && lines[i]!.kind === "bullet") {
        items.push({ type: "listItem", content: [lineToParagraphJson(lines[i]!)] });
        i++;
      }
      blocks.push({ type: "bulletList", content: items });
    } else {
      blocks.push(lineToParagraphJson(line));
      i++;
    }
  }
  return blocks;
}

function plainTextToDoc(text: string): ComposerDoc {
  return {
    lines: text.split("\n").map((line) => ({
      kind: "text" as const,
      spans: line ? [{ text: line }] : [],
    })),
  };
}

/* =============================================================
 * Custom marks (spoiler ||…|| and <font color>)
 * ============================================================= */

export const Spoiler = Mark.create({
  name: "spoiler",
  parseHTML() {
    return [
      { tag: "span[data-spoiler]" },
      // Stored rich-HTML bodies (format 'html') carry the whitelist's
      // literal spoiler class — accepted so the inline message editor
      // hydrates persisted spoilers.
      { tag: `span.${RICH_SPOILER_CLASS}` },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-spoiler": "", class: "tk-composer-spoiler" }), 0];
  },
});

export const TextColor = Mark.create({
  name: "textColor",
  addAttributes() {
    return {
      color: { default: null },
    };
  },
  parseHTML() {
    return [
      {
        tag: "font[color]",
        getAttrs: (el) => {
          if (typeof el === "string") return false;
          const color = el.getAttribute("color");
          return color ? { color } : false;
        },
      },
      // Stored rich-HTML bodies carry `style="color: #hex"` spans.
      // Style rules are non-consuming, so one span carrying both color
      // and font-size hydrates both marks.
      {
        style: "color",
        getAttrs: (value) => {
          const hex = cssColorToHex(String(value));
          return hex ? { color: hex } : false;
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes, mark }) {
    const color = typeof mark.attrs.color === "string" ? mark.attrs.color : "";
    // The wire keeps the RAW hex; only the preview ink runs through the
    // same legibility clamp the feed/export apply (resolveMessageColor
    // against the active theme background, stamped on <body> by
    // applyTheme) — otherwise a black swatch on a dark theme paints the
    // draft invisible while the SENT line renders nudged.
    const themeBg =
      typeof document !== "undefined" ? document.body.getAttribute("data-theme-bg") : null;
    const ink = resolveMessageColor(color, themeBg) ?? color;
    // Inline style ATTRIBUTE — allowed by the prod CSP's
    // style-src-attr 'unsafe-inline' (unlike <style> elements).
    return ["span", mergeAttributes(HTMLAttributes, { style: `color: ${ink}` }), 0];
  },
});

export const TextSize = Mark.create({
  name: "textSize",
  addAttributes() {
    return {
      size: { default: null },
    };
  },
  parseHTML() {
    return [
      {
        tag: "span[data-size]",
        getAttrs: (el) => {
          if (typeof el === "string") return false;
          const size = el.getAttribute("data-size");
          return size === "small" || size === "large" || size === "huge" ? { size } : false;
        },
      },
      // Stored rich-HTML bodies carry the exact bucket em constants as
      // `style="font-size: …em"` spans; anything else is not a bucket
      // and stays unmarked.
      {
        style: "font-size",
        getAttrs: (value) => {
          const bucket = richFontSizeEmToBucket(String(value));
          return bucket ? { size: bucket } : false;
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes, mark }) {
    const size = mark.attrs.size as ComposerTextSize;
    const em = FONT_SIZE_EM[size] ?? "1em";
    // Same em buckets the chat renderer uses, so the editor previews
    // exactly what the sent line will look like. Style ATTRIBUTE, not
    // a <style> element, so prod CSP is satisfied.
    return ["span", mergeAttributes(HTMLAttributes, { "data-size": size, style: `font-size: ${em}` }), 0];
  },
});

/* =============================================================
 * Component
 * ============================================================= */

const HEIGHT_STORAGE_KEY = "tk:composerHeight";
const MIN_HEIGHT_PX = 32;
const MAX_SAVED_HEIGHT_PX = 1200;
const KEYBOARD_RESIZE_STEP_PX = 24;

function loadSavedHeight(): number | null {
  try {
    const raw = window.localStorage.getItem(HEIGHT_STORAGE_KEY);
    if (!raw) return null;
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < MIN_HEIGHT_PX || n > MAX_SAVED_HEIGHT_PX) return null;
    return n;
  } catch {
    return null;
  }
}

export function ComposerEditor({
  value,
  onChange,
  onStateChange,
  onEditorKeyDown,
  onTyped,
  onBlur,
  onRequestLink,
  handleRef,
  disabled,
  richEnabled,
  placeholder,
  ariaLabel,
}: Props) {
  const { t } = useTranslation("chat");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);

  // Latest-callback refs: the Tiptap instance captures its options once
  // at creation, so every callback routes through a ref.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const onKeyDownRef = useRef(onEditorKeyDown);
  onKeyDownRef.current = onEditorKeyDown;
  const onTypedRef = useRef(onTyped);
  onTypedRef.current = onTyped;
  const onBlurRef = useRef(onBlur);
  onBlurRef.current = onBlur;
  const onRequestLinkRef = useRef(onRequestLink);
  onRequestLinkRef.current = onRequestLink;
  const placeholderRef = useRef(placeholder);

  // Last value this editor has SEEN — either emitted from onUpdate or
  // synced in from the prop. Guards the external-sync effect against
  // clobbering keystrokes (same pattern as RichEditor's lastSync).
  const lastValueRef = useRef<string | null>(null);
  const initialValueRef = useRef(value);
  // The editor instance for callbacks that are wired up at creation
  // time (handlePaste) and therefore can't close over the result.
  const editorRefInternal = useRef<Editor | null>(null);
  // Rebuild bookkeeping: richEnabled flips destroy and recreate the
  // Tiptap instance. Autofocus belongs to the FIRST instance only —
  // a rebuild may fire while the user is typing in some other field,
  // so it restores focus only when the destroyed instance held it
  // (destroying a focused view fires no blur, so the flag survives).
  const hadEditorRef = useRef(false);
  const editorFocusedRef = useRef(false);
  const rebuildSyncRef = useRef(false);

  const shortcuts = useMemo(
    () =>
      Extension.create({
        name: "composerShortcuts",
        addKeyboardShortcuts() {
          return {
            // Spec shortcuts: Mod+B / I / U ship with the marks; add
            // Mod+Shift+S (strike) and Mod+K (link prompt).
            "Mod-Shift-s": () => this.editor.commands.toggleStrike(),
            "Mod-k": () => {
              onRequestLinkRef.current();
              return true;
            },
            // Shift+Enter = new line (Enter is send). Inside a list it
            // starts the next bullet.
            "Shift-Enter": () =>
              this.editor.commands.first(({ commands }) => [
                () => commands.splitListItem("listItem"),
                () => commands.splitBlock(),
              ]),
          };
        },
      }),
    [],
  );

  const emitState = useCallback((editor: Editor) => {
    const { state } = editor;
    const sizeAttr = editor.getAttributes("textSize").size as unknown;
    const headingLevel = editor.isActive("heading")
      ? (editor.getAttributes("heading").level as unknown)
      : null;
    onStateChangeRef.current({
      plainText: docPlainText(state.doc),
      caretStart: textOffsetOfPos(state.doc, state.selection.from),
      caretEnd: textOffsetOfPos(state.doc, state.selection.to),
      size:
        sizeAttr === "small" || sizeAttr === "large" || sizeAttr === "huge"
          ? sizeAttr
          : "normal",
      block:
        headingLevel === 1 ? "h1" : headingLevel === 2 ? "h2" : headingLevel === 3 ? "h3" : "normal",
      align: editor.isActive({ textAlign: "center" })
        ? "center"
        : editor.isActive({ textAlign: "right" })
          ? "right"
          : "left",
      active: {
        bold: editor.isActive("bold"),
        italic: editor.isActive("italic"),
        underline: editor.isActive("underline"),
        strike: editor.isActive("strike"),
        spoiler: editor.isActive("spoiler"),
        code: editor.isActive("code"),
        link: editor.isActive("link"),
        color: editor.isActive("textColor"),
        quote: editor.isActive("blockquote"),
        bullet: editor.isActive("bulletList"),
      },
    });
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // The chat grammar's inline set plus rich-only headings
        // (H1-H3, shipped via the rich-HTML message format — schema'd
        // only where that format can actually be SENT, so forum-mode
        // "# " stays literal). No ordered lists, no hr, no code
        // blocks. hardBreak stays off so every line is its own block
        // (the \n mapping relies on it).
        heading: richEnabled ? { levels: [1, 2, 3] } : false,
        codeBlock: false,
        horizontalRule: false,
        orderedList: false,
        hardBreak: false,
        dropcursor: false,
        gapcursor: false,
        // Replaced below with flat-content variants: the wire grammar
        // is line-based and cannot express nested blocks.
        blockquote: false,
        listItem: false,
        code: {
          HTMLAttributes: {},
        },
      }),
      // Quotes hold only paragraphs and list items hold exactly one, so
      // list-in-quote / list-in-list nesting (toggle commands and the
      // "- " input rule alike) fails cleanly instead of building
      // structure the line-based wire format would drop or flatten.
      Blockquote.extend({ content: "paragraph+" }),
      ListItem.extend({ content: "paragraph" }),
      // Rich-only alignment (center/right ship via the rich-HTML wire
      // format; left is the default flow — off entirely when the rich
      // format is, along with its keymap). Applies to paragraphs and
      // headings — list items / quotes align through their paragraphs.
      ...(richEnabled
        ? [
            TextAlign.configure({
              types: ["heading", "paragraph"],
              alignments: ["left", "center", "right"],
            }),
          ]
        : []),
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: false,
        linkOnPaste: false,
        HTMLAttributes: { rel: "noopener noreferrer ugc" },
      }),
      Placeholder.configure({
        // Resolved through a ref per decoration pass so forum-mode
        // placeholder swaps apply without rebuilding the editor.
        placeholder: () => placeholderRef.current,
      }),
      Spoiler,
      TextColor,
      TextSize,
      shortcuts,
    ],
    content: {
      type: "doc",
      content: composerDocToPmJson(parseChatMarkdown(initialValueRef.current)),
    },
    editable: !disabled,
    autofocus: !hadEditorRef.current || editorFocusedRef.current ? "end" : false,
    // Prod CSP drops un-nonced <style> tags; all editor styling lives
    // in styles.css under .keep-composer-editor instead.
    injectCSS: false,
    onCreate: ({ editor: e }) => {
      if (hadEditorRef.current) rebuildSyncRef.current = true;
      hadEditorRef.current = true;
      lastValueRef.current = initialValueRef.current;
      emitState(e);
    },
    onUpdate: ({ editor: e, transaction }) => {
      const md = serializeComposerDoc(pmToComposerDoc(e.state.doc));
      lastValueRef.current = md;
      onChangeRef.current(md);
      if (transaction.docChanged) onTypedRef.current();
      emitState(e);
    },
    onSelectionUpdate: ({ editor: e }) => emitState(e),
    onFocus: () => {
      editorFocusedRef.current = true;
    },
    onBlur: () => {
      editorFocusedRef.current = false;
      onBlurRef.current?.();
    },
    editorProps: {
      attributes: {
        class:
          "keep-composer-editor block w-full px-3 py-2 text-base leading-snug outline-none lg:py-1 lg:text-sm",
        enterkeyhint: "send",
        "aria-label": ariaLabel,
      },
      handleKeyDown: (view, event) => {
        // A capture-phase popup (SynonymPopup) may have already claimed
        // this key with preventDefault but without stopPropagation —
        // treat it as handled so Enter can't double as "send".
        if (event.defaultPrevented) return true;
        // IME composition: never intercept — Enter commits the
        // composition, it must not send (mirrors the old textarea's
        // isComposing guards).
        if (event.isComposing || view.composing) return false;
        onKeyDownRef.current(event);
        if (event.defaultPrevented) return true;
        // Keep lists flat: Tab would sink the item into a nested list
        // the wire grammar can't express. Outside lists Tab falls
        // through to the browser (focus moves on, as the textarea did).
        if (event.key === "Tab" && !event.shiftKey) {
          const { $from } = view.state.selection;
          for (let d = $from.depth; d > 0; d--) {
            if ($from.node(d).type.name === "listItem") return true;
          }
        }
        return false;
      },
      handleTextInput: (view, from, to, text) => {
        // Slash-command drafts are identity input: insert the typed
        // characters directly so mark/list input rules (which run after
        // this prop) can't rewrite bytes the command pipeline will
        // receive verbatim (e.g. `_Name_` names must stay literal).
        const first = view.state.doc.firstChild;
        if (!first || !first.textContent.startsWith("/")) return false;
        view.dispatch(view.state.tr.insertText(text, from, to));
        return true;
      },
      handlePaste: (view, event) => {
        const cd = event.clipboardData;
        if (!cd) return false;
        const html = cd.getData("text/html");
        const text = cd.getData("text/plain");
        let doc: ComposerDoc | null = null;
        if (html && html.trim()) {
          // Rich paste: sanitize down to the supported mark set;
          // anything unsupported drops to plain text (never raw HTML).
          doc = htmlClipboardToComposerDoc(html);
          if (!richEnabled) {
            // Headings/alignment aren't in this surface's schema (no
            // rich wire format) — degrade pasted ones to plain lines
            // instead of feeding the schema unknown node types.
            doc = {
              lines: doc.lines.map(({ block: _block, align: _align, ...line }) => {
                void _block;
                void _align;
                return line;
              }),
            };
          }
          if (!doc.lines.some((l) => l.spans.length > 0) && text) doc = plainTextToDoc(text);
        } else if (text) {
          // Plain-text paste stays byte-exact: inserted literally,
          // no markdown interpretation.
          doc = plainTextToDoc(text);
        }
        if (!doc) return false;
        event.preventDefault();
        void view;
        const target = editorRefInternal.current;
        if (!target) return true;
        const blocks = composerDocToPmJson(doc);
        if (blocks.length === 1 && doc.lines.length === 1 && doc.lines[0]!.kind === "text") {
          // Single plain line: inline insertion keeps the caret inside
          // the current block instead of splitting it.
          const content = blocks[0]!.content ?? [];
          if (content.length > 0) target.commands.insertContent(content);
          return true;
        }
        target.commands.insertContent(blocks);
        return true;
      },
    },
  // Rich-capability flips (flat room ⇄ forum room) change the SCHEMA
  // (heading node, textAlign attrs), which needs a fresh editor; the
  // external-value sync effect below restores the current draft into it.
  }, [richEnabled]);
  editorRefInternal.current = editor;

  // External value sync (prefills, history recall, compose-set chips,
  // send-clears). Mirrors the old textarea: focus + caret to end —
  // except on the catch-up pass right after a richEnabled rebuild,
  // where grabbing focus would steal the keyboard from another field
  // (the was-focused case is covered by the rebuild's autofocus).
  useEffect(() => {
    if (!editor) return;
    const rebuildSync = rebuildSyncRef.current;
    rebuildSyncRef.current = false;
    if (value === lastValueRef.current) return;
    lastValueRef.current = value;
    editor.commands.setContent(
      { type: "doc", content: composerDocToPmJson(parseChatMarkdown(value)) },
      false,
    );
    const end = editor.state.doc.content.size;
    editor.commands.setTextSelection(end);
    if (!editor.isFocused && !rebuildSync) editor.commands.focus("end");
    emitState(editor);
  }, [editor, value, emitState]);

  // Forum-mode enable/disable.
  useEffect(() => {
    if (editor) editor.setEditable(!disabled);
  }, [editor, disabled]);

  // Placeholder swaps (forum modes, thread modal override): poke an
  // empty transaction so the Placeholder decoration re-reads the ref.
  useEffect(() => {
    placeholderRef.current = placeholder;
    if (editor) editor.view.dispatch(editor.state.tr.setMeta("composerPlaceholder", true));
  }, [editor, placeholder]);

  // The accessible name mirrors the contextual placeholder; the
  // editorProps attribute is resolved once at creation, so keep the
  // live DOM attribute in step.
  useEffect(() => {
    if (editor) editor.view.dom.setAttribute("aria-label", ariaLabel);
  }, [editor, ariaLabel]);

  /* ---------- resize handle (drag up to grow) ---------- */

  const [userHeight, setUserHeight] = useState<number | null>(() => {
    try {
      return typeof window === "undefined" ? null : loadSavedHeight();
    } catch {
      return null;
    }
  });
  const [dragging, setDragging] = useState(false);
  // Live ≈60%-of-column ceiling. The persisted/dragged height must be
  // clamped at APPLY time, not just during the gesture: a height saved
  // on a tall window would otherwise swallow the message feed on a
  // smaller one (reload, window shrink, rotation).
  const [maxPx, setMaxPx] = useState<number | null>(null);
  const gestureRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    maxPx: number;
    latest: number;
    raf: number | null;
    detach: () => void;
  } | null>(null);

  useEffect(() => () => gestureRef.current?.detach(), []);

  const maxHeightPx = useCallback((): number => {
    // ≈60% of the chat column; the column is the composer's <main>.
    const column = rootRef.current?.closest("main");
    const base = column?.clientHeight ?? window.innerHeight;
    return Math.max(MIN_HEIGHT_PX * 2, Math.round(base * 0.6));
  }, []);

  // Track the ceiling across window/column resizes so the applied
  // height re-clamps live. Layout effect: the clamp must land before
  // first paint when a saved height is restored on a small window.
  useLayoutEffect(() => {
    const update = () => setMaxPx(maxHeightPx());
    update();
    window.addEventListener("resize", update);
    const column = rootRef.current?.closest("main");
    const ro = typeof ResizeObserver !== "undefined" && column ? new ResizeObserver(update) : null;
    if (column) ro?.observe(column);
    return () => {
      window.removeEventListener("resize", update);
      ro?.disconnect();
    };
  }, [maxHeightPx]);

  const appliedHeight = userHeight == null ? null : Math.min(userHeight, maxPx ?? userHeight);

  const onHandlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0 || gestureRef.current) return;
      const frame = frameRef.current;
      if (!frame) return;
      // Window-level listeners (not pointer capture): the frame can
      // re-render mid-gesture and a moved node silently loses capture.
      const onMove = (ev: PointerEvent) => {
        const g = gestureRef.current;
        if (!g || ev.pointerId !== g.pointerId) return;
        g.latest = Math.min(g.maxPx, Math.max(MIN_HEIGHT_PX, g.startHeight + (g.startY - ev.clientY)));
        // rAF-coalesced so the feed's bottom-pin sees at most one
        // container resize per frame.
        if (g.raf == null) {
          g.raf = window.requestAnimationFrame(() => {
            const gg = gestureRef.current;
            if (!gg) return;
            gg.raf = null;
            setUserHeight(gg.latest);
          });
        }
      };
      const finish = (ev: PointerEvent) => {
        const g = gestureRef.current;
        if (!g || ev.pointerId !== g.pointerId) return;
        gestureRef.current = null;
        g.detach();
        if (g.raf != null) window.cancelAnimationFrame(g.raf);
        setDragging(false);
        setUserHeight(g.latest);
        try {
          window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(g.latest));
        } catch { /* storage may be disabled */ }
      };
      const detach = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
      };
      gestureRef.current = {
        pointerId: e.pointerId,
        startY: e.clientY,
        startHeight: frame.offsetHeight,
        maxPx: maxHeightPx(),
        latest: frame.offsetHeight,
        raf: null,
        detach,
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      setDragging(true);
      e.preventDefault();
    },
    [maxHeightPx],
  );

  const resetHeight = useCallback(() => {
    setUserHeight(null);
    try {
      window.localStorage.removeItem(HEIGHT_STORAGE_KEY);
    } catch { /* ignore */ }
  }, []);

  // Keyboard resize on the separator (the drag gesture is unreachable
  // without a pointer): arrows step the height, Enter/Home reset.
  const onHandleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.key === "Enter" || e.key === "Home") {
        e.preventDefault();
        resetHeight();
        return;
      }
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const current = frameRef.current?.offsetHeight ?? MIN_HEIGHT_PX;
      const step = e.key === "ArrowUp" ? KEYBOARD_RESIZE_STEP_PX : -KEYBOARD_RESIZE_STEP_PX;
      const next = Math.min(maxHeightPx(), Math.max(MIN_HEIGHT_PX, current + step));
      setUserHeight(next);
      try {
        window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(next));
      } catch { /* storage may be disabled */ }
    },
    [maxHeightPx, resetHeight],
  );

  /* ---------- imperative handle ---------- */

  useEffect(() => {
    if (!editor) {
      handleRef.current = null;
      return;
    }
    const withEditor = (fn: (e: Editor) => void) => fn(editor);
    const handle: ComposerEditorHandle = {
      getElement: () => (editor.view.dom as HTMLElement) ?? null,
      getPlainText: () => docPlainText(editor.state.doc),
      getSelection: () => {
        const { from, to } = editor.state.selection;
        return {
          start: textOffsetOfPos(editor.state.doc, from),
          end: textOffsetOfPos(editor.state.doc, to),
        };
      },
      setSelection: (start, end) =>
        withEditor((e) => {
          const doc = e.state.doc;
          const from = posOfTextOffset(doc, Math.min(start, end));
          const to = posOfTextOffset(doc, Math.max(start, end));
          e.view.dispatch(e.state.tr.setSelection(TextSelection.create(doc, from, to)).scrollIntoView());
        }),
      replaceRange: (start, end, text) =>
        withEditor((e) => {
          const doc = e.state.doc;
          const from = posOfTextOffset(doc, Math.min(start, end));
          const to = posOfTextOffset(doc, Math.max(start, end));
          let tr = e.state.tr.insertText(text, from, to);
          tr = tr.setSelection(TextSelection.create(tr.doc, Math.min(from + text.length, tr.doc.content.size)));
          e.view.dispatch(tr.scrollIntoView());
          e.view.focus();
        }),
      focus: () => editor.view.focus(),
      isFocused: () => editor.isFocused,
      caretLeftInWrapper: () => {
        try {
          const coords = editor.view.coordsAtPos(editor.state.selection.head);
          const wrapper = (rootRef.current?.offsetParent as HTMLElement | null) ?? rootRef.current;
          if (!wrapper) return null;
          return coords.left - wrapper.getBoundingClientRect().left;
        } catch {
          return null;
        }
      },
      toggleMark: (mark) =>
        withEditor((e) => {
          switch (mark) {
            case "bold": e.chain().focus().toggleBold().run(); break;
            case "italic": e.chain().focus().toggleItalic().run(); break;
            case "underline": e.chain().focus().toggleUnderline().run(); break;
            case "strike": e.chain().focus().toggleStrike().run(); break;
            case "code": e.chain().focus().toggleCode().run(); break;
            case "spoiler": e.chain().focus().toggleMark("spoiler").run(); break;
          }
        }),
      toggleQuote: () => editor.chain().focus().toggleBlockquote().run(),
      toggleBullet: () => editor.chain().focus().toggleBulletList().run(),
      applyColor: (hex, sel, placeholderText) =>
        withEditor((e) => {
          if (sel && sel.start !== sel.end) {
            const doc = e.state.doc;
            const from = posOfTextOffset(doc, Math.min(sel.start, sel.end));
            const to = posOfTextOffset(doc, Math.max(sel.start, sel.end));
            e.chain()
              .focus()
              .setTextSelection({ from, to })
              .setMark("textColor", { color: hex })
              .run();
            return;
          }
          if (!e.state.selection.empty) {
            e.chain().focus().setMark("textColor", { color: hex }).run();
            return;
          }
          // Select the inserted placeholder so typing replaces it.
          const from = e.state.selection.from;
          e.chain()
            .focus()
            .insertContent({ type: "text", text: placeholderText, marks: [{ type: "textColor", attrs: { color: hex } }] })
            .setTextSelection({ from, to: from + placeholderText.length })
            .run();
        }),
      applySize: (size, sel) =>
        withEditor((e) => {
          const chain = e.chain().focus();
          if (sel && sel.start !== sel.end) {
            const doc = e.state.doc;
            const from = posOfTextOffset(doc, Math.min(sel.start, sel.end));
            const to = posOfTextOffset(doc, Math.max(sel.start, sel.end));
            chain.setTextSelection({ from, to });
          }
          // With a collapsed selection setMark/unsetMark set the TYPING
          // style (stored marks), mirroring Gmail's size behavior.
          if (size === "normal") chain.unsetMark("textSize").run();
          else chain.setMark("textSize", { size }).run();
        }),
      applyLink: (url, placeholderText) =>
        withEditor((e) => {
          if (e.state.selection.empty) {
            // Select the inserted placeholder so typing replaces it.
            const from = e.state.selection.from;
            e.chain()
              .focus()
              .insertContent({ type: "text", text: placeholderText, marks: [{ type: "link", attrs: { href: url } }] })
              .setTextSelection({ from, to: from + placeholderText.length })
              .run();
            return;
          }
          e.chain().focus().setMark("link", { href: url }).run();
        }),
      unsetLink: () =>
        withEditor((e) => {
          e.chain().focus().extendMarkRange("link").unsetMark("link").run();
        }),
      clearColor: () =>
        withEditor((e) => {
          e.chain().focus().extendMarkRange("textColor").unsetMark("textColor").run();
        }),
      insertText: (text) =>
        withEditor((e) => {
          e.view.dispatch(e.state.tr.insertText(text).scrollIntoView());
          e.view.focus();
        }),
      insertNewline: () =>
        withEditor((e) => {
          e.chain()
            .focus()
            .first(({ commands }) => [
              () => commands.splitListItem("listItem"),
              () => commands.splitBlock(),
            ])
            .run();
        }),
      applyBlock: (block) =>
        withEditor((e) => {
          // No heading node in the schema (richEnabled off) → no rich
          // wire format on this surface; the toolbar hides the control
          // but the handle stays callable, so fail as a no-op.
          if (!e.schema.nodes.heading) return;
          if (block === "normal") {
            e.chain().focus().setParagraph().run();
            return;
          }
          const level = block === "h1" ? 1 : block === "h2" ? 2 : 3;
          e.chain().focus().setHeading({ level }).run();
        }),
      applyAlign: (align) =>
        withEditor((e) => {
          // TextAlign is omitted when richEnabled is off (see above).
          if (typeof e.commands.setTextAlign !== "function") return;
          e.chain().focus().setTextAlign(align).run();
        }),
      getRichPayload: () => {
        const doc = normalizeComposerDoc(pmToComposerDoc(editor.state.doc));
        return composerDocNeedsRichFormat(doc) ? composerDocToRichHtml(doc) : null;
      },
    };
    handleRef.current = handle;
    // Re-emit once the handle exists: the parent passes it to the
    // popup components as a plain prop, so it needs a render to see it.
    emitState(editor);
    return () => {
      if (handleRef.current === handle) handleRef.current = null;
    };
  }, [editor, handleRef, emitState]);

  /* ---------- render ---------- */

  return (
    <div ref={rootRef} className="relative">
      {/* Resize grip on the input's top border. Drag up to grow the
          workspace (clamped to ≈60% of the chat column), double-click
          to reset to auto-grow. Window-driven pointer gesture. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("composer.resizeAria")}
        aria-valuemin={MIN_HEIGHT_PX}
        aria-valuemax={maxPx ?? MAX_SAVED_HEIGHT_PX}
        aria-valuenow={Math.round(appliedHeight ?? frameRef.current?.offsetHeight ?? MIN_HEIGHT_PX)}
        title={t("composer.resizeTitle")}
        tabIndex={0}
        onPointerDown={onHandlePointerDown}
        onDoubleClick={resetHeight}
        onKeyDown={onHandleKeyDown}
        className="group absolute -top-1.5 left-0 right-0 z-10 flex h-3 cursor-ns-resize touch-none items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-keep-action"
      >
        <div
          className={`h-1 w-12 rounded-full transition-opacity ${
            dragging ? "bg-keep-action opacity-100" : "bg-keep-rule opacity-40 group-hover:opacity-100 group-focus-visible:opacity-100"
          }`}
        />
      </div>
      <div
        ref={frameRef}
        style={appliedHeight != null ? { height: `${appliedHeight}px` } : undefined}
        // Clicking the frame's dead space (below a short document in a
        // user-sized frame) still lands the caret in the editor.
        onMouseDown={(e) => {
          if (disabled || !editor) return;
          if (e.target === frameRef.current) {
            e.preventDefault();
            editor.commands.focus("end");
          }
        }}
        className={`keep-composer-frame block w-full cursor-text overflow-y-auto rounded border border-keep-rule bg-keep-bg focus-within:border-keep-action ${
          userHeight != null ? "" : "max-h-44 lg:max-h-40"
        } min-h-[68px] lg:min-h-8 ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
      >
        <EditorContent editor={editor} className="h-full" />
      </div>
    </div>
  );
}
