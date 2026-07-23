/**
 * Find-a-setting index for the Global Admin panel (docs/ADMIN_IA.md §5).
 *
 * This module is DATA ONLY: a curated key→place map the search component
 * resolves against the loaded i18next `admin` catalog at runtime, so the
 * searchable text always matches the viewer's locale (with i18next's
 * built-in en fallback for untranslated keys — Spanish search is never
 * empty). No strings live here; every `key` / `also` value is an
 * admin-namespace catalog key.
 *
 * Anchor contract: each entry's `key` doubles as the jump target — the tab
 * that owns the row stamps `data-admin-anchor="<key>"` (the catalog key,
 * verbatim, dots included) on its `<fieldset>` (fieldset entries) or the
 * wrapping `<label>` (row entries). Missing anchors are harmless: picking
 * the hit still switches tabs, the scroll+flash just no-ops.
 *
 * Tab-level entries (`panel.tab.<id>`) are NOT listed here — AdminPanel
 * derives them from TAB_ITEMS so they can never drift from the registry.
 * Extension is additive: append entries + stamp anchors; nothing else
 * changes. The ORPHAN admin tab components (Emoticons, Announcements,
 * FAQs, Earning — moved per-server) are deliberately unindexed.
 */
import type { AdminTab } from "./AdminPanel.js";

/** Subtab ids for the Settings tab split (docs/ADMIN_IA.md §4). Owned here
 *  so the search index, AdminPanel plumbing, and AdminSettingsTab all share
 *  one union without an import cycle. */
export type SettingsSubtab = "accounts" | "chat" | "safety" | "theme" | "features";

/** Subtab ids for the Analytics tab split (same mounted-hidden pattern as
 *  Settings). Ids double as `recordNav` suffixes — never change. */
export type AnalyticsSubtab = "overview" | "engagement" | "traffic" | "features";

/** One findable thing. `key` is an admin-namespace catalog key; its
 *  translated text is the row title AND the data-admin-anchor value. */
export interface AdminSearchEntry {
  key: string;
  tab: AdminTab;
  /** Only present when `tab === "settings"`: which Settings subtab the
   *  anchor lives on once the subtab split lands. */
  subtab?: SettingsSubtab;
  /** Only present when `tab === "analytics"`: which Analytics subtab owns
   *  the anchor, so the jump can un-hide it before scroll + flash. */
  analyticsSubtab?: AnalyticsSubtab;
  /** Extra catalog keys folded into the match text (hints, on/off labels)
   *  so "flood" finds Anti-spam even though the label never says it. */
  also?: readonly string[];
}

/** Curated "not in this panel" rows. Never navigate; render label + hint. */
export interface AdminSearchRedirect {
  labelKey: string;
  hintKey: string;
}

/** Row-level entries (docs/ADMIN_IA.md §5.4). Settings rows carry their
 *  future subtab; Branding/Rules entries anchor on whole fieldsets. The
 *  remaining tabs' entries anchor their named sections/panels/tools —
 *  anchors inside conditional UI (a user row's Edit form, a non-default
 *  Email section) resolve only while that UI is mounted, so those jumps
 *  may stop at the tab switch, which is fine by contract. */
export const ADMIN_SEARCH_ENTRIES: readonly AdminSearchEntry[] = [
  // ----- Settings rows -----
  { key: "settings.retentionLegend", tab: "settings", subtab: "chat", also: ["settings.retentionHelp"] },
  { key: "settings.idleTimeoutLegend", tab: "settings", subtab: "chat", also: ["settings.idleTimeoutHelp"] },
  { key: "settings.idleGhostLegend", tab: "settings", subtab: "chat", also: ["settings.idleGhostHelp"] },
  { key: "settings.maxMsgLenLabel", tab: "settings", subtab: "chat", also: ["settings.maxMsgLenHint"] },
  { key: "settings.maxDmLenLabel", tab: "settings", subtab: "chat", also: ["settings.maxDmLenHint"] },
  { key: "settings.editWindowLabel", tab: "settings", subtab: "chat", also: ["settings.editWindowHint"] },
  { key: "settings.maxForumLenLabel", tab: "settings", subtab: "chat", also: ["settings.maxForumLenHint"] },
  { key: "settings.maxForumTitleLenLabel", tab: "settings", subtab: "chat", also: ["settings.maxForumTitleLenHint"] },
  { key: "settings.forumTopicsPerPageLabel", tab: "settings", subtab: "chat", also: ["settings.forumTopicsPerPageHint"] },
  { key: "settings.registrationLabel", tab: "settings", subtab: "accounts", also: ["settings.registrationHint", "settings.registrationOn", "settings.registrationOff"] },
  { key: "settings.signupAgeLabel", tab: "settings", subtab: "accounts", also: ["settings.signupAgeHint", "settings.signupAgeOn", "settings.signupAgeOff"] },
  { key: "settings.maxEmailLabel", tab: "settings", subtab: "accounts", also: ["settings.maxEmailHint"] },
  { key: "settings.blockedEmailDomainsLabel", tab: "settings", subtab: "accounts", also: ["settings.blockedEmailDomainsHint", "settings.blockedEmailDomainsPlaceholder"] },
  { key: "settings.maxCharsLabel", tab: "settings", subtab: "accounts", also: ["settings.maxCharsHint"] },
  { key: "settings.maxRoomsLabel", tab: "settings", subtab: "accounts", also: ["settings.maxRoomsHint"] },
  { key: "settings.maxBioLenLabel", tab: "settings", subtab: "accounts", also: ["settings.maxBioLenHint"] },
  { key: "settings.antiSpamLabel", tab: "settings", subtab: "safety", also: ["settings.antiSpamHint", "settings.antiSpamOn", "settings.antiSpamOff"] },
  { key: "settings.automodLabel", tab: "settings", subtab: "safety", also: ["settings.automodHint", "settings.automodOn", "settings.automodOff"] },
  { key: "settings.automodRulesLegend", tab: "settings", subtab: "safety", also: ["settings.automodRulesHelp"] },
  { key: "settings.minorFilterLegend", tab: "settings", subtab: "safety", also: ["settings.minorFilterHelp", "settings.minorFilterOn", "settings.minorFilterOff"] },
  { key: "settings.minorFilterTermsLabel", tab: "settings", subtab: "safety", also: ["settings.minorFilterTermsHint"] },
  { key: "settings.minorFilterAllowLabel", tab: "settings", subtab: "safety", also: ["settings.minorFilterAllowHint"] },
  { key: "settings.defaultThemeLegend", tab: "settings", subtab: "theme", also: ["settings.defaultThemeHelp"] },
  { key: "settings.themeStyleLegend", tab: "settings", subtab: "theme", also: ["settings.themeStyleHelp"] },
  { key: "settings.designsByThemeLegend", tab: "settings", subtab: "theme", also: ["settings.designsByThemeHelp"] },
  { key: "settings.activityFeedsLabel", tab: "settings", subtab: "features", also: ["settings.activityFeedsHint", "settings.activityFeedsOn", "settings.activityFeedsOff"] },
  { key: "settings.messages24hLabel", tab: "settings", subtab: "features", also: ["settings.messages24hHint", "settings.messages24hOn", "settings.messages24hOff"] },
  { key: "settings.featuredWorldsLabel", tab: "settings", subtab: "features", also: ["settings.featuredWorldsHint", "settings.featuredWorldsOn", "settings.featuredWorldsOff"] },
  { key: "settings.betaBadgeLabel", tab: "settings", subtab: "features", also: ["settings.betaBadgeHint", "settings.betaBadgeOn", "settings.betaBadgeOff"] },
  { key: "settings.designerLabel", tab: "settings", subtab: "features", also: ["settings.designerHint", "settings.designerOn", "settings.designerOff"] },
  { key: "settings.memberRankingsLabel", tab: "settings", subtab: "features", also: ["settings.memberRankingsHint", "settings.memberRankingsOn", "settings.memberRankingsOff"] },
  { key: "settings.multiServerLabel", tab: "settings", subtab: "features", also: ["settings.multiServerHint", "settings.multiServerOn", "settings.multiServerOff"] },
  { key: "settings.worldMapUploadsLabel", tab: "settings", subtab: "features", also: ["settings.worldMapUploadsHint", "settings.worldMapUploadsOn", "settings.worldMapUploadsOff"] },

  // ----- Branding fieldsets -----
  { key: "branding.siteNameLegend", tab: "branding" },
  { key: "branding.siteUrlLegend", tab: "branding" },
  { key: "branding.taglineLegend", tab: "branding" },
  { key: "branding.logoImageLegend", tab: "branding" },
  { key: "branding.backgroundsLegend", tab: "branding", also: ["branding.backgroundsHelp", "branding.bgLightLabel", "branding.bgDarkLabel"] },
  { key: "branding.logoColorLegend", tab: "branding" },
  { key: "branding.logoFontLegend", tab: "branding" },
  { key: "branding.bannerCoverLegend", tab: "branding" },
  { key: "branding.welcomeLegend", tab: "branding" },
  { key: "branding.seoDescLegend", tab: "branding" },
  { key: "branding.seoKeywordsLegend", tab: "branding" },
  { key: "branding.ogImageLegend", tab: "branding" },
  { key: "branding.serpLegend", tab: "branding" },
  { key: "branding.verificationLegend", tab: "branding" },
  { key: "branding.indexingLegend", tab: "branding" },
  { key: "branding.socialProfilesLegend", tab: "branding" },
  { key: "branding.customHeadLegend", tab: "branding" },

  // ----- Rules fieldsets -----
  { key: "rules.appRulesLegend", tab: "rules" },
  { key: "rules.welcomeLegend", tab: "rules" },
  { key: "rules.securityLegend", tab: "rules" },
  { key: "rules.disclaimerLegend", tab: "rules" },
  { key: "rules.serverRegLegend", tab: "rules" },
  { key: "rules.forumRegLegend", tab: "rules" },

  // ----- Overview dashboard cards -----
  { key: "overview.onlineNow", tab: "overview", also: ["overview.onlineNowHint"] },
  { key: "overview.registeredUsers", tab: "overview", also: ["overview.registeredUsersHint"] },
  { key: "overview.activeUsers", tab: "overview", also: ["overview.activeUsersHint"] },
  { key: "overview.rooms", tab: "overview", also: ["overview.roomsHint"] },
  { key: "overview.chatMessages", tab: "overview", also: ["overview.chatMessagesHint"] },
  { key: "overview.forumActivity", tab: "overview", also: ["overview.forumActivityHint"] },
  { key: "overview.content", tab: "overview", also: ["overview.contentHint"] },
  { key: "overview.moderation7d", tab: "overview", also: ["overview.moderation7dHint"] },
  { key: "overview.thisWeek", tab: "overview", also: ["overview.seriesLogins", "overview.seriesRegistrations"] },

  // ----- Analytics sections (each entry names its owning subtab so the
  // jump can un-hide the mounted-hidden section first) -----
  { key: "analytics.kpiTitle", tab: "analytics", analyticsSubtab: "overview", also: ["analytics.kpiActivesYesterday", "analytics.kpiRetentionD1", "analytics.kpiMessagesYesterday", "analytics.kpiRegistrations7d"] },
  { key: "analytics.engRegistrations", tab: "analytics", analyticsSubtab: "engagement", also: ["analytics.seriesRegistrations"] },
  { key: "analytics.engActives", tab: "analytics", analyticsSubtab: "engagement", also: ["analytics.engActivesHint"] },
  { key: "analytics.engMessages", tab: "analytics", analyticsSubtab: "engagement", also: ["analytics.engMessagesHint", "analytics.seriesChat", "analytics.seriesForum"] },
  { key: "analytics.engRetention", tab: "analytics", analyticsSubtab: "engagement", also: ["analytics.engRetentionHint"] },
  { key: "analytics.hitsOverTime", tab: "analytics", analyticsSubtab: "traffic", also: ["analytics.pageviews", "analytics.uniqueVisitors"] },
  { key: "analytics.topReferrers", tab: "analytics", analyticsSubtab: "traffic" },
  { key: "analytics.geoBreakdown", tab: "analytics", analyticsSubtab: "traffic", also: ["analytics.geoHint"] },
  { key: "analytics.geoAccuracyTitle", tab: "analytics", analyticsSubtab: "traffic", also: ["analytics.geoAccuracyHint", "analytics.accountId", "analytics.licenseKey"] },
  { key: "analytics.topPages", tab: "analytics", analyticsSubtab: "traffic" },
  { key: "analytics.featureUsageTitle", tab: "analytics", analyticsSubtab: "features", also: ["analytics.featureUsageHint", "analytics.serverFilterLabel"] },
  { key: "analytics.inAppTitle", tab: "analytics", analyticsSubtab: "features", also: ["analytics.inAppHint"] },
  { key: "analytics.entityTitle", tab: "analytics", analyticsSubtab: "features", also: ["analytics.entityHint"] },

  // ----- Users: directory columns + per-user tools (tools anchor inside
  // the row's Edit form, so the jump may stop at the tab switch) -----
  { key: "users.colIps", tab: "users", also: ["users.colIpsTitle"] },
  { key: "users.colAge", tab: "users", also: ["users.colAgeTitle"] },
  { key: "users.accountBan", tab: "users" },
  { key: "users.resetPassword", tab: "users", also: ["users.resetPasswordHelp"] },
  { key: "users.grantLegend", tab: "users", also: ["users.grantHelp"] },
  { key: "users.cosmeticsLegend", tab: "users", also: ["users.cosmeticsHelp"] },
  { key: "users.resetEarningLegend", tab: "users", also: ["users.resetEarningHelp"] },

  // ----- Roles & Permissions panels -----
  { key: "permissions.integrityTitle", tab: "permissions", also: ["permissions.integrityDescription"] },
  { key: "permissions.sensitiveTitle", tab: "permissions", also: ["permissions.sensitiveDescription"] },

  // ----- Content & community queues (curation sections carry the
  // feature/archive/suspend vocabulary the tab labels lack) -----
  { key: "scriptorium.title", tab: "scriptorium", also: ["scriptorium.forceRate", "scriptorium.hideStory", "scriptorium.deleteStory"] },
  { key: "forums.forums", tab: "forums", also: ["review.feature", "review.archive", "review.restore"] },
  { key: "servers.servers", tab: "servers", also: ["servers.suspendTitle", "servers.banTitle", "servers.enterTitle", "servers.openAdminTitle"] },

  // ----- Banner Links -----
  { key: "links.addTitle", tab: "links" },

  // ----- Top Communities sections -----
  { key: "affiliates.pendingApprovals", tab: "affiliates" },
  { key: "affiliates.liveCards", tab: "affiliates", also: ["affiliates.addCard"] },
  { key: "affiliates.legacyTitle", tab: "affiliates", also: ["affiliates.legacyDescription"] },
  { key: "affiliates.paddingLegend", tab: "affiliates" },

  // ----- Email sections (compose is the tab's landing section; the
  // newsletter/settings anchors resolve once that section is open) -----
  { key: "email.sendTitle", tab: "email", also: ["email.specificUser", "email.allUsers"] },
  { key: "email.newNewsletter", tab: "email", also: ["email.deliverAt"] },
  { key: "email.verificationLegend", tab: "email", also: ["email.requireVerification", "email.verificationNote"] },
  { key: "email.denoteUnverified", tab: "email", also: ["email.denoteUnverifiedHint"] },
  { key: "email.dailyCapLabel", tab: "email" },

  // ----- System panels + maintenance tools -----
  { key: "system.panelProcess", tab: "system", also: ["system.uptime", "system.memoryRss"] },
  { key: "system.panelHost", tab: "system" },
  { key: "system.panelConnections", tab: "system", also: ["system.database", "system.onlineUsers"] },
  { key: "system.panelFly", tab: "system" },
  { key: "system.maintenanceTools", tab: "system", also: ["system.maintenanceDescription"] },
  { key: "system.restartTitle", tab: "system", also: ["system.restartDescription"] },
  { key: "system.purgeTitle", tab: "system" },

  // ----- Backups panels -----
  { key: "backups.fullTitle", tab: "backups", also: ["backups.fullSubtitle", "backups.createDownload"] },
  { key: "backups.contentTitle", tab: "backups", also: ["backups.contentSubtitle"] },
  { key: "backups.snapshotsTitle", tab: "backups", also: ["backups.snapshotsHelp"] },
];

/** Curated NOT-IN-ADMIN redirects (docs/ADMIN_IA.md §5.5). Informational
 *  only — they render under the "Looking for one of these?" heading and do
 *  not navigate. Always shown regardless of the viewer's permission set. */
export const ADMIN_SEARCH_REDIRECTS: readonly AdminSearchRedirect[] = [
  { labelKey: "panel.search.redirect.language", hintKey: "panel.search.redirect.languageHint" },
  { labelKey: "panel.search.redirect.profile", hintKey: "panel.search.redirect.profileHint" },
  { labelKey: "panel.search.redirect.notifications", hintKey: "panel.search.redirect.notificationsHint" },
  { labelKey: "panel.search.redirect.serverAdmin", hintKey: "panel.search.redirect.serverAdminHint" },
];
