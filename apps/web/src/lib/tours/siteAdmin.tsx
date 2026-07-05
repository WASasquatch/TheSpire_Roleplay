import type { CoachStep } from "../../components/CoachTour.js";

/**
 * Site Admin Panel first-run tour. Orients a keeper to the tab strip and its
 * five groups (Monitor, People & access, Content & community, Site
 * configuration, System). Steps target the PERSISTENT tab buttons so the
 * spotlight always lands on something real, and describe the deeper controls
 * in the body. Order follows the strip left to right.
 */
export const steps: CoachStep[] = [
  {
    title: "Welcome to the Admin Panel",
    body: "This is your control room for the whole site. Everything is sorted into tabs along the top, grouped by what they do.",
    targets: ['[data-tour="admin-tab-strip"]'],
  },
  {
    title: "Keep an eye on things",
    body: "Overview gives you a live snapshot, and the nearby tabs let you dig into analytics, reports, and the moderation log.",
    targets: ['[data-tour="admin-tab-overview"]'],
  },
  {
    title: "People and access",
    body: "Manage members here, and set what each role is allowed to do over in Permissions.",
    targets: ['[data-tour="admin-tab-users"]'],
  },
  {
    title: "Content and community",
    body: "Oversee community servers, forums, and the Scriptorium. Open a server to manage its own rooms, ranks, and rewards.",
    // Fall back to the whole strip if this keeper can't see the Servers tab.
    targets: ['[data-tour="admin-tab-servers"]', '[data-tour="admin-tab-forums"]', '[data-tour="admin-tab-strip"]'],
  },
  {
    title: "Set up the site",
    body: "Settings, Branding, and Rules shape how the whole site looks and behaves. Changes here reach everyone, so take your time.",
    // Fall back to the whole strip if this keeper can't see the Settings tab.
    targets: ['[data-tour="admin-tab-settings"]', '[data-tour="admin-tab-strip"]'],
  },
  {
    title: "You are all set",
    body: "You can replay this walkthrough any time from the question mark next to the tabs. Have a look around.",
    targets: ['[data-tour="admin-tab-strip"]'],
  },
];
