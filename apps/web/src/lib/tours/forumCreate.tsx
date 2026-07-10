import type { TFunction } from "i18next";
import type { CoachStep } from "../../components/tours/CoachTour.js";

export const steps = (t: TFunction<"tours">): CoachStep[] => [
  {
    title: t("forumCreate.name.title"),
    body: t("forumCreate.name.body"),
    targets: ['[data-tour="forum-create-name-input"]'],
  },
  {
    title: t("forumCreate.address.title"),
    body: t("forumCreate.address.body"),
    targets: ['[data-tour="forum-create-slug-input"]'],
  },
  {
    title: t("forumCreate.purpose.title"),
    body: t("forumCreate.purpose.body"),
    targets: ['[data-tour="forum-create-purpose-input"]'],
  },
  {
    title: t("forumCreate.submit.title"),
    body: t("forumCreate.submit.body"),
    targets: ['[data-tour="forum-create-submit"]'],
  },
];
