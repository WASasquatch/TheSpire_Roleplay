import { useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Blockquote from "@tiptap/extension-blockquote";
import ListItem from "@tiptap/extension-list-item";
import TextAlign from "@tiptap/extension-text-align";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import { composerDocToRichHtml, normalizeComposerDoc } from "@thekeep/shared";
import { sanitizeRichClient } from "../../lib/richBody.js";
import { Spoiler, TextColor, TextSize, pmToComposerDoc } from "./ComposerEditor.js";

/**
 * Inline editor for a stored rich-HTML message body (format 'html',
 * migration 0352). A compact Tiptap instance sharing the composer's
 * schema (headings 1-3, alignment, the chat mark set, spoiler, color,
 * size buckets): the persisted body hydrates through DOMPurify + the
 * marks' style-based parse rules, and every update re-serializes the
 * document through the same whitelist-HTML serializer the composer
 * ships fresh sends with — the PATCHed body can never carry a
 * construct the ingest sanitizer wouldn't have admitted.
 *
 * Key contract mirrors the md edit textarea: Enter submits, Shift+Enter
 * inserts a line, Escape closes. Styling comes from the static
 * `.keep-composer-editor` rules (prod CSP drops runtime <style> tags,
 * so Tiptap's injection stays off).
 */
export function RichMessageEditArea({
  initialHtml,
  onChange,
  onSubmit,
  onCancel,
  className,
  ariaLabel,
  richEnabled = true,
}: {
  initialHtml: string;
  /** Fired with the re-serialized whitelist HTML on every doc change. */
  onChange: (html: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  className: string;
  ariaLabel?: string;
  /**
   * Per-room rich-text toggle (migration 0354). False = the room is
   * Simple-formatting now: headings and alignment come out of the edit
   * schema, so a stored heading hydrates as a plain paragraph and the
   * saved body can't re-carry either construct (the PATCH route degrades
   * server-side regardless). Inline marks are untouched.
   */
  richEnabled?: boolean;
}) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  // Latest serialized body: a live richEnabled flip rebuilds the editor
  // (the heading/alignment schema can't change in place), and the fresh
  // instance must hydrate the in-progress draft, not the original body.
  const htmlRef = useRef(initialHtml);
  // Rebuilds must not steal keyboard focus from another field; restore
  // it only when the destroyed instance held it (destroying a focused
  // view fires no blur, so the flag survives the swap).
  const hadEditorRef = useRef(false);
  const editorFocusedRef = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: richEnabled ? { levels: [1, 2, 3] } : false,
        codeBlock: false,
        horizontalRule: false,
        orderedList: false,
        hardBreak: false,
        dropcursor: false,
        gapcursor: false,
        blockquote: false,
        listItem: false,
      }),
      Blockquote.extend({ content: "paragraph+" }),
      ListItem.extend({ content: "paragraph" }),
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
      Spoiler,
      TextColor,
      TextSize,
    ],
    // Defense in depth: the stored body was ingest-sanitized, but it
    // re-passes DOMPurify before Tiptap parses it, same as the feed.
    content: sanitizeRichClient(htmlRef.current),
    autofocus: !hadEditorRef.current || editorFocusedRef.current ? "end" : false,
    injectCSS: false,
    onCreate: ({ editor: e }) => {
      if (hadEditorRef.current) {
        // Rebuild pass: hydrating into the downgraded schema may have
        // unwrapped headings/alignment, so re-sync the serialized body
        // with the parent's draft state.
        const html = composerDocToRichHtml(normalizeComposerDoc(pmToComposerDoc(e.state.doc)));
        htmlRef.current = html;
        onChangeRef.current(html);
      }
      hadEditorRef.current = true;
    },
    onFocus: () => {
      editorFocusedRef.current = true;
    },
    onBlur: () => {
      editorFocusedRef.current = false;
    },
    onUpdate: ({ editor: e }) => {
      const html = composerDocToRichHtml(normalizeComposerDoc(pmToComposerDoc(e.state.doc)));
      htmlRef.current = html;
      onChangeRef.current(html);
    },
    editorProps: {
      attributes: {
        class: "keep-composer-editor block w-full px-2 py-1 text-sm outline-none",
        ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
      },
      handleKeyDown: (_view, event) => {
        if (event.isComposing) return false;
        if (event.key === "Escape") {
          event.preventDefault();
          onCancelRef.current();
          return true;
        }
        if (
          event.key === "Enter" &&
          !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
        ) {
          event.preventDefault();
          onSubmitRef.current();
          return true;
        }
        return false;
      },
    },
  // richEnabled changes the SCHEMA (heading node, textAlign attrs),
  // which needs a fresh editor — same contract as ComposerEditor.
  }, [richEnabled]);

  return (
    <div className={className}>
      <EditorContent editor={editor} />
    </div>
  );
}
