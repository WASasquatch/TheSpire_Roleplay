import type { TFunction } from "i18next";
import type { CoachStep } from "../../components/tours/CoachTour.js";

/**
 * Site Admin Panel first-run tour. Orients a keeper to the tab strip and its
 * six groups (docs/ADMIN_IA.md §2: Keeping watch, Members & roles,
 * Communities & content, Site setup, Growth & email, Backups & maintenance).
 * Steps target the PERSISTENT tab buttons so the spotlight always lands on
 * something real, and describe the deeper controls in the body. Order
 * follows the strip left to right.
 */
export const steps = (t: TFunction<"tours">): CoachStep[] => [
  {
    title: t("siteAdmin.welcome.title"),
    body: t("siteAdmin.welcome.body"),
    targets: ['[data-tour="admin-tab-strip"]'],
  },
  {
    title: t("siteAdmin.monitor.title"),
    body: t("siteAdmin.monitor.body"),
    targets: ['[data-tour="admin-tab-overview"]'],
  },
  {
    title: t("siteAdmin.people.title"),
    body: t("siteAdmin.people.body"),
    targets: ['[data-tour="admin-tab-users"]'],
  },
  {
    title: t("siteAdmin.content.title"),
    body: t("siteAdmin.content.body"),
    // Fall back to the whole strip if this keeper can't see the Servers tab.
    targets: ['[data-tour="admin-tab-servers"]', '[data-tour="admin-tab-forums"]', '[data-tour="admin-tab-strip"]'],
  },
  {
    title: t("siteAdmin.configure.title"),
    body: t("siteAdmin.configure.body"),
    // Fall back to the whole strip if this keeper can't see the Settings tab.
    targets: ['[data-tour="admin-tab-settings"]', '[data-tour="admin-tab-strip"]'],
  },
  {
    title: t("siteAdmin.done.title"),
    body: t("siteAdmin.done.body"),
    targets: ['[data-tour="admin-tab-strip"]'],
  },
];
