import { useEffect, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import DOMPurify from "dompurify";
import { sanitizeUserHtml, USER_HTML_SCOPE_CLASS } from "../../lib/userHtml.js";
import { readError } from "../../lib/http.js";
import { useChat } from "../../state/store.js";
import { AdminSaveFooter, useAdminShell, type SettingsRow } from "./adminShell.js";

/* =============================================================
 * RULES TAB
 * =============================================================
 *
 * Edits the two HTML bodies rendered by the Rules modal:
 *   - rulesHtml          - admin-authored house rules
 *   - securityNoticeHtml - privacy/safety notice (defaults to the canonical
 *                          "private rooms aren't readable by admins" text)
 *
 * Both go through the same sanitizeBio() allow-list as profile bios on save.
 */
export function RulesTab() {
  const { t } = useTranslation("admin");
  const setBranding = useChat((s) => s.setBranding);
  // Rules saves through PUT /admin/settings (the same endpoint that
  // backs Settings + Branding), so the gate is `edit_site_settings`.
  const canEditSiteSettings = useChat((s) => s.me?.permissions.includes("edit_site_settings") ?? false);
  const [data, setData] = useState<SettingsRow | null>(null);
  const [rulesHtml, setRulesHtml] = useState("");
  const [securityHtml, setSecurityHtml] = useState("");
  const [disclaimerHtml, setDisclaimerHtml] = useState("");
  const [serverRegRulesHtml, setServerRegRulesHtml] = useState("");
  const [forumRegRulesHtml, setForumRegRulesHtml] = useState("");
  const [welcomeHtml, setWelcomeHtml] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load() {
    setError(null);
    try {
      const r = await fetch("/admin/settings", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as SettingsRow;
      setData(j);
      setRulesHtml(j.rulesHtml ?? "");
      setSecurityHtml(j.securityNoticeHtml ?? "");
      setDisclaimerHtml(j.registerDisclaimerHtml ?? "");
      setServerRegRulesHtml(j.serverRegistrationRulesHtml ?? "");
      setForumRegRulesHtml(j.forumRegistrationRulesHtml ?? "");
      setWelcomeHtml(j.newUserWelcomeHtml ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("loadFailed"));
    }
  }
  useEffect(() => { load(); }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!data) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/admin/settings", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rulesHtml,
          securityNoticeHtml: securityHtml,
          registerDisclaimerHtml: disclaimerHtml,
          serverRegistrationRulesHtml: serverRegRulesHtml,
          forumRegistrationRulesHtml: forumRegRulesHtml,
          newUserWelcomeHtml: welcomeHtml,
        }),
      });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as SettingsRow;
      setData(j);
      // Re-sync from server: sanitize may have stripped tags or transformed
      // attributes, so the textarea should reflect what's actually stored.
      setRulesHtml(j.rulesHtml ?? "");
      setSecurityHtml(j.securityNoticeHtml ?? "");
      setDisclaimerHtml(j.registerDisclaimerHtml ?? "");
      setServerRegRulesHtml(j.serverRegistrationRulesHtml ?? "");
      setForumRegRulesHtml(j.forumRegistrationRulesHtml ?? "");
      setWelcomeHtml(j.newUserWelcomeHtml ?? "");
      // The disclaimer is part of public branding (consumed by AuthGate); push
      // the new copy into the store so other open tabs / the splash see it
      // without waiting for the next /site fetch.
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
  // SettingsTab / BrandingTab, see those for the full rationale.
  const shell = useAdminShell();
  useEffect(() => {
    if (!shell) return;
    shell.setFooter(
      <AdminSaveFooter
        formId="admin-rules-form"
        saving={saving}
        savedFlash={savedFlash}
        lastUpdatedAt={data?.updatedAt ?? null}
        error={error}
        saveLabel={t("rules.saveLabel")}
        canEdit={canEditSiteSettings}
        readOnlyHint={t("readOnlyNeedsSiteSettings")}
      />,
    );
    return () => shell.setFooter(null);
  }, [shell, saving, savedFlash, error, data?.updatedAt, canEditSiteSettings, t]);

  if (!data) {
    return <div className="text-keep-muted text-xs">{error ?? t("loading")}</div>;
  }

  return (
    <form id="admin-rules-form" onSubmit={save} className="space-y-4">
      <p className="text-xs text-keep-muted">
        {t("rules.description")}
      </p>

      <fieldset data-admin-anchor="rules.appRulesLegend" className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("rules.appRulesLegend")}</legend>
        <textarea
          value={rulesHtml}
          onChange={(e) => setRulesHtml(e.target.value)}
          rows={14}
          maxLength={1_000_000}
          placeholder={t("rules.appRulesPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          {t("rules.appRulesHelp")}
        </p>
      </fieldset>

      <fieldset data-admin-anchor="rules.securityLegend" className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("rules.securityLegend")}</legend>
        <textarea
          value={securityHtml}
          onChange={(e) => setSecurityHtml(e.target.value)}
          rows={8}
          maxLength={500_000}
          placeholder={t("rules.securityPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          {t("rules.securityHelp")}
        </p>
      </fieldset>

      <fieldset data-admin-anchor="rules.disclaimerLegend" className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("rules.disclaimerLegend")}</legend>
        <textarea
          value={disclaimerHtml}
          onChange={(e) => setDisclaimerHtml(e.target.value)}
          rows={10}
          maxLength={500_000}
          placeholder={t("rules.disclaimerPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          <Trans t={t} i18nKey="rules.disclaimerHelp">
            {'Rendered above the registration form on the splash. Users must tick an "I agree" checkbox before '}
            <code>/auth/register</code>
            {" succeeds. Empty disclaimer = no checkbox shown (registration unblocked). 500KB cap fits a full Terms-of-Service document."}
          </Trans>
        </p>
      </fieldset>

      <fieldset data-admin-anchor="rules.serverRegLegend" className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("rules.serverRegLegend")}</legend>
        <textarea
          value={serverRegRulesHtml}
          onChange={(e) => setServerRegRulesHtml(e.target.value)}
          rows={10}
          maxLength={500_000}
          placeholder={t("rules.serverRegPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          {t("rules.serverRegHelp")}
        </p>
      </fieldset>

      <fieldset data-admin-anchor="rules.forumRegLegend" className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("rules.forumRegLegend")}</legend>
        <textarea
          value={forumRegRulesHtml}
          onChange={(e) => setForumRegRulesHtml(e.target.value)}
          rows={10}
          maxLength={500_000}
          placeholder={t("rules.forumRegPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          {t("rules.forumRegHelp")}
        </p>
      </fieldset>

      <fieldset data-admin-anchor="rules.welcomeLegend" className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("rules.welcomeLegend")}</legend>
        <textarea
          value={welcomeHtml}
          onChange={(e) => setWelcomeHtml(e.target.value)}
          rows={10}
          maxLength={500_000}
          placeholder={t("rules.welcomePlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          <Trans t={t} i18nKey="rules.welcomeHelp">
            {"Onboarding modal shown once to users who register "}
            <b>after</b>
            {" the most recent save here. Existing users (registered before the welcome was set or last edited) never see it - this is for fresh accounts only, not a broadcast channel. Re-saving with the same text doesn't re-shift the audience cutoff; only changing the text does. Empty text = no welcome shown."}
          </Trans>
        </p>
      </fieldset>

      {/* Live preview */}
      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("common:preview")}</legend>
        <div className="space-y-3 rounded border border-keep-rule bg-keep-bg p-3">
          {securityHtml.trim() ? (
            <div
              className={`prose prose-sm max-w-none rounded border border-keep-action/40 bg-keep-action/5 p-2 ${USER_HTML_SCOPE_CLASS}`}
              dangerouslySetInnerHTML={{ __html: sanitizeUserHtml(securityHtml) }}
            />
          ) : null}
          {rulesHtml.trim() ? (
            <div
              className={`prose prose-sm max-w-none ${USER_HTML_SCOPE_CLASS}`}
              dangerouslySetInnerHTML={{ __html: sanitizeUserHtml(rulesHtml) }}
            />
          ) : (
            <p className="italic text-keep-muted">{t("rules.noRulesSet")}</p>
          )}
          {disclaimerHtml.trim() ? (
            <div className="rounded border border-keep-border/60 bg-keep-bg/50 p-2">
              <div className="mb-1 text-[10px] uppercase tracking-[0.25em] text-keep-muted">
                {t("rules.previewDisclaimerCaption")}
              </div>
              <div
                className="prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(disclaimerHtml) }}
              />
              <label className="mt-1 flex items-start gap-2 text-[11px] text-keep-muted">
                <input type="checkbox" disabled checked className="mt-0.5" />
                <span>{t("rules.previewAgree")}</span>
              </label>
            </div>
          ) : null}
          {welcomeHtml.trim() ? (
            <div className="rounded border border-keep-action/40 bg-keep-action/5 p-2">
              <div className="mb-1 text-[10px] uppercase tracking-[0.25em] text-keep-muted">
                {t("rules.previewWelcomeCaption")}
              </div>
              <div
                className="prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(welcomeHtml) }}
              />
            </div>
          ) : null}
        </div>
        <p className="mt-1 text-[10px] text-keep-muted">
          {t("rules.previewNote")}
        </p>
      </fieldset>

      {/* Save controls + status (incl. error) live in the modal
          footer via `useAdminShell().setFooter(...)` near the top of
          this component. */}
    </form>
  );
}
