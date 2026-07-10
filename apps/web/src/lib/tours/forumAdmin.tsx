import type { TFunction } from "i18next";
import type { CoachStep } from "../../components/tours/CoachTour.js";

export const steps = (t: TFunction<"tours">): CoachStep[] => [
  {
    title: t("forumAdmin.settings.title"),
    body: t("forumAdmin.settings.body"),
    targets: ['[data-tour="forum-settings-tab-strip"]'],
  },
  {
    title: t("forumAdmin.basics.title"),
    body: t("forumAdmin.basics.body"),
    targets: ['[data-tour="forum-settings-tab-overview"]', '[data-tour="forum-settings-tab-boards"]'],
  },
  {
    title: t("forumAdmin.team.title"),
    body: t("forumAdmin.team.body"),
    targets: ['[data-tour="forum-settings-tab-roles"]'],
  },
  {
    title: t("forumAdmin.keepOrder.title"),
    body: t("forumAdmin.keepOrder.body"),
    targets: ['[data-tour="forum-settings-tab-bans"]'],
  },
  {
    title: t("forumAdmin.modLog.title"),
    body: t("forumAdmin.modLog.body"),
    targets: ['[data-tour="forum-settings-tab-modlog"]'],
  },
];
