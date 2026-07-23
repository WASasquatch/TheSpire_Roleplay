import { useEffect, useRef, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { VERSION, isBetaVersion, parseBackgroundArt, type BackgroundArt } from "@thekeep/shared";
import { readError } from "../../lib/http.js";
import { useChat } from "../../state/store.js";
import { AdminSaveFooter, useAdminShell, type SettingsRow } from "./adminShell.js";

/* =============================================================
 * BRANDING TAB
 * =============================================================
 *
 * Site name, banner cover CSS, logo color, logo font. Reads/writes
 * /admin/settings (the same row that the Settings tab edits) but only
 * touches the branding-related fields. Saves push the updated branding
 * directly into the zustand store so the banner reflects changes
 * immediately without waiting for a /site refetch.
 */

interface BrandingDraft {
  siteName: string;
  /** Optional canonical site URL the banner logo links to. Empty = no
   *  wrapping (logo renders bare). When set, banner adds an unstyled
   *  `<a>` around the logo. */
  siteUrl: string;
  bannerCoverCss: string;
  logoColor: string;
  logoFont: string;
  /** Logo URL. Empty string = no logo image, banner falls back to the text title. */
  logoUrl: string;
  welcomeHtml: string;
  metaDescription: string;
  customHeadHtml: string;
  /** Default social-card image URL. Empty = the image baked into index.html. */
  ogImageUrl: string;
  /** Homepage/login/register title tagline. Empty = built-in. */
  homepageTagline: string;
  /** Keyword shelf. Empty = built-in default. */
  seoKeywords: string;
  /** google-site-verification content token. */
  googleSiteVerification: string;
  /** Bing msvalidate.01 content token. */
  bingSiteVerification: string;
  /** Master search-indexing switch. */
  searchIndexingEnabled: boolean;
  /** Newline-separated social profile URLs. */
  socialProfileUrls: string;
}

export function BrandingTab() {
  const { t } = useTranslation("admin");
  const setBranding = useChat((s) => s.setBranding);
  // Edit gate. Branding submits through PUT /admin/settings, which
  // now does per-field gating: a patch that only touches branding
  // fields (site name, logos, banner CSS, welcome HTML, theme-design
  // map, …) requires `edit_branding`. So we hold the form open for
  // anyone with EITHER edit_branding OR the broader edit_site_settings
  //, both let the patch through, and the server is the source of
  // truth on what counts as "branding-only."
  //
  // The Upload-logo affordance below is independently gated on
  // `upload_logo` because the server pins that to a separate route.
  const canEditSiteSettings = useChat(
    (s) => (s.me?.permissions.includes("edit_branding") ?? false)
      || (s.me?.permissions.includes("edit_site_settings") ?? false),
  );
  const canUploadLogo = useChat((s) => s.me?.permissions.includes("upload_logo") ?? false);
  const [data, setData] = useState<SettingsRow | null>(null);
  const [draft, setDraft] = useState<BrandingDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saving, setSaving] = useState(false);

  /** Completion handler for both background slot rows: mirror the fresh
   *  settings row locally and push the parsed art into the live branding
   *  store so the splash + glass backdrop swap without a reload. */
  function onBackgroundDone(j: { background: BackgroundArt | null; settings: SettingsRow }): void {
    setData(j.settings);
    setBranding({
      ...useChat.getState().branding,
      bgLight: parseBackgroundArt(j.settings.bgLightJson),
      bgDark: parseBackgroundArt(j.settings.bgDarkJson),
    });
  }

  async function load() {
    setError(null);
    try {
      const r = await fetch("/admin/settings", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as SettingsRow;
      setData(j);
      setDraft({
        siteName: j.siteName,
        siteUrl: j.siteUrl ?? "",
        bannerCoverCss: j.bannerCoverCss ?? "",
        logoColor: j.logoColor ?? "",
        logoFont: j.logoFont ?? "",
        logoUrl: j.logoUrl ?? "",
        welcomeHtml: j.welcomeHtml ?? "",
        metaDescription: j.metaDescription ?? "",
        customHeadHtml: j.customHeadHtml ?? "",
        ogImageUrl: j.ogImageUrl ?? "",
        homepageTagline: j.homepageTagline ?? "",
        seoKeywords: j.seoKeywords ?? "",
        googleSiteVerification: j.googleSiteVerification ?? "",
        bingSiteVerification: j.bingSiteVerification ?? "",
        searchIndexingEnabled: j.searchIndexingEnabled ?? true,
        socialProfileUrls: j.socialProfileUrls ?? "",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("loadFailed"));
    }
  }
  useEffect(() => { load(); }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        siteName: draft.siteName,
        // Empty string clears the link wrapping; trim runs before
        // the server's URL-shape validation so a stray newline can't
        // sneak past.
        siteUrl: draft.siteUrl.trim(),
        // Empty strings clear the override (sent as null).
        bannerCoverCss: draft.bannerCoverCss.trim() === "" ? null : draft.bannerCoverCss.trim(),
        logoColor: draft.logoColor.trim() === "" ? null : draft.logoColor.trim(),
        logoFont: draft.logoFont.trim() === "" ? null : draft.logoFont.trim(),
        // Logo URL is stored verbatim. Empty string is the explicit
        // "no logo, show text" clear; non-empty stays as the path /
        // URL the banner uses for <img src>.
        logoUrl: draft.logoUrl.trim(),
        // welcomeHtml is sanitized server-side; empty stays empty (no rendering).
        welcomeHtml: draft.welcomeHtml,
        // metaDescription is plain text; server collapses internal whitespace.
        metaDescription: draft.metaDescription,
        // customHeadHtml is admin-trusted raw HTML (analytics scripts) - the
        // server stores it verbatim without sanitization.
        customHeadHtml: draft.customHeadHtml,
        // SEO fields: server trims. Empty string is the explicit clear /
        // "fall back to the built-in default" for each.
        ogImageUrl: draft.ogImageUrl.trim(),
        homepageTagline: draft.homepageTagline,
        seoKeywords: draft.seoKeywords,
        googleSiteVerification: draft.googleSiteVerification.trim(),
        bingSiteVerification: draft.bingSiteVerification.trim(),
        searchIndexingEnabled: draft.searchIndexingEnabled,
        socialProfileUrls: draft.socialProfileUrls,
      };
      if (body.logoColor && !/^#[0-9a-fA-F]{6}$/.test(body.logoColor as string)) {
        throw new Error(t("branding.logoColorError"));
      }
      const r = await fetch("/admin/settings", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as SettingsRow;
      setData(j);
      // Push directly into the store so Banner/AuthGate/BootSplash see it
      // without waiting for the next /site fetch on reload.
      setBranding({
        siteName: j.siteName,
        siteUrl: j.siteUrl ?? "",
        bannerCoverCss: j.bannerCoverCss,
        logoColor: j.logoColor,
        logoFont: j.logoFont,
        logoUrl: j.logoUrl,
        registrationOpen: j.registrationOpen,
        welcomeHtml: j.welcomeHtml,
        registerDisclaimerHtml: j.registerDisclaimerHtml,
        messageRetentionMs: j.messageRetentionMs,
        sessionTtlMs: j.sessionTtlMs,
        editGraceMs: j.editGraceMs,
        defaultTheme: j.defaultTheme,
        activityFeedsEnabled: j.activityFeedsEnabled,
        featuredWorldsEnabled: j.featuredWorldsEnabled,
        splashMessages24hEnabled: j.splashMessages24hEnabled,
        // The admin response carries the RAW toggle; branding carries the
        // toggle ANDed with the version gate (mirrors the /site payload).
        betaBadgeEnabled: j.betaBadgeEnabled && isBetaVersion(VERSION),
        profileDesignerEnabled: j.profileDesignerEnabled,
        serversEnabled: j.serversEnabled,
        defaultStyleKey: j.defaultStyleKey,
        themeDesignMap: j.themeDesignMap ?? {},
        // Null = admin hasn't set an explicit override → splash falls
        // back to prefers-color-scheme + cached last-active theme.
        defaultThemeJson: j.defaultThemeJson ?? null,
      });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  // Project save controls into the modal footer. Same pattern as
  // SettingsTab, the inline save row used to sit at the bottom of
  // the scrolling form; now it's anchored in the persistent footer
  // so it's always reachable and the modal's bottom chrome isn't
  // empty space.
  const shell = useAdminShell();
  useEffect(() => {
    if (!shell) return;
    shell.setFooter(
      <AdminSaveFooter
        formId="admin-branding-form"
        saving={saving}
        savedFlash={savedFlash}
        lastUpdatedAt={data?.updatedAt ?? null}
        error={error}
        saveLabel={t("branding.saveLabel")}
        canEdit={canEditSiteSettings}
        readOnlyHint={t("readOnlyNeedsSiteSettings")}
      />,
    );
    return () => shell.setFooter(null);
  }, [shell, saving, savedFlash, error, data?.updatedAt, canEditSiteSettings, t]);

  if (!data || !draft) {
    return <div className="text-keep-muted text-xs">{error ?? t("loading")}</div>;
  }

  // ---- Live preview (pure client, no server work) ----
  // Mirror the server's fallback chain (seo.ts) so the mockups show exactly
  // what a crawler / card scraper would see for the HOMEPAGE. These fallback
  // strings deliberately stay UNTRANSLATED: they mirror what the server
  // actually emits to crawlers, which is English regardless of UI locale.
  const FALLBACK_TAGLINE = "Roleplay Chat, Communities & Forums";
  const previewName = draft.siteName.trim() || "The Spire";
  const previewTagline = draft.homepageTagline.trim() || FALLBACK_TAGLINE;
  const previewTitle = `${previewName} - ${previewTagline}`;
  const previewDescription =
    draft.metaDescription.trim() ||
    "Host your own roleplay chat community or forum, or dive into live RP chat, character profiles, worlds, and collaborative writing.";
  // Recommended lengths for the SERP snippet (Google truncates past these).
  const SERP_TITLE_MAX = 60;
  const SERP_DESC_MAX = 155;
  const titleOver = previewTitle.length > SERP_TITLE_MAX;
  const descOver = previewDescription.length > SERP_DESC_MAX;
  const clampedDesc =
    previewDescription.length > SERP_DESC_MAX
      ? previewDescription.slice(0, SERP_DESC_MAX).replace(/\s+\S*$/, "") + "…"
      : previewDescription;
  // Host + URL shown in the SERP row. Derive from the configured Site URL when
  // it's a valid absolute URL; otherwise show a neutral placeholder.
  let previewHost = "yoursite.example";
  const siteUrlTrimmed = draft.siteUrl.trim();
  if (/^https?:\/\//i.test(siteUrlTrimmed)) {
    try { previewHost = new URL(siteUrlTrimmed).host; } catch { /* keep placeholder */ }
  }
  // Card image: the default OG image when set, else the logo image, else none.
  const previewCardImage = draft.ogImageUrl.trim() || draft.logoUrl.trim();

  return (
    <form id="admin-branding-form" onSubmit={save} className="space-y-4">
      <p className="text-xs text-keep-muted">
        {t("branding.description")}
      </p>

      <fieldset data-admin-anchor="branding.siteNameLegend" className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("branding.siteNameLegend")}</legend>
        <input
          type="text"
          value={draft.siteName}
          onChange={(e) => setDraft({ ...draft, siteName: e.target.value })}
          maxLength={60}
          placeholder={t("branding.siteNamePlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
        />
        <p className="mt-1 text-keep-muted">
          <Trans t={t} i18nKey="branding.siteNameHelp">
            {"Shown in the banner, login screen, BootSplash, and tab title. Empty falls back to "}
            <code>The Spire</code>
            {"."}
          </Trans>
        </p>
      </fieldset>

      <fieldset data-admin-anchor="branding.siteUrlLegend" className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("branding.siteUrlLegend")}</legend>
        <input
          type="url"
          value={draft.siteUrl}
          onChange={(e) => setDraft({ ...draft, siteUrl: e.target.value })}
          maxLength={500}
          placeholder={t("branding.siteUrlPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          <Trans t={t} i18nKey="branding.siteUrlHelp">
            {"When set, the banner wraps the site name / logo image in an unstyled link pointing here, useful for sending visitors back to a marketing landing page or the main domain when the chat lives at a subdomain. The wrapping is invisible (no underline, no color change); the logo still reads as a logo, it just becomes clickable. Must start with "}
            <code>http://</code>
            {" or "}
            <code>https://</code>
            {"; leave empty to disable."}
          </Trans>
        </p>
      </fieldset>

      <fieldset data-admin-anchor="branding.bannerCoverLegend" className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("branding.bannerCoverLegend")}</legend>
        <textarea
          value={draft.bannerCoverCss}
          onChange={(e) => setDraft({ ...draft, bannerCoverCss: e.target.value })}
          rows={2}
          maxLength={1000}
          placeholder={t("branding.bannerCoverPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          <Trans t={t} i18nKey="branding.bannerCoverHelp">
            {"Full CSS "}
            <code>background</code>
            {" shorthand applied behind the logo text. Accepts "}
            <code>url()</code>
            {", "}
            <code>linear-gradient(...)</code>
            {", a solid color, etc. Leave empty to use the theme's panel color."}
          </Trans>
        </p>
      </fieldset>

      <fieldset data-admin-anchor="branding.logoImageLegend" className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("branding.logoImageLegend")}</legend>
        <p className="mb-2 text-keep-muted">
          <Trans t={t} i18nKey="branding.logoImageHelp">
            {"Shown in the banner and on the splash in place of the site name. Leave empty to use the text title instead. The default install ships "}
            <code>/thespire-logo.png</code>
            {"; uploading replaces it with your own image stored on the server (no external host required)."}
          </Trans>
        </p>
        <LogoImageRow
          value={draft.logoUrl}
          canUpload={canUploadLogo}
          onChange={(next) => setDraft({ ...draft, logoUrl: next })}
          onUploaded={(j) => {
            // The upload endpoint returns the full freshly-saved
            // settings row. Mirror it straight into the store so the
            // banner refreshes without waiting for the form save.
            // Spread the CURRENT branding first: setBranding replaces
            // the whole object, and fields this handler doesn't list
            // (serversEnabled, uploaded background art, …) must survive
            // a logo upload rather than reset until the next /site load.
            setData(j.settings);
            setDraft((d) => (d ? { ...d, logoUrl: j.url } : d));
            setBranding({
              ...useChat.getState().branding,
              siteName: j.settings.siteName,
              siteUrl: j.settings.siteUrl ?? "",
              bannerCoverCss: j.settings.bannerCoverCss,
              logoColor: j.settings.logoColor,
              logoFont: j.settings.logoFont,
              logoUrl: j.settings.logoUrl,
              registrationOpen: j.settings.registrationOpen,
              welcomeHtml: j.settings.welcomeHtml,
              registerDisclaimerHtml: j.settings.registerDisclaimerHtml,
              messageRetentionMs: j.settings.messageRetentionMs,
              sessionTtlMs: j.settings.sessionTtlMs,
              editGraceMs: j.settings.editGraceMs,
              defaultTheme: j.settings.defaultTheme,
              activityFeedsEnabled: j.settings.activityFeedsEnabled,
              featuredWorldsEnabled: j.settings.featuredWorldsEnabled,
              splashMessages24hEnabled: j.settings.splashMessages24hEnabled,
              betaBadgeEnabled: j.settings.betaBadgeEnabled && isBetaVersion(VERSION),
              profileDesignerEnabled: j.settings.profileDesignerEnabled,
              defaultStyleKey: j.settings.defaultStyleKey,
              themeDesignMap: j.settings.themeDesignMap ?? {},
              defaultThemeJson: j.settings.defaultThemeJson ?? null,
            });
          }}
        />
      </fieldset>

      <fieldset data-admin-anchor="branding.backgroundsLegend" className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("branding.backgroundsLegend")}</legend>
        <p className="mb-2 text-keep-muted">{t("branding.backgroundsHelp")}</p>
        <div className="space-y-3">
          <BackgroundSlotRow
            slot="light"
            art={data ? parseBackgroundArt(data.bgLightJson) : null}
            canUpload={canUploadLogo}
            onDone={onBackgroundDone}
          />
          <BackgroundSlotRow
            slot="dark"
            art={data ? parseBackgroundArt(data.bgDarkJson) : null}
            canUpload={canUploadLogo}
            onDone={onBackgroundDone}
          />
        </div>
      </fieldset>

      <fieldset data-admin-anchor="branding.logoColorLegend" className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("branding.logoColorLegend")}</legend>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={draft.logoColor || "#1a1a1a"}
            onChange={(e) => setDraft({ ...draft, logoColor: e.target.value })}
            className="h-8 w-10 cursor-pointer rounded border border-keep-rule"
            aria-label={t("branding.logoColorLegend")}
          />
          <input
            type="text"
            value={draft.logoColor}
            onChange={(e) => setDraft({ ...draft, logoColor: e.target.value })}
            placeholder={t("branding.logoColorPlaceholder")}
            maxLength={7}
            pattern="^#[0-9a-fA-F]{6}$|^$"
            className="flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
          />
          <button
            type="button"
            onClick={() => setDraft({ ...draft, logoColor: "" })}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-keep-muted hover:text-keep-text"
            title={t("branding.logoColorClearTitle")}
          >
            {t("common:clear")}
          </button>
        </div>
      </fieldset>

      <fieldset data-admin-anchor="branding.logoFontLegend" className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("branding.logoFontLegend")}</legend>
        <input
          type="text"
          value={draft.logoFont}
          onChange={(e) => setDraft({ ...draft, logoFont: e.target.value })}
          maxLength={200}
          placeholder={t("branding.logoFontPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          <Trans t={t} i18nKey="branding.logoFontHelp">
            {"A CSS "}
            <code>font-family</code>
            {" stack. Web fonts must be self-hosted or loaded via "}
            <code>@import</code>
            {" in your stylesheet - this field only changes the family name, not the loading. Empty to use the built-in serif stack."}
          </Trans>
        </p>
      </fieldset>

      <fieldset data-admin-anchor="branding.welcomeLegend" className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("branding.welcomeLegend")}</legend>
        <textarea
          value={draft.welcomeHtml}
          onChange={(e) => setDraft({ ...draft, welcomeHtml: e.target.value })}
          rows={6}
          maxLength={500_000}
          placeholder={t("branding.welcomePlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          {t("branding.welcomeHelp")}
        </p>
      </fieldset>

      <fieldset data-admin-anchor="branding.seoDescLegend" className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("branding.seoDescLegend")}</legend>
        <textarea
          value={draft.metaDescription}
          onChange={(e) => setDraft({ ...draft, metaDescription: e.target.value })}
          rows={3}
          maxLength={500}
          placeholder={t("branding.seoDescPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
        />
        <p className="mt-1 text-keep-muted">
          <Trans t={t} i18nKey="branding.seoDescHelp" shouldUnescape>
            {"Plain-text description used in "}
            <code>{'<meta name="description">'}</code>
            {"and the OG / Twitter card. Search engines typically display the first ~155 characters. Empty falls back to the welcome message stripped to text."}
          </Trans>
          <span className="ml-1 tabular-nums">
            ({draft.metaDescription.length}/500)
          </span>
        </p>
      </fieldset>

      <fieldset data-admin-anchor="branding.ogImageLegend" className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("branding.ogImageLegend")}</legend>
        <input
          type="url"
          value={draft.ogImageUrl}
          onChange={(e) => setDraft({ ...draft, ogImageUrl: e.target.value })}
          maxLength={2000}
          placeholder={t("branding.ogImagePlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          {t("branding.ogImageHelp")}
        </p>
        {canUploadLogo ? (
          <OgCardUploadRow
            onUploaded={(j) => {
              // The endpoint renders the 1200x630 card, saves it under
              // /uploads/og/, and persists ogImageUrl — mirror both the
              // fresh row and the URL field so the preview updates live.
              setData(j.settings);
              setDraft((d) => (d ? { ...d, ogImageUrl: j.url } : d));
            }}
          />
        ) : null}
        {draft.ogImageUrl.trim() ? (
          <div className="mt-2">
            <img
              src={draft.ogImageUrl.trim()}
              alt={t("branding.ogImageAlt")}
              className="max-h-40 w-full rounded border border-keep-rule object-cover"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
          </div>
        ) : null}
      </fieldset>

      <fieldset data-admin-anchor="branding.taglineLegend" className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("branding.taglineLegend")}</legend>
        <input
          type="text"
          value={draft.homepageTagline}
          onChange={(e) => setDraft({ ...draft, homepageTagline: e.target.value })}
          maxLength={200}
          placeholder={t("branding.taglinePlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
        />
        <p className="mt-1 text-keep-muted">
          <Trans
            t={t}
            i18nKey="branding.taglineHelp"
            values={{ title: `${previewName} - ${previewTagline}`, fallback: FALLBACK_TAGLINE }}
          >
            {"Added after the site name in the browser tab and search results on the homepage, login, and register pages, so the title reads "}
            <code>{"{{title}}"}</code>
            {". Keeps the title keyword-rich without baking search terms into the brand name itself. Empty falls back to "}
            <code>{"{{fallback}}"}</code>
            {"."}
          </Trans>
        </p>
      </fieldset>

      <fieldset data-admin-anchor="branding.seoKeywordsLegend" className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("branding.seoKeywordsLegend")}</legend>
        <textarea
          value={draft.seoKeywords}
          onChange={(e) => setDraft({ ...draft, seoKeywords: e.target.value })}
          rows={3}
          maxLength={1000}
          placeholder={t("branding.seoKeywordsPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
        />
        <p className="mt-1 text-keep-muted">
          <Trans t={t} i18nKey="branding.seoKeywordsHelp" shouldUnescape>
            {"Comma-separated keyword list for "}
            <code>{'<meta name="keywords">'}</code>
            {". Google ignores this, but Bing, DuckDuckGo, and some card scrapers still read it. Empty falls back to the built-in default list."}
          </Trans>
        </p>
      </fieldset>

      <fieldset data-admin-anchor="branding.verificationLegend" className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("branding.verificationLegend")}</legend>
        <label className="mb-2 block">
          <span className="mb-1 block text-keep-muted">{t("branding.googleLabel")}</span>
          <input
            type="text"
            value={draft.googleSiteVerification}
            onChange={(e) => setDraft({ ...draft, googleSiteVerification: e.target.value })}
            maxLength={200}
            placeholder={t("branding.tokenPlaceholder")}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-keep-muted">{t("branding.bingLabel")}</span>
          <input
            type="text"
            value={draft.bingSiteVerification}
            onChange={(e) => setDraft({ ...draft, bingSiteVerification: e.target.value })}
            maxLength={200}
            placeholder={t("branding.tokenPlaceholder")}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
          />
        </label>
        <p className="mt-1 text-keep-muted">
          <Trans t={t} i18nKey="branding.verificationHelp" shouldUnescape>
            {"Paste only the "}
            <code>content</code>
            {" token from the verification tag, not the whole "}
            <code>{"<meta>"}</code>
            {". Each gets added to the page "}
            <code>{"<head>"}</code>
            {" when set. Leave empty once you've switched to the DNS or file verification method."}
          </Trans>
        </p>
      </fieldset>

      <fieldset data-admin-anchor="branding.socialProfilesLegend" className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("branding.socialProfilesLegend")}</legend>
        <textarea
          value={draft.socialProfileUrls}
          onChange={(e) => setDraft({ ...draft, socialProfileUrls: e.target.value })}
          rows={3}
          maxLength={2000}
          placeholder={t("branding.socialProfilesPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          {t("branding.socialProfilesHelp")}
        </p>
      </fieldset>

      <fieldset data-admin-anchor="branding.indexingLegend" className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("branding.indexingLegend")}</legend>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={draft.searchIndexingEnabled}
            onChange={(e) => setDraft({ ...draft, searchIndexingEnabled: e.target.checked })}
            className="mt-0.5"
          />
          <span>{t("branding.indexingAllow")}</span>
        </label>
        {draft.searchIndexingEnabled ? (
          <p className="mt-1 text-keep-muted">
            {t("branding.indexingOnHelp")}
          </p>
        ) : (
          <p className="mt-1 text-keep-accent">
            <Trans t={t} i18nKey="branding.indexingOffHelp">
              <b>Off:</b>
              {" the site tells all search engines not to index it, and over time it will be removed from Google and other search results. Only use this before launch."}
            </Trans>
          </p>
        )}
      </fieldset>

      {/* SERP + social-card live preview (pure client, homepage values) */}
      <fieldset data-admin-anchor="branding.serpLegend" className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("branding.serpLegend")}</legend>
        <p className="mb-2 text-keep-muted">
          {t("branding.serpHelp")}
        </p>

        {/* Google SERP snippet */}
        <div className="rounded border border-keep-rule bg-white p-3">
          <div className="truncate text-[13px] text-[#202124]">{previewHost}/</div>
          <div className="truncate text-[16px] leading-tight text-[#1a0dab]">{previewTitle}</div>
          <div className="mt-0.5 text-[12px] leading-snug text-[#4d5156]">{clampedDesc}</div>
        </div>
        <div className="mt-1 flex flex-wrap gap-3 text-[10px] text-keep-muted">
          <span className={titleOver ? "text-keep-accent" : ""}>
            {t("branding.titleCount", { length: previewTitle.length, max: SERP_TITLE_MAX })}
            {titleOver ? t("branding.mayBeCutOff") : ""}
          </span>
          <span className={descOver ? "text-keep-accent" : ""}>
            {t("branding.descCount", { length: previewDescription.length, max: SERP_DESC_MAX })}
            {descOver ? t("branding.mayBeCutOff") : ""}
          </span>
        </div>

        {/* Discord / X large card */}
        <div className="mt-3 max-w-md overflow-hidden rounded border border-keep-rule bg-keep-panel">
          {previewCardImage ? (
            <img
              src={previewCardImage}
              alt=""
              className="aspect-[1200/630] w-full bg-keep-bg object-cover"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
          ) : (
            <div className="flex aspect-[1200/630] w-full items-center justify-center bg-keep-bg text-keep-muted">
              {t("branding.noCardImage")}
            </div>
          )}
          <div className="p-3">
            <div className="text-[10px] uppercase tracking-widest text-keep-muted">{previewHost}</div>
            <div className="mt-0.5 font-semibold text-keep-text">{previewTitle}</div>
            <div className="mt-0.5 line-clamp-2 text-keep-muted">{previewDescription}</div>
          </div>
        </div>
      </fieldset>

      <fieldset data-admin-anchor="branding.customHeadLegend" className="rounded border border-keep-accent/40 bg-keep-accent/5 p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-accent">
          {t("branding.customHeadLegend")}
        </legend>
        <textarea
          value={draft.customHeadHtml}
          onChange={(e) => setDraft({ ...draft, customHeadHtml: e.target.value })}
          rows={6}
          maxLength={20_000}
          spellCheck={false}
          placeholder={t("branding.customHeadPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-accent/80">
          <Trans t={t} i18nKey="branding.customHeadHelp" shouldUnescape>
            <b>Raw HTML, not sanitized.</b>
            {" Pasted verbatim into "}
            <code>{"<head>"}</code>
            {"on every splash response so analytics fire before React mounts. Anything you put here ships to every visitor on first paint - double-check the snippet from your provider's dashboard before saving."}
          </Trans>
        </p>
      </fieldset>

      {/* Live preview */}
      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("common:preview")}</legend>
        <div
          className="flex items-center justify-between rounded border border-keep-rule px-4 py-2"
          style={{
            background: draft.bannerCoverCss.trim() || "rgb(var(--keep-panel) / 1)",
          }}
        >
          <span
            className="font-action text-xl tracking-wide"
            style={{
              ...(draft.logoColor ? { color: draft.logoColor } : {}),
              ...(draft.logoFont ? { fontFamily: draft.logoFont } : {}),
            }}
          >
            {draft.siteName || "The Spire"}
          </span>
          <span className="text-[10px] uppercase tracking-widest text-keep-muted">
            {t("branding.previewCaption")}
          </span>
        </div>
      </fieldset>

      {/* Save controls + status (incl. error) live in the modal
          footer via `useAdminShell().setFooter(...)` near the top of
          this component. */}
    </form>
  );
}

/**
 * Logo image picker, URL input + Upload button + live preview.
 *
 * Two paths admins can take:
 *   1. Type/paste a URL (built-in `/thespire-logo.png`, an
 *      `/uploads/...` path that was uploaded earlier, or a remote
 *      https URL). Save commits via the standard /admin/settings PUT
 *      flow alongside the rest of the branding form.
 *   2. Click Upload, pick a local file. We read it via FileReader as
 *      a base64 data URL, POST to /admin/upload/logo, and the server
 *      writes it under /uploads + immediately persists the URL onto
 *      site_settings.logo_url. That bypass the parent form save,
 *      the upload is its own atomic operation since admins typically
 *      want the new logo live as soon as they pick it. The parent
 *      callback then syncs the local draft + branding store.
 */
/** Read a picked file as a data URL, with basic type/size validation.
 *  Shared by the background + OG-card upload rows; returns null (and
 *  reports via setError) when the pick is unusable. */
async function readPickedImage(
  f: File,
  maxBytes: number,
  setError: (msg: string | null) => void,
  typeError: string,
  sizeError: string,
  readFailed: string,
): Promise<string | null> {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) {
    setError(typeError);
    return null;
  }
  if (f.size > maxBytes) {
    setError(sizeError);
    return null;
  }
  setError(null);
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(new Error(readFailed));
    r.readAsDataURL(f);
  });
}

/** One background art slot (light or dark): thumbnail of the current
 *  upload (or a "built-in art" note), an Upload picker, and a Remove
 *  action. The server renders the WebP/AVIF/color variants; this row
 *  only ships the source bytes up and mirrors the result back. */
function BackgroundSlotRow({
  slot,
  art,
  canUpload,
  onDone,
}: {
  slot: "light" | "dark";
  art: BackgroundArt | null;
  canUpload: boolean;
  onDone: (j: { background: BackgroundArt | null; settings: SettingsRow }) => void;
}) {
  const { t } = useTranslation("admin");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(body: unknown): Promise<void> {
    setBusy(true);
    try {
      const res = await fetch("/admin/upload/background", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readError(res));
      onDone((await res.json()) as { ok: true; background: BackgroundArt | null; settings: SettingsRow });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("uploadFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    let dataUrl: string | null;
    try {
      dataUrl = await readPickedImage(
        f, 10 * 1024 * 1024, setError,
        t("branding.bgTypeError"), t("branding.bgSizeError"), t("branding.fileReadFailed"),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t("uploadFailed"));
      return;
    }
    if (dataUrl) await send({ slot, dataUrl });
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-28 shrink-0 uppercase tracking-widest text-keep-muted">
          {slot === "light" ? t("branding.bgLightLabel") : t("branding.bgDarkLabel")}
        </span>
        {art ? (
          <img
            src={art.webpUrl}
            alt={slot === "light" ? t("branding.bgLightLabel") : t("branding.bgDarkLabel")}
            className="h-12 w-24 rounded border border-keep-rule object-cover"
          />
        ) : (
          <span className="text-keep-muted">{t("branding.bgBuiltIn")}</span>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={onPick}
          className="hidden"
        />
        {canUpload ? (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="rounded border border-keep-rule bg-keep-banner px-3 py-1 hover:bg-keep-banner/80 disabled:opacity-50"
          >
            {busy ? t("branding.uploading") : t("branding.upload")}
          </button>
        ) : null}
        {canUpload && art ? (
          <button
            type="button"
            onClick={() => void send({ slot, clear: true })}
            disabled={busy}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-keep-muted hover:text-keep-text disabled:opacity-50"
            title={t("branding.bgRemoveTitle")}
          >
            {t("common:clear")}
          </button>
        ) : null}
      </div>
      {error ? <div className="text-[11px] text-keep-accent">{error}</div> : null}
    </div>
  );
}

/** Upload picker for the social share card: the server cover-crops the
 *  source to the standard 1200x630 JPEG and persists its URL. */
function OgCardUploadRow({
  onUploaded,
}: {
  onUploaded: (j: { url: string; settings: SettingsRow }) => void;
}) {
  const { t } = useTranslation("admin");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setBusy(true);
    try {
      const dataUrl = await readPickedImage(
        f, 10 * 1024 * 1024, setError,
        t("branding.bgTypeError"), t("branding.bgSizeError"), t("branding.fileReadFailed"),
      );
      if (!dataUrl) return;
      const res = await fetch("/admin/upload/og-card", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl }),
      });
      if (!res.ok) throw new Error(await readError(res));
      onUploaded((await res.json()) as { ok: true; url: string; settings: SettingsRow });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("uploadFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={onPick}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="rounded border border-keep-rule bg-keep-banner px-3 py-1 hover:bg-keep-banner/80 disabled:opacity-50"
        >
          {busy ? t("branding.uploading") : t("branding.ogUpload")}
        </button>
        <span className="text-keep-muted">{t("branding.ogUploadHelp")}</span>
      </div>
      {error ? <div className="text-[11px] text-keep-accent">{error}</div> : null}
    </div>
  );
}

function LogoImageRow({
  value,
  onChange,
  onUploaded,
  canUpload,
}: {
  value: string;
  onChange: (next: string) => void;
  onUploaded: (j: { url: string; settings: SettingsRow }) => void;
  /** Whether the viewer holds `upload_logo`. When false the Upload
   *  button hides, the URL input stays editable since pasting a
   *  URL only requires `edit_site_settings`, which the parent gates
   *  independently. */
  canUpload: boolean;
}) {
  const { t } = useTranslation("admin");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!f) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) {
      setError(t("branding.logoTypeError"));
      return;
    }
    if (f.size > 8 * 1024 * 1024) {
      setError(t("branding.logoSizeError"));
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result ?? ""));
        r.onerror = () => reject(new Error(t("branding.fileReadFailed")));
        r.readAsDataURL(f);
      });
      const res = await fetch("/admin/upload/logo", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const j = (await res.json()) as { ok: true; url: string; settings: SettingsRow };
      onUploaded(j);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("uploadFailed"));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t("branding.logoUrlPlaceholder")}
          className="min-w-[14rem] flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={onPick}
          className="hidden"
        />
        {canUpload ? (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="rounded border border-keep-rule bg-keep-banner px-3 py-1 hover:bg-keep-banner/80 disabled:opacity-50"
          >
            {uploading ? t("branding.uploading") : t("branding.upload")}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onChange("")}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-keep-muted hover:text-keep-text"
          title={t("branding.logoClearTitle")}
        >
          {t("common:clear")}
        </button>
      </div>
      {error ? (
        <div className="text-[11px] text-keep-accent">{error}</div>
      ) : null}
      {value ? (
        <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg p-2">
          <span className="text-[10px] uppercase tracking-widest text-keep-muted">{t("branding.previewLabel")}</span>
          <img
            src={value}
            alt={t("branding.logoPreviewAlt")}
            className="max-h-10 w-auto"
            // Surface a broken URL without breaking the form layout.
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "0.3"; }}
          />
        </div>
      ) : null}
    </div>
  );
}
