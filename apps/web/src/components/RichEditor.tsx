import { useEffect, useRef, type ReactNode } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { Node, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";

interface Props {
  /** HTML string. May contain legacy `<br data-auto-br />` markers from
   *  the old plain-text editor; we normalize those into `<p>` blocks
   *  before handing to Tiptap so paragraphs survive. */
  value: string;
  /** Fired on every keystroke with the editor's HTML output. */
  onChange: (html: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  /** Min height for the content area in Tailwind units (e.g. "20rem"). */
  minHeight?: string;
  /** Show the margin-note toolbar button. Scriptorium chapter bodies
   *  set this to true; synopsis / author's notes leave it false. */
  enableMarginNote?: boolean;
  /** Extra toolbar slot rendered to the right of the built-ins (e.g.
   *  Preview / History buttons from the chapter editor chrome). */
  toolbarTrailing?: ReactNode;
}

/* =============================================================
 *  MarginNote node, wraps `<aside class="margin-note">…</aside>`
 *
 *  Renders inside the editor as a yellow-bordered block so authors
 *  can see their drafting annotations. Server's `stripMarginNotes`
 *  removes the same `<aside class="margin-note">` on publish, so
 *  these never reach readers.
 * ============================================================= */
const MarginNote = Node.create({
  name: "marginNote",
  group: "block",
  content: "inline*",
  defining: true,
  parseHTML() {
    return [
      {
        tag: "aside.margin-note",
      },
      {
        tag: "aside",
        getAttrs: (el: HTMLElement | string) => {
          if (typeof el === "string") return false;
          const cls = el.getAttribute("class") ?? "";
          return cls.split(/\s+/).includes("margin-note") ? {} : false;
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) {
    return ["aside", mergeAttributes(HTMLAttributes, { class: "margin-note" }), 0];
  },
});

/**
 * Convert legacy auto-BR-marked HTML (from the old plain-text save
 * path) into `<p>`-structured HTML so Tiptap parses paragraphs
 * correctly. If the HTML already carries block structure (`<p>`,
 * `<div>`, `<blockquote>`, `<pre>`, `<h1..6>`, `<ul>`, `<ol>`,
 * `<aside>`), we trust it and pass through unchanged.
 */
function normalizeLegacyHtml(html: string): string {
  if (!html) return html;
  if (/<(?:p|div|blockquote|pre|h[1-6]|ul|ol|aside)\b/i.test(html)) return html;
  if (!/<br\b[^>]*\bdata-auto-br\b/i.test(html)) return html;
  // Each run of auto-BR tags marks a paragraph break in the legacy
  // format (one per source newline in the run). Split on those runs
  // and wrap each chunk in <p>; empty chunks (from leading/trailing
  // runs or back-to-back paragraph breaks) collapse to a blank line.
  const parts = html.split(/(?:<br\b[^>]*\bdata-auto-br\b[^>]*>\s*)+/i);
  const paragraphs = parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `<p>${p}</p>`);
  return paragraphs.join("");
}

export function RichEditor({
  value,
  onChange,
  readOnly,
  placeholder,
  minHeight = "20rem",
  enableMarginNote,
  toolbarTrailing,
}: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          rel: "noopener noreferrer ugc",
          target: "_blank",
        },
      }),
      Placeholder.configure({
        placeholder: placeholder ?? "Start writing...",
      }),
      MarginNote,
    ],
    content: normalizeLegacyHtml(value),
    editable: !readOnly,
    onUpdate: ({ editor: e }) => {
      onChange(e.getHTML());
    },
    editorProps: {
      attributes: {
        class: "rich-editor-canvas prose max-w-none focus:outline-none",
      },
    },
  });

  // Sync editable when readOnly toggles (lock acquired/released).
  useEffect(() => {
    if (editor) editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  // External value resets (load chapter, restore version) should
  // replace the doc. Compare against the editor's current HTML so we
  // don't clobber the user's keystrokes, every onUpdate flows back
  // up as `value` and would otherwise loop.
  const lastSync = useRef(value);
  useEffect(() => {
    if (!editor) return;
    if (value === lastSync.current) return;
    if (value === editor.getHTML()) {
      lastSync.current = value;
      return;
    }
    lastSync.current = value;
    editor.commands.setContent(normalizeLegacyHtml(value), false);
  }, [editor, value]);

  return (
    <div
      className={`flex min-h-0 flex-1 flex-col rounded border border-keep-rule bg-keep-bg ${
        readOnly ? "opacity-60" : ""
      }`}
    >
      <RichToolbar
        editor={editor}
        enableMarginNote={!!enableMarginNote}
        trailing={toolbarTrailing ?? null}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" style={{ minHeight }}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

/* =============================================================
 *  Toolbar
 * ============================================================= */

function RichToolbar({
  editor,
  enableMarginNote,
  trailing,
}: {
  editor: Editor | null;
  enableMarginNote: boolean;
  trailing: ReactNode;
}) {
  if (!editor) {
    return (
      <div className="flex shrink-0 items-center gap-1 border-b border-keep-rule bg-keep-panel/40 px-2 py-1.5 text-xs text-keep-muted">
        Loading editor...
      </div>
    );
  }
  const disabled = !editor.isEditable;
  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-keep-rule bg-keep-panel/40 px-2 py-1.5 text-xs">
      <Btn
        label="B"
        title="Bold (Ctrl+B)"
        bold
        active={editor.isActive("bold")}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <Btn
        label="I"
        italic
        title="Italic (Ctrl+I)"
        active={editor.isActive("italic")}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <Btn
        label="U"
        underline
        title="Underline (Ctrl+U)"
        active={editor.isActive("underline")}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      />
      <Btn
        label="S"
        strike
        title="Strikethrough"
        active={editor.isActive("strike")}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      />
      <Sep />
      <Btn
        label="H2"
        title="Heading 2"
        active={editor.isActive("heading", { level: 2 })}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      />
      <Btn
        label="H3"
        title="Heading 3"
        active={editor.isActive("heading", { level: 3 })}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      />
      <Btn
        label="¶"
        title="Paragraph"
        active={editor.isActive("paragraph")}
        disabled={disabled}
        onClick={() => editor.chain().focus().setParagraph().run()}
      />
      <Sep />
      <Btn
        label="• List"
        title="Bullet list"
        active={editor.isActive("bulletList")}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      />
      <Btn
        label="1. List"
        title="Numbered list"
        active={editor.isActive("orderedList")}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      />
      <Btn
        label="❝"
        title="Blockquote"
        active={editor.isActive("blockquote")}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      />
      <Btn
        label="―"
        title="Horizontal rule"
        disabled={disabled}
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
      />
      <Sep />
      <Btn
        label="Link"
        title="Add or edit link"
        active={editor.isActive("link")}
        disabled={disabled}
        onClick={() => {
          const prev = editor.getAttributes("link").href as string | undefined;
          const next = window.prompt("Link URL (https://…). Leave blank to remove.", prev ?? "");
          if (next === null) return;
          if (next === "") {
            editor.chain().focus().extendMarkRange("link").unsetLink().run();
            return;
          }
          editor.chain().focus().extendMarkRange("link").setLink({ href: next }).run();
        }}
      />
      {enableMarginNote ? (
        <Btn
          label="+ Note"
          title="Insert a margin note, visible to collaborators in drafts; stripped on publish"
          disabled={disabled}
          onClick={() => {
            editor
              .chain()
              .focus()
              .insertContent({
                type: "marginNote",
                content: [{ type: "text", text: "your note here" }],
              })
              .run();
          }}
        />
      ) : null}
      <Sep />
      <Btn
        label="↶"
        title="Undo (Ctrl+Z)"
        disabled={disabled || !editor.can().undo()}
        onClick={() => editor.chain().focus().undo().run()}
      />
      <Btn
        label="↷"
        title="Redo (Ctrl+Shift+Z)"
        disabled={disabled || !editor.can().redo()}
        onClick={() => editor.chain().focus().redo().run()}
      />
      {trailing ? (
        <>
          <span className="flex-1" />
          {trailing}
        </>
      ) : null}
    </div>
  );
}

function Btn({
  label,
  title,
  onClick,
  active,
  disabled,
  bold,
  italic,
  underline,
  strike,
}: {
  label: string;
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded border px-2 py-0.5 text-[11px] tabular-nums transition disabled:opacity-40 ${
        active
          ? "border-keep-action bg-keep-action/15 text-keep-action"
          : "border-keep-rule bg-keep-bg text-keep-text hover:bg-keep-panel"
      } ${bold ? "font-bold" : ""} ${italic ? "italic" : ""} ${
        underline ? "underline" : ""
      } ${strike ? "line-through" : ""}`}
    >
      {label}
    </button>
  );
}

function Sep() {
  return <span className="mx-0.5 h-4 w-px bg-keep-rule/60" />;
}
