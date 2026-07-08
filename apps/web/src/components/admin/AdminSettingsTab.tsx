import { useEffect, useState, type FormEvent } from "react";
import type { AutomodRule, Theme } from "@thekeep/shared";
import { DEFAULT_THEME, normalizeTheme, THEME_PRESETS } from "@thekeep/shared";
import { readError } from "../../lib/http.js";
import { parseDurationMs } from "../../lib/duration.js";
import { useChat } from "../../state/store.js";
import { AdminSaveFooter, useAdminShell, type SettingsRow } from "./adminShell.js";
import { StylePicker } from "../StylePicker.js";
import { ThemePicker } from "../cosmetics/ThemePicker.js";

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

export function SettingsTab() {
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
  const [profileDesignerEnabled, setProfileDesignerEnabled] = useState(false);
  const [serversEnabled, setServersEnabled] = useState(false);
  const [antiSpamEnabled, setAntiSpamEnabled] = useState(false);
  const [automodEnabled, setAutomodEnabled] = useState(false);
  const [defaultStyleKey, setDefaultStyleKey] = useState<string>("medieval");
  // Per-preset design pinning. Keyed by THEME_PRESETS name. Empty
  // entry on a preset means "fall through to defaultStyleKey for
  // that palette." Edited in the Theme designs section below.
  const [themeDesignMap, setThemeDesignMap] = useState<Record<string, string>>({});
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
      setRetention(formatMs(j.messageRetentionMs));
      setSessionTtl(formatMs(j.sessionTtlMs));
      setIdleGrace(formatMs(j.idleGraceMs));
      setTheme(j.defaultThemeJson ? normalizeTheme(JSON.parse(j.defaultThemeJson)) : null);
      setMaxChars(String(j.maxCharactersPerUser));
      setMaxEmail(String(j.maxAccountsPerEmail));
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
      setProfileDesignerEnabled(j.profileDesignerEnabled);
      setServersEnabled(j.serversEnabled);
      setAntiSpamEnabled(j.antiSpamEnabled);
      setAutomodEnabled(j.automodEnabled);
      setDefaultStyleKey(j.defaultStyleKey || "medieval");
      setThemeDesignMap(j.themeDesignMap ?? {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    }
  }
  useEffect(() => { load(); }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const retentionMs = parseDurationMs(retention, 0);
      const ttlMs = parseDurationMs(sessionTtl, 0);
      const idleGraceMs = parseDurationMs(idleGrace, 0);
      const editGraceMs = parseDurationMs(editGrace, 0);
      if (retentionMs === null) throw new Error("retention must be a duration like 30d (or 0 for never)");
      if (ttlMs === null || ttlMs < 5 * 60 * 1000) throw new Error("session TTL must be at least 5m");
      if (idleGraceMs === null || idleGraceMs < 30 * 1000) throw new Error("idle grace must be at least 30s");
      if (idleGraceMs > 24 * 60 * 60 * 1000) throw new Error("idle grace must be 24h or less");
      if (editGraceMs === null) throw new Error("edit window must be a duration like 5m (or 0 to disable edits)");
      // Server caps at 7d; same here so the input error is friendlier
      // than an opaque 400 from the route.
      if (editGraceMs > 7 * 24 * 60 * 60 * 1000) throw new Error("edit window must be 7 days or less");
      const intOrThrow = (label: string, raw: string, min: number, max: number): number => {
        const n = parseInt(raw, 10);
        if (!Number.isFinite(n) || n < min || n > max) {
          throw new Error(`${label} must be an integer ${min}-${max}`);
        }
        return n;
      };
      const body: Record<string, unknown> = {
        messageRetentionMs: retentionMs,
        sessionTtlMs: ttlMs,
        idleGraceMs,
        maxCharactersPerUser: intOrThrow("Max characters/user", maxChars, 1, 1000),
        maxAccountsPerEmail: intOrThrow("Max accounts/email", maxEmail, 1, 50),
        maxRoomsPerOwner: intOrThrow("Max rooms/owner", maxRooms, 0, 1000),
        maxMessageLength: intOrThrow("Max chat message length", maxMsgLen, 100, 50_000),
        maxDirectMessageLength: intOrThrow("Max DM length", maxDmLen, 100, 50_000),
        maxForumPostLength: intOrThrow("Max forum post length", maxForumLen, 100, 50_000),
        maxForumTopicTitleLength: intOrThrow("Max forum topic title length", maxForumTitleLen, 10, 500),
        forumTopicsPerPage: intOrThrow("Forum topics per page", forumTopicsPerPage, 5, 100),
        editGraceMs,
        maxBioLength: intOrThrow("Max bio length", maxBioLen, 1000, 200_000),
        registrationOpen: regOpen,
        activityFeedsEnabled,
        featuredWorldsEnabled,
        splashMessages24hEnabled,
        profileDesignerEnabled,
        serversEnabled,
        antiSpamEnabled,
        automodEnabled,
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
      setError(err instanceof Error ? err.message : "save failed");
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
        lastUpdatedAt={data?.updatedAt ?? null}
        error={error}
        saveLabel="Save settings"
        canEdit={canEditSiteSettings}
        readOnlyHint="Read-only, needs edit_site_settings to save."
      />,
    );
    return () => shell.setFooter(null);
  }, [shell, saving, savedFlash, error, data?.updatedAt, canEditSiteSettings]);

  if (!data) {
    return <div className="text-keep-muted text-xs">{error ?? "loading..."}</div>;
  }

  return (
    <div className="space-y-4">
    <form id="admin-settings-form" onSubmit={save} className="space-y-4">
      <p className="text-xs text-keep-muted">
        Sitewide configuration. Changes apply immediately for new sessions and the next hourly retention sweep.
      </p>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Message retention</legend>
        <div className="flex items-baseline gap-2">
          <input
            type="text"
            value={retention}
            onChange={(e) => setRetention(e.target.value)}
            placeholder="30d, 90d, 0 = forever"
            className="w-32 rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
          />
          <span className="text-keep-muted">
            Messages older than this are purged hourly. <code>0</code> retains forever.
          </span>
        </div>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Idle timeout</legend>
        <div className="flex items-baseline gap-2">
          <input
            type="text"
            value={sessionTtl}
            onChange={(e) => setSessionTtl(e.target.value)}
            placeholder="30m, 1h, 1d"
            className="w-32 rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
          />
          <span className="text-keep-muted">
            How long a user can be idle before they get bounced back to the login splash. Sliding: any keypress, mousemove, message, or room switch resets the clock. Min 5m.
          </span>
        </div>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Idle ghost lifetime</legend>
        <div className="flex items-baseline gap-2">
          <input
            type="text"
            value={idleGrace}
            onChange={(e) => setIdleGrace(e.target.value)}
            placeholder="30m, 1h"
            className="w-32 rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
          />
          <span className="text-keep-muted">
            When someone closes their tab or refreshes, they stay in the userlist faded out as "(idle)" for this long instead of vanishing. Inside the window, no connect/disconnect chat lines fire. The room they were in is also held open against archival. Min 30s, max 24h.
          </span>
        </div>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Limits & capacity</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <LimitField
            label="Max characters / user"
            hint="Per-account ceiling on character profiles."
            value={maxChars}
            onChange={setMaxChars}
            min={1}
            max={1000}
          />
          <LimitField
            label="Max accounts / email"
            hint="1 = traditional. Raise to allow shared/family accounts."
            value={maxEmail}
            onChange={setMaxEmail}
            min={1}
            max={50}
          />
          <LimitField
            label="Max rooms / owner"
            hint="Cap on user-created rooms a single user may own. 0 disables user-created rooms."
            value={maxRooms}
            onChange={setMaxRooms}
            min={0}
            max={1000}
          />
          <LimitField
            label="Max chat message length"
            hint="Hard cap on flat-chat body length (chars)."
            value={maxMsgLen}
            onChange={setMaxMsgLen}
            min={100}
            max={50_000}
          />
          <LimitField
            label="Max direct message length"
            hint="Hard cap on DM body length (chars). Independent from chat so private long-form conversations can have more room."
            value={maxDmLen}
            onChange={setMaxDmLen}
            min={100}
            max={50_000}
          />
          <LimitField
            label="Max forum post length"
            hint="Hard cap on forum topic + reply body length (chars) in nested rooms. Typically larger than chat to allow long-form posts."
            value={maxForumLen}
            onChange={setMaxForumLen}
            min={100}
            max={50_000}
          />
          <LimitField
            label="Max forum topic title length"
            hint="Hard cap on a forum topic title (chars). Kept short so titles stay list-renderable in the topic picker."
            value={maxForumTitleLen}
            onChange={setMaxForumTitleLen}
            min={10}
            max={500}
          />
          <LimitField
            label="Forum topics per page"
            hint="How many non-sticky topics appear on each page of a forum category's numbered pagination strip. Stickies stay on page 1 only and don't count against this. Default 20."
            value={forumTopicsPerPage}
            onChange={setForumTopicsPerPage}
            min={5}
            max={100}
          />
          <label className="text-xs">
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">
              Edit / delete window
            </span>
            <input
              type="text"
              value={editGrace}
              onChange={(e) => setEditGrace(e.target.value)}
              placeholder="5m"
              className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
            />
            <span className="mt-0.5 block text-[10px] text-keep-muted">
              How long after sending an author can edit / delete their own chat or DM message. Duration like 30s / 5m / 1h. 0 disables author edits entirely. Mods + admins always bypass this; forum posts are exempt and stay editable indefinitely.
            </span>
          </label>
          <LimitField
            label="Max bio length"
            hint="Hard cap on profile bio HTML (chars)."
            value={maxBioLen}
            onChange={setMaxBioLen}
            min={1000}
            max={200_000}
          />
          <label className="text-xs">
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">Registration</span>
            <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
              <input
                type="checkbox"
                checked={regOpen}
                onChange={(e) => setRegOpen(e.target.checked)}
              />
              <span>{regOpen ? "Open - anyone can register" : "Closed - login only"}</span>
            </div>
            <span className="mt-0.5 block text-[10px] text-keep-muted">
              When closed, /auth/register returns 503 and the login screen hides the Register tab.
            </span>
          </label>
          <label className="text-xs">
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">Activity feeds</span>
            <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
              <input
                type="checkbox"
                checked={activityFeedsEnabled}
                onChange={(e) => setActivityFeedsEnabled(e.target.checked)}
              />
              <span>{activityFeedsEnabled ? "On - splash shows live counters" : "Off - cold-start posture"}</span>
            </div>
            <span className="mt-0.5 block text-[10px] text-keep-muted">
              When off, the splash hides the "X users online" / room counters so an empty community doesn't telegraph "dead site" to first visitors. Flip on once there's a real pulse to surface.
            </span>
          </label>
          <label className="text-xs">
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">Messages in last 24h</span>
            <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
              <input
                type="checkbox"
                checked={splashMessages24hEnabled}
                onChange={(e) => setSplashMessages24hEnabled(e.target.checked)}
              />
              <span>{splashMessages24hEnabled ? "On - splash shows rolling 24h message count" : "Off - splash hides the 24h message stat"}</span>
            </div>
            <span className="mt-0.5 block text-[10px] text-keep-muted">
              Surfaces a rolling 24h chat-message count on the splash. Independent of Activity feeds, flip it on alone to show the message volume by itself, or pair with Activity feeds so it sits in the same row as the online/registered/room counters.
            </span>
          </label>
          <label className="text-xs">
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">Featured worlds carousel</span>
            <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
              <input
                type="checkbox"
                checked={featuredWorldsEnabled}
                onChange={(e) => setFeaturedWorldsEnabled(e.target.checked)}
              />
              <span>{featuredWorldsEnabled ? "On - splash rotates open worlds" : "Off - splash hides the carousel"}</span>
            </div>
            <span className="mt-0.5 block text-[10px] text-keep-muted">
              Splash page picks up to 10 random open worlds and rotates them as a "settings you can play in" strip. Off by default; the seeded defaults plus any community open worlds will fill the rotation once enabled.
            </span>
          </label>
          <label className="text-xs">
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">Profile bio Designer</span>
            <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
              <input
                type="checkbox"
                checked={profileDesignerEnabled}
                onChange={(e) => setProfileDesignerEnabled(e.target.checked)}
              />
              <span>{profileDesignerEnabled ? "On - bio tab offers a visual Designer (desktop)" : "Off - bio editor is raw HTML source only"}</span>
            </div>
            <span className="mt-0.5 block text-[10px] text-keep-muted">
              Adds a visual drag-and-drop Designer alongside the raw-HTML Source on the profile bio tab (desktop only). Off by default. Try it on your own profile before enabling site-wide; the Source view remains available either way.
            </span>
          </label>
          <label className="text-xs">
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">Multi-server</span>
            <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
              <input
                type="checkbox"
                checked={serversEnabled}
                onChange={(e) => setServersEnabled(e.target.checked)}
              />
              <span>{serversEnabled ? "On - server rail + join/create your own servers" : "Off - single-server chat (today's experience)"}</span>
            </div>
            <span className="mt-0.5 block text-[10px] text-keep-muted">
              Master switch for the multi-server feature: the round server-icon rail beside the userlist, the discover/create-a-server flow, and all per-server scoping. Off keeps the chat exactly as a single server. The SERVERS_KILL env var overrides this to off.
            </span>
          </label>
          <label className="text-xs">
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">Anti-spam</span>
            <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
              <input
                type="checkbox"
                checked={antiSpamEnabled}
                onChange={(e) => setAntiSpamEnabled(e.target.checked)}
              />
              <span>{antiSpamEnabled ? "On - rapid-fire floods get warned, then auto-muted" : "Off - no automatic spam throttling"}</span>
            </div>
            <span className="mt-0.5 block text-[10px] text-keep-muted">
              Catches rapid-fire message floods: after more than five messages in a few seconds a user gets a warning and a short, growing cooldown, then an automatic mute (5 minutes, growing on repeat offenders) after three warnings. Keeps a room from being blown out when no mod is around. Trusted users, mods, and admins are exempt via the bypass_anti_spam permission.
            </span>
          </label>
          <label className="text-xs">
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">Auto-moderation</span>
            <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
              <input
                type="checkbox"
                checked={automodEnabled}
                onChange={(e) => setAutomodEnabled(e.target.checked)}
              />
              <span>{automodEnabled ? "On - messages are checked against your rules below" : "Off - no content filtering (mature-RP safe)"}</span>
            </div>
            <span className="mt-0.5 block text-[10px] text-keep-muted">
              Master switch for content auto-moderation. When on, each message is checked against the rules below before it posts; a matching rule can warn (block the message), delete (silently drop it), or mute the sender. Off by default so mature roleplay isn't caught by surprise. Trusted users, mods, and admins are exempt via the bypass_automod permission. Manage rules and try sample text in the Auto-moderation section below.
            </span>
          </label>
        </div>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Default theme</legend>
        <p className="mb-2 text-keep-muted">
          Used when a user has no custom theme and no active character with a theme.
          Cleared (no override) means the built-in Parchment palette.
        </p>
        <ThemePicker
          theme={theme ?? DEFAULT_THEME}
          onChange={setTheme}
          onReset={() => setTheme(null)}
        />
        {!theme ? (
          <div className="mt-1 italic text-keep-muted">No site default - using built-in Parchment.</div>
        ) : null}
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Theme style</legend>
        <p className="mb-2 text-keep-muted">
          The fallback visual treatment (ornaments, borders, textures) for
          palettes that don't have a design pinned below. Orthogonal to
          the palette, picking a style doesn't change which colors are
          used, just how they're rendered. Users can override this on
          their master or character profile.
        </p>
        <StylePicker
          value={defaultStyleKey}
          // Admin requires a non-null value; if the user manages to
          // pick "(use site default)" (only shown with allowInherit)
          // fall through to the launch flagship.
          onChange={(k) => setDefaultStyleKey(k ?? "medieval")}
        />
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Designs by theme</legend>
        <p className="mb-2 text-keep-muted">
          Pin a design to each named palette. When a user (or character)
          picks one of these themes, they get the paired design unless
          they've explicitly overridden it on their profile. "Use site
          default" means that theme falls through to the Theme style
          above. Custom palettes (anything not matching one of these
          presets) always fall through.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {THEME_PRESETS.map((p) => (
            <label key={p.name} className="flex items-center gap-2">
              <span
                aria-hidden
                title={`Preview of ${p.name}'s palette`}
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

      {/* Save controls + status (incl. error) live in the modal
          footer via `useAdminShell().setFooter(...)` near the top of
          this component. No inline save row, keeps the form
          scrolling area focused on field editing. */}
    </form>

    {/* Auto-moderation rule management + test box. Self-contained
        (own fetch/state), lives OUTSIDE the settings <form> so its
        buttons never submit the settings save. The master toggle
        above (Auto-moderation) enables/disables enforcement; these
        rules define WHAT gets caught. */}
    <AutomodRulesCard canEdit={canEditSiteSettings} />
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

const AUTOMOD_KIND_LABELS: Record<AutomodRule["kind"], string> = {
  keyword: "Keyword",
  regex: "Regex",
  link: "Any link",
  invite: "Invite link",
  mention_cap: "Mention cap",
};
const AUTOMOD_ACTION_LABELS: Record<AutomodRule["action"], string> = {
  warn: "Warn (block message)",
  delete: "Delete (silent)",
  mute: "Mute sender",
};
const AUTOMOD_SCOPE_LABELS: Record<AutomodRule["scope"], string> = {
  chat: "Chat only",
  forum: "Forum only",
  both: "Chat + forum",
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
      setErr(e instanceof Error ? e.message : "load failed");
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
        throw new Error("Mute length must be at least 1 minute (or blank for the default).");
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
      setErr(e instanceof Error ? e.message : "save failed");
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
      setErr(e instanceof Error ? e.message : "update failed");
    }
  }

  async function deleteRule(rule: AutomodRule) {
    // eslint-disable-next-line no-alert
    if (!window.confirm("Delete this auto-moderation rule?")) return;
    setErr(null);
    try {
      const r = await fetch(`/admin/automod/rules/${rule.id}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      await loadRules();
      if (editingId === rule.id) cancelEdit();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "delete failed");
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
      setErr(e instanceof Error ? e.message : "test failed");
    }
  }

  const inputCls = "rounded border border-keep-rule bg-keep-bg px-2 py-1";

  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">Auto-moderation rules</legend>
      <p className="mb-2 text-keep-muted">
        Rules checked against each message when Auto-moderation is on (toggle above). A rule can warn (block the message with a notice), delete it silently, or mute the sender. Trusted users, mods, and admins are always exempt. Off by default so mature roleplay isn't caught by surprise, use the test box below to blunt false positives before enabling.
      </p>

      {err ? <div className="mb-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-red-300">{err}</div> : null}

      {/* Rule list */}
      <div className="mb-3 space-y-1">
        {!loaded ? (
          <div className="text-keep-muted">loading rules...</div>
        ) : rules.length === 0 ? (
          <div className="italic text-keep-muted">No rules yet. Add one below.</div>
        ) : (
          rules.map((rule) => (
            <div
              key={rule.id}
              className={`flex flex-wrap items-center gap-2 rounded border border-keep-rule px-2 py-1 ${rule.enabled ? "" : "opacity-50"}`}
            >
              <span className="rounded bg-keep-panel px-1.5 py-0.5 font-semibold">{AUTOMOD_KIND_LABELS[rule.kind]}</span>
              {rule.kind !== "link" && rule.kind !== "invite" ? (
                <code className="max-w-[16rem] truncate rounded bg-keep-bg px-1">{rule.pattern || "(empty)"}</code>
              ) : null}
              <span className="text-keep-muted">→</span>
              <span>{AUTOMOD_ACTION_LABELS[rule.action]}</span>
              <span className="text-keep-muted">·</span>
              <span className="text-keep-muted">{AUTOMOD_SCOPE_LABELS[rule.scope]}</span>
              {rule.note ? <span className="text-keep-muted">· {rule.note}</span> : null}
              <span className="ml-auto flex items-center gap-2">
                {canEdit ? (
                  <>
                    <button type="button" className="underline" onClick={() => toggleRule(rule)}>
                      {rule.enabled ? "Disable" : "Enable"}
                    </button>
                    <button type="button" className="underline" onClick={() => startEdit(rule)}>Edit</button>
                    <button type="button" className="text-red-400 underline" onClick={() => deleteRule(rule)}>Delete</button>
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
            {editingId ? "Edit rule" : "Add rule"}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-keep-muted">Match on</span>
              <select
                className={inputCls}
                value={draft.kind}
                onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value as AutomodRule["kind"] }))}
              >
                {(Object.keys(AUTOMOD_KIND_LABELS) as AutomodRule["kind"][]).map((k) => (
                  <option key={k} value={k}>{AUTOMOD_KIND_LABELS[k]}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-keep-muted">Action</span>
              <select
                className={inputCls}
                value={draft.action}
                onChange={(e) => setDraft((d) => ({ ...d, action: e.target.value as AutomodRule["action"] }))}
              >
                {(Object.keys(AUTOMOD_ACTION_LABELS) as AutomodRule["action"][]).map((a) => (
                  <option key={a} value={a}>{AUTOMOD_ACTION_LABELS[a]}</option>
                ))}
              </select>
            </label>
            {!patternless ? (
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className="text-keep-muted">
                  {draft.kind === "mention_cap" ? "Max @mentions allowed" : draft.kind === "regex" ? "Regular expression" : "Word or phrase"}
                </span>
                <input
                  className={`${inputCls} font-mono`}
                  value={draft.pattern}
                  placeholder={draft.kind === "mention_cap" ? "e.g. 5" : draft.kind === "regex" ? "e.g. \\bbad(word)?\\b" : "e.g. spoiler"}
                  onChange={(e) => setDraft((d) => ({ ...d, pattern: e.target.value }))}
                />
              </label>
            ) : (
              <div className="sm:col-span-2 text-keep-muted italic">
                {draft.kind === "link" ? "Matches any http/https link in the message." : "Matches common chat/forum/other-service invite links."}
              </div>
            )}
            <label className="flex flex-col gap-1">
              <span className="text-keep-muted">Applies to</span>
              <select
                className={inputCls}
                value={draft.scope}
                onChange={(e) => setDraft((d) => ({ ...d, scope: e.target.value as AutomodRule["scope"] }))}
              >
                {(Object.keys(AUTOMOD_SCOPE_LABELS) as AutomodRule["scope"][]).map((s) => (
                  <option key={s} value={s}>{AUTOMOD_SCOPE_LABELS[s]}</option>
                ))}
              </select>
            </label>
            {draft.action === "mute" ? (
              <label className="flex flex-col gap-1">
                <span className="text-keep-muted">Mute length (minutes)</span>
                <input
                  className={inputCls}
                  value={draft.muteMinutes}
                  placeholder="blank = default (10)"
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
                  <span>Ignore case</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.wholeWord}
                    onChange={(e) => setDraft((d) => ({ ...d, wholeWord: e.target.checked }))}
                  />
                  <span>Whole word only</span>
                </label>
              </>
            ) : draft.kind === "regex" ? (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.caseInsensitive}
                  onChange={(e) => setDraft((d) => ({ ...d, caseInsensitive: e.target.checked }))}
                />
                <span>Ignore case</span>
              </label>
            ) : null}
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-keep-muted">Note (optional)</span>
              <input
                className={inputCls}
                value={draft.note}
                placeholder="Why this rule exists"
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
              {editingId ? "Save rule" : "Add rule"}
            </button>
            {editingId ? (
              <button type="button" onClick={cancelEdit} className="underline text-keep-muted">Cancel</button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Test box */}
      <div className="rounded border border-keep-rule bg-keep-bg/40 p-2">
        <div className="mb-2 font-semibold uppercase tracking-widest text-keep-muted">Test a message</div>
        <p className="mb-2 text-keep-muted">
          Paste sample text to see which enabled rules would fire (and the resulting action). Nothing is saved or posted.
        </p>
        <textarea
          className={`${inputCls} w-full font-mono`}
          rows={3}
          value={testText}
          placeholder="Type or paste a message to test..."
          onChange={(e) => setTestText(e.target.value)}
        />
        <div className="mt-2 flex items-center gap-2">
          <select
            className={inputCls}
            value={testSurface}
            onChange={(e) => setTestSurface(e.target.value as "chat" | "forum")}
          >
            <option value="chat">As chat</option>
            <option value="forum">As forum post</option>
          </select>
          <button
            type="button"
            onClick={runTest}
            className="rounded border border-keep-rule bg-keep-panel px-3 py-1 font-semibold"
          >
            Run test
          </button>
        </div>
        {testResult ? (
          <div className="mt-2">
            {testResult.hits.length === 0 ? (
              <div className="text-green-400">No rules fired, this message would post.</div>
            ) : (
              <>
                <div className="mb-1">
                  Resulting action: <span className="font-semibold">{testResult.action ? AUTOMOD_ACTION_LABELS[testResult.action] : "none"}</span>
                </div>
                <ul className="list-disc pl-5 text-keep-muted">
                  {testResult.hits.map((h, i) => (
                    <li key={`${h.ruleId}-${i}`}>
                      {AUTOMOD_KIND_LABELS[h.kind]} ({AUTOMOD_ACTION_LABELS[h.action]}): <code>{h.label}</code>
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
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  min: number;
  max: number;
}) {
  return (
    <label className="text-xs">
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
