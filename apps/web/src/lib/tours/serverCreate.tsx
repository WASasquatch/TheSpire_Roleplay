import type { TFunction } from "i18next";
import type { CoachStep } from "../../components/tours/CoachTour.js";

/**
 * Server-create tour: walks an eligible viewer through the application form for
 * raising their own community server — its three fields and the Apply button
 * that sends it for review.
 *
 * It starts on the form's first field, not the rail "+" button that opened
 * Discover: this tour only fires once the application form is already open, and
 * that rail button sits behind the open full-screen modal (occluded), so
 * spotlighting it would ring an element the viewer can't see. Every step here
 * targets a field inside the open form.
 */
export const steps = (t: TFunction<"tours">): CoachStep[] => [
  {
    title: t("serverCreate.name.title"),
    body: t("serverCreate.name.body"),
    targets: ['[data-tour="server-create-name"]'],
  },
  {
    title: t("serverCreate.address.title"),
    body: t("serverCreate.address.body"),
    targets: ['[data-tour="server-create-slug"]'],
  },
  {
    title: t("serverCreate.purpose.title"),
    body: t("serverCreate.purpose.body"),
    targets: ['[data-tour="server-create-purpose"]'],
  },
  {
    title: t("serverCreate.submit.title"),
    body: t("serverCreate.submit.body"),
    targets: ['[data-tour="server-create-submit"]'],
  },
];
