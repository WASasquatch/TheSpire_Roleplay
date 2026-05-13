import { useEffect, type ReactNode } from "react";

interface ModalProps {
  onClose: () => void;
  /**
   * False = backdrop tap is a no-op (the welcome modal does this so the
   * dismiss path is explicit). Default true.
   */
  closeOnBackdrop?: boolean;
  /** False = Escape key is a no-op. Default true. */
  closeOnEscape?: boolean;
  /**
   * Stack level. Most modals are 40; world viewer / room-password sit
   * above the profile modal at 50. ProfileEditor's color picker uses 60.
   */
  zIndex?: number;
  /**
   * Layout for the backdrop wrapper.
   *   "centered" (default) — flex-centered with consistent padding on
   *     every size.
   *   "mobile-fullscreen" — child fills the viewport edge-to-edge on
   *     small screens (no padding); centers with padding on md+. Used
   *     by ProfileModal and WorldViewerModal so the in-header close
   *     button is reachable on mobile without a backdrop margin.
   */
  variant?: "centered" | "mobile-fullscreen";
  children: ReactNode;
}

const VARIANT_CLASS = {
  // Tighter padding on mobile (p-2 = 8px each side) so children using
  // `w-full` or `96vw` don't bleed into the viewport edge. The child
  // owns its own width cap.
  centered: "flex items-center justify-center p-2 md:p-4",
  "mobile-fullscreen": "flex items-stretch justify-stretch md:items-center md:justify-center md:p-4",
} as const;

/**
 * Shared modal backdrop. Owns:
 *   - backdrop click → onClose (gated by closeOnBackdrop)
 *   - Escape key → onClose (gated by closeOnEscape; document-level
 *     listener so the modal doesn't need keyboard focus to close)
 *   - role="dialog" + aria-modal="true" so screen readers and assistive
 *     tech see the modal as such
 *
 * Children own their own card layout and should stopPropagation on their
 * inner click handler so internal clicks don't dismiss the modal.
 */
export function Modal({
  onClose,
  closeOnBackdrop = true,
  closeOnEscape = true,
  zIndex = 40,
  variant = "centered",
  children,
}: ModalProps) {
  useEffect(() => {
    if (!closeOnEscape) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeOnEscape, onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{ zIndex }}
      className={`fixed inset-0 bg-black/40 ${VARIANT_CLASS[variant]}`}
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      {children}
    </div>
  );
}
