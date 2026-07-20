/**
 * Shared AdminPanel shell primitives, extracted verbatim from
 * AdminPanel.tsx so the individual admin tab modules can consume them
 * without a circular import back through the panel shell. Behaviour is
 * unchanged; this is a pure relocation.
 */
import { createContext, useContext, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Theme } from "@thekeep/shared";
import { formatDateTime } from "../../lib/intlFormat.js";

/**
 * Per-tab access to the AdminPanel modal shell. Tabs use `setFooter`
 * to project save/cancel/status controls into the persistent modal
 * footer, instead of rendering them inline at the bottom of the
 * scrolling form (which previously made for an awkward gap at the
 * bottom of the modal). `close` is the same callback the X button
 * uses, exposed here so a tab's Cancel button can wire up to it
 * without prop-drilling.
 *
 * `setFooter(null)` (or letting the tab unmount on tab-switch) drops
 * back to the default footer, a lone Close button on the right.
 */
export interface AdminShellAPI {
  setFooter: (node: ReactNode | null) => void;
  close: () => void;
}
export const AdminShellContext = createContext<AdminShellAPI | null>(null);

/**
 * Hook for tabs to register footer content. Returns null when called
 * outside the AdminPanel shell (tabs can render in isolation in
 * tests / Storybook without crashing), callers should defensive-
 * check before using `setFooter` / `close`.
 */
export function useAdminShell(): AdminShellAPI | null {
  return useContext(AdminShellContext);
}

/**
 * Standard footer cluster for the three save-form tabs (Settings,
 * Branding, Rules). They all share the same shape, status text on
 * the left, Cancel + Save on the right, so the helper keeps the
 * three tabs' useEffects from drifting apart visually.
 *
 * The Save button submits the tab's `<form id={formId}>` via the
 * HTML5 `form` attribute. The form lives inside the body's scroll
 * area; the button lives outside it, in the modal footer. Browser
 * still routes the submit to the right form. No React plumbing
 * (lift state up, render-prop, etc.) needed.
 */
export function AdminSaveFooter({
  formId,
  saving,
  savedFlash,
  dirty = false,
  lastUpdatedAt,
  error,
  saveLabel,
  canEdit = true,
  readOnlyHint,
}: {
  formId: string;
  saving: boolean;
  savedFlash: boolean;
  /** True when the form has edits that haven't been saved yet. Shows an
   *  "Unsaved changes" status and emphasises the Save button, so a toggled
   *  switch can't be mistaken for a committed setting (a ticked-but-unsaved
   *  Sign-up age box cost the owner a debugging session). Optional so tabs
   *  that haven't threaded a dirty flag through yet are unchanged. */
  dirty?: boolean;
  lastUpdatedAt: number | null;
  error: string | null;
  /** e.g. "Save settings". The button shows "Saving..." while saving. */
  saveLabel: string;
  /** Whether the viewer holds the permission to save this form.
   *  Defaults true for backwards compatibility with tabs that haven't
   *  threaded the gate through yet. When false the Save button is
   *  hidden and the left-side status text surfaces `readOnlyHint`
   *  instead so the tab reads as read-only at a glance. */
  canEdit?: boolean;
  /** Short hint shown in the footer when `canEdit` is false. */
  readOnlyHint?: string;
}): JSX.Element {
  const { t } = useTranslation("admin");
  const shell = useAdminShell();
  return (
    <>
      <span
        className={`min-w-0 truncate text-xs ${
          !canEdit
            ? "italic text-keep-muted"
            : error
              ? "text-keep-accent"
              : savedFlash
                ? "text-keep-system"
                : dirty
                  ? "text-keep-action"
                  : "text-keep-muted"
        }`}
      >
        {!canEdit
          ? (readOnlyHint ?? t("shell.readOnly"))
          : error
            ? error
            : savedFlash
              ? t("shell.saved")
              : dirty
                ? t("shell.unsaved")
                : lastUpdatedAt
                  ? t("shell.lastUpdated", { time: formatDateTime(lastUpdatedAt) })
                  : ""}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => shell?.close()}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 text-xs hover:bg-keep-banner/60"
        >
          {canEdit ? t("common:cancel") : t("common:close")}
        </button>
        {canEdit ? (
          <button
            form={formId}
            type="submit"
            disabled={saving}
            className={`keep-button rounded border px-4 py-1 text-xs disabled:opacity-50 hover:bg-keep-banner/80 ${
              dirty ? "border-keep-action bg-keep-banner" : "border-keep-rule bg-keep-banner"
            }`}
          >
            {saving ? t("common:savingDots") : saveLabel}
          </button>
        ) : null}
      </div>
    </>
  );
}

/**
 * The site_settings row shape as returned by /admin/settings. Shared by
 * the Settings, Branding, and Rules tabs (all three read/write the same
 * row through different field subsets).
 */
export interface SettingsRow {
  messageRetentionMs: number;
  sessionTtlMs: number;
  idleGraceMs: number;
  defaultThemeJson: string | null;
  defaultTheme: Theme;
  siteName: string;
  /** Canonical site URL the banner logo links to. Empty = no wrapping. */
  siteUrl: string;
  bannerCoverCss: string | null;
  logoColor: string | null;
  logoFont: string | null;
  /** Banner/splash logo URL. Empty string = no logo. */
  logoUrl: string;
  maxCharactersPerUser: number;
  maxAccountsPerEmail: number;
  /** Extra disposable/temporary email domains blocked at signup (migration
   *  0367), newline/comma separated; on top of the vendored list. */
  blockedEmailDomains: string;
  maxRoomsPerOwner: number;
  maxMessageLength: number;
  maxDirectMessageLength: number;
  maxForumPostLength: number;
  maxForumTopicTitleLength: number;
  forumTopicsPerPage: number;
  /** Author edit/delete grace window in ms for chat + DM messages. */
  editGraceMs: number;
  maxBioLength: number;
  registrationOpen: boolean;
  welcomeHtml: string;
  rulesHtml: string;
  securityNoticeHtml: string;
  registerDisclaimerHtml: string;
  serverRegistrationRulesHtml: string;
  forumRegistrationRulesHtml: string;
  metaDescription: string;
  customHeadHtml: string;
  /** Default social-card image URL (og:image / twitter:image fallback). "" = index.html default. */
  ogImageUrl: string;
  /** Tagline appended after the site name in the homepage/login/register title. "" = built-in. */
  homepageTagline: string;
  /** Keyword shelf for <meta name="keywords">. "" = built-in default. */
  seoKeywords: string;
  /** google-site-verification content token. "" = no meta. */
  googleSiteVerification: string;
  /** Bing msvalidate.01 content token. "" = no meta. */
  bingSiteVerification: string;
  /** Master search-indexing switch. false = robots Disallow / + noindex meta. */
  searchIndexingEnabled: boolean;
  /** Newline-separated social profile URLs for Organization.sameAs. */
  socialProfileUrls: string;
  activityFeedsEnabled: boolean;
  featuredWorldsEnabled: boolean;
  splashMessages24hEnabled: boolean;
  /** Splash "Beta" chip + hero line toggle. The /site payload also version-gates it (< 1.0.0). */
  betaBadgeEnabled: boolean;
  profileDesignerEnabled: boolean;
  serversEnabled: boolean;
  /** World map image uploads (default off — disk is shared with the DB). */
  worldMapUploadsEnabled: boolean;
  antiSpamEnabled: boolean;
  /** Content auto-moderation master switch. */
  automodEnabled: boolean;
  /** Registration minimum-age switch (age plan): true = 13+ signups, false = 18+. */
  allowMinorSignups: boolean;
  /** Minor language filter master switch: mask strong language for under-18 viewers. Default on. */
  minorFilterEnabled: boolean;
  /** Admin-added words the minor filter also masks. */
  minorFilterTerms: string[];
  /** Words the minor filter must never mask. */
  minorFilterAllow: string[];
  /** Sanitized HTML for the post-login welcome modal. "" = no welcome shown. */
  newUserWelcomeHtml: string;
  /** Site-wide default theme style key. Users without an override inherit this. */
  defaultStyleKey: string;
  /**
   * Per-preset design map (`{ "Parchment": "medieval", "Twilight":
   * "scifi", ... }`). Pins a default design to each named palette so
   * users picking a preset get a coherent paired look without having
   * to pick the design themselves. Resolution chain documented in
   * App.tsx's apply effect.
   */
  themeDesignMap: Record<string, string>;
  updatedAt: number;
}
