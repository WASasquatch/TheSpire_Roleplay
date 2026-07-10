import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TourId } from "@thekeep/shared";
import { useChat } from "../../state/store.js";
import { TOUR_REGISTRY } from "../../lib/tours/index.js";
import { CoachTour } from "./CoachTour.js";

/**
 * Contextual first-time tour driver for a single surface.
 *
 * Mount one of these inside a surface (the Forums catalog, a server admin
 * panel, …) passing that surface's `tourId` and an `active` flag (true while
 * the surface is actually visible/mounted). It opens the shared <CoachTour>
 * exactly when all of these hold:
 *
 *   - `active` (the surface is up), AND
 *   - the tour is due — either the server listed it in `toursToShow`, or the
 *     user asked to replay it (`forcedTourId === tourId`), AND
 *   - the registry actually has steps for this tour (surface teams fill these
 *     in later; an empty step list renders nothing).
 *
 * Closing the tour calls `dismissTour(tourId)`, which optimistically drops it
 * from `toursToShow` and fire-and-forgets the server dismiss. CoachTour itself
 * is reused unchanged.
 */
export function ContextualTour({ tourId, active }: { tourId: TourId; active: boolean }) {
  const { t } = useTranslation("tours");
  const toursToShow = useChat((s) => s.toursToShow);
  const forcedTourId = useChat((s) => s.forcedTourId);
  const dismissTour = useChat((s) => s.dismissTour);

  const entry = TOUR_REGISTRY[tourId];
  // Memoized so the step objects keep a stable identity across unrelated
  // re-renders (CoachTour re-measures its spotlight when the current step's
  // identity changes); `t` changes on a language flip, rebuilding the copy.
  const steps = useMemo(() => entry.steps(t), [entry, t]);
  const due = toursToShow.includes(tourId) || forcedTourId === tourId;

  if (!active || !due || steps.length === 0) return null;

  return (
    <CoachTour
      steps={steps}
      icon={entry.icon}
      onClose={() => dismissTour(tourId)}
    />
  );
}
