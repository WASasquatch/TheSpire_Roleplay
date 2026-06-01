import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * Render an inline `<img>` or `<iframe>` that:
 *
 *   1. Defers initial load until the placeholder is near the viewport.
 *      Native `loading="lazy"` covers the cheap case but a custom
 *      IntersectionObserver makes the threshold tunable + lets us
 *      *unload* the resource again when it scrolls far enough away.
 *
 *   2. Detaches the resource entirely when scrolled past `OFFSCREEN_MARGIN`
 *      so a YouTube iframe stops eating CPU (autoplay videos keep
 *      running offscreen otherwise) and a giant `<img>` stops holding
 *      decoded pixel memory.
 *
 *   3. Reloads cleanly when the placeholder scrolls back into range.
 *      For images we re-set the src (browser cache makes this cheap);
 *      for iframes the same — they're built to remount, and the
 *      detach/remount cycle is what frees the embedded player.
 *
 * Layout stability: the wrapper renders a sized placeholder using the
 * caller-provided className + style so the chat scroll buffer doesn't
 * jump when the inner element appears/disappears. The placeholder is
 * still in the DOM the whole time — only the `<img>` / `<iframe>`
 * itself flips in and out.
 *
 * Used by:
 *   - `lib/markdown.tsx`'s UrlOrMedia for "Show image" / "Show video"
 *     toggles in chat messages.
 *
 * The caller controls *whether* the embed shows at all (the
 * privacy-by-default toggle still lives in `UrlOrMedia`). This
 * component only manages the lifecycle of the already-revealed embed.
 */

const NEAR_VIEWPORT_MARGIN = "200px"; // start preloading 200px before scroll-in
const OFFSCREEN_DETACH_DELAY_MS = 3000; // wait 3s after going offscreen before tearing down

export function LazyMediaEmbed({
  kind,
  src,
  alt,
  title,
  iframeAllow,
  iframeAllowFullScreen,
  iframeReferrerPolicy,
  imgReferrerPolicy = "no-referrer",
  className,
  style,
  placeholderLabel,
}: {
  kind: "img" | "iframe";
  src: string;
  alt?: string;
  /** Forwarded to `<iframe title>` for accessibility. Ignored for img. */
  title?: string;
  iframeAllow?: string;
  iframeAllowFullScreen?: boolean;
  iframeReferrerPolicy?: React.HTMLAttributeReferrerPolicy;
  imgReferrerPolicy?: React.HTMLAttributeReferrerPolicy;
  /** Sizing classes applied to BOTH the placeholder and the loaded
   *  element so the layout doesn't reflow on attach/detach. */
  className?: string;
  /** Same intent as `className` — inline style fork for callers that
   *  need viewport-relative caps that don't fit in a Tailwind class. */
  style?: CSSProperties;
  /** Short text shown while the placeholder is in DOM but the embed
   *  is detached. Defaults to "Loading…" / "Paused offscreen". */
  placeholderLabel?: string;
}) {
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  // `attached` = the actual <img>/<iframe> is mounted; false renders
  // the placeholder div with the same dimensions.
  const [attached, setAttached] = useState(false);
  // Track the most recent visibility so a flicker (in→out→in within
  // the detach delay) doesn't tear down the embed needlessly.
  const detachTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const node = wrapperRef.current;
    if (!node) return;
    // Defensive: if IntersectionObserver isn't available (older
    // browsers), attach immediately and never detach. Better to
    // degrade than to leave the user staring at a placeholder.
    if (typeof IntersectionObserver === "undefined") {
      setAttached(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        if (entry.isIntersecting) {
          // Cancel any pending detach if we scrolled back.
          if (detachTimerRef.current !== null) {
            window.clearTimeout(detachTimerRef.current);
            detachTimerRef.current = null;
          }
          setAttached(true);
        } else {
          // Defer the detach so a quick flick past the embed doesn't
          // tear it down + immediately remount it. Three seconds is
          // long enough that "still on the screen but scrolled out
          // momentarily" doesn't trigger; short enough that browsing
          // away from the chat for a few seconds frees the resource.
          if (detachTimerRef.current !== null) {
            window.clearTimeout(detachTimerRef.current);
          }
          detachTimerRef.current = window.setTimeout(() => {
            setAttached(false);
            detachTimerRef.current = null;
          }, OFFSCREEN_DETACH_DELAY_MS);
        }
      },
      // `rootMargin` extends the observed area so we preload BEFORE
      // the embed actually hits the viewport — eliminates the
      // pop-in-on-scroll feel.
      { rootMargin: NEAR_VIEWPORT_MARGIN },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (detachTimerRef.current !== null) {
        window.clearTimeout(detachTimerRef.current);
        detachTimerRef.current = null;
      }
    };
  }, []);

  const placeholder = (
    <span
      // Match the same sizing as the loaded element so the swap
      // doesn't reflow. `aspect-video` etc. come from the className.
      className={`flex items-center justify-center bg-keep-panel/40 text-[10px] uppercase tracking-widest text-keep-muted ${className ?? ""}`}
      style={style}
      aria-hidden
    >
      {placeholderLabel ?? "loading…"}
    </span>
  );

  // Wrapper sizing: images carry their own intrinsic dimensions, so
  // `inline-block` (shrink-to-content) is the right wrapper for the
  // image case. Iframes have a tiny default intrinsic size (300x150)
  // and rely on the caller's `w-full aspect-video` class to be sized
  // properly — so for iframes the wrapper has to stretch (`block`)
  // and inherit width sizing from the caller's class so `w-full` on
  // the iframe resolves to the parent's actual width, not zero.
  const wrapperClass = kind === "iframe"
    ? `block ${className ?? ""}`
    : "inline-block";
  return (
    <span ref={wrapperRef} className={wrapperClass} style={kind === "iframe" ? style : undefined}>
      {attached
        ? kind === "img"
          ? (
            <img
              src={src}
              alt={alt ?? ""}
              loading="lazy"
              referrerPolicy={imgReferrerPolicy}
              className={className}
              style={style}
            />
          )
          : (
            <iframe
              src={src}
              {...(title ? { title } : {})}
              loading="lazy"
              {...(iframeReferrerPolicy ? { referrerPolicy: iframeReferrerPolicy } : {})}
              {...(iframeAllow ? { allow: iframeAllow } : {})}
              allowFullScreen={!!iframeAllowFullScreen}
              // The wrapper already carries the caller's class, so the
              // iframe just needs to fill that wrapper. `block` strips
              // the iframe's default inline-baseline whitespace gap.
              className="block h-full w-full border-0"
            />
          )
        : placeholder}
    </span>
  );
}
