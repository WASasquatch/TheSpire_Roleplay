/**
 * Shared AdminPanel shell primitives, extracted verbatim from
 * AdminPanel.tsx so the individual admin tab modules can consume them
 * without a circular import back through the panel shell. Behaviour is
 * unchanged; this is a pure relocation.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { Theme } from "@thekeep/shared";

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
  lastUpdatedAt,
  error,
  saveLabel,
  canEdit = true,
  readOnlyHint,
}: {
  formId: string;
  saving: boolean;
  savedFlash: boolean;
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
                : "text-keep-muted"
        }`}
      >
        {!canEdit
          ? (readOnlyHint ?? "Read-only, you don't have permission to save changes here.")
          : error
            ? error
            : savedFlash
              ? "Saved."
              : lastUpdatedAt
                ? `Last updated ${new Date(lastUpdatedAt).toLocaleString()}`
                : ""}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => shell?.close()}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 text-xs hover:bg-keep-banner/60"
        >
          {canEdit ? "Cancel" : "Close"}
        </button>
        {canEdit ? (
          <button
            form={formId}
            type="submit"
            disabled={saving}
            className="keep-button rounded border border-keep-rule bg-keep-banner px-4 py-1 text-xs disabled:opacity-50 hover:bg-keep-banner/80"
          >
            {saving ? "Saving..." : saveLabel}
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
  profileDesignerEnabled: boolean;
  serversEnabled: boolean;
  antiSpamEnabled: boolean;
  /** Content auto-moderation master switch. */
  automodEnabled: boolean;
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
