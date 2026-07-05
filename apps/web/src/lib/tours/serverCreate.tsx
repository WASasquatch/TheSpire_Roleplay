import type { CoachStep } from "../../components/CoachTour.js";

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
export const steps: CoachStep[] = [
  {
    title: "Name your server",
    body: "Give your community a name people will recognize. You can change how it looks later.",
    targets: ['[data-tour="server-create-name"]'],
  },
  {
    title: "Pick an address",
    body: "This is the short link people use to reach your server. We check it's free as you type.",
    targets: ['[data-tour="server-create-slug"]'],
  },
  {
    title: "Say what it's for",
    body: "Tell our reviewers who your community is for and what its rooms will hold.",
    targets: ['[data-tour="server-create-purpose"]'],
  },
  {
    title: "Send it in",
    body: "Apply and our moderators take it from there. You'll hear back here and in chat once it's decided.",
    targets: ['[data-tour="server-create-submit"]'],
  },
];
