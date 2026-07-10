/**
 * Floating "back to top" button for long scrolling surfaces (the Rules
 * page/modal, where the stacked privacy + rules content runs several
 * screens on mobile).
 *
 * Renders nothing until the surface has scrolled past `threshold`, then
 * fades in as a semi-transparent circle (full opacity on hover/focus)
 * so it never fights the content for attention. Clicking scrolls back
 * to the top, honoring the reduce-motion preference.
 *
 * Positioning is the CALLER's job via `className` (`fixed bottom-4
 * right-4` for window-scrolled pages, `absolute` inside a relative
 * wrapper for modal scroll containers) because the right anchor depends
 * on the surface's chrome (footers, safe areas).
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp } from "lucide-react";
import { useReducedMotion } from "../../lib/reducedMotion.js";

interface Props {
  /** The scrolling element; omit/null for window scrolling. */
  scroller?: HTMLElement | null;
  /** Scroll distance (px) before the button appears. */
  threshold?: number;
  /** Positioning classes from the caller (fixed vs absolute + offsets). */
  className: string;
}

export function BackToTop({ scroller, threshold = 400, className }: Props) {
  const { t } = useTranslation("servers");
  const reduceMotion = useReducedMotion();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const target: HTMLElement | Window = scroller ?? window;
    const read = () => (scroller ? scroller.scrollTop : window.scrollY);
    const onScroll = () => setVisible(read() > threshold);
    onScroll();
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => target.removeEventListener("scroll", onScroll);
  }, [scroller, threshold]);

  if (!visible) return null;

  const jump = () => {
    const behavior: ScrollBehavior = reduceMotion ? "auto" : "smooth";
    if (scroller) scroller.scrollTo({ top: 0, behavior });
    else window.scrollTo({ top: 0, behavior });
  };

  return (
    <button
      type="button"
      onClick={jump}
      title={t("rules.backToTop")}
      aria-label={t("rules.backToTop")}
      className={`${className} z-20 flex h-10 w-10 items-center justify-center rounded-full border border-keep-border bg-keep-panel text-keep-text opacity-60 shadow-lg transition-opacity hover:opacity-100 focus-visible:opacity-100`}
    >
      <ArrowUp className="h-5 w-5" aria-hidden />
    </button>
  );
}
