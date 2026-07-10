import type { TFunction } from "i18next";
import type { CoachStep } from "../../components/tours/CoachTour.js";

/**
 * Server-admin tour: orients the owner (or a mod with the matching grants) in
 * their per-server console. The console is a tabbed panel and the tabs shift
 * with the viewer's permissions, so every step anchors to the persistent tab
 * strip (always mounted) and names the tab it's talking about, rather than a
 * control that only exists while its tab is open.
 */
export const steps = (t: TFunction<"tours">): CoachStep[] => [
  {
    title: t("serverAdmin.controlRoom.title"),
    body: t("serverAdmin.controlRoom.body"),
    targets: ['[data-tour="server-settings-tab-strip"]'],
  },
  {
    title: t("serverAdmin.overview.title"),
    body: t("serverAdmin.overview.body"),
    targets: ['[data-tour="server-settings-tab-overview"]', '[data-tour="server-settings-tab-strip"]'],
  },
  {
    title: t("serverAdmin.appearance.title"),
    body: t("serverAdmin.appearance.body"),
    targets: ['[data-tour="server-settings-tab-appearance"]', '[data-tour="server-settings-tab-strip"]'],
  },
  {
    title: t("serverAdmin.rooms.title"),
    body: t("serverAdmin.rooms.body"),
    targets: ['[data-tour="server-settings-tab-rooms"]', '[data-tour="server-settings-tab-strip"]'],
  },
  {
    title: t("serverAdmin.members.title"),
    body: t("serverAdmin.members.body"),
    targets: ['[data-tour="server-settings-tab-members"]', '[data-tour="server-settings-tab-strip"]'],
  },
  {
    title: t("serverAdmin.roles.title"),
    body: t("serverAdmin.roles.body"),
    targets: ['[data-tour="server-settings-tab-roles"]', '[data-tour="server-settings-tab-strip"]'],
  },
  {
    title: t("serverAdmin.save.title"),
    body: t("serverAdmin.save.body"),
    targets: ['[data-tour="server-settings-tab-strip"]'],
  },
];
