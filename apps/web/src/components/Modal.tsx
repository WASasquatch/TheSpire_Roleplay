import { useEffect, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useReducedMotion } from "../lib/reducedMotion.js";

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
   *   "centered" (default), flex-centered with consistent padding on
   *     every size.
   *   "mobile-fullscreen", child fills the viewport edge-to-edge on
   *     small screens (no padding); centers with padding on md+. Used
   *     by ProfileModal and WorldViewerModal so the in-header close
   *     button is reachable on mobile without a backdrop margin.
   */
  variant?: "centered" | "mobile-fullscreen";
  /**
   * Inline-style escape hatch for the backdrop div (the click-to-close
   * surface). Used by ProfileModal to paint the owner's chosen public-
   * profile background image, the backdrop CSS gets merged onto the
   * same div that owns the dismiss handler, so the override changes
   * how the backdrop looks without breaking how it behaves (clicks
   * still bubble to `onClose`). `zIndex` always wins over anything
   * passed here so the stacking-order contract is preserved.
   */
  backdropStyle?: CSSProperties;
  children: ReactNode;
}

const VARIANT_CLASS = {
  // Tighter padding on mobile (p-2 = 8px each side) so children using
  // `w-full` or `96vw` don't bleed into the viewport edge. The child
  // owns its own width cap. Used by small input-prompt modals (room
  // password, character-create) where a centered card is the goal.
  centered: "flex items-center justify-center p-2 md:p-4",
  // Content modals: edge-to-edge fill on mobile (no padding, child
  // expands via `w-full h-full`), then centered with breathing room
  // on `lg+`. Pinned to `lg` so it matches the rest of the chat shell's
  // mobile/desktop boundary, at 768–1023px we still want the modal
  // to behave like mobile (the chat itself is in drawer-rail mode
  // there). Pair with the `MODAL_CARD_CONTENT` helper below for the
  // standard 75vw desktop sizing.
  "mobile-fullscreen": "flex items-stretch justify-stretch lg:items-center lg:justify-center lg:p-4",
} as const;

/**
 * Standard size class for content-shaped modals (Profile, Earning,
 * Rules, Help, Admin, Users, Worlds, etc.). Edge-to-edge on mobile,
 * 75vw centered on desktop with a generous max so 4K viewports
 * actually get the proportional width instead of a 1000px box.
 *
 * Each modal still owns its own background / border / shadow class
 * (themes differ between parchment-card and bg-keep-bg shells),
 * this constant is purely the sizing recipe. Spread it into the
 * card's className alongside whatever decoration the modal uses.
 *
 *   <div className={`${MODAL_CARD_CONTENT} bg-keep-bg`}>…</div>
 *
 * NOT for small input prompts (room password, "new character" name
 * entry, etc.). Those keep their own tight `w-[20rem]` / `max-w-md`
 * sizing, a 75vw modal asking "what's the name?" reads as
 * disproportionate.
 */
export const MODAL_CARD_CONTENT =
  "flex h-full w-full flex-col overflow-hidden lg:h-[90vh] lg:w-[75vw] lg:max-w-[2400px]";

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
  backdropStyle,
  children,
}: ModalProps) {
  // Under Reduce Motion, ease the whole modal (backdrop + card) in with a
  // gentle opacity fade instead of the default instant pop. Fade is applied to
  // the backdrop wrapper so the card rides along; pure opacity, no movement.
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!closeOnEscape) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeOnEscape, onClose]);

  // Portal to <body> so the backdrop's `position: fixed` always
  // resolves against the viewport. Without this, a modal opened
  // from inside a `.keep-frame` (or any ancestor with `transform`,
  // `filter`, `backdrop-filter`, `perspective`, etc.) gets clipped
  // to that ancestor's box, since those properties make the
  // ancestor the containing block for fixed descendants. This bit
  // the nested EmoticonSubmissionModal in glass theme, the
  // dashboard's `.keep-frame` has `backdrop-filter: blur(...)`,
  // so the submission modal's `fixed inset-0` rendered only over
  // the dashboard card and its stacking context trapped the
  // z-index, producing a blank dark overlay with no visible card.
  // Portaling lifts every modal out of those traps in one place.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      // Caller's backdropStyle first; zIndex applied last so it always
      // wins. Inline styles (backgroundImage from ProfileModal's BG
      // override) layer on top of the `bg-black/40` Tailwind class
      // since CSS paints background-image over background-color.
      style={{ ...backdropStyle, zIndex }}
      className={`fixed inset-0 bg-black/40 ${VARIANT_CLASS[variant]}${reduceMotion ? " tk-fade-in" : ""}`}
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      {children}
    </div>,
    document.body,
  );
}
