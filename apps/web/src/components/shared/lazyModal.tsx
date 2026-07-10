/**
 * Code-split modal/surface loader with a BUILT-IN Suspense boundary.
 *
 * The app wraps its whole authenticated shell in one high-level
 * `<Suspense fallback={null}>`. A bare `React.lazy` modal suspends into
 * that ancestor on its first open, so React swapped the ENTIRE shell for
 * `null` while the chunk downloaded — the "app blanks out for a moment
 * when opening Server Admin / the Profile Editor / …" report. Wrapping
 * each lazy component in its own boundary here means only the modal
 * itself waits for its chunk; the shell (and any other open modal) stays
 * painted, and the user sees a brief translucent veil instead of a blank
 * page.
 *
 * Drop-in replacement: `lazyModal(() => import(...).then(...))` where
 * `lazy(...)` was used; call sites don't change.
 */

import { lazy, Suspense, type ComponentProps, type ComponentType, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Translucent full-viewport veil + pulse while a modal's chunk loads.
 *  Swallows clicks so a double-click can't fire whatever is behind the
 *  spot where the modal is about to appear. Chunk loads are typically
 *  well under a second, so this reads as "opening…", not as a spinner
 *  screen. Portaled to <body>: the app shell is its own stacking context,
 *  so an inline z-[80] would paint BELOW every body-portaled Modal (40-70)
 *  and FloatingWindow — at body level the 80 actually wins (CoachTour's
 *  z-200 stays above). */
function ChunkVeil() {
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30" aria-hidden>
      <div className="h-3 w-3 animate-pulse rounded-full bg-keep-action" />
    </div>,
    document.body,
  );
}

// Generic shape mirrors React.lazy itself (infer the whole component type,
// not its props) so every former `lazy(...)` call site type-checks
// unchanged. The spread cast is the standard workaround for TS's generic
// JSX-spread limitation under exactOptionalPropertyTypes.
//
// `fallback` override: the veil is for USER-OPENED surfaces. A component
// that mounts at app boot (the notification bell) must pass `null` here,
// or every page load flashes a click-blocking dark veil while its chunk
// downloads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyModal<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
  fallback: ReactNode = <ChunkVeil />,
): T {
  const Inner = lazy(load);
  function LazyModalBoundary(props: ComponentProps<T>) {
    return (
      <Suspense fallback={fallback}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <Inner {...(props as any)} />
      </Suspense>
    );
  }
  return LazyModalBoundary as unknown as T;
}
