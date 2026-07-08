import type { CoachStep } from "../../components/tours/CoachTour.js";

export const steps: CoachStep[] = [
  {
    title: "Your forum settings",
    body: "Everything you need to run the place lives in these tabs. Pick one to open its tools.",
    targets: ['[data-tour="forum-settings-tab-strip"]'],
  },
  {
    title: "The basics",
    body: "Overview sets your forum's name, purpose, and who can join or post. Boards is where you add and reorder the boards inside it.",
    targets: ['[data-tour="forum-settings-tab-overview"]', '[data-tour="forum-settings-tab-boards"]'],
  },
  {
    title: "Your team",
    body: "In Roles you promote trusted members to moderators and choose exactly what each of them is allowed to do.",
    targets: ['[data-tour="forum-settings-tab-roles"]'],
  },
  {
    title: "Keep order",
    body: "Bans lets you remove troublemakers, for a while or for good, and lift a ban later.",
    targets: ['[data-tour="forum-settings-tab-bans"]'],
  },
  {
    title: "The paper trail",
    body: "The Mod log records what your moderators have done, so nothing happens in the dark.",
    targets: ['[data-tour="forum-settings-tab-modlog"]'],
  },
];
