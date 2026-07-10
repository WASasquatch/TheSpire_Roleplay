/**
 * CloseButton, shared dismiss control rendered as a square `×`
 * button.
 *
 * Replaces the ad-hoc `<button>close</button>` text links scattered
 * across modals/panels with a single consistent affordance. The
 * glyph is the Unicode multiplication sign (U+00D7), universally
 * recognized as "close" without needing the word, and visually
 * lighter than typing the letter "X".
 *
 * Visual: bordered square, muted color, lifts to keep-text on hover
 * with a banner-tinted background, matches the existing keep-button
 * treatment so it feels native everywhere.
 *
 * Use `aria-label` (or the default "Close") to keep screen readers
 * happy; the visual `×` is `aria-hidden` so it's not announced.
 */

import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

interface Props {
  onClick: () => void;
  /** Defaults to the localized "Close". Pass a more specific label
   *  when the surface needs one (e.g. "Close admin panel"). */
  label?: string;
  /** Optional extra classes for positioning/alignment in tight
   *  headers (e.g. `self-start` to keep this in the top-right of
   *  a vertically-centered flex row). */
  className?: string;
}

export function CloseButton({ onClick, label, className }: Props) {
  const { t } = useTranslation("common");
  const effectiveLabel = label ?? t("close");
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={effectiveLabel}
      title={effectiveLabel}
      className={
        "shrink-0 inline-flex h-7 w-7 items-center justify-center rounded border border-keep-rule/60 bg-keep-bg/40 text-lg leading-none text-keep-muted hover:border-keep-rule hover:bg-keep-banner/60 hover:text-keep-text focus:outline-none focus:ring-1 focus:ring-keep-action " +
        (className ?? "")
      }
    >
      <span aria-hidden>×</span>
    </button>
  );
}

interface IconCloseButtonProps {
  onClick: () => void;
  /** Defaults to the localized "Close". */
  label?: string;
  /** Prepend `shrink-0` so the button doesn't collapse inside a flex
   *  header. Kept opt-in because some headers historically omit it. */
  shrink?: boolean;
  /** Extra classes appended after the base set. */
  className?: string;
}

/**
 * IconCloseButton — the bordered header dismiss control that renders a
 * Lucide `X` glyph (as opposed to {@link CloseButton}'s Unicode `×`).
 *
 * This is the copy that had drifted across panel headers
 * (NotificationCenter, ServerEventsPanel, ServerSettingsView). The
 * class set, icon size, and ARIA/title text are reproduced exactly; the
 * only per-caller knob is whether `shrink-0` leads the class list.
 */
export function IconCloseButton({ onClick, label, shrink = false, className }: IconCloseButtonProps) {
  const { t } = useTranslation("common");
  const effectiveLabel = label ?? t("close");
  return (
    <button
      type="button"
      onClick={onClick}
      title={effectiveLabel}
      aria-label={effectiveLabel}
      className={
        (shrink ? "shrink-0 " : "") +
        "rounded border border-keep-rule p-1 text-keep-muted hover:text-keep-text" +
        (className ? " " + className : "")
      }
    >
      <X className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
