import type { TFunction } from "i18next";
import type { CoachStep } from "../../components/tours/CoachTour.js";

/**
 * Forums browse tour — the first-run "welcome to the forums" overview. It runs
 * on the FORUM view (the Catalog's default landing), so it does NOT force the
 * mostly-empty Discover list to be the first thing a newcomer sees.
 *
 * Only step 2 carries a target: the chrome-bar Discover compass, which is the
 * one browse affordance visible in every viewport (the forums rail is
 * display:none under lg and the mobile forum list is a closed drawer, so a rail
 * anchor would measure as a zero-size box). The welcome and "start your own"
 * steps are centered narration.
 */
export const steps = (t: TFunction<"tours">): CoachStep[] => [
  {
    title: t("forumsBrowse.welcome.title"),
    body: t("forumsBrowse.welcome.body"),
  },
  {
    title: t("forumsBrowse.discover.title"),
    body: t("forumsBrowse.discover.body"),
    targets: ['[data-tour="forums-chrome-discover-btn"]'],
  },
  {
    title: t("forumsBrowse.startYourOwn.title"),
    body: t("forumsBrowse.startYourOwn.body"),
    // The rail's Create-your-Forum button — renders only for members who
    // can apply, so ineligible viewers get the centered-card fallback.
    targets: ['[data-tour="forums-create-button"]'],
  },
];
