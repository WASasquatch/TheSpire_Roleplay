import type { CoachStep } from "../../components/CoachTour.js";

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
export const steps: CoachStep[] = [
  {
    title: "Welcome to the Forums",
    body: "Forums are for long-form writing you want to keep — boards and topics that stay put instead of scrolling away like chat.",
  },
  {
    title: "Discover more forums",
    body: "Tap the compass to browse other communities' forums and search any of them by name or tag.",
    targets: ['[data-tour="forums-chrome-discover-btn"]'],
  },
  {
    title: "Start your own",
    body: "Ready to gather your own community? Look for the Create your Forum button to apply, and a keeper will review it.",
  },
];
