import DOMPurify from "dompurify";
import { useState } from "react";
import { Modal } from "./cosmetics/Modal.js";

interface Props {
  /** Sanitized HTML body. Server already ran this through the bio allow-list; we DOMPurify a second time as defense-in-depth. */
  html: string;
  /** Hash the user is acknowledging - sent to the dismiss endpoint so the server can record what they actually saw. */
  hash: string;
  /** Called after the dismiss POST resolves (or fails); parent should hide the modal so the user can use the chat. */
  onDismissed: () => void;
}

/**
 * One-shot welcome / announcement modal for logged-in users. The server
 * decides when to render this (returns `welcome: { html, hash }` from
 * /me/profile only when the user hasn't acknowledged the current hash).
 *
 * Hashing the welcome content means edits in admin auto-re-show the modal
 * to everyone on their next page load - no manual "broadcast" button
 * needed - while users who already acknowledged the current text won't
 * see it twice.
 */
export function WelcomeModal({ html, hash, onDismissed }: Props) {
  const [busy, setBusy] = useState(false);

  async function dismiss() {
    setBusy(true);
    try {
      await fetch("/me/welcome/dismiss", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash }),
      });
    } catch {
      // Network blip - the modal will re-appear on the next /me/profile
      // fetch, which is the safe degradation here. Don't block the user.
    } finally {
      onDismissed();
    }
  }

  return (
    // Backdrop click and Esc are both disabled, this is intentional. The
    // server records `hash` only when the user clicks "Got it", so a
    // dismissive Esc/backdrop tap could leave them in a state where the
    // welcome re-renders next page load. The button is the only path out.
    <Modal onClose={onDismissed} closeOnBackdrop={false} closeOnEscape={false} zIndex={50}>
      <div
        className="keep-frame flex max-h-[85vh] w-full flex-col overflow-hidden rounded bg-keep-bg text-keep-text md:w-[min(720px,78vw)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-keep-rule bg-keep-banner px-4 py-2">
          <h2 id="welcome-modal-title" className="font-action text-lg">
            Welcome
          </h2>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div
            className="prose prose-sm max-w-none break-words"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }}
          />
        </div>
        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-keep-rule bg-keep-panel/40 px-4 py-2">
          <button
            type="button"
            onClick={dismiss}
            disabled={busy}
            className="rounded border border-keep-action/60 bg-keep-action/10 px-3 py-1 text-sm font-semibold text-keep-action hover:bg-keep-action/20 disabled:opacity-50"
          >
            {busy ? "Saving..." : "Got it"}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
