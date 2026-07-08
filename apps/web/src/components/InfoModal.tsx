import { Modal } from "./cosmetics/Modal.js";
import { CloseButton } from "./shared/CloseButton.js";

interface Props {
  title: string;
  body: string;
  onClose: () => void;
}

/**
 * InfoModal, a persistent display for server-emitted informational
 * payloads that are too long for the auto-dismissing toast.
 *
 * Used by commands that produce multi-line structured output the
 * user wants to scan / re-scan at leisure (e.g. `/list` of public
 * rooms, `/find <name>` for partial-match room search). The toast
 * channel is reserved for single-line transient feedback (errors,
 * one-shot confirmations), anything with a header line + bullet
 * list belongs here.
 *
 * Renders the body inside a `<pre>` with `whitespace-pre-wrap` and
 * a monospace font so the server's bullet-list alignment (leading
 * spaces, aligned columns) survives intact. Scrolls vertically
 * inside a bounded card so a 50-result list stays usable on small
 * viewports.
 *
 * Sized smaller than content modals: ~28rem max width, ~70vh max
 * height, centered with the standard backdrop. Closing is via the
 * × button, backdrop click, or Escape (all owned by the base
 * `Modal` component).
 */
export function InfoModal({ title, body, onClose }: Props) {
  return (
    <Modal onClose={onClose} zIndex={45} variant="centered">
      <div
        onClick={(e) => e.stopPropagation()}
        className="keep-frame flex max-h-[80vh] w-full max-w-md flex-col rounded bg-keep-bg shadow-lg md:max-w-lg"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-keep-rule bg-keep-banner px-3 py-2">
          <h2 className="font-action text-sm">{title}</h2>
          <CloseButton onClick={onClose} />
        </div>
        <pre className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-relaxed text-keep-text">
          {body}
        </pre>
        <div className="shrink-0 border-t border-keep-rule bg-keep-banner/40 px-3 py-1.5 text-[10px] text-keep-muted">
          Press <kbd className="rounded border border-keep-rule bg-keep-bg px-1">Esc</kbd> or click outside to close.
        </div>
      </div>
    </Modal>
  );
}
