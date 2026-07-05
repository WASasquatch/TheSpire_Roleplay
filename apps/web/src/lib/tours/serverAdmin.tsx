import type { CoachStep } from "../../components/CoachTour.js";

/**
 * Server-admin tour: orients the owner (or a mod with the matching grants) in
 * their per-server console. The console is a tabbed panel and the tabs shift
 * with the viewer's permissions, so every step anchors to the persistent tab
 * strip (always mounted) and names the tab it's talking about, rather than a
 * control that only exists while its tab is open.
 */
export const steps: CoachStep[] = [
  {
    title: "Your server's control room",
    body: "Everything about this community lives behind these tabs. Pick one to work on it, and your changes save right here.",
    targets: ['[data-tour="server-settings-tab-strip"]'],
  },
  {
    title: "Name and how people join",
    body: "The Overview tab sets your server's name, tagline, and whether folks join instantly, apply, or need an invite.",
    targets: ['[data-tour="server-settings-tab-overview"]', '[data-tour="server-settings-tab-strip"]'],
  },
  {
    title: "Make it yours",
    body: "The Appearance tab is for your icon, banner, and colors, so members always know which server they're in.",
    targets: ['[data-tour="server-settings-tab-appearance"]', '[data-tour="server-settings-tab-strip"]'],
  },
  {
    title: "Add your rooms",
    body: "Open the Rooms tab and use New room to add a place to talk. Give it a name and it shows up for your members.",
    targets: ['[data-tour="server-settings-tab-rooms"]', '[data-tour="server-settings-tab-strip"]'],
  },
  {
    title: "Give someone a hand",
    body: "In the Members tab, Make mod hands a trusted member the tools to help you run the place.",
    targets: ['[data-tour="server-settings-tab-members"]', '[data-tour="server-settings-tab-strip"]'],
  },
  {
    title: "Decide who can do what",
    body: "The Roles tab is where you appoint staff and choose exactly which powers they hold. Grant only what each person needs.",
    targets: ['[data-tour="server-settings-tab-roles"]', '[data-tour="server-settings-tab-strip"]'],
  },
  {
    title: "Nothing is lost",
    body: "Each tab has its own Save button. Make your changes, press Save, and you're done. You can reopen this walkthrough any time from the question mark up top.",
    targets: ['[data-tour="server-settings-tab-strip"]'],
  },
];
