import { useEffect, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { AutomodRule, Theme } from "@thekeep/shared";
import { DEFAULT_THEME, VERSION, isBetaVersion, normalizeTheme, THEME_PRESETS } from "@thekeep/shared";
import { readError } from "../../lib/http.js";
import { parseDurationMs } from "../../lib/duration.js";
import { useChat } from "../../state/store.js";
import { useReducedMotion } from "../../lib/reducedMotion.js";
import { recordNav } from "../../lib/nav-metrics.js";
import { StylePicker } from "../StylePicker.js";
import { ThemePicker } from "../cosmetics/ThemePicker.js";
import { TabBtn } from "../shared/TabBtn.js";
import { AdminSaveFooter, useAdminShell, type SettingsRow } from "./adminShell.js";
import { afterNextPaint, flashAnchor } from "./FindSetting.js";
import type { SettingsSubtab } from "./adminSearchIndex.js";

/* =============================================================
 * SETTINGS TAB
 * ============================================================= */

/**
 * Format ms as the most natural unit for display ("30d", "2h", "5m").
 * 0 means "forever / disabled" depending on context.
 */
function formatMs(ms: number): string {
  if (ms === 0) return "0";
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

/** Strip order for the Settings sections (docs/ADMIN_IA.md §4). Ids are
 *  display-only (never persisted, never sent on the wire); the union
 *  itself lives in adminSearchIndex.ts so the search index, the
 *  AdminPanel plumbing, and this tab share it without an import cycle. */
const SETTINGS_SUBTABS: readonly SettingsSubtab[] = ["accounts", "chat", "safety", "theme", "features"];

interface SettingsTabProps {
  /** Find-a-setting jump handed down by the AdminPanel shell
   *  (docs/ADMIN_IA.md §5.3): land on `subtab`, then scroll to + flash
   *  the element stamped `data-admin-anchor={anchor}`. Null/absent =
   *  no jump armed. */
  findRequest?: { subtab: SettingsSubtab; anchor: string } | null;
  /** Called once the jump has been handled so the shell can disarm it. */
  onFindHandled?: () => void;
}

export function SettingsTab({ findRequest, onFindHandled }: SettingsTabProps = {}) {
  const { t } = useTranslation("admin");
  const setBranding = useChat((s) => s.setBranding);
  // Edit permission gates the Save button. A delegate granted only
  // `view_admin_settings` reads the form but can't submit changes,
  // the server's PUT /admin/settings would 403 anyway, but hiding
  // Save up front spares the user the wasted round-trip.
  const canEditSiteSettings = useChat((s) => s.me?.permissions.includes("edit_site_settings") ?? false);
  const [data, setData] = useState<SettingsRow | null>(null);
  const [retention, setRetention] = useState("");
  const [sessionTtl, setSessionTtl] = useState("");
  const [idleGrace, setIdleGrace] = useState("");
  const [theme, setTheme] = useState<Theme | null>(null);
  const [maxChars, setMaxChars] = useState("");
  const [maxEmail, setMaxEmail] = useState("");
  const [blockedDomains, setBlockedDomains] = useState("");
  const [maxRooms, setMaxRooms] = useState("");
  const [maxMsgLen, setMaxMsgLen] = useState("");
  const [maxDmLen, setMaxDmLen] = useState("");
  const [maxForumLen, setMaxForumLen] = useState("");
  const [maxForumTitleLen, setMaxForumTitleLen] = useState("");
  const [forumTopicsPerPage, setForumTopicsPerPage] = useState("");
  // Edit-grace window stored as a duration string (e.g. "5m", "30s",
  // "1h") so admins can pick the right unit for the room's pace.
  // Persisted as ms via parseDurationMs. "0" disables editing entirely
  // (still leaves mods/admins able to delete via moderation tools).
  const [editGrace, setEditGrace] = useState("");
  const [maxBioLen, setMaxBioLen] = useState("");
  const [regOpen, setRegOpen] = useState(true);
  const [activityFeedsEnabled, setActivityFeedsEnabled] = useState(false);
  const [featuredWorldsEnabled, setFeaturedWorldsEnabled] = useState(false);
  const [splashMessages24hEnabled, setSplashMessages24hEnabled] = useState(false);
  // Default true, mirrors the schema default: the badge ships ON and the
  // version gate (< 1.0.0) is the real off-switch.
  const [betaBadgeEnabled, setBetaBadgeEnabled] = useState(true);
  const [profileDesignerEnabled, setProfileDesignerEnabled] = useState(false);
  const [serversEnabled, setServersEnabled] = useState(false);
  const [worldMapUploadsEnabled, setWorldMapUploadsEnabled] = useState(false);
  const [antiSpamEnabled, setAntiSpamEnabled] = useState(false);
  const [automodEnabled, setAutomodEnabled] = useState(false);
  const [allowMinorSignups, setAllowMinorSignups] = useState(false);
  // Minor language filter: master toggle + the two overlay word lists,
  // edited as one-word-per-line textareas (split/joined on save/load).
  const [minorFilterEnabled, setMinorFilterEnabled] = useState(true);
  const [minorFilterTerms, setMinorFilterTerms] = useState("");
  const [minorFilterAllow, setMinorFilterAllow] = useState("");
  // Language-filter live preview (see the Try-it block for why it exists).
  // undefined = nothing typed yet; null = server says the sentence is clean.
  const [filterTryText, setFilterTryText] = useState("");
  const [filterTryResult, setFilterTryResult] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const text = filterTryText.trim();
    if (!text) { setFilterTryResult(undefined); return; }
    let stale = false;
    const timer = window.setTimeout(async () => {
      try {
        const r = await fetch("/admin/minor-filter/preview", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!r.ok) return;
        const j = (await r.json()) as { masked: string | null };
        if (!stale) setFilterTryResult(j.masked);
      } catch { /* preview is a nicety; stay quiet on network blips */ }
    }, 400);
    return () => { stale = true; window.clearTimeout(timer); };
  }, [filterTryText]);
  const [defaultStyleKey, setDefaultStyleKey] = useState<string>("medieval");
  // Per-preset design pinning. Keyed by THEME_PRESETS name. Empty
  // entry on a preset means "fall through to defaultStyleKey for
  // that palette." Edited in the Theme designs section below.
  const [themeDesignMap, setThemeDesignMap] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saving, setSaving] = useState(false);
  // Which Settings section is on screen (docs/ADMIN_IA.md §4). Display-only
  // state: switching toggles the `hidden` attribute on the section wrappers
  // in the form below — every section stays MOUNTED, so unsaved edits, the
  // dirty nudge, and the single save/PUT flow are untouched by subtab hops.
  const [subtab, setSubtab] = useState<SettingsSubtab>("accounts");
  const changeSubtab = (next: SettingsSubtab) => {
    // Same section-switch analytics choke point as the outer tab strip
    // (stable enum key, never free text). Find-a-setting jumps set the
    // state directly instead — the pick already went through the panel's
    // changeTab recordNav, so routing them here would double-count.
    if (next !== subtab) recordNav("tab", `admin:settings:${next}`);
    setSubtab(next);
  };

  async function load() {
    setError(null);
    try {
      const r = await fetch("/admin/settings", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as SettingsRow;
      setData(j);
      setRetention(formatMs(j.messageRetentionMs));
      setSessionTtl(formatMs(j.sessionTtlMs));
      setIdleGrace(formatMs(j.idleGraceMs));
      setTheme(j.defaultThemeJson ? normalizeTheme(JSON.parse(j.defaultThemeJson)) : null);
      setMaxChars(String(j.maxCharactersPerUser));
      setMaxEmail(String(j.maxAccountsPerEmail));
      setBlockedDomains(j.blockedEmailDomains ?? "");
      setMaxRooms(String(j.maxRoomsPerOwner));
      setMaxMsgLen(String(j.maxMessageLength));
      setMaxDmLen(String(j.maxDirectMessageLength));
      setMaxForumLen(String(j.maxForumPostLength));
      setMaxForumTitleLen(String(j.maxForumTopicTitleLength));
      setForumTopicsPerPage(String(j.forumTopicsPerPage));
      setEditGrace(formatMs(j.editGraceMs));
      setMaxBioLen(String(j.maxBioLength));
      setRegOpen(j.registrationOpen);
      setActivityFeedsEnabled(j.activityFeedsEnabled);
      setFeaturedWorldsEnabled(j.featuredWorldsEnabled);
      setSplashMessages24hEnabled(j.splashMessages24hEnabled);
      setBetaBadgeEnabled(j.betaBadgeEnabled);
      setProfileDesignerEnabled(j.profileDesignerEnabled);
      setServersEnabled(j.serversEnabled);
      setWorldMapUploadsEnabled(j.worldMapUploadsEnabled);
      setAntiSpamEnabled(j.antiSpamEnabled);
      setAutomodEnabled(j.automodEnabled);
      setAllowMinorSignups(j.allowMinorSignups);
      setMinorFilterEnabled(j.minorFilterEnabled);
      setMinorFilterTerms((j.minorFilterTerms ?? []).join("\n"));
      setMinorFilterAllow((j.minorFilterAllow ?? []).join("\n"));
      setDefaultStyleKey(j.defaultStyleKey || "medieval");
      setThemeDesignMap(j.themeDesignMap ?? {});
      setTouchedSinceSave(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("loadFailed"));
    }
  }
  useEffect(() => { load(); }, []);

  // Unsaved-edits nudge. A checked toggle LOOKS committed while the actual
  // save lives in the footer button; the owner burned a debugging session on
  // a ticked-but-never-saved "Allow ages 13 to 17" box. One form-level
  // onChange (change events bubble from every input) flips this on any edit;
  // it resets on load and on a successful save. Button-driven controls (the
  // theme picker) don't bubble a change event, so this is a guardrail, not
  // an exact diff.
  const [touchedSinceSave, setTouchedSinceSave] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const retentionMs = parseDurationMs(retention, 0);
      const ttlMs = parseDurationMs(sessionTtl, 0);
      const idleGraceMs = parseDurationMs(idleGrace, 0);
      const editGraceMs = parseDurationMs(editGrace, 0);
      if (retentionMs === null) throw new Error(t("settings.retentionError"));
      if (ttlMs === null || ttlMs < 5 * 60 * 1000) throw new Error(t("settings.ttlError"));
      if (idleGraceMs === null || idleGraceMs < 30 * 1000) throw new Error(t("settings.idleGraceMinError"));
      if (idleGraceMs > 24 * 60 * 60 * 1000) throw new Error(t("settings.idleGraceMaxError"));
      if (editGraceMs === null) throw new Error(t("settings.editGraceError"));
      // Server caps at 7d; same here so the input error is friendlier
      // than an opaque 400 from the route.
      if (editGraceMs > 7 * 24 * 60 * 60 * 1000) throw new Error(t("settings.editGraceMaxError"));
      const intOrThrow = (label: string, raw: string, min: number, max: number): number => {
        const n = parseInt(raw, 10);
        if (!Number.isFinite(n) || n < min || n > max) {
          throw new Error(t("settings.intError", { label, min, max }));
        }
        return n;
      };
      const body: Record<string, unknown> = {
        messageRetentionMs: retentionMs,
        sessionTtlMs: ttlMs,
        idleGraceMs,
        maxCharactersPerUser: intOrThrow(t("settings.errMaxCharsPerUser"), maxChars, 1, 1000),
        maxAccountsPerEmail: intOrThrow(t("settings.errMaxAccountsPerEmail"), maxEmail, 1, 50),
        blockedEmailDomains: blockedDomains,
        maxRoomsPerOwner: intOrThrow(t("settings.errMaxRoomsPerOwner"), maxRooms, 0, 1000),
        maxMessageLength: intOrThrow(t("settings.errMaxChatLen"), maxMsgLen, 100, 50_000),
        maxDirectMessageLength: intOrThrow(t("settings.errMaxDmLen"), maxDmLen, 100, 50_000),
        maxForumPostLength: intOrThrow(t("settings.errMaxForumLen"), maxForumLen, 100, 50_000),
        maxForumTopicTitleLength: intOrThrow(t("settings.errMaxForumTitleLen"), maxForumTitleLen, 10, 500),
        forumTopicsPerPage: intOrThrow(t("settings.errForumTopicsPerPage"), forumTopicsPerPage, 5, 100),
        editGraceMs,
        maxBioLength: intOrThrow(t("settings.errMaxBioLen"), maxBioLen, 1000, 200_000),
        registrationOpen: regOpen,
        activityFeedsEnabled,
        featuredWorldsEnabled,
        splashMessages24hEnabled,
        betaBadgeEnabled,
        profileDesignerEnabled,
        serversEnabled,
        worldMapUploadsEnabled,
        antiSpamEnabled,
        automodEnabled,
        allowMinorSignups,
        minorFilterEnabled,
        // One word or phrase per line (commas work too); the server trims
        // and dedupes, so this split only has to break lines apart.
        minorFilterTerms: minorFilterTerms.split(/[\n,]+/).map((w) => w.trim()).filter(Boolean),
        minorFilterAllow: minorFilterAllow.split(/[\n,]+/).map((w) => w.trim()).filter(Boolean),
        defaultStyleKey,
        themeDesignMap,
      };
      // Send theme only when admin actually changed it from the loaded value.
      if (theme === null && data?.defaultThemeJson) body.defaultTheme = null;
      else if (theme !== null) body.defaultTheme = theme;

      const r = await fetch("/admin/settings", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as SettingsRow;
      setData(j);
      // Push the branding-relevant fields into the store so the splash
      // theme updates immediately if the admin changed defaultTheme or
      // toggled registration. The Settings tab can change defaultTheme,
      // which the splash uses to scope its palette.
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
        // toggle ANDed with the version gate (mirrors the /site payload) so
        // the splash never shows a Beta chip on a 1.0.0+ build.
        betaBadgeEnabled: j.betaBadgeEnabled && isBetaVersion(VERSION),
        profileDesignerEnabled: j.profileDesignerEnabled,
        serversEnabled: j.serversEnabled,
        worldMapUploadsEnabled: j.worldMapUploadsEnabled,
        defaultStyleKey: j.defaultStyleKey,
        themeDesignMap: j.themeDesignMap ?? {},
        // Null = admin hasn't set an explicit override → splash falls
        // back to prefers-color-scheme + cached last-active theme.
        defaultThemeJson: j.defaultThemeJson ?? null,
      });
      setTouchedSinceSave(false);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  // Project save controls into the modal footer so the previously-
  // empty area below the body becomes anchored chrome. The footer
  // renders our Save (which submits this form via the HTML5 `form`
  // attribute → see the `id` on `<form>` below) + Cancel + status.
  // Cleanup on unmount drops back to the default Close-only footer
  // when the user switches tabs.
  const shell = useAdminShell();
  useEffect(() => {
    if (!shell) return;
    shell.setFooter(
      <AdminSaveFooter
        formId="admin-settings-form"
        saving={saving}
        savedFlash={savedFlash}
        dirty={touchedSinceSave}
        lastUpdatedAt={data?.updatedAt ?? null}
        error={error}
        saveLabel={t("saveSettings")}
        canEdit={canEditSiteSettings}
        readOnlyHint={t("readOnlyNeedsSiteSettings")}
      />,
    );
    return () => shell.setFooter(null);
  }, [shell, saving, savedFlash, touchedSinceSave, error, data?.updatedAt, canEditSiteSettings, t]);

  // Find-a-setting jump (docs/ADMIN_IA.md §5.3). Waits for `data` so the
  // form (and its data-admin-anchor stamps) is actually on screen — the
  // effect re-fires when the settings row arrives. The subtab that owns
  // the anchor is un-hidden FIRST (a display:none element can't be
  // scrolled to), then the scroll + flash run after that swap has
  // painted. A missing anchor is silently fine; the user still lands on
  // this tab + subtab.
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    if (!findRequest || !data) return;
    setSubtab(findRequest.subtab);
    return afterNextPaint(() => {
      flashAnchor(findRequest.anchor, reduceMotion);
      onFindHandled?.();
    });
  }, [findRequest, data, reduceMotion, onFindHandled]);

  if (!data) {
    return <div className="text-keep-muted text-xs">{error ?? t("loading")}</div>;
  }

  return (
    <div className="space-y-4">
    <form
      id="admin-settings-form"
      onSubmit={save}
      onChange={() => setTouchedSinceSave(true)}
      className="space-y-4"
    >
      <p className="text-xs text-keep-muted">
        {t("settings.description")}
      </p>

      {/* Subtab strip (docs/ADMIN_IA.md §4). The buttons only flip the
          `subtab` flag: every section below stays MOUNTED and toggles
          the HTML `hidden` attribute instead of conditional-rendering,
          so unsaved edits in controlled inputs survive switches and
          change events keep bubbling up to the form-level dirty
          listener above (save() reads React state, not FormData, so
          display:none is fully safe). TabBtn renders type="button",
          so a click can never submit this form. The strip wraps on
          phones (flex-wrap); no nested dropdown. */}
      <nav
        aria-label={t("settings.subtabAria")}
        className="flex flex-wrap items-center gap-1 text-xs uppercase tracking-widest"
      >
        {SETTINGS_SUBTABS.map((s) => (
          <TabBtn key={s} active={subtab === s} onClick={() => changeSubtab(s)}>
            {t(`settings.subtab.${s}`)}
          </TabBtn>
        ))}
      </nav>

      {/* ----- Joining & accounts ------------------------------------ */}
      <section hidden={subtab !== "accounts"} className="space-y-4">
        <fieldset data-admin-anchor="settings.accountLimitsLegend" className="rounded border border-keep-rule p-3 text-xs">
          <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("settings.accountLimitsLegend")}</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label data-admin-anchor="settings.registrationLabel" className="text-xs">
              <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("settings.registrationLabel")}</span>
              <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
                <input
                  type="checkbox"
                  checked={regOpen}
                  onChange={(e) => setRegOpen(e.target.checked)}
                />
                <span>{regOpen ? t("settings.registrationOn") : t("settings.registrationOff")}</span>
              </div>
              <span className="mt-0.5 block text-[10px] text-keep-muted">
                {t("settings.registrationHint")}
              </span>
            </label>
            <label data-admin-anchor="settings.signupAgeLabel" className="text-xs">
              <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("settings.signupAgeLabel")}</span>
              <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
                <input
                  type="checkbox"
                  checked={allowMinorSignups}
                  onChange={(e) => setAllowMinorSignups(e.target.checked)}
                />
                <span>{allowMinorSignups ? t("settings.signupAgeOn") : t("settings.signupAgeOff")}</span>
              </div>
              <span className="mt-0.5 block text-[10px] text-keep-muted">
                {t("settings.signupAgeHint")}
              </span>
            </label>
            <LimitField
              anchor="settings.maxEmailLabel"
              label={t("settings.maxEmailLabel")}
              hint={t("settings.maxEmailHint")}
              value={maxEmail}
              onChange={setMaxEmail}
              min={1}
              max={50}
            />
            <LimitField
              anchor="settings.maxCharsLabel"
              label={t("settings.maxCharsLabel")}
              hint={t("settings.maxCharsHint")}
              value={maxChars}
              onChange={setMaxChars}
              min={1}
              max={1000}
            />
            <LimitField
              anchor="settings.maxRoomsLabel"
              label={t("settings.maxRoomsLabel")}
              hint={t("settings.maxRoomsHint")}
              value={maxRooms}
              onChange={setMaxRooms}
              min={0}
              max={1000}
            />
            <LimitField
              anchor="settings.maxBioLenLabel"
              label={t("settings.maxBioLenLabel")}
              hint={t("settings.maxBioLenHint")}
              value={maxBioLen}
              onChange={setMaxBioLen}
              min={1000}
              max={200_000}
            />
          </div>
          <label data-admin-anchor="settings.blockedEmailDomainsLabel" className="mt-2 block text-xs">
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("settings.blockedEmailDomainsLabel")}</span>
            <textarea
              value={blockedDomains}
              onChange={(e) => setBlockedDomains(e.target.value)}
              rows={3}
              maxLength={20_000}
              placeholder={t("settings.blockedEmailDomainsPlaceholder")}
              className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-[11px]"
            />
            <span className="mt-0.5 block text-[10px] text-keep-muted">{t("settings.blockedEmailDomainsHint")}</span>
          </label>
        </fieldset>
      </section>

      {/* ----- Chat & forums ----------------------------------------- */}
      <section hidden={subtab !== "chat"} className="space-y-4">
        <fieldset data-admin-anchor="settings.retentionLegend" className="rounded border border-keep-rule p-3 text-xs">
          <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("settings.retentionLegend")}</legend>
          <div className="flex items-baseline gap-2">
            <input
              type="text"
              value={retention}
              onChange={(e) => setRetention(e.target.value)}
              placeholder={t("settings.retentionPlaceholder")}
              className="w-32 rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
            />
            <span className="text-keep-muted">
              <Trans t={t} i18nKey="settings.retentionHelp">
                {"Messages older than this are purged hourly. "}
                <code>0</code>
                {" retains forever."}
              </Trans>
            </span>
          </div>
        </fieldset>

        <fieldset data-admin-anchor="settings.idleTimeoutLegend" className="rounded border border-keep-rule p-3 text-xs">
          <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("settings.idleTimeoutLegend")}</legend>
          <div className="flex items-baseline gap-2">
            <input
              type="text"
              value={sessionTtl}
              onChange={(e) => setSessionTtl(e.target.value)}
              placeholder={t("settings.idleTimeoutPlaceholder")}
              className="w-32 rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
            />
            <span className="text-keep-muted">
              {t("settings.idleTimeoutHelp")}
            </span>
          </div>
        </fieldset>

        <fieldset data-admin-anchor="settings.idleGhostLegend" className="rounded border border-keep-rule p-3 text-xs">
          <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("settings.idleGhostLegend")}</legend>
          <div className="flex items-baseline gap-2">
            <input
              type="text"
              value={idleGrace}
              onChange={(e) => setIdleGrace(e.target.value)}
              placeholder={t("settings.idleGhostPlaceholder")}
              className="w-32 rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
            />
            <span className="text-keep-muted">
              {t("settings.idleGhostHelp")}
            </span>
          </div>
        </fieldset>

        <fieldset data-admin-anchor="settings.chatLimitsLegend" className="rounded border border-keep-rule p-3 text-xs">
          <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("settings.chatLimitsLegend")}</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <LimitField
              anchor="settings.maxMsgLenLabel"
              label={t("settings.maxMsgLenLabel")}
              hint={t("settings.maxMsgLenHint")}
              value={maxMsgLen}
              onChange={setMaxMsgLen}
              min={100}
              max={50_000}
            />
            <LimitField
              anchor="settings.maxDmLenLabel"
              label={t("settings.maxDmLenLabel")}
              hint={t("settings.maxDmLenHint")}
              value={maxDmLen}
              onChange={setMaxDmLen}
              min={100}
              max={50_000}
            />
            <label data-admin-anchor="settings.editWindowLabel" className="text-xs">
              <span className="mb-1 block uppercase tracking-widest text-keep-muted">
                {t("settings.editWindowLabel")}
              </span>
              <input
                type="text"
                value={editGrace}
                onChange={(e) => setEditGrace(e.target.value)}
                placeholder="5m"
                className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
              />
              <span className="mt-0.5 block text-[10px] text-keep-muted">
                {t("settings.editWindowHint")}
              </span>
            </label>
          </div>
        </fieldset>

        <fieldset data-admin-anchor="settings.forumLimitsLegend" className="rounded border border-keep-rule p-3 text-xs">
          <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("settings.forumLimitsLegend")}</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <LimitField
              anchor="settings.maxForumLenLabel"
              label={t("settings.maxForumLenLabel")}
              hint={t("settings.maxForumLenHint")}
              value={maxForumLen}
              onChange={setMaxForumLen}
              min={100}
              max={50_000}
            />
            <LimitField
              anchor="settings.maxForumTitleLenLabel"
              label={t("settings.maxForumTitleLenLabel")}
              hint={t("settings.maxForumTitleLenHint")}
              value={maxForumTitleLen}
              onChange={setMaxForumTitleLen}
              min={10}
              max={500}
            />
            <LimitField
              anchor="settings.forumTopicsPerPageLabel"
              label={t("settings.forumTopicsPerPageLabel")}
              hint={t("settings.forumTopicsPerPageHint")}
              value={forumTopicsPerPage}
              onChange={setForumTopicsPerPage}
              min={5}
              max={100}
            />
          </div>
        </fieldset>
      </section>

      {/* ----- Safety & filters -------------------------------------- */}
      <section hidden={subtab !== "safety"} className="space-y-4">
        <fieldset data-admin-anchor="settings.safetyTogglesLegend" className="rounded border border-keep-rule p-3 text-xs">
          <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("settings.safetyTogglesLegend")}</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label data-admin-anchor="settings.antiSpamLabel" className="text-xs">
              <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("settings.antiSpamLabel")}</span>
              <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
                <input
                  type="checkbox"
                  checked={antiSpamEnabled}
                  onChange={(e) => setAntiSpamEnabled(e.target.checked)}
                />
                <span>{antiSpamEnabled ? t("settings.antiSpamOn") : t("settings.antiSpamOff")}</span>
              </div>
              <span className="mt-0.5 block text-[10px] text-keep-muted">
                {t("settings.antiSpamHint")}
              </span>
            </label>
            <label data-admin-anchor="settings.automodLabel" className="text-xs">
              <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("settings.automodLabel")}</span>
              <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
                <input
                  type="checkbox"
                  checked={automodEnabled}
                  onChange={(e) => setAutomodEnabled(e.target.checked)}
                />
                <span>{automodEnabled ? t("settings.automodOn") : t("settings.automodOff")}</span>
              </div>
              <span className="mt-0.5 block text-[10px] text-keep-muted">
                {t("settings.automodHint")}
              </span>
            </label>
          </div>
        </fieldset>

        {/* Minor language filter. Sits under the protection toggles above
            (anti-spam / auto-moderation): same save flow, same permission.
            Masking is VIEWER-side for under-18 accounts only; nothing here
            edits stored messages, and adults always see the original. */}
        <fieldset data-admin-anchor="settings.minorFilterLegend" className="rounded border border-keep-rule p-3 text-xs">
          <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("settings.minorFilterLegend")}</legend>
          <p className="mb-2 text-keep-muted">
            {t("settings.minorFilterHelp")}
          </p>
          <label className="mb-2 flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
            <input
              type="checkbox"
              checked={minorFilterEnabled}
              onChange={(e) => setMinorFilterEnabled(e.target.checked)}
            />
            <span>{minorFilterEnabled ? t("settings.minorFilterOn") : t("settings.minorFilterOff")}</span>
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label data-admin-anchor="settings.minorFilterTermsLabel" className="text-xs">
              <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("settings.minorFilterTermsLabel")}</span>
              <textarea
                value={minorFilterTerms}
                onChange={(e) => setMinorFilterTerms(e.target.value)}
                rows={5}
                placeholder={t("settings.minorFilterTermsPh")}
                className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
              />
              <span className="mt-0.5 block text-[10px] text-keep-muted">
                {t("settings.minorFilterTermsHint")}
              </span>
            </label>
            <label data-admin-anchor="settings.minorFilterAllowLabel" className="text-xs">
              <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("settings.minorFilterAllowLabel")}</span>
              <textarea
                value={minorFilterAllow}
                onChange={(e) => setMinorFilterAllow(e.target.value)}
                rows={5}
                placeholder={t("settings.minorFilterAllowPh")}
                className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
              />
              <span className="mt-0.5 block text-[10px] text-keep-muted">
                {t("settings.minorFilterAllowHint")}
              </span>
            </label>
          </div>
          {/* Live preview. The built-in word list is invisible in the boxes
              above, and an EMPTY Added-words box read to the owner as "the
              filter does nothing" — one typed test kills that doubt better
              than any copy. Evaluates the SAVED settings through the same
              matcher the live surfaces use (parity rule shared with the
              automod tester). stopPropagation keeps preview typing from
              tripping the form-level unsaved-changes nudge — nothing here
              is a setting. */}
          <div className="mt-2">
            <label className="text-xs">
              <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("settings.minorFilterTryLabel")}</span>
              <input
                value={filterTryText}
                onChange={(e) => { e.stopPropagation(); setFilterTryText(e.target.value); }}
                placeholder={t("settings.minorFilterTryPh")}
                className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
              />
            </label>
            {filterTryResult !== undefined ? (
              <p className={`mt-1 text-xs ${filterTryResult === null ? "text-keep-muted" : "text-keep-text"}`}>
                {filterTryResult === null
                  ? t("settings.minorFilterTryClean")
                  : t("settings.minorFilterTryMasked", { masked: filterTryResult })}
              </p>
            ) : null}
          </div>
        </fieldset>
      </section>

      {/* ----- Look & theme ------------------------------------------ */}
      <section hidden={subtab !== "theme"} className="space-y-4">
        <fieldset data-admin-anchor="settings.defaultThemeLegend" className="rounded border border-keep-rule p-3 text-xs">
          <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("settings.defaultThemeLegend")}</legend>
          <p className="mb-2 text-keep-muted">
            {t("settings.defaultThemeHelp")}
          </p>
          <ThemePicker
            theme={theme ?? DEFAULT_THEME}
            onChange={setTheme}
            onReset={() => setTheme(null)}
          />
          {!theme ? (
            <div className="mt-1 italic text-keep-muted">{t("settings.noSiteDefault")}</div>
          ) : null}
        </fieldset>

        <fieldset data-admin-anchor="settings.themeStyleLegend" className="rounded border border-keep-rule p-3 text-xs">
          <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("settings.themeStyleLegend")}</legend>
          <p className="mb-2 text-keep-muted">
            {t("settings.themeStyleHelp")}
          </p>
          <StylePicker
            value={defaultStyleKey}
            // Admin requires a non-null value; if the user manages to
            // pick "(use site default)" (only shown with allowInherit)
            // fall through to the launch flagship.
            onChange={(k) => setDefaultStyleKey(k ?? "medieval")}
          />
        </fieldset>

        <fieldset data-admin-anchor="settings.designsByThemeLegend" className="rounded border border-keep-rule p-3 text-xs">
          <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("settings.designsByThemeLegend")}</legend>
          <p className="mb-2 text-keep-muted">
            {t("settings.designsByThemeHelp")}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {THEME_PRESETS.map((p) => (
              <label key={p.name} className="flex items-center gap-2">
                <span
                  aria-hidden
                  title={t("settings.palettePreviewTitle", { name: p.name })}
                  className="flex shrink-0 rounded border"
                  style={{ borderColor: p.theme.border }}
                >
                  {(["panel", "action", "accent"] as const).map((slot) => (
                    <span
                      key={slot}
                      className="inline-block h-4 w-4"
                      style={{ backgroundColor: p.theme[slot] }}
                    />
                  ))}
                </span>
                <span className="min-w-[6rem] truncate font-semibold">{p.name}</span>
                <StylePicker
                  value={themeDesignMap[p.name] ?? null}
                  allowInherit
                  onChange={(k) => {
                    setThemeDesignMap((prev) => {
                      const next = { ...prev };
                      if (k === null) delete next[p.name];
                      else next[p.name] = k;
                      return next;
                    });
                  }}
                />
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      {/* ----- Homepage & extras ------------------------------------- */}
      <section hidden={subtab !== "features"} className="space-y-4">
        <fieldset data-admin-anchor="settings.homepageTogglesLegend" className="rounded border border-keep-rule p-3 text-xs">
          <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("settings.homepageTogglesLegend")}</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label data-admin-anchor="settings.activityFeedsLabel" className="text-xs">
              <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("settings.activityFeedsLabel")}</span>
              <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
                <input
                  type="checkbox"
                  checked={activityFeedsEnabled}
                  onChange={(e) => setActivityFeedsEnabled(e.target.checked)}
                />
                <span>{activityFeedsEnabled ? t("settings.activityFeedsOn") : t("settings.activityFeedsOff")}</span>
              </div>
              <span className="mt-0.5 block text-[10px] text-keep-muted">
                {t("settings.activityFeedsHint")}
              </span>
            </label>
            <label data-admin-anchor="settings.messages24hLabel" className="text-xs">
              <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("settings.messages24hLabel")}</span>
              <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
                <input
                  type="checkbox"
                  checked={splashMessages24hEnabled}
                  onChange={(e) => setSplashMessages24hEnabled(e.target.checked)}
                />
                <span>{splashMessages24hEnabled ? t("settings.messages24hOn") : t("settings.messages24hOff")}</span>
              </div>
              <span className="mt-0.5 block text-[10px] text-keep-muted">
                {t("settings.messages24hHint")}
              </span>
            </label>
            <label data-admin-anchor="settings.featuredWorldsLabel" className="text-xs">
              <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("settings.featuredWorldsLabel")}</span>
              <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
                <input
                  type="checkbox"
                  checked={featuredWorldsEnabled}
                  onChange={(e) => setFeaturedWorldsEnabled(e.target.checked)}
                />
                <span>{featuredWorldsEnabled ? t("settings.featuredWorldsOn") : t("settings.featuredWorldsOff")}</span>
              </div>
              <span className="mt-0.5 block text-[10px] text-keep-muted">
                {t("settings.featuredWorldsHint")}
              </span>
            </label>
            <label data-admin-anchor="settings.betaBadgeLabel" className="text-xs">
              <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("settings.betaBadgeLabel")}</span>
              <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
                <input
                  type="checkbox"
                  checked={betaBadgeEnabled}
                  onChange={(e) => setBetaBadgeEnabled(e.target.checked)}
                />
                <span>{betaBadgeEnabled ? t("settings.betaBadgeOn") : t("settings.betaBadgeOff")}</span>
              </div>
              <span className="mt-0.5 block text-[10px] text-keep-muted">
                {t("settings.betaBadgeHint")}
              </span>
            </label>
          </div>
        </fieldset>

        <fieldset data-admin-anchor="settings.featureTogglesLegend" className="rounded border border-keep-rule p-3 text-xs">
          <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("settings.featureTogglesLegend")}</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label data-admin-anchor="settings.designerLabel" className="text-xs">
              <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("settings.designerLabel")}</span>
              <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
                <input
                  type="checkbox"
                  checked={profileDesignerEnabled}
                  onChange={(e) => setProfileDesignerEnabled(e.target.checked)}
                />
                <span>{profileDesignerEnabled ? t("settings.designerOn") : t("settings.designerOff")}</span>
              </div>
              <span className="mt-0.5 block text-[10px] text-keep-muted">
                {t("settings.designerHint")}
              </span>
            </label>
            <label data-admin-anchor="settings.multiServerLabel" className="text-xs">
              <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("settings.multiServerLabel")}</span>
              <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
                <input
                  type="checkbox"
                  checked={serversEnabled}
                  onChange={(e) => setServersEnabled(e.target.checked)}
                />
                <span>{serversEnabled ? t("settings.multiServerOn") : t("settings.multiServerOff")}</span>
              </div>
              <span className="mt-0.5 block text-[10px] text-keep-muted">
                {t("settings.multiServerHint")}
              </span>
            </label>
            <label data-admin-anchor="settings.worldMapUploadsLabel" className="text-xs">
              <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("settings.worldMapUploadsLabel")}</span>
              <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
                <input
                  type="checkbox"
                  checked={worldMapUploadsEnabled}
                  onChange={(e) => setWorldMapUploadsEnabled(e.target.checked)}
                />
                <span>{worldMapUploadsEnabled ? t("settings.worldMapUploadsOn") : t("settings.worldMapUploadsOff")}</span>
              </div>
              <span className="mt-0.5 block text-[10px] text-keep-muted">
                {t("settings.worldMapUploadsHint")}
              </span>
            </label>
          </div>
        </fieldset>
      </section>

      {/* Save controls + status (incl. error) live in the modal
          footer via `useAdminShell().setFooter(...)` near the top of
          this component. No inline save row, keeps the form
          scrolling area focused on field editing. Validation errors
          surface there even when the failing field sits on a hidden
          subtab — no auto-switch-on-error, by design. */}
    </form>

    {/* Auto-moderation rule management + test box. Self-contained
        (own fetch/state), lives OUTSIDE the settings <form> so its
        buttons never submit the settings save; it shows with the
        Safety & filters subtab via the same `hidden` toggle as the
        in-form sections (stays mounted, so its rule list doesn't
        refetch on every visit). The master toggle above
        (Auto-moderation) enables/disables enforcement; these rules
        define WHAT gets caught. */}
    <div hidden={subtab !== "safety"}>
      <AutomodRulesCard canEdit={canEditSiteSettings} />
    </div>
    </div>
  );
}

/* =============================================================
 * AUTO-MODERATION RULES CARD (inside the Settings tab)
 * =============================================================
 *
 * CRUD over site-wide content-moderation rules plus a live test box.
 * Reads/writes /admin/automod/*; fully self-contained so it can be
 * dropped beside the Anti-spam toggle without touching the settings
 * save flow. Gated read-only when the admin lacks edit_site_settings.
 */

/** Catalog keys (admin ns) for the automod enum labels; resolve with t(). */
const AUTOMOD_KIND_KEYS: Record<AutomodRule["kind"], string> = {
  keyword: "settings.automodKind.keyword",
  regex: "settings.automodKind.regex",
  link: "settings.automodKind.link",
  invite: "settings.automodKind.invite",
  mention_cap: "settings.automodKind.mention_cap",
};
const AUTOMOD_ACTION_KEYS: Record<AutomodRule["action"], string> = {
  warn: "settings.automodAction.warn",
  delete: "settings.automodAction.delete",
  mute: "settings.automodAction.mute",
};
const AUTOMOD_SCOPE_KEYS: Record<AutomodRule["scope"], string> = {
  chat: "settings.automodScope.chat",
  forum: "settings.automodScope.forum",
  both: "settings.automodScope.both",
};

type AutomodDraft = {
  kind: AutomodRule["kind"];
  pattern: string;
  action: AutomodRule["action"];
  scope: AutomodRule["scope"];
  caseInsensitive: boolean;
  wholeWord: boolean;
  muteMinutes: string;
  note: string;
};

function freshAutomodDraft(): AutomodDraft {
  return {
    kind: "keyword",
    pattern: "",
    action: "warn",
    scope: "both",
    caseInsensitive: true,
    wholeWord: true,
    muteMinutes: "",
    note: "",
  };
}

function AutomodRulesCard({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation("admin");
  const [rules, setRules] = useState<AutomodRule[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<AutomodDraft>(freshAutomodDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Test box.
  const [testText, setTestText] = useState("");
  const [testSurface, setTestSurface] = useState<"chat" | "forum">("chat");
  const [testResult, setTestResult] = useState<
    { action: AutomodRule["action"] | null; hits: Array<{ ruleId: string; kind: AutomodRule["kind"]; action: AutomodRule["action"]; label: string }> } | null
  >(null);

  async function loadRules() {
    setErr(null);
    try {
      const r = await fetch("/admin/automod/rules", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { rules: AutomodRule[] };
      setRules(j.rules);
      setLoaded(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("loadFailed"));
    }
  }
  useEffect(() => { loadRules(); }, []);

  // link/invite carry no pattern; mention_cap uses a number; keyword/regex a string.
  const patternless = draft.kind === "link" || draft.kind === "invite";

  function startEdit(rule: AutomodRule) {
    setEditingId(rule.id);
    setDraft({
      kind: rule.kind,
      pattern: rule.pattern,
      action: rule.action,
      scope: rule.scope,
      caseInsensitive: rule.caseInsensitive,
      wholeWord: rule.wholeWord,
      muteMinutes: rule.muteMs != null ? String(Math.round(rule.muteMs / 60_000)) : "",
      note: rule.note ?? "",
    });
  }
  function cancelEdit() {
    setEditingId(null);
    setDraft(freshAutomodDraft());
  }

  async function submitDraft() {
    setErr(null);
    setBusy(true);
    try {
      const muteMs =
        draft.action === "mute" && draft.muteMinutes.trim()
          ? Math.round(Number(draft.muteMinutes) * 60_000)
          : null;
      if (draft.action === "mute" && draft.muteMinutes.trim() && (!Number.isFinite(muteMs) || (muteMs ?? 0) < 60_000)) {
        throw new Error(t("settings.muteLengthError"));
      }
      const payload = {
        kind: draft.kind,
        pattern: patternless ? "" : draft.pattern,
        action: draft.action,
        scope: draft.scope,
        caseInsensitive: draft.caseInsensitive,
        wholeWord: draft.wholeWord,
        muteMs,
        note: draft.note.trim() || null,
      };
      const url = editingId ? `/admin/automod/rules/${editingId}` : "/admin/automod/rules";
      const method = editingId ? "PATCH" : "POST";
      const r = await fetch(url, {
        method,
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(await readError(r));
      await loadRules();
      cancelEdit();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function toggleRule(rule: AutomodRule) {
    setErr(null);
    try {
      const r = await fetch(`/admin/automod/rules/${rule.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      if (!r.ok) throw new Error(await readError(r));
      await loadRules();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("updateFailed"));
    }
  }

  async function deleteRule(rule: AutomodRule) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t("settings.deleteRuleConfirm"))) return;
    setErr(null);
    try {
      const r = await fetch(`/admin/automod/rules/${rule.id}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      await loadRules();
      if (editingId === rule.id) cancelEdit();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("deleteFailed"));
    }
  }

  async function runTest() {
    setErr(null);
    try {
      const r = await fetch("/admin/automod/test", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: testText, surface: testSurface }),
      });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as typeof testResult;
      setTestResult(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("settings.testFailed"));
    }
  }

  const inputCls = "rounded border border-keep-rule bg-keep-bg px-2 py-1";

  return (
    <fieldset data-admin-anchor="settings.automodRulesLegend" className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("settings.automodRulesLegend")}</legend>
      <p className="mb-2 text-keep-muted">
        {t("settings.automodRulesHelp")}
      </p>

      {err ? <div className="mb-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-red-300">{err}</div> : null}

      {/* Rule list */}
      <div className="mb-3 space-y-1">
        {!loaded ? (
          <div className="text-keep-muted">{t("settings.loadingRules")}</div>
        ) : rules.length === 0 ? (
          <div className="italic text-keep-muted">{t("settings.noRules")}</div>
        ) : (
          rules.map((rule) => (
            <div
              key={rule.id}
              className={`flex flex-wrap items-center gap-2 rounded border border-keep-rule px-2 py-1 ${rule.enabled ? "" : "opacity-50"}`}
            >
              <span className="rounded bg-keep-panel px-1.5 py-0.5 font-semibold">{t(AUTOMOD_KIND_KEYS[rule.kind])}</span>
              {rule.kind !== "link" && rule.kind !== "invite" ? (
                <code className="max-w-[16rem] truncate rounded bg-keep-bg px-1">{rule.pattern || t("settings.emptyPattern")}</code>
              ) : null}
              <span className="text-keep-muted">→</span>
              <span>{t(AUTOMOD_ACTION_KEYS[rule.action])}</span>
              <span className="text-keep-muted">·</span>
              <span className="text-keep-muted">{t(AUTOMOD_SCOPE_KEYS[rule.scope])}</span>
              {rule.note ? <span className="text-keep-muted">· {rule.note}</span> : null}
              <span className="ml-auto flex items-center gap-2">
                {canEdit ? (
                  <>
                    <button type="button" className="underline" onClick={() => toggleRule(rule)}>
                      {rule.enabled ? t("affiliates.disable") : t("affiliates.enable")}
                    </button>
                    <button type="button" className="underline" onClick={() => startEdit(rule)}>{t("edit")}</button>
                    <button type="button" className="text-red-400 underline" onClick={() => deleteRule(rule)}>{t("common:delete")}</button>
                  </>
                ) : null}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Add / edit form */}
      {canEdit ? (
        <div className="mb-3 rounded border border-keep-rule bg-keep-bg/40 p-2">
          <div className="mb-2 font-semibold uppercase tracking-widest text-keep-muted">
            {editingId ? t("settings.editRule") : t("settings.addRule")}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-keep-muted">{t("settings.matchOn")}</span>
              <select
                className={inputCls}
                value={draft.kind}
                onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value as AutomodRule["kind"] }))}
              >
                {(Object.keys(AUTOMOD_KIND_KEYS) as AutomodRule["kind"][]).map((k) => (
                  <option key={k} value={k}>{t(AUTOMOD_KIND_KEYS[k])}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-keep-muted">{t("settings.actionLabel")}</span>
              <select
                className={inputCls}
                value={draft.action}
                onChange={(e) => setDraft((d) => ({ ...d, action: e.target.value as AutomodRule["action"] }))}
              >
                {(Object.keys(AUTOMOD_ACTION_KEYS) as AutomodRule["action"][]).map((a) => (
                  <option key={a} value={a}>{t(AUTOMOD_ACTION_KEYS[a])}</option>
                ))}
              </select>
            </label>
            {!patternless ? (
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className="text-keep-muted">
                  {draft.kind === "mention_cap" ? t("settings.mentionCapLabel") : draft.kind === "regex" ? t("settings.regexLabel") : t("settings.keywordLabel")}
                </span>
                <input
                  className={`${inputCls} font-mono`}
                  value={draft.pattern}
                  placeholder={draft.kind === "mention_cap" ? t("settings.mentionCapPlaceholder") : draft.kind === "regex" ? t("settings.regexPlaceholder") : t("settings.keywordPlaceholder")}
                  onChange={(e) => setDraft((d) => ({ ...d, pattern: e.target.value }))}
                />
              </label>
            ) : (
              <div className="sm:col-span-2 text-keep-muted italic">
                {draft.kind === "link" ? t("settings.linkNote") : t("settings.inviteNote")}
              </div>
            )}
            <label className="flex flex-col gap-1">
              <span className="text-keep-muted">{t("settings.appliesTo")}</span>
              <select
                className={inputCls}
                value={draft.scope}
                onChange={(e) => setDraft((d) => ({ ...d, scope: e.target.value as AutomodRule["scope"] }))}
              >
                {(Object.keys(AUTOMOD_SCOPE_KEYS) as AutomodRule["scope"][]).map((s) => (
                  <option key={s} value={s}>{t(AUTOMOD_SCOPE_KEYS[s])}</option>
                ))}
              </select>
            </label>
            {draft.action === "mute" ? (
              <label className="flex flex-col gap-1">
                <span className="text-keep-muted">{t("settings.muteLengthLabel")}</span>
                <input
                  className={inputCls}
                  value={draft.muteMinutes}
                  placeholder={t("settings.muteLengthPlaceholder")}
                  onChange={(e) => setDraft((d) => ({ ...d, muteMinutes: e.target.value }))}
                />
              </label>
            ) : null}
            {draft.kind === "keyword" ? (
              <>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.caseInsensitive}
                    onChange={(e) => setDraft((d) => ({ ...d, caseInsensitive: e.target.checked }))}
                  />
                  <span>{t("settings.ignoreCase")}</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.wholeWord}
                    onChange={(e) => setDraft((d) => ({ ...d, wholeWord: e.target.checked }))}
                  />
                  <span>{t("settings.wholeWord")}</span>
                </label>
              </>
            ) : draft.kind === "regex" ? (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.caseInsensitive}
                  onChange={(e) => setDraft((d) => ({ ...d, caseInsensitive: e.target.checked }))}
                />
                <span>{t("settings.ignoreCase")}</span>
              </label>
            ) : null}
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-keep-muted">{t("settings.noteLabel")}</span>
              <input
                className={inputCls}
                value={draft.note}
                placeholder={t("settings.notePlaceholder")}
                onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
              />
            </label>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={submitDraft}
              className="rounded border border-keep-rule bg-keep-panel px-3 py-1 font-semibold disabled:opacity-50"
            >
              {editingId ? t("settings.saveRule") : t("settings.addRule")}
            </button>
            {editingId ? (
              <button type="button" onClick={cancelEdit} className="underline text-keep-muted">{t("common:cancel")}</button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Test box */}
      <div className="rounded border border-keep-rule bg-keep-bg/40 p-2">
        <div className="mb-2 font-semibold uppercase tracking-widest text-keep-muted">{t("settings.testTitle")}</div>
        <p className="mb-2 text-keep-muted">
          {t("settings.testHelp")}
        </p>
        <textarea
          className={`${inputCls} w-full font-mono`}
          rows={3}
          value={testText}
          placeholder={t("settings.testPlaceholder")}
          onChange={(e) => setTestText(e.target.value)}
        />
        <div className="mt-2 flex items-center gap-2">
          <select
            className={inputCls}
            value={testSurface}
            onChange={(e) => setTestSurface(e.target.value as "chat" | "forum")}
          >
            <option value="chat">{t("settings.asChat")}</option>
            <option value="forum">{t("settings.asForum")}</option>
          </select>
          <button
            type="button"
            onClick={runTest}
            className="rounded border border-keep-rule bg-keep-panel px-3 py-1 font-semibold"
          >
            {t("settings.runTest")}
          </button>
        </div>
        {testResult ? (
          <div className="mt-2">
            {testResult.hits.length === 0 ? (
              <div className="text-green-400">{t("settings.noRulesFired")}</div>
            ) : (
              <>
                <div className="mb-1">
                  <Trans
                    t={t}
                    i18nKey="settings.resultingAction"
                    values={{ action: testResult.action ? t(AUTOMOD_ACTION_KEYS[testResult.action]) : t("settings.noneAction") }}
                  >
                    {"Resulting action: "}
                    <span className="font-semibold">{"{{action}}"}</span>
                  </Trans>
                </div>
                <ul className="list-disc pl-5 text-keep-muted">
                  {testResult.hits.map((h, i) => (
                    <li key={`${h.ruleId}-${i}`}>
                      {t(AUTOMOD_KIND_KEYS[h.kind])} ({t(AUTOMOD_ACTION_KEYS[h.action])}): <code>{h.label}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : null}
      </div>
    </fieldset>
  );
}

function LimitField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  anchor,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  min: number;
  max: number;
  /** Find-a-setting jump target: the row's own catalog key, stamped
   *  verbatim as `data-admin-anchor` (docs/ADMIN_IA.md §5.3). */
  anchor: string;
}) {
  return (
    <label data-admin-anchor={anchor} className="text-xs">
      <span className="mb-1 block uppercase tracking-widest text-keep-muted">{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        min={min}
        max={max}
        step={1}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
      />
      <span className="mt-0.5 block text-[10px] text-keep-muted">{hint}</span>
    </label>
  );
}
