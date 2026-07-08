import type { CoachStep } from "../../components/tours/CoachTour.js";

export const steps: CoachStep[] = [
  {
    title: "Name your forum",
    body: "This is what everyone will see in the catalog. Pick something that fits your community.",
    targets: ['[data-tour="forum-create-name-input"]'],
  },
  {
    title: "Choose an address",
    body: "This is the short link people use to find you. It has to be free, and we'll tell you if it's taken.",
    targets: ['[data-tour="forum-create-slug-input"]'],
  },
  {
    title: "Tell us the purpose",
    body: "Explain what your forum gathers and what its boards will hold. Reviewers read this before approving.",
    targets: ['[data-tour="forum-create-purpose-input"]'],
  },
  {
    title: "Send it in",
    body: "Apply when you're ready. A site moderator reviews it, and you'll hear back here and in chat.",
    targets: ['[data-tour="forum-create-submit"]'],
  },
];
