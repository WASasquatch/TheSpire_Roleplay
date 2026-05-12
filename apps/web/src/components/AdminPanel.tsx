import { useEffect, useState, type FormEvent } from "react";
import DOMPurify from "dompurify";
import type { AuditEntry, ReportEntry, Role, Theme, ThreadCategory } from "@thekeep/shared";
import { DEFAULT_THEME, normalizeTheme } from "@thekeep/shared";
import { readError } from "../lib/http.js";
import { listStyles } from "../lib/ornaments/index.js";
import { Modal } from "./Modal.js";
import { ThemePicker } from "./ThemePicker.js";
import { useChat } from "../state/store.js";

interface Props {
  onClose: () => void;
  /** Bumped after any change so the banner re-fetches. */
  onLinksChanged: () => void;
}

type Tab = "overview" | "settings" | "branding" | "rules" | "links" | "affiliates" | "rooms" | "commands" | "titles" | "users" | "reports" | "audit";

export function AdminPanel({ onClose, onLinksChanged }: Props) {
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <Modal onClose={onClose} zIndex={50}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="keep-frame max-h-[92vh] w-[min(900px,95vw)] overflow-hidden rounded bg-keep-parchment"
      >
        <div className="flex items-center justify-between border-b border-keep-rule bg-keep-banner px-4 py-2">
          <div className="flex items-center gap-3">
            <h2 className="font-action text-lg">Admin</h2>
            <nav className="flex gap-1 text-xs uppercase tracking-widest">
              <TabBtn active={tab === "overview"} onClick={() => setTab("overview")}>Overview</TabBtn>
              <TabBtn active={tab === "settings"} onClick={() => setTab("settings")}>Settings</TabBtn>
              <TabBtn active={tab === "branding"} onClick={() => setTab("branding")}>Branding</TabBtn>
              <TabBtn active={tab === "rules"} onClick={() => setTab("rules")}>Rules</TabBtn>
              <TabBtn active={tab === "links"} onClick={() => setTab("links")}>Nav Links</TabBtn>
              <TabBtn active={tab === "affiliates"} onClick={() => setTab("affiliates")}>Affiliates</TabBtn>
              <TabBtn active={tab === "commands"} onClick={() => setTab("commands")}>Commands</TabBtn>
              <TabBtn active={tab === "titles"} onClick={() => setTab("titles")}>Titles</TabBtn>
              <TabBtn active={tab === "rooms"} onClick={() => setTab("rooms")}>Rooms</TabBtn>
              <TabBtn active={tab === "users"} onClick={() => setTab("users")}>Users</TabBtn>
              <TabBtn active={tab === "reports"} onClick={() => setTab("reports")}>Reports</TabBtn>
              <TabBtn active={tab === "audit"} onClick={() => setTab("audit")}>Audit</TabBtn>
            </nav>
          </div>
          <button onClick={onClose} className="text-sm text-keep-muted hover:text-keep-text">
            close
          </button>
        </div>

        <div className="max-h-[78vh] overflow-y-auto p-4">
          {tab === "overview" ? <OverviewTab /> : null}
          {tab === "settings" ? <SettingsTab /> : null}
          {tab === "branding" ? <BrandingTab /> : null}
          {tab === "rules" ? <RulesTab /> : null}
          {tab === "links" ? <LinksTab onLinksChanged={onLinksChanged} /> : null}
          {tab === "affiliates" ? <AffiliatesTab /> : null}
          {tab === "commands" ? <CommandsTab /> : null}
          {tab === "titles" ? <TitleKindsTab /> : null}
          {tab === "rooms" ? <RoomsTab /> : null}
          {tab === "users" ? <UsersTab /> : null}
          {tab === "reports" ? <ReportsTab /> : null}
          {tab === "audit" ? <AuditTab /> : null}
        </div>
      </div>
    </Modal>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border border-keep-rule px-2 py-0.5 ${active ? "bg-keep-bg" : "bg-keep-banner/40 hover:bg-keep-banner"}`}
    >
      {children}
    </button>
  );
}

/**
 * Shared style-key picker. Reads available styles from the ornaments
 * registry so the catalog stays single-sourced — adding a style file
 * automatically surfaces it here without UI changes.
 *
 * Caller controls value semantics:
 *  - Admin: required, defaults to "medieval"
 *  - Profile: nullable; null means "follow site default", represented
 *    by the empty-string sentinel in the <select>.
 */
export function StylePicker({
  value,
  onChange,
  allowInherit = false,
}: {
  value: string | null;
  onChange: (key: string | null) => void;
  /** When true, prepend a "(use site default)" option whose value is null. */
  allowInherit?: boolean;
}) {
  const styles = listStyles();
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
    >
      {allowInherit ? (
        <option value="">(use site default)</option>
      ) : null}
      {styles.map((s) => (
        <option key={s.key} value={s.key}>{s.label}</option>
      ))}
    </select>
  );
}

/* =============================================================
 * NAV LINKS TAB
 * ============================================================= */

interface NavLinkRow {
  id: string;
  label: string;
  href: string;
  target: "_self" | "_blank";
  position: number;
  enabled: boolean;
}

interface NavLinkInput {
  label: string;
  href: string;
  position?: number;
  enabled?: boolean;
  target?: "_self" | "_blank";
}

/* =============================================================
 * SETTINGS TAB
 * ============================================================= */

interface SettingsRow {
  messageRetentionMs: number;
  sessionTtlMs: number;
  defaultThemeJson: string | null;
  defaultTheme: Theme;
  siteName: string;
  bannerCoverCss: string | null;
  logoColor: string | null;
  logoFont: string | null;
  maxCharactersPerUser: number;
  maxAccountsPerEmail: number;
  maxRoomsPerOwner: number;
  maxMessageLength: number;
  maxBioLength: number;
  registrationOpen: boolean;
  welcomeHtml: string;
  rulesHtml: string;
  securityNoticeHtml: string;
  registerDisclaimerHtml: string;
  metaDescription: string;
  customHeadHtml: string;
  activityFeedsEnabled: boolean;
  featuredWorldsEnabled: boolean;
  /** Sanitized HTML for the post-login welcome modal. "" = no welcome shown. */
  newUserWelcomeHtml: string;
  /** Site-wide default theme style key. Users without an override inherit this. */
  defaultStyleKey: string;
  updatedAt: number;
}

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

/** Inverse of formatMs. Accepts "5m", "1h20m", "30d", or a bare number = ms. */
function parseDurationMs(s: string): number | null {
  const trimmed = s.trim();
  if (trimmed === "" || trimmed === "0") return 0;
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  let total = 0;
  let any = false;
  const re = /(\d+)\s*([smhd])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    any = true;
    const n = parseInt(m[1] ?? "0", 10);
    const unit = (m[2] ?? "").toLowerCase();
    const ms = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000;
    total += n * ms;
  }
  return any ? total : null;
}

/* =============================================================
 * OVERVIEW TAB
 * =============================================================
 *
 * Admin dashboard. Polls /admin/overview every 30s and renders a card
 * grid of headline counters plus a 7-day daily-series block covering
 * messages, topics, logins, and registrations. Distinct from the public
 * /stats endpoint — this one carries DAU/WAU/MAU, moderation volume,
 * and per-day login/registration counts that aren't appropriate for
 * the anonymous splash view.
 */

interface OverviewDayPoint {
  day: string;
  count: number;
}

interface AdminOverview {
  online: number;
  users: {
    total: number;
    newLast7d: number;
    newLast30d: number;
    dau: number;
    wau: number;
    mau: number;
  };
  rooms: { public: number; private: number; total: number };
  messages: { last24h: number; last7d: number; last30d: number };
  forum: { topics: number; replies: number; topicsLast7d: number; repliesLast7d: number };
  content: { characters: number; worlds: number };
  moderation: { reportsLast7d: number; auditLast7d: number };
  series: {
    messages: OverviewDayPoint[];
    topics: OverviewDayPoint[];
    logins: OverviewDayPoint[];
    registrations: OverviewDayPoint[];
  };
}

function OverviewTab() {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/admin/overview", { credentials: "include" });
        if (!r.ok) throw new Error(await readError(r));
        const j = (await r.json()) as AdminOverview;
        if (!cancelled) { setData(j); setError(null); }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "load failed");
      }
    }
    load();
    const id = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  if (!data) {
    return <div className="text-keep-muted text-xs">{error ?? "loading..."}</div>;
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-keep-muted">
        Live snapshot of activity across the site. Auto-refreshes every 30 seconds.
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <OverviewCard title="Online now" hint="Connected sockets, deduped per user.">
          <BigStat value={data.online} accent={data.online > 0} />
        </OverviewCard>

        <OverviewCard title="Registered users" hint="Total accounts, excluding the system sentinel.">
          <BigStat value={data.users.total} />
          <SubStats items={[
            { label: "new 7d", value: data.users.newLast7d },
            { label: "new 30d", value: data.users.newLast30d },
          ]} />
        </OverviewCard>

        <OverviewCard title="Active users" hint="Distinct logins inside each window. Older buckets undercount if session TTL is shorter than the window.">
          <SubStats items={[
            { label: "DAU", value: data.users.dau },
            { label: "WAU", value: data.users.wau },
            { label: "MAU", value: data.users.mau },
          ]} />
        </OverviewCard>

        <OverviewCard title="Rooms" hint="Public chambers + private rooms.">
          <BigStat value={data.rooms.total} />
          <SubStats items={[
            { label: "public", value: data.rooms.public },
            { label: "private", value: data.rooms.private },
          ]} />
        </OverviewCard>

        <OverviewCard title="Chat messages" hint="Chat volume, excludes presence/system rows and soft-deleted messages.">
          <SubStats items={[
            { label: "24h", value: data.messages.last24h },
            { label: "7d", value: data.messages.last7d },
            { label: "30d", value: data.messages.last30d },
          ]} />
        </OverviewCard>

        <OverviewCard title="Forum activity" hint="Topics and replies across all nested-mode rooms.">
          <SubStats items={[
            { label: "topics", value: data.forum.topics },
            { label: "replies", value: data.forum.replies },
            { label: "topics 7d", value: data.forum.topicsLast7d },
            { label: "replies 7d", value: data.forum.repliesLast7d },
          ]} />
        </OverviewCard>

        <OverviewCard title="Content" hint="User-authored material across the site.">
          <SubStats items={[
            { label: "characters", value: data.content.characters },
            { label: "worlds", value: data.content.worlds },
          ]} />
        </OverviewCard>

        <OverviewCard title="Moderation (7d)" hint="Reports filed and audit-log actions in the last week.">
          <SubStats items={[
            { label: "reports", value: data.moderation.reportsLast7d },
            { label: "audit", value: data.moderation.auditLast7d },
          ]} />
        </OverviewCard>
      </div>

      <fieldset className="rounded border border-keep-rule p-3">
        <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">This week</legend>
        <div className="space-y-2">
          <SparklineRow label="Messages" series={data.series.messages} colorClass="bg-keep-action/70" />
          <SparklineRow label="Topics" series={data.series.topics} colorClass="bg-keep-accent/70" />
          <SparklineRow label="Logins" series={data.series.logins} colorClass="bg-keep-action/70" />
          <SparklineRow label="Registrations" series={data.series.registrations} colorClass="bg-keep-accent/70" />
          <SparklineAxis days={data.series.messages.map((d) => d.day)} />
        </div>
      </fieldset>

      {error ? <div className="text-xs text-keep-accent">{error}</div> : null}
    </div>
  );
}

function OverviewCard({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded border border-keep-rule p-3" title={hint}>
      <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">{title}</legend>
      <div className="space-y-2">{children}</div>
    </fieldset>
  );
}

function BigStat({ value, accent }: { value: number; accent?: boolean }) {
  return (
    <div className={`text-2xl font-semibold tabular-nums ${accent ? "text-keep-action" : "text-keep-text"}`}>
      {value.toLocaleString()}
    </div>
  );
}

function SubStats({ items }: { items: { label: string; value: number }[] }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
      {items.map((it) => (
        <div key={it.label} className="flex items-baseline gap-1.5">
          <span className="font-semibold tabular-nums text-keep-text">{it.value.toLocaleString()}</span>
          <span className="text-keep-muted">{it.label}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * One labeled sparkline row in the "This week" panel. The plot area is a
 * fixed-height (`h-8`) box so every row occupies the same vertical extent
 * regardless of its peak — otherwise quiet rows shrink and busy rows grow
 * and the panel gets a ragged baseline. Per-day date labels live once at
 * the bottom in `SparklineAxis` rather than under every row.
 */
function SparklineRow({ label, series, colorClass }: { label: string; series: OverviewDayPoint[]; colorClass: string }) {
  if (series.length === 0) return null;
  const max = Math.max(1, ...series.map((d) => d.count));
  const total = series.reduce((s, d) => s + d.count, 0);
  return (
    <div
      className="grid items-center gap-2 text-xs sm:grid-cols-[110px_1fr_64px]"
      title={`${total.toLocaleString()} this week`}
    >
      <span className="uppercase tracking-widest text-keep-muted">{label}</span>
      <div className="flex h-8 items-end gap-1">
        {series.map((d) => {
          // Floor each bar at 2px so a zero-day still reads as a visible
          // "no traffic" baseline instead of vanishing into the row.
          const h = Math.max(2, Math.round((d.count / max) * 28));
          return (
            <div
              key={d.day}
              className="flex flex-1 items-end"
              title={`${d.day}: ${d.count.toLocaleString()}`}
            >
              <div className={`${colorClass} w-full rounded-sm`} style={{ height: `${h}px` }} />
            </div>
          );
        })}
      </div>
      <span className="text-right font-semibold tabular-nums text-keep-text">
        {total.toLocaleString()}
      </span>
    </div>
  );
}

function SparklineAxis({ days }: { days: string[] }) {
  return (
    <div className="grid gap-2 text-[9px] sm:grid-cols-[110px_1fr_64px]">
      <span aria-hidden />
      <div className="flex gap-1">
        {days.map((d) => (
          <span key={d} className="flex-1 text-center tabular-nums text-keep-muted">
            {d.slice(5)}
          </span>
        ))}
      </div>
      <span aria-hidden />
    </div>
  );
}

function SettingsTab() {
  const setBranding = useChat((s) => s.setBranding);
  const [data, setData] = useState<SettingsRow | null>(null);
  const [retention, setRetention] = useState("");
  const [sessionTtl, setSessionTtl] = useState("");
  const [theme, setTheme] = useState<Theme | null>(null);
  const [maxChars, setMaxChars] = useState("");
  const [maxEmail, setMaxEmail] = useState("");
  const [maxRooms, setMaxRooms] = useState("");
  const [maxMsgLen, setMaxMsgLen] = useState("");
  const [maxBioLen, setMaxBioLen] = useState("");
  const [regOpen, setRegOpen] = useState(true);
  const [activityFeedsEnabled, setActivityFeedsEnabled] = useState(false);
  const [featuredWorldsEnabled, setFeaturedWorldsEnabled] = useState(false);
  const [defaultStyleKey, setDefaultStyleKey] = useState<string>("medieval");
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
      setTheme(j.defaultThemeJson ? normalizeTheme(JSON.parse(j.defaultThemeJson)) : null);
      setMaxChars(String(j.maxCharactersPerUser));
      setMaxEmail(String(j.maxAccountsPerEmail));
      setMaxRooms(String(j.maxRoomsPerOwner));
      setMaxMsgLen(String(j.maxMessageLength));
      setMaxBioLen(String(j.maxBioLength));
      setRegOpen(j.registrationOpen);
      setActivityFeedsEnabled(j.activityFeedsEnabled);
      setFeaturedWorldsEnabled(j.featuredWorldsEnabled);
      setDefaultStyleKey(j.defaultStyleKey || "medieval");
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
      const retentionMs = parseDurationMs(retention);
      const ttlMs = parseDurationMs(sessionTtl);
      if (retentionMs === null) throw new Error("retention must be a duration like 30d (or 0 for never)");
      if (ttlMs === null || ttlMs < 5 * 60 * 1000) throw new Error("session TTL must be at least 5m");
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
        maxCharactersPerUser: intOrThrow("Max characters/user", maxChars, 1, 1000),
        maxAccountsPerEmail: intOrThrow("Max accounts/email", maxEmail, 1, 50),
        maxRoomsPerOwner: intOrThrow("Max rooms/owner", maxRooms, 0, 1000),
        maxMessageLength: intOrThrow("Max message length", maxMsgLen, 100, 50_000),
        maxBioLength: intOrThrow("Max bio length", maxBioLen, 1000, 200_000),
        registrationOpen: regOpen,
        activityFeedsEnabled,
        featuredWorldsEnabled,
        defaultStyleKey,
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
        bannerCoverCss: j.bannerCoverCss,
        logoColor: j.logoColor,
        logoFont: j.logoFont,
        registrationOpen: j.registrationOpen,
        welcomeHtml: j.welcomeHtml,
        registerDisclaimerHtml: j.registerDisclaimerHtml,
        messageRetentionMs: j.messageRetentionMs,
        sessionTtlMs: j.sessionTtlMs,
        defaultTheme: j.defaultTheme,
        activityFeedsEnabled: j.activityFeedsEnabled,
        featuredWorldsEnabled: j.featuredWorldsEnabled,
        defaultStyleKey: j.defaultStyleKey,
      });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  if (!data) {
    return <div className="text-keep-muted text-xs">{error ?? "loading..."}</div>;
  }

  return (
    <form onSubmit={save} className="space-y-4">
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
            label="Max message length"
            hint="Hard cap on chat body length (chars)."
            value={maxMsgLen}
            onChange={setMaxMsgLen}
            min={100}
            max={50_000}
          />
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
          The site-wide visual treatment (ornaments, borders, textures).
          Orthogonal to the palette above — picking a style doesn't change
          which colors are used, just how they're rendered. Users can
          override this in their profile.
        </p>
        <StylePicker
          value={defaultStyleKey}
          // Admin requires a non-null value; if the user manages to
          // pick "(use site default)" (only shown with allowInherit)
          // fall through to the launch flagship.
          onChange={(k) => setDefaultStyleKey(k ?? "medieval")}
        />
      </fieldset>

      {error ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
      ) : null}

      <div className="flex items-center justify-between">
        <span className={`text-xs ${savedFlash ? "text-keep-system" : "text-keep-muted"}`}>
          {savedFlash ? "Saved." : `Last updated ${new Date(data.updatedAt).toLocaleString()}`}
        </span>
        <button
          type="submit"
          disabled={saving}
          className="keep-button rounded border border-keep-rule bg-keep-banner px-4 py-1 text-xs disabled:opacity-50 hover:bg-keep-banner/80"
        >
          {saving ? "Saving..." : "Save settings"}
        </button>
      </div>
    </form>
  );
}

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
  bannerCoverCss: string;
  logoColor: string;
  logoFont: string;
  welcomeHtml: string;
  metaDescription: string;
  customHeadHtml: string;
}

function BrandingTab() {
  const setBranding = useChat((s) => s.setBranding);
  const [data, setData] = useState<SettingsRow | null>(null);
  const [draft, setDraft] = useState<BrandingDraft | null>(null);
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
      setDraft({
        siteName: j.siteName,
        bannerCoverCss: j.bannerCoverCss ?? "",
        logoColor: j.logoColor ?? "",
        logoFont: j.logoFont ?? "",
        welcomeHtml: j.welcomeHtml ?? "",
        metaDescription: j.metaDescription ?? "",
        customHeadHtml: j.customHeadHtml ?? "",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
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
        // Empty strings clear the override (sent as null).
        bannerCoverCss: draft.bannerCoverCss.trim() === "" ? null : draft.bannerCoverCss.trim(),
        logoColor: draft.logoColor.trim() === "" ? null : draft.logoColor.trim(),
        logoFont: draft.logoFont.trim() === "" ? null : draft.logoFont.trim(),
        // welcomeHtml is sanitized server-side; empty stays empty (no rendering).
        welcomeHtml: draft.welcomeHtml,
        // metaDescription is plain text; server collapses internal whitespace.
        metaDescription: draft.metaDescription,
        // customHeadHtml is admin-trusted raw HTML (analytics scripts) - the
        // server stores it verbatim without sanitization.
        customHeadHtml: draft.customHeadHtml,
      };
      if (body.logoColor && !/^#[0-9a-fA-F]{6}$/.test(body.logoColor as string)) {
        throw new Error("Logo color must be a 6-digit hex like #2c5d2c (or empty to clear).");
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
        bannerCoverCss: j.bannerCoverCss,
        logoColor: j.logoColor,
        logoFont: j.logoFont,
        registrationOpen: j.registrationOpen,
        welcomeHtml: j.welcomeHtml,
        registerDisclaimerHtml: j.registerDisclaimerHtml,
        messageRetentionMs: j.messageRetentionMs,
        sessionTtlMs: j.sessionTtlMs,
        defaultTheme: j.defaultTheme,
        activityFeedsEnabled: j.activityFeedsEnabled,
        featuredWorldsEnabled: j.featuredWorldsEnabled,
        defaultStyleKey: j.defaultStyleKey,
      });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  if (!data || !draft) {
    return <div className="text-keep-muted text-xs">{error ?? "loading..."}</div>;
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <p className="text-xs text-keep-muted">
        Public branding shown to every user (including the login screen).
        Changes apply immediately for everyone after save.
      </p>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Site name</legend>
        <input
          type="text"
          value={draft.siteName}
          onChange={(e) => setDraft({ ...draft, siteName: e.target.value })}
          maxLength={60}
          placeholder="The Spire"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
        />
        <p className="mt-1 text-keep-muted">
          Shown in the banner, login screen, BootSplash, and tab title.
          Empty falls back to <code>The Spire</code>.
        </p>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Banner cover</legend>
        <textarea
          value={draft.bannerCoverCss}
          onChange={(e) => setDraft({ ...draft, bannerCoverCss: e.target.value })}
          rows={2}
          maxLength={1000}
          placeholder='e.g. url("https://example.com/banner.jpg") center/cover no-repeat'
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          Full CSS <code>background</code> shorthand applied behind the logo
          text. Accepts <code>url()</code>, <code>linear-gradient(...)</code>,
          a solid color, etc. Leave empty to use the theme's panel color.
        </p>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Logo color</legend>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={draft.logoColor || "#1a1a1a"}
            onChange={(e) => setDraft({ ...draft, logoColor: e.target.value })}
            className="h-8 w-10 cursor-pointer rounded border border-keep-rule"
            aria-label="Logo color"
          />
          <input
            type="text"
            value={draft.logoColor}
            onChange={(e) => setDraft({ ...draft, logoColor: e.target.value })}
            placeholder="(empty = inherit theme text color)"
            maxLength={7}
            pattern="^#[0-9a-fA-F]{6}$|^$"
            className="flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
          />
          <button
            type="button"
            onClick={() => setDraft({ ...draft, logoColor: "" })}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-keep-muted hover:text-keep-text"
            title="Clear - logo follows the active theme."
          >
            Clear
          </button>
        </div>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Logo font</legend>
        <input
          type="text"
          value={draft.logoFont}
          onChange={(e) => setDraft({ ...draft, logoFont: e.target.value })}
          maxLength={200}
          placeholder='e.g. "Cinzel", "Georgia", serif'
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          A CSS <code>font-family</code> stack. Web fonts must be self-hosted
          or loaded via <code>@import</code> in your stylesheet - this field
          only changes the family name, not the loading. Empty to use the
          built-in serif stack.
        </p>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Welcome message</legend>
        <textarea
          value={draft.welcomeHtml}
          onChange={(e) => setDraft({ ...draft, welcomeHtml: e.target.value })}
          rows={6}
          maxLength={50_000}
          placeholder="<p>Welcome to <b>The Spire</b> - a roleplay-focused chat sanctuary.</p>&#10;<p>Sign in to enter, or register a new account.</p>"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          HTML rendered above the splash login/register form. Sanitized
          server-side using the same allow-list as profile bios - basic
          formatting tags, links, lists, and headings (h3-h6) are accepted.
          Empty hides the welcome block entirely.
        </p>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">SEO description</legend>
        <textarea
          value={draft.metaDescription}
          onChange={(e) => setDraft({ ...draft, metaDescription: e.target.value })}
          rows={3}
          maxLength={500}
          placeholder="A roleplay-focused chat sanctuary. Build characters, share scenes, and tell collaborative stories with other writers."
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
        />
        <p className="mt-1 text-keep-muted">
          Plain-text description used in <code>&lt;meta name="description"&gt;</code>
          and the OG / Twitter card. Search engines typically display the
          first ~155 characters. Empty falls back to the welcome message
          stripped to text.
          <span className="ml-1 tabular-nums">
            ({draft.metaDescription.length}/500)
          </span>
        </p>
      </fieldset>

      <fieldset className="rounded border border-keep-accent/40 bg-keep-accent/5 p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-accent">
          Custom head HTML (analytics)
        </legend>
        <textarea
          value={draft.customHeadHtml}
          onChange={(e) => setDraft({ ...draft, customHeadHtml: e.target.value })}
          rows={6}
          maxLength={20_000}
          spellCheck={false}
          placeholder={`<!-- Plausible -->\n<script defer data-domain="example.com" src="https://plausible.io/js/script.js"></script>\n\n<!-- or Google Analytics, Cloudflare Web Analytics, Umami, etc. -->`}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-accent/80">
          <b>Raw HTML, not sanitized.</b> Pasted verbatim into <code>&lt;head&gt;</code>
          on every splash response so analytics fire before React mounts.
          Anything you put here ships to every visitor on first paint -
          double-check the snippet from your provider's dashboard before saving.
        </p>
      </fieldset>

      {/* Live preview */}
      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Preview</legend>
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
            preview
          </span>
        </div>
      </fieldset>

      {error ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
      ) : null}

      <div className="flex items-center justify-between">
        <span className={`text-xs ${savedFlash ? "text-keep-system" : "text-keep-muted"}`}>
          {savedFlash ? "Saved." : `Last updated ${new Date(data.updatedAt).toLocaleString()}`}
        </span>
        <button
          type="submit"
          disabled={saving}
          className="keep-button rounded border border-keep-rule bg-keep-banner px-4 py-1 text-xs disabled:opacity-50 hover:bg-keep-banner/80"
        >
          {saving ? "Saving..." : "Save branding"}
        </button>
      </div>
    </form>
  );
}

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
function RulesTab() {
  const setBranding = useChat((s) => s.setBranding);
  const [data, setData] = useState<SettingsRow | null>(null);
  const [rulesHtml, setRulesHtml] = useState("");
  const [securityHtml, setSecurityHtml] = useState("");
  const [disclaimerHtml, setDisclaimerHtml] = useState("");
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
      setWelcomeHtml(j.newUserWelcomeHtml ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
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
      setWelcomeHtml(j.newUserWelcomeHtml ?? "");
      // The disclaimer is part of public branding (consumed by AuthGate); push
      // the new copy into the store so other open tabs / the splash see it
      // without waiting for the next /site fetch.
      setBranding({
        siteName: j.siteName,
        bannerCoverCss: j.bannerCoverCss,
        logoColor: j.logoColor,
        logoFont: j.logoFont,
        registrationOpen: j.registrationOpen,
        welcomeHtml: j.welcomeHtml,
        registerDisclaimerHtml: j.registerDisclaimerHtml,
        messageRetentionMs: j.messageRetentionMs,
        sessionTtlMs: j.sessionTtlMs,
        defaultTheme: j.defaultTheme,
        activityFeedsEnabled: j.activityFeedsEnabled,
        featuredWorldsEnabled: j.featuredWorldsEnabled,
        defaultStyleKey: j.defaultStyleKey,
      });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  if (!data) {
    return <div className="text-keep-muted text-xs">{error ?? "loading..."}</div>;
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <p className="text-xs text-keep-muted">
        Rules and the privacy notice shown when users click the Rules button.
        Both fields accept the same HTML allow-list as profile bios - formatting
        tags, links, lists, and headings (h3-h6).
      </p>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">House rules</legend>
        <textarea
          value={rulesHtml}
          onChange={(e) => setRulesHtml(e.target.value)}
          rows={14}
          maxLength={50_000}
          placeholder="<h3>House Rules</h3><ol><li>...</li></ol>"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          Free-form RP house rules. Defaults seed an 8-point baseline covering
          consent, godmodding, OOC/IC separation, and reporting.
        </p>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Privacy &amp; safety notice</legend>
        <textarea
          value={securityHtml}
          onChange={(e) => setSecurityHtml(e.target.value)}
          rows={8}
          maxLength={10_000}
          placeholder="<h3>Privacy &amp; Safety</h3><p>...</p>"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          Shown alongside the rules. Defaults explain the privacy contract:
          admins cannot read private/whispered messages, so users should
          self-govern and report problems with screenshots.
        </p>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Registration disclaimer</legend>
        <textarea
          value={disclaimerHtml}
          onChange={(e) => setDisclaimerHtml(e.target.value)}
          rows={10}
          maxLength={20_000}
          placeholder="<p>This is a free-form roleplay chat...</p>"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          Rendered above the registration form on the splash. Users must tick
          an "I agree" checkbox before <code>/auth/register</code> succeeds.
          Empty disclaimer = no checkbox shown (registration unblocked).
        </p>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">New-user welcome (post-login)</legend>
        <textarea
          value={welcomeHtml}
          onChange={(e) => setWelcomeHtml(e.target.value)}
          rows={10}
          maxLength={50_000}
          placeholder="<h3>Welcome to The Spire</h3><p>Quick orientation...</p>"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          Onboarding modal shown once to users who register <b>after</b> the most
          recent save here. Existing users (registered before the welcome was
          set or last edited) never see it - this is for fresh accounts only,
          not a broadcast channel. Re-saving with the same text doesn't
          re-shift the audience cutoff; only changing the text does. Empty
          text = no welcome shown.
        </p>
      </fieldset>

      {/* Live preview */}
      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Preview</legend>
        <div className="space-y-3 rounded border border-keep-rule bg-keep-bg p-3">
          {securityHtml.trim() ? (
            <div
              className="prose prose-sm max-w-none rounded border border-keep-action/40 bg-keep-action/5 p-2"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(securityHtml) }}
            />
          ) : null}
          {rulesHtml.trim() ? (
            <div
              className="prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(rulesHtml) }}
            />
          ) : (
            <p className="italic text-keep-muted">(no rules set)</p>
          )}
          {disclaimerHtml.trim() ? (
            <div className="rounded border border-keep-border/60 bg-keep-bg/50 p-2">
              <div className="mb-1 text-[10px] uppercase tracking-[0.25em] text-keep-muted">
                register disclaimer (shown on the splash)
              </div>
              <div
                className="prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(disclaimerHtml) }}
              />
              <label className="mt-1 flex items-start gap-2 text-[11px] text-keep-muted">
                <input type="checkbox" disabled checked className="mt-0.5" />
                <span>I have read and accept the disclaimer above and the house rules.</span>
              </label>
            </div>
          ) : null}
          {welcomeHtml.trim() ? (
            <div className="rounded border border-keep-action/40 bg-keep-action/5 p-2">
              <div className="mb-1 text-[10px] uppercase tracking-[0.25em] text-keep-muted">
                new-user welcome modal (shown only to accounts registered after this is saved)
              </div>
              <div
                className="prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(welcomeHtml) }}
              />
            </div>
          ) : null}
        </div>
        <p className="mt-1 text-[10px] text-keep-muted">
          Preview is run through DOMPurify, but tags outside the server's
          allow-list will still disappear on save (server uses sanitize-html
          with a stricter list than DOMPurify's default).
        </p>
      </fieldset>

      {error ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
      ) : null}

      <div className="flex items-center justify-between">
        <span className={`text-xs ${savedFlash ? "text-keep-system" : "text-keep-muted"}`}>
          {savedFlash ? "Saved." : `Last updated ${new Date(data.updatedAt).toLocaleString()}`}
        </span>
        <button
          type="submit"
          disabled={saving}
          className="keep-button rounded border border-keep-rule bg-keep-banner px-4 py-1 text-xs disabled:opacity-50 hover:bg-keep-banner/80"
        >
          {saving ? "Saving..." : "Save rules"}
        </button>
      </div>
    </form>
  );
}

function LinksTab({ onLinksChanged }: { onLinksChanged: () => void }) {
  const [links, setLinks] = useState<NavLinkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    try {
      const r = await fetch("/admin/nav-links", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { links: NavLinkRow[] };
      setLinks(j.links);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); }, []);

  async function create(input: NavLinkInput) {
    const r = await fetch("/admin/nav-links", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(await readError(r));
    onLinksChanged();
    await reload();
  }

  async function patch(id: string, input: Partial<NavLinkInput>) {
    const r = await fetch(`/admin/nav-links/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(await readError(r));
    onLinksChanged();
    await reload();
  }

  async function destroy(id: string) {
    if (!window.confirm("Delete this link?")) return;
    const r = await fetch(`/admin/nav-links/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!r.ok) throw new Error(await readError(r));
    onLinksChanged();
    await reload();
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-keep-muted">
        Banner links shown to all users. The Exit/logout link is built-in.
      </p>

      {error ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div> : null}

      <NewLinkForm onCreate={create} />

      {loading ? (
        <div className="text-keep-muted">loading...</div>
      ) : links.length === 0 ? (
        <div className="rounded border border-keep-rule bg-keep-bg p-4 text-center text-sm text-keep-muted">
          No links yet. Add one above.
        </div>
      ) : (
        <table className="w-full text-xs">
          <thead className="bg-keep-banner/50 text-keep-muted uppercase tracking-widest">
            <tr>
              <th className="px-2 py-1 text-left">Pos</th>
              <th className="px-2 py-1 text-left">Label</th>
              <th className="px-2 py-1 text-left">URL</th>
              <th className="px-2 py-1">Target</th>
              <th className="px-2 py-1">On</th>
              <th className="px-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <LinkRow key={l.id} link={l} onPatch={patch} onDelete={destroy} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NewLinkForm({ onCreate }: { onCreate: (i: NavLinkInput) => Promise<void> }) {
  const [label, setLabel] = useState("");
  const [href, setHref] = useState("");
  const [position, setPosition] = useState("0");
  const [target, setTarget] = useState<"_self" | "_blank">("_blank");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onCreate({
        label: label.trim(),
        href: href.trim(),
        position: parseInt(position, 10) || 0,
        target,
      });
      setLabel("");
      setHref("");
      setPosition("0");
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded border border-keep-rule bg-keep-bg p-2 text-xs">
      <div className="mb-1 font-semibold">Add a link</div>
      <div className="grid grid-cols-12 gap-2">
        <input
          required
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (e.g. Rules)"
          maxLength={40}
          className="col-span-3 rounded border border-keep-rule px-2 py-1"
        />
        <input
          required
          value={href}
          onChange={(e) => setHref(e.target.value)}
          placeholder="https://example.com or /path"
          maxLength={500}
          className="col-span-5 rounded border border-keep-rule px-2 py-1"
        />
        <input
          type="number"
          value={position}
          onChange={(e) => setPosition(e.target.value)}
          min={0}
          max={9999}
          title="Sort order - lower renders first"
          className="col-span-1 rounded border border-keep-rule px-2 py-1"
        />
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value as "_self" | "_blank")}
          className="col-span-2 rounded border border-keep-rule px-2 py-1"
        >
          <option value="_blank">new tab</option>
          <option value="_self">same tab</option>
        </select>
        <button
          type="submit"
          disabled={submitting}
          className="keep-button col-span-1 rounded border border-keep-rule bg-keep-banner px-2 py-1 disabled:opacity-50 hover:bg-keep-banner/80"
        >
          {submitting ? "..." : "Add"}
        </button>
      </div>
      {error ? <div className="mt-1 text-keep-accent">{error}</div> : null}
    </form>
  );
}

function LinkRow({
  link,
  onPatch,
  onDelete,
}: {
  link: NavLinkRow;
  onPatch: (id: string, p: Partial<NavLinkInput>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(link);
  const dirty =
    draft.label !== link.label ||
    draft.href !== link.href ||
    draft.position !== link.position ||
    draft.target !== link.target;

  async function commit() {
    await onPatch(link.id, {
      label: draft.label,
      href: draft.href,
      position: draft.position,
      target: draft.target,
    });
  }

  async function toggleEnabled() {
    await onPatch(link.id, { enabled: !link.enabled });
  }

  return (
    <tr className="border-t border-keep-rule">
      <td className="px-2 py-1">
        <input
          type="number"
          min={0}
          max={9999}
          value={draft.position}
          onChange={(e) => setDraft({ ...draft, position: parseInt(e.target.value, 10) || 0 })}
          className="w-14 rounded border border-keep-rule px-1 py-0.5"
        />
      </td>
      <td className="px-2 py-1">
        <input
          value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          maxLength={40}
          className="w-full rounded border border-keep-rule px-1 py-0.5"
        />
      </td>
      <td className="px-2 py-1">
        <input
          value={draft.href}
          onChange={(e) => setDraft({ ...draft, href: e.target.value })}
          maxLength={500}
          className="w-full rounded border border-keep-rule px-1 py-0.5"
        />
      </td>
      <td className="px-2 py-1">
        <select
          value={draft.target}
          onChange={(e) => setDraft({ ...draft, target: e.target.value as "_self" | "_blank" })}
          className="rounded border border-keep-rule px-1 py-0.5"
        >
          <option value="_blank">new</option>
          <option value="_self">same</option>
        </select>
      </td>
      <td className="px-2 py-1 text-center">
        <input type="checkbox" checked={link.enabled} onChange={toggleEnabled} />
      </td>
      <td className="px-2 py-1 text-right">
        {dirty ? (
          <button
            type="button"
            onClick={commit}
            className="keep-button mr-1 rounded border border-keep-rule bg-keep-banner px-2 py-0.5 hover:bg-keep-banner/80"
          >
            Save
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onDelete(link.id)}
          className="rounded border border-keep-accent/60 bg-keep-bg px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10"
        >
          Delete
        </button>
      </td>
    </tr>
  );
}

/* =============================================================
 * CUSTOM COMMANDS TAB
 * ============================================================= */

interface CustomCmdRow {
  id: string;
  name: string;
  kind: "action" | "say";
  template: string;
  description: string | null;
  enabled: boolean;
  aliases: string[];
  /** Hex color override; null = inherit sender's chatColor. */
  color: string | null;
}

interface CustomCmdInput {
  name: string;
  kind: "action" | "say";
  template: string;
  description?: string;
  aliases?: string[];
  enabled?: boolean;
  /** Pass null to clear; pass a #rrggbb hex to set. */
  color?: string | null;
}

function CommandsTab() {
  const [cmds, setCmds] = useState<CustomCmdRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<CustomCmdRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    try {
      const r = await fetch("/admin/custom-commands", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { commands: CustomCmdRow[] };
      setCmds(j.commands);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); }, []);

  async function create(input: CustomCmdInput) {
    const r = await fetch("/admin/custom-commands", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(await readError(r));
    setAdding(false);
    await reload();
  }

  async function update(id: string, input: Partial<CustomCmdInput>) {
    const r = await fetch(`/admin/custom-commands/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(await readError(r));
    setEditing(null);
    await reload();
  }

  async function destroy(id: string) {
    if (!window.confirm("Delete this command?")) return;
    const r = await fetch(`/admin/custom-commands/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!r.ok) throw new Error(await readError(r));
    await reload();
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between">
        <div className="text-xs text-keep-muted max-w-[60%]">
          User-authored slash commands beyond the built-ins. Built-in names
          (<code>/me</code>, <code>/char</code>, etc.) are protected and can't be shadowed.
        </div>
        <button
          type="button"
          onClick={() => { setAdding(true); setEditing(null); }}
          className="rounded border border-keep-rule bg-keep-banner px-3 py-1 text-xs hover:bg-keep-banner/80"
        >
          + New command
        </button>
      </div>

      {error ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
      ) : null}

      {adding ? (
        <CommandForm
          mode="create"
          onCancel={() => setAdding(false)}
          onSubmit={create}
        />
      ) : null}

      {editing ? (
        <CommandForm
          mode="edit"
          initial={editing}
          onCancel={() => setEditing(null)}
          onSubmit={(input) => update(editing.id, input)}
          onDelete={() => destroy(editing.id)}
        />
      ) : null}

      {loading ? (
        <div className="text-keep-muted text-xs">loading...</div>
      ) : cmds.length === 0 ? (
        <div className="rounded border border-keep-rule bg-keep-bg p-4 text-center text-sm text-keep-muted">
          No custom commands yet.
        </div>
      ) : (
        <table className="w-full text-xs">
          <thead className="bg-keep-banner/50 text-keep-muted uppercase tracking-widest">
            <tr>
              <th className="px-2 py-1 text-left">Name</th>
              <th className="px-2 py-1 text-left">Kind</th>
              <th className="px-2 py-1 text-left">Aliases</th>
              <th className="px-2 py-1 text-left">Template</th>
              <th className="px-2 py-1">On</th>
              <th className="px-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {cmds.map((c) => (
              <tr key={c.id} className="border-t border-keep-rule">
                <td className="px-2 py-1 font-mono">/{c.name}</td>
                <td className="px-2 py-1">{c.kind}</td>
                <td className="px-2 py-1 font-mono">
                  {c.aliases.length ? c.aliases.map((a) => `/${a}`).join(" ") : "-"}
                </td>
                <td className="px-2 py-1 truncate max-w-xs" title={c.template}>{c.template}</td>
                <td className="px-2 py-1 text-center">
                  <input
                    type="checkbox"
                    checked={c.enabled}
                    onChange={() => update(c.id, { enabled: !c.enabled })}
                  />
                </td>
                <td className="px-2 py-1 text-right">
                  <button
                    type="button"
                    onClick={() => { setEditing(c); setAdding(false); }}
                    className="mr-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CommandForm({
  mode,
  initial,
  onSubmit,
  onCancel,
  onDelete,
}: {
  mode: "create" | "edit";
  initial?: CustomCmdRow;
  onSubmit: (input: CustomCmdInput) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<"action" | "say">(initial?.kind ?? "action");
  // Pre-fill new templates with `{sender} ` so authors see the variable
  // available; they can erase or rearrange it as needed.
  const [template, setTemplate] = useState(initial?.template ?? "{sender} ");
  const [aliases, setAliases] = useState((initial?.aliases ?? []).join(" "));
  const [description, setDescription] = useState(initial?.description ?? "");
  // null = inherit sender's chat color (default). A hex string overrides.
  const [color, setColor] = useState<string | null>(initial?.color ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const body: CustomCmdInput = {
        name: name.trim().toLowerCase(),
        kind,
        template,
      };
      if (description.trim()) body.description = description.trim();
      const aliasList = aliases.split(/[\s,]+/).map((a) => a.replace(/^\//, "").trim().toLowerCase()).filter(Boolean);
      if (mode === "create" || aliasList.length || (initial?.aliases.length ?? 0) > 0) {
        body.aliases = aliasList;
      }
      // Send color when changed from the loaded value (including clearing).
      if (mode === "create") {
        if (color) body.color = color;
      } else if (color !== (initial?.color ?? null)) {
        body.color = color;
      }
      await onSubmit(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setSubmitting(false);
    }
  }

  // Live preview using the same substitution rules as the server. {sender}
  // and {name} are synonyms - both resolve to the sender's display name.
  const preview = renderTemplatePreview(template, {
    name: "Sigrid",
    sender: "Sigrid",
    target: "Bran",
    args: "Bran tightly",
    rest: "tightly",
    time: "14:30",
    date: new Date().toISOString().slice(0, 10),
  });

  return (
    <form onSubmit={submit} className="rounded border border-keep-rule bg-keep-bg p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-semibold">{mode === "create" ? "New command" : `Edit /${initial?.name}`}</div>
        <button type="button" onClick={onCancel} className="text-keep-muted hover:text-keep-text">cancel</button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Name</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="hug"
            disabled={mode === "edit"}
            maxLength={32}
            pattern="[a-zA-Z][a-zA-Z0-9_-]*"
            className="w-full rounded border border-keep-rule px-2 py-1 disabled:bg-keep-banner/30"
          />
        </label>
        <label>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "action" | "say")}
            className="w-full rounded border border-keep-rule px-2 py-1"
          >
            <option value="action">action - renders like /me (no brackets)</option>
            <option value="say">say - renders as a normal message</option>
          </select>
        </label>
        <label className="col-span-2">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Template</span>
          <textarea
            required
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            placeholder="hugs {target} tightly."
            rows={2}
            className="w-full rounded border border-keep-rule px-2 py-1 font-mono"
          />
        </label>
        <label className="col-span-2">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Aliases</span>
          <input
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder="hugs embrace"
            className="w-full rounded border border-keep-rule px-2 py-1 font-mono"
          />
          <span className="mt-0.5 block text-[10px] text-keep-muted">
            space-separated, no leading slash. Conflicts with built-ins are rejected.
          </span>
        </label>
        <label className="col-span-2">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Description</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={200}
            placeholder="Hug someone."
            className="w-full rounded border border-keep-rule px-2 py-1"
          />
        </label>
        <label className="col-span-2">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Color</span>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={color ?? "#990000"}
              onChange={(e) => setColor(e.target.value)}
              className="h-7 w-10 cursor-pointer rounded border border-keep-rule"
              aria-label="Command color"
            />
            <input
              type="text"
              value={color ?? ""}
              onChange={(e) => setColor(e.target.value || null)}
              placeholder="(none - sender's chat color flows through)"
              maxLength={7}
              pattern="^#[0-9a-fA-F]{6}$"
              className="flex-1 rounded border border-keep-rule px-2 py-1 font-mono"
            />
            <button
              type="button"
              onClick={() => setColor(null)}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-keep-muted hover:text-keep-text"
              title="Clear - let the sender's /color flow through"
            >
              Clear
            </button>
          </div>
          <span className="mt-0.5 block text-[10px] text-keep-muted">
            Optional. Locks every message from this command to this color, regardless of who runs it.
          </span>
        </label>
      </div>

      <details className="mt-3 text-[11px]">
        <summary className="cursor-pointer text-keep-muted">Template syntax</summary>
        <div className="mt-1 space-y-2">
          <div>
            <div className="mb-0.5 uppercase tracking-widest text-keep-muted">Variables</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono">
              <div><b>{"{sender}"}</b> / <b>{"{name}"}</b> - sender</div>
              <div><b>{"{target}"}</b> - first arg</div>
              <div><b>{"{args}"}</b> - full args</div>
              <div><b>{"{rest}"}</b> - args without first</div>
              <div><b>{"{time}"}</b> - HH:MM</div>
              <div><b>{"{date}"}</b> - YYYY-MM-DD</div>
              <div><b>{"{room}"}</b> - current room id</div>
            </div>
          </div>
          <div>
            <div className="mb-0.5 uppercase tracking-widest text-keep-muted">Functions</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono">
              <div><b>{"{roll:1d20}"}</b> - dice roll</div>
              <div><b>{"{choose:a|b|c}"}</b> - random pick</div>
              <div><b>{"{upper:text}"}</b> - uppercase</div>
              <div><b>{"{lower:text}"}</b> - lowercase</div>
              <div className="col-span-2"><b>{"{if:cond|then|else}"}</b> - truthy if cond is non-empty &amp; not 0/false</div>
            </div>
          </div>
          <div>
            <div className="mb-0.5 uppercase tracking-widest text-keep-muted">Sugar</div>
            <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 font-mono">
              <div><b>{"{a|b|c}"}</b> - bare-pipe random pick (sugar for choose)</div>
              <div><b>{"{=expr}"}</b> - safe arithmetic, <code>+ - * / % ( )</code> only</div>
            </div>
          </div>
          <div>
            <div className="mb-0.5 uppercase tracking-widest text-keep-muted">Nesting</div>
            <div className="font-mono">
              <div>{"{if:{target}|hugs {target}|waves}"}</div>
              <div>{"{=10+{roll:1d20}}"}</div>
            </div>
          </div>
        </div>
      </details>

      <div className="mt-2 rounded border border-keep-rule bg-keep-banner/30 p-2">
        <div className="mb-0.5 text-[10px] uppercase tracking-widest text-keep-muted">
          Preview (Sigrid runs /{name || "..."} Bran tightly)
        </div>
        <div className="font-mono" style={color ? { color } : undefined}>
          {kind === "action"
            ? <span><b>Sigrid</b> {preview}</span>
            : <span>[<b>Sigrid</b>] {preview}</span>}
        </div>
      </div>

      {error ? <div className="mt-2 text-keep-accent">{error}</div> : null}

      <div className="mt-3 flex items-center justify-between">
        <div>
          {mode === "edit" && onDelete ? (
            <button
              type="button"
              onClick={onDelete}
              className="keep-button rounded border border-keep-accent/60 bg-keep-bg px-3 py-1 text-keep-accent hover:bg-keep-accent/10"
            >
              Delete
            </button>
          ) : null}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 hover:bg-keep-banner"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="keep-button rounded border border-keep-rule bg-keep-banner px-3 py-1 disabled:opacity-50 hover:bg-keep-banner/80"
          >
            {submitting ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </form>
  );
}

/**
 * Mirror of server-side renderTemplate (registry.ts) so the preview pane
 * faithfully shows what users will see at command time. Keep these in sync.
 */
function renderTemplatePreview(tpl: string, vars: Record<string, string>): string {
  let out = tpl;
  for (let i = 0; i < 16; i++) {
    let changed = false;
    out = out.replace(/\{([^{}]*)\}/g, (m, raw: string) => {
      const replaced = evalNode(raw, vars);
      if (replaced === null) return m;
      changed = true;
      return replaced;
    });
    if (!changed) break;
  }
  return out;
}

function evalNode(raw: string, vars: Record<string, string>): string | null {
  const body = raw.trim();
  if (!body) return null;
  if (body.startsWith("=")) return safeEvalMath(body.slice(1));
  const colon = body.indexOf(":");
  if (colon > 0 && /^[a-zA-Z]+$/.test(body.slice(0, colon))) {
    return evalFn(body.slice(0, colon).toLowerCase(), body.slice(colon + 1));
  }
  if (body.includes("|")) {
    const opts = body.split("|").map((s) => s.trim()).filter(Boolean);
    return opts.length ? opts[Math.floor(Math.random() * opts.length)]! : "";
  }
  return vars[body.toLowerCase()] ?? null;
}

function evalFn(fn: string, arg: string): string | null {
  switch (fn) {
    case "roll": {
      const m = /^(\d*)d(\d+)$/i.exec(arg.trim());
      if (!m) return null;
      const count = Math.min(20, parseInt(m[1] || "1", 10) || 1);
      const sides = Math.min(1000, parseInt(m[2] ?? "0", 10) || 0);
      if (sides < 2) return null;
      let total = 0;
      for (let i = 0; i < count; i++) total += 1 + Math.floor(Math.random() * sides);
      return String(total);
    }
    case "choose": {
      const opts = arg.split("|").map((s) => s.trim()).filter(Boolean);
      return opts.length ? opts[Math.floor(Math.random() * opts.length)]! : "";
    }
    case "upper": return arg.toUpperCase();
    case "lower": return arg.toLowerCase();
    case "if": {
      const parts = arg.split("|");
      if (parts.length < 2) return null;
      const cond = (parts[0] ?? "").trim();
      const truthy = cond !== "" && cond !== "0" && cond.toLowerCase() !== "false";
      return truthy ? (parts[1] ?? "") : parts.slice(2).join("|");
    }
    default: return null;
  }
}

function safeEvalMath(expr: string): string | null {
  const s = expr.replace(/\s+/g, "");
  if (!s || !/^[\d.+\-*/%()]+$/.test(s)) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const result = Function(`"use strict"; return (${s});`)();
    if (typeof result === "number" && Number.isFinite(result)) {
      return Number.isInteger(result) ? String(result) : String(+result.toFixed(6));
    }
  } catch { /* ignore */ }
  return null;
}

/* =============================================================
 * ROOMS TAB
 * ============================================================= */

interface AdminRoom {
  id: string;
  name: string;
  type: "public" | "private";
  topic: string | null;
  description: string | null;
  ownerId: string | null;
  isSystem: boolean;
  isDefault: boolean;
  replyMode: "flat" | "nested";
  hasPassword: boolean;
  memberCount: number;
}

interface RoomDraft {
  name: string;
  type: "public" | "private";
  topic: string;
  description: string;
  isSystem: boolean;
  isDefault: boolean;
  /**
   * "flat" = chronological chat; "nested" = forum-style threads with
   * persistent top-level posts and grouped replies. Choosing "nested"
   * unlocks the thread-categories panel for organizing those threads.
   */
  replyMode: "flat" | "nested";
  /** Empty string keeps existing password (edit) or means "no password" (create + public). */
  password: string;
  /** True iff editing AND admin clicked "clear password" - sends null. */
  clearPassword: boolean;
}

function emptyDraft(): RoomDraft {
  return {
    name: "",
    type: "public",
    topic: "",
    description: "",
    isSystem: true,
    isDefault: false,
    replyMode: "flat",
    password: "",
    clearPassword: false,
  };
}

function draftFromRoom(r: AdminRoom): RoomDraft {
  return {
    name: r.name,
    type: r.type,
    topic: r.topic ?? "",
    description: r.description ?? "",
    isSystem: r.isSystem,
    isDefault: r.isDefault,
    replyMode: r.replyMode,
    password: "",
    clearPassword: false,
  };
}

/* ============================================================================
 * TITLE KINDS TAB
 *
 * CRUD over the catalog of mutual-title kinds (marriage, partner, mentor, etc.).
 * Slug = the user-facing keyword in /request <slug> <name>. Format strings
 * use {target} as the substitution point for the other party's display name.
 * Symmetric kinds use formatA on both sides; asymmetric kinds let the
 * requester (A side) and recipient (B side) carry different labels.
 * ========================================================================== */

interface TitleKindRow {
  id: string;
  slug: string;
  label: string;
  symmetric: boolean;
  formatA: string;
  formatB: string;
  exclusive: boolean;
  enabled: boolean;
  usageCount: number;
}

interface TitleKindInput {
  slug: string;
  label: string;
  symmetric: boolean;
  formatA: string;
  formatB: string;
  exclusive: boolean;
  enabled: boolean;
}

function TitleKindsTab() {
  const [kinds, setKinds] = useState<TitleKindRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TitleKindRow | null>(null);
  const [adding, setAdding] = useState(false);

  async function reload() {
    setLoading(true);
    try {
      const r = await fetch("/admin/title-kinds", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { kinds: TitleKindRow[] };
      setKinds(j.kinds);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); }, []);

  async function create(input: TitleKindInput) {
    const r = await fetch("/admin/title-kinds", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(await readError(r));
    setAdding(false);
    await reload();
  }

  async function update(id: string, input: TitleKindInput) {
    const r = await fetch(`/admin/title-kinds/${id}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(await readError(r));
    setEditing(null);
    await reload();
  }

  async function destroy(id: string, usageCount: number) {
    const msg = usageCount > 0
      ? `Delete this kind? ${usageCount} active or pending title(s) of this kind will also be removed.`
      : "Delete this kind?";
    if (!window.confirm(msg)) return;
    const r = await fetch(`/admin/title-kinds/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!r.ok) throw new Error(await readError(r));
    await reload();
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between">
        <div className="text-xs text-keep-muted max-w-[60%]">
          Catalog of mutual-title kinds. Users invoke these via{" "}
          <code>/request &lt;slug&gt; &lt;user&gt;</code>. <code>{"{target}"}</code> in the
          format string is replaced with the other party's display name.
          Symmetric kinds use the same label on both sides; asymmetric kinds
          (e.g. mentor / apprentice) let you set distinct A and B labels.
          Exclusive kinds limit each identity to one accepted title of that kind at a time.
        </div>
        <button
          type="button"
          onClick={() => { setAdding(true); setEditing(null); }}
          className="rounded border border-keep-rule bg-keep-banner px-3 py-1 text-xs hover:bg-keep-banner/80"
        >
          + New title kind
        </button>
      </div>

      {error ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
      ) : null}

      {adding ? (
        <TitleKindForm
          mode="create"
          onCancel={() => setAdding(false)}
          onSubmit={create}
        />
      ) : null}

      {editing ? (
        <TitleKindForm
          mode="edit"
          initial={editing}
          onCancel={() => setEditing(null)}
          onSubmit={(input) => update(editing.id, input)}
          onDelete={() => destroy(editing.id, editing.usageCount)}
        />
      ) : null}

      {loading ? (
        <div className="text-keep-muted text-xs">loading...</div>
      ) : kinds.length === 0 ? (
        <div className="rounded border border-keep-rule bg-keep-bg p-4 text-center text-sm text-keep-muted">
          No title kinds yet.
        </div>
      ) : (
        <table className="w-full text-xs">
          <thead className="bg-keep-banner/50 text-keep-muted uppercase tracking-widest">
            <tr>
              <th className="px-2 py-1 text-left">Slug</th>
              <th className="px-2 py-1 text-left">Label</th>
              <th className="px-2 py-1 text-left">A side</th>
              <th className="px-2 py-1 text-left">B side</th>
              <th className="px-2 py-1">Excl.</th>
              <th className="px-2 py-1">In use</th>
              <th className="px-2 py-1">On</th>
              <th className="px-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {kinds.map((k) => (
              <tr key={k.id} className="border-t border-keep-rule">
                <td className="px-2 py-1 font-mono">{k.slug}</td>
                <td className="px-2 py-1">{k.label}</td>
                <td className="px-2 py-1 truncate max-w-[180px]" title={k.formatA}>{k.formatA}</td>
                <td className="px-2 py-1 truncate max-w-[180px]" title={k.formatB}>
                  {k.symmetric ? <span className="italic text-keep-muted">(same)</span> : k.formatB}
                </td>
                <td className="px-2 py-1 text-center">{k.exclusive ? "✓" : ""}</td>
                <td className="px-2 py-1 text-center tabular-nums">{k.usageCount}</td>
                <td className="px-2 py-1 text-center">{k.enabled ? "✓" : ""}</td>
                <td className="px-2 py-1 text-right">
                  <button
                    type="button"
                    onClick={() => { setEditing(k); setAdding(false); }}
                    className="mr-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TitleKindForm({
  mode,
  initial,
  onSubmit,
  onCancel,
  onDelete,
}: {
  mode: "create" | "edit";
  initial?: TitleKindRow;
  onSubmit: (input: TitleKindInput) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
}) {
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [symmetric, setSymmetric] = useState(initial?.symmetric ?? true);
  const [formatA, setFormatA] = useState(initial?.formatA ?? "Married to {target}");
  const [formatB, setFormatB] = useState(initial?.formatB ?? "Married to {target}");
  const [exclusive, setExclusive] = useState(initial?.exclusive ?? false);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onSubmit({
        slug: slug.trim().toLowerCase(),
        label: label.trim(),
        symmetric,
        formatA: formatA.trim(),
        formatB: symmetric ? formatA.trim() : formatB.trim(),
        exclusive,
        enabled,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded border border-keep-rule bg-keep-bg p-3 text-xs">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <div className="text-keep-muted uppercase tracking-widest">Slug</div>
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="marriage"
            className="w-full rounded border border-keep-rule bg-keep-parchment px-2 py-1 font-mono"
            required
          />
        </label>
        <label className="space-y-1">
          <div className="text-keep-muted uppercase tracking-widest">Label</div>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Marriage"
            className="w-full rounded border border-keep-rule bg-keep-parchment px-2 py-1"
            required
          />
        </label>
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={symmetric}
          onChange={(e) => setSymmetric(e.target.checked)}
        />
        <span>Symmetric (same label on both sides)</span>
      </label>

      <label className="space-y-1 block">
        <div className="text-keep-muted uppercase tracking-widest">
          {symmetric ? "Display format" : "A side (requester)"}
        </div>
        <input
          type="text"
          value={formatA}
          onChange={(e) => setFormatA(e.target.value)}
          placeholder="Married to {target}"
          className="w-full rounded border border-keep-rule bg-keep-parchment px-2 py-1 font-mono"
          required
        />
        <div className="text-[10px] text-keep-muted">
          {"{target} is replaced with the other party's display name."}
        </div>
      </label>

      {!symmetric ? (
        <label className="space-y-1 block">
          <div className="text-keep-muted uppercase tracking-widest">B side (recipient)</div>
          <input
            type="text"
            value={formatB}
            onChange={(e) => setFormatB(e.target.value)}
            placeholder="Apprentice of {target}"
            className="w-full rounded border border-keep-rule bg-keep-parchment px-2 py-1 font-mono"
            required
          />
        </label>
      ) : null}

      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={exclusive}
            onChange={(e) => setExclusive(e.target.checked)}
          />
          <span>Exclusive (one accepted per identity)</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>Enabled</span>
        </label>
      </div>

      {error ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-keep-accent">{error}</div>
      ) : null}

      <div className="flex justify-between pt-1">
        <div>
          {mode === "edit" && onDelete ? (
            <button
              type="button"
              onClick={onDelete}
              className="keep-button rounded border border-keep-accent/60 bg-keep-bg px-3 py-1 text-keep-accent hover:bg-keep-accent/10"
            >
              Delete
            </button>
          ) : null}
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={onCancel}
            className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 text-keep-muted hover:bg-keep-banner"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="keep-button rounded border border-keep-rule bg-keep-banner px-3 py-1 hover:bg-keep-banner/80 disabled:opacity-50"
          >
            {mode === "create" ? "Create" : "Save"}
          </button>
        </div>
      </div>
    </form>
  );
}

function RoomsTab() {
  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdminRoom | null>(null);
  const [occupants, setOccupants] = useState<Array<{ userId: string; username: string; role: string }>>([]);
  /** Open form: { mode: "create" } | { mode: "edit", room: AdminRoom } | null */
  const [editing, setEditing] = useState<{ mode: "create" } | { mode: "edit"; room: AdminRoom } | null>(null);

  async function reload() {
    setLoading(true);
    try {
      const r = await fetch("/admin/rooms", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { rooms: AdminRoom[] };
      setRooms(j.rooms);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); }, []);

  async function loadOccupants(room: AdminRoom) {
    setSelected(room);
    setOccupants([]);
    try {
      const r = await fetch(`/admin/rooms/${room.id}/occupants`, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { occupants: typeof occupants };
      setOccupants(j.occupants);
    } catch (err) {
      setError(err instanceof Error ? err.message : "occupants load failed");
    }
  }

  async function deleteRoom(room: AdminRoom) {
    if (room.isSystem) return; // server refuses, but disable in UI too
    const ok = window.confirm(
      `Delete the room "${room.name}"?\n\nAll messages will be removed and any occupants will be moved to the landing room. This cannot be undone.`,
    );
    if (!ok) return;
    try {
      const r = await fetch(`/admin/rooms/${room.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      setSelected(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    }
  }

  async function submitCreate(draft: RoomDraft) {
    if (draft.type === "private" && !draft.password) {
      throw new Error("Private rooms require a password.");
    }
    const body: Record<string, unknown> = {
      name: draft.name.trim(),
      type: draft.type,
      isSystem: draft.isSystem,
      isDefault: draft.isDefault,
      replyMode: draft.replyMode,
    };
    if (draft.topic.trim()) body.topic = draft.topic.trim();
    if (draft.description.trim()) body.description = draft.description.trim();
    if (draft.type === "private" && draft.password) body.password = draft.password;
    const r = await fetch("/admin/rooms", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await readError(r));
    setEditing(null);
    await reload();
  }

  async function submitEdit(room: AdminRoom, draft: RoomDraft) {
    const body: Record<string, unknown> = {};
    if (draft.name.trim() !== room.name) body.name = draft.name.trim();
    // null clears, "" leaves unchanged (since we use ?? "" in draftFromRoom)
    if (draft.topic !== (room.topic ?? "")) {
      body.topic = draft.topic.trim() === "" ? null : draft.topic.trim();
    }
    if (draft.description !== (room.description ?? "")) {
      body.description = draft.description.trim() === "" ? null : draft.description.trim();
    }
    if (draft.isSystem !== room.isSystem) body.isSystem = draft.isSystem;
    if (draft.isDefault !== room.isDefault) body.isDefault = draft.isDefault;
    if (draft.replyMode !== room.replyMode) body.replyMode = draft.replyMode;
    if (draft.type !== room.type) {
      body.type = draft.type;
      if (draft.type === "private" && draft.password) body.password = draft.password;
      else if (draft.type === "private" && !draft.password && !room.hasPassword) {
        throw new Error("Switching to private requires a password.");
      }
    } else if (draft.password) {
      body.password = draft.password;
    } else if (draft.clearPassword) {
      body.password = null;
    }
    if (Object.keys(body).length === 0) {
      setEditing(null);
      return;
    }
    const r = await fetch(`/admin/rooms/${room.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await readError(r));
    setEditing(null);
    await reload();
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="max-w-[60%] text-xs text-keep-muted">
          Every room with member count and metadata. Admin-created rooms can
          be flagged as <b>system</b> rooms - they're permanent (don't auto-expire
          when empty) and protected from deletion. Private room message logs
          remain unviewable even to admins.
        </p>
        <button
          type="button"
          onClick={() => setEditing({ mode: "create" })}
          className="rounded border border-keep-rule bg-keep-banner px-3 py-1 text-xs hover:bg-keep-banner/80"
        >
          + New room
        </button>
      </div>

      {error ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div> : null}

      {editing ? (
        <RoomForm
          mode={editing.mode}
          {...(editing.mode === "edit" ? { initial: draftFromRoom(editing.room), original: editing.room } : {})}
          onCancel={() => setEditing(null)}
          onSubmit={editing.mode === "create"
            ? submitCreate
            : (draft: RoomDraft) => submitEdit(editing.room, draft)}
        />
      ) : null}

      {loading ? (
        <div className="text-keep-muted text-xs">loading...</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="bg-keep-banner/50 text-keep-muted uppercase tracking-widest">
            <tr>
              <th className="px-2 py-1 text-left">Name</th>
              <th className="px-2 py-1 text-left">Type</th>
              <th className="px-2 py-1">Members</th>
              <th className="px-2 py-1 text-left">Topic</th>
              <th className="px-2 py-1">System</th>
              <th className="px-2 py-1">Default</th>
              <th className="px-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {rooms.map((r) => (
              <tr key={r.id} className="border-t border-keep-rule">
                <td className="px-2 py-1 font-semibold" title={r.description ?? ""}>{r.name}</td>
                <td className="px-2 py-1">
                  {/*
                    Type badge - derives its tint from the active theme so it
                    stays legible on light and dark palettes alike. Public uses
                    the "action" slot (green on default, accent on dark themes);
                    private uses the "accent" slot to read as "restricted".
                  */}
                  <span
                    className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest ${
                      r.type === "public"
                        ? "bg-keep-action/20 text-keep-action"
                        : "bg-keep-accent/20 text-keep-accent"
                    }`}
                  >
                    {r.type}
                  </span>
                </td>
                <td className="px-2 py-1 text-center tabular-nums">{r.memberCount}</td>
                <td className="px-2 py-1 truncate max-w-xs" title={r.topic ?? ""}>{r.topic ?? "-"}</td>
                <td className="px-2 py-1 text-center">{r.isSystem ? "✓" : ""}</td>
                <td className="px-2 py-1 text-center" title={r.isDefault ? "Default landing room" : ""}>
                  {r.isDefault ? "★" : ""}
                </td>
                <td className="px-2 py-1 text-right">
                  <button
                    type="button"
                    onClick={() => loadOccupants(r)}
                    className="mr-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                  >
                    Occupants
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing({ mode: "edit", room: r })}
                    className="mr-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                    title="Edit room metadata (name, topic, description, type, system flag)."
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteRoom(r)}
                    disabled={r.isSystem}
                    title={r.isSystem ? "System rooms cannot be deleted. Toggle the System flag off via Edit first." : "Delete this room (occupants are moved to the landing room)."}
                    className="rounded border border-keep-accent/60 bg-keep-bg px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected ? (
        <div className="rounded border border-keep-rule bg-keep-bg p-3 text-xs">
          <div className="mb-2 flex items-center justify-between">
            <div><b>{selected.name}</b> - members</div>
            <button type="button" onClick={() => setSelected(null)} className="text-keep-muted">close</button>
          </div>
          {occupants.length === 0 ? (
            <div className="text-keep-muted">(empty)</div>
          ) : (
            <ul>
              {occupants.map((o) => (
                <li key={o.userId} className="flex justify-between border-t border-keep-rule/50 py-0.5 first:border-t-0">
                  <span>{o.username}</span>
                  <span className="text-keep-muted">{o.role}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function RoomForm({
  mode,
  initial,
  original,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  initial?: RoomDraft;
  /** When editing, the original AdminRoom is needed for hasPassword display logic. */
  original?: AdminRoom;
  onSubmit: (draft: RoomDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<RoomDraft>(initial ?? emptyDraft());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded border border-keep-rule bg-keep-bg p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-semibold">
          {mode === "create" ? "New room" : `Edit ${original?.name ?? ""}`}
        </div>
        <button type="button" onClick={onCancel} className="text-keep-muted hover:text-keep-text">cancel</button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="col-span-1">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Name</span>
          <input
            required
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            maxLength={40}
            placeholder="Tavern"
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          />
        </label>
        <label className="col-span-1">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Type</span>
          <select
            value={draft.type}
            onChange={(e) => setDraft({ ...draft, type: e.target.value as "public" | "private" })}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="public">public - anyone can join</option>
            <option value="private">private - password required</option>
          </select>
        </label>
        {draft.type === "private" ? (
          <label className="col-span-2">
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">
              Password{" "}
              {mode === "edit" && original?.hasPassword ? (
                <span className="normal-case tracking-normal text-keep-muted/80">
                  (leave blank to keep existing)
                </span>
              ) : null}
            </span>
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={draft.password}
                onChange={(e) => setDraft({ ...draft, password: e.target.value, clearPassword: false })}
                placeholder={mode === "edit" && original?.hasPassword ? "(unchanged)" : "Required"}
                maxLength={100}
                className="flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1"
              />
              {mode === "edit" && original?.hasPassword ? (
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, password: "", clearPassword: !draft.clearPassword })}
                  className={`rounded border px-2 py-1 ${
                    draft.clearPassword
                      ? "border-keep-accent/60 bg-keep-accent/10 text-keep-accent"
                      : "border-keep-rule bg-keep-bg text-keep-muted hover:text-keep-text"
                  }`}
                  title="Clear the password - the room becomes private with no password (membership/invite-only)."
                >
                  {draft.clearPassword ? "Clearing" : "Clear"}
                </button>
              ) : null}
            </div>
          </label>
        ) : null}
        <label className="col-span-2">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Topic</span>
          <input
            value={draft.topic}
            onChange={(e) => setDraft({ ...draft, topic: e.target.value })}
            maxLength={200}
            placeholder="Short headline shown above the chat"
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          />
        </label>
        <label className="col-span-2">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Description</span>
          <textarea
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            rows={4}
            maxLength={5000}
            placeholder="Long-form world/setting description shown to users on join. Newlines preserved."
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          />
        </label>
        <label className="col-span-2 flex items-center gap-2 pt-1">
          <input
            type="checkbox"
            checked={draft.isSystem}
            onChange={(e) => setDraft({ ...draft, isSystem: e.target.checked })}
          />
          <span>
            <b>System room</b> - permanent, exempt from auto-expire, protected from deletion until this flag is cleared.
          </span>
        </label>
        <label className="col-span-2 flex items-center gap-2 pt-1">
          <input
            type="checkbox"
            checked={draft.isDefault}
            onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })}
          />
          <span>
            <b>Default landing room</b> - new users and reconnecting users with no remembered room land here. Flipping this on automatically clears the flag off whichever room currently holds it.
          </span>
        </label>

        {/* Reply / thread mode. Flat = ephemeral chronological chat;
            nested = forum-style with persistent threads and the
            thread-categories panel below. Toggling here saves on form
            submit and re-broadcasts room state so anyone currently in
            the room flips renderers without a refresh. */}
        <label className="col-span-2">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Reply mode</span>
          <select
            value={draft.replyMode}
            onChange={(e) => setDraft({ ...draft, replyMode: e.target.value as "flat" | "nested" })}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="flat">flat — chronological chat (messages may auto-expire per retention)</option>
            <option value="nested">nested — forum-style threads (persistent topics, replies group under their parent, supports categories)</option>
          </select>
          <span className="mt-1 block text-[10px] text-keep-muted">
            {draft.replyMode === "nested"
              ? "Threads in this room read like a forum: top-level posts persist, replies group under their parent, and admins can add categories to organize them."
              : "Standard chat timeline. /replymode in chat is the equivalent toggle for room owners and mods."}
          </span>
        </label>
      </div>

      {/* Thread categories — only meaningful for nested-mode rooms.
          We branch on the DRAFT replyMode (not the saved value) so
          flipping the select above immediately reveals the panel; the
          panel itself hits the API directly, independent of the
          room-form save. New rooms have no id yet, so we hint that
          categories can be added after the first save. */}
      {mode === "edit" && original && draft.replyMode === "nested" ? (
        <ThreadCategoriesEditor roomId={original.id} />
      ) : null}
      {mode === "create" && draft.replyMode === "nested" ? (
        <div className="mt-3 rounded border border-keep-action/40 bg-keep-action/10 p-2 text-[10px] uppercase tracking-widest text-keep-action">
          Thread categories can be added after the room is created — save this form, then re-open the room's Edit panel and the categories editor will appear here.
        </div>
      ) : null}

      {error ? <div className="mt-2 text-keep-accent">{error}</div> : null}

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 hover:bg-keep-banner"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="keep-button rounded border border-keep-rule bg-keep-banner px-3 py-1 disabled:opacity-50 hover:bg-keep-banner/80"
        >
          {submitting ? "Saving..." : mode === "create" ? "Create room" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

/**
 * Inline editor for a nested-mode room's thread categories. Lives inside
 * the room-edit form so admins manage everything for a room in one
 * place. CRUD hits `/admin/rooms/:id/thread-categories`; the list refresh
 * happens locally without round-tripping the whole room edit form so the
 * admin doesn't lose draft state on unrelated changes.
 */
function ThreadCategoriesEditor({ roomId }: { roomId: string }) {
  const [cats, setCats] = useState<ThreadCategory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  async function load() {
    setError(null);
    try {
      const r = await fetch(`/rooms/${encodeURIComponent(roomId)}/thread-categories`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { categories: ThreadCategory[] };
      setCats(j.categories);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    }
  }
  useEffect(() => { load(); }, [roomId]);

  async function add() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/admin/rooms/${encodeURIComponent(roomId)}/thread-categories`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, sortOrder: (cats?.length ?? 0) }),
      });
      if (!r.ok) throw new Error(await readError(r));
      setNewName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "add failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveRename(catId: string) {
    const trimmed = editName.trim();
    if (!trimmed) { setEditingId(null); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/admin/rooms/${encodeURIComponent(roomId)}/thread-categories/${encodeURIComponent(catId)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!r.ok) throw new Error(await readError(r));
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "rename failed");
    } finally {
      setBusy(false);
    }
  }

  async function move(catId: string, direction: -1 | 1) {
    if (!cats) return;
    const idx = cats.findIndex((c) => c.id === catId);
    const swapIdx = idx + direction;
    if (idx < 0 || swapIdx < 0 || swapIdx >= cats.length) return;
    const a = cats[idx]!;
    const b = cats[swapIdx]!;
    setBusy(true);
    setError(null);
    try {
      // Two PATCHes: swap the sortOrder of the adjacent rows. We only
      // touch two records per move so a long category list doesn't
      // require a full re-shuffle on every reorder click.
      await Promise.all([
        fetch(`/admin/rooms/${encodeURIComponent(roomId)}/thread-categories/${encodeURIComponent(a.id)}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sortOrder: b.sortOrder }),
        }),
        fetch(`/admin/rooms/${encodeURIComponent(roomId)}/thread-categories/${encodeURIComponent(b.id)}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sortOrder: a.sortOrder }),
        }),
      ]);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "reorder failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(catId: string) {
    if (!window.confirm("Delete this category? Existing threads in it fall back to Uncategorized.")) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/admin/rooms/${encodeURIComponent(roomId)}/thread-categories/${encodeURIComponent(catId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded border border-keep-rule bg-keep-banner/20 p-2 text-xs">
      <div className="mb-1 text-[10px] uppercase tracking-widest text-keep-muted">Thread categories</div>
      {error ? <div className="mb-1 text-keep-accent">{error}</div> : null}
      {cats === null ? <div className="italic text-keep-muted">loading…</div> : null}
      {cats && cats.length === 0 ? (
        <div className="italic text-keep-muted">No categories yet. Threads will all land in "Uncategorized" until you add one.</div>
      ) : null}
      {cats && cats.length > 0 ? (
        <ul className="mb-2 space-y-1">
          {cats.map((c, idx) => (
            <li key={c.id} className="flex items-center gap-1 rounded border border-keep-rule/60 bg-keep-bg px-2 py-1">
              {editingId === c.id ? (
                <>
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape") setEditingId(null); }}
                    maxLength={40}
                    className="flex-1 rounded border border-keep-rule px-1 py-0.5"
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                  />
                  <button type="button" onClick={() => saveRename(c.id)} disabled={busy} className="rounded border border-keep-action/60 bg-keep-action/10 px-2 py-0.5 text-keep-action hover:bg-keep-action/20 disabled:opacity-50">Save</button>
                  <button type="button" onClick={() => setEditingId(null)} className="rounded border border-keep-rule px-2 py-0.5 hover:bg-keep-banner">Cancel</button>
                </>
              ) : (
                <>
                  <span className="flex-1 truncate">{c.name}</span>
                  <button type="button" onClick={() => move(c.id, -1)} disabled={busy || idx === 0} className="rounded border border-keep-rule px-1 py-0.5 hover:bg-keep-banner disabled:opacity-40" title="Move up">▲</button>
                  <button type="button" onClick={() => move(c.id, 1)} disabled={busy || idx === cats.length - 1} className="rounded border border-keep-rule px-1 py-0.5 hover:bg-keep-banner disabled:opacity-40" title="Move down">▼</button>
                  <button type="button" onClick={() => { setEditingId(c.id); setEditName(c.name); }} className="rounded border border-keep-rule px-2 py-0.5 hover:bg-keep-banner">Rename</button>
                  <button type="button" onClick={() => remove(c.id)} disabled={busy} className="rounded border border-keep-accent/60 px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10 disabled:opacity-50">Delete</button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-1">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          maxLength={40}
          placeholder="New category name"
          className="flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        />
        <button
          type="button"
          onClick={add}
          disabled={busy || !newName.trim()}
          className="keep-button rounded border border-keep-rule bg-keep-banner px-2 py-1 hover:bg-keep-banner/80 disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </div>
  );
}

/* =============================================================
 * USERS TAB
 * ============================================================= */

interface AdminUserRow {
  userId: string;
  username: string;
  email: string;
  role: Role;
  online: boolean;
  away: boolean;
  awayMessage: string | null;
  activeCharacterId: string | null;
  createdAt: number;
  lastLoginAt: number | null;
  disabled: boolean;
  characters: Array<{ id: string; name: string; deleted: boolean }>;
}

function UsersTab() {
  const [rows, setRows] = useState<AdminUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<AdminUserRow | null>(null);

  async function reload() {
    setLoading(true);
    try {
      const url = q.trim() ? `/admin/users?q=${encodeURIComponent(q.trim())}` : "/admin/users";
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { users: AdminUserRow[] };
      setRows(j.users);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const t = window.setTimeout(reload, 200);
    return () => window.clearTimeout(t);
  }, [q]);

  async function patch(id: string, body: Record<string, unknown>) {
    const r = await fetch(`/admin/users/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await readError(r));
    setEditing(null);
    await reload();
  }

  async function destroy(u: AdminUserRow) {
    const ok = window.confirm(
      `DELETE user "${u.username}"?\n\nThis cascades through their characters, room memberships, sessions, and bans. Their messages keep the snapshotted display name in history but their account is gone permanently. This cannot be undone.`,
    );
    if (!ok) return;
    try {
      const r = await fetch(`/admin/users/${u.userId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      setEditing(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-keep-muted">
          Every registered account, including disabled ones. Search matches
          username and email. Editing role to "admin" grants full sitewide
          control - same as <code>/promoteadmin</code>.
        </p>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search username/email"
          className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs"
        />
      </div>

      {error ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
      ) : null}

      {loading ? (
        <div className="text-keep-muted text-xs">loading...</div>
      ) : rows.length === 0 ? (
        <div className="rounded border border-keep-rule bg-keep-bg p-4 text-center text-sm text-keep-muted">
          No users match.
        </div>
      ) : (
        <table className="w-full text-xs">
          <thead className="bg-keep-banner/50 text-keep-muted uppercase tracking-widest">
            <tr>
              <th className="px-2 py-1 text-left">Username</th>
              <th className="px-2 py-1 text-left">Email</th>
              <th className="px-2 py-1">Role</th>
              <th className="px-2 py-1">State</th>
              <th className="px-2 py-1">Chars</th>
              <th className="px-2 py-1">Last seen</th>
              <th className="px-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.userId} className="border-t border-keep-rule">
                <td className="px-2 py-1 font-semibold">{u.username}</td>
                <td className="px-2 py-1 font-mono">{u.email}</td>
                <td className="px-2 py-1 text-center">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${
                    u.role === "admin"
                      ? "bg-keep-accent/20 text-keep-accent"
                      : u.role === "mod"
                        ? "bg-keep-action/20 text-keep-action"
                        : "bg-keep-muted/20 text-keep-muted"
                  }`}>
                    {u.role}
                  </span>
                </td>
                <td className="px-2 py-1 text-center">
                  {u.disabled ? (
                    <span className="text-keep-accent">disabled</span>
                  ) : u.online ? (
                    <span className="text-keep-action">online</span>
                  ) : (
                    <span className="text-keep-muted">offline</span>
                  )}
                  {u.away ? <span className="ml-1 text-keep-system">away</span> : null}
                </td>
                <td className="px-2 py-1 text-center tabular-nums" title={u.characters.map((c) => c.name).join(", ")}>
                  {u.characters.filter((c) => !c.deleted).length}
                </td>
                <td className="px-2 py-1 text-center tabular-nums">
                  {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : "-"}
                </td>
                <td className="px-2 py-1 text-right">
                  <button
                    type="button"
                    onClick={() => setEditing(u)}
                    className="mr-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => destroy(u)}
                    className="rounded border border-keep-accent/60 bg-keep-bg px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing ? (
        <UserEditForm
          user={editing}
          onCancel={() => setEditing(null)}
          onSubmit={(body) => patch(editing.userId, body)}
        />
      ) : null}
    </div>
  );
}

function UserEditForm({
  user,
  onCancel,
  onSubmit,
}: {
  user: AdminUserRow;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [username, setUsername] = useState(user.username);
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState<Role>(user.role);
  const [disabled, setDisabled] = useState(user.disabled);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      if (username !== user.username) body.username = username;
      if (email !== user.email) body.email = email;
      if (role !== user.role) body.role = role;
      if (disabled !== user.disabled) body.disabled = disabled;
      if (Object.keys(body).length === 0) {
        onCancel();
        return;
      }
      await onSubmit(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded border border-keep-rule bg-keep-bg p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-semibold">Editing {user.username}</div>
        <button type="button" onClick={onCancel} className="text-keep-muted hover:text-keep-text">cancel</button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={40}
            className="w-full rounded border border-keep-rule px-2 py-1"
          />
        </label>
        <label>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={200}
            className="w-full rounded border border-keep-rule px-2 py-1"
          />
        </label>
        <label>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Role</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="w-full rounded border border-keep-rule px-2 py-1"
          >
            <option value="user">user</option>
            <option value="trusted">trusted</option>
            <option value="mod">mod</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <label className="flex items-end gap-2 pb-1">
          <input
            type="checkbox"
            checked={disabled}
            onChange={(e) => setDisabled(e.target.checked)}
          />
          <span>Disabled (account cannot log in)</span>
        </label>
      </div>

      {error ? <div className="mt-2 text-keep-accent">{error}</div> : null}

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 hover:bg-keep-banner"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="keep-button rounded border border-keep-rule bg-keep-banner px-3 py-1 disabled:opacity-50 hover:bg-keep-banner/80"
        >
          {submitting ? "Saving..." : "Save"}
        </button>
      </div>
    </form>
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

/* =========================================================
 *  Reports tab — triage queue for user-filed public reports
 * ========================================================= */
function ReportsTab() {
  const [statusFilter, setStatusFilter] = useState<"open" | "reviewed" | "dismissed" | "all">("open");
  const [reports, setReports] = useState<ReportEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setReports(null);
    setError(null);
    const qs = statusFilter === "all" ? "" : `?status=${statusFilter}`;
    fetch(`/admin/reports${qs}`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return r.json() as Promise<{ reports: ReportEntry[] }>;
      })
      .then((j) => { if (!cancelled) setReports(j.reports); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "load failed"); });
    return () => { cancelled = true; };
  }, [statusFilter, refreshKey]);

  async function resolve(id: string, status: "reviewed" | "dismissed") {
    const note = window.prompt(
      status === "reviewed"
        ? "Mark report as reviewed (acted on). Optional note for the audit log:"
        : "Dismiss report (no action). Optional note for the audit log:",
      "",
    );
    if (note === null) return;
    try {
      const res = await fetch(`/admin/reports/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setRefreshKey((k) => k + 1);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "resolve failed");
    }
  }

  return (
    <section className="space-y-2 text-sm">
      <header className="flex items-center justify-between">
        <h3 className="font-action text-base">Reports queue</h3>
        <div className="flex gap-2 text-xs">
          {(["open", "reviewed", "dismissed", "all"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`rounded border border-keep-rule px-2 py-0.5 ${
                statusFilter === s ? "bg-keep-bg" : "bg-keep-banner/40 hover:bg-keep-banner"
              }`}
            >
              {s}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setRefreshKey((k) => k + 1)}
            className="rounded border border-keep-rule bg-keep-banner/40 px-2 py-0.5 hover:bg-keep-banner"
          >
            Refresh
          </button>
        </div>
      </header>
      {error ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div> : null}
      {reports === null ? (
        <p className="italic text-keep-muted">Loading reports...</p>
      ) : reports.length === 0 ? (
        <p className="italic text-keep-muted">No reports.</p>
      ) : (
        <ul className="space-y-2">
          {reports.map((r) => (
            <li key={r.id} className="rounded border border-keep-rule bg-keep-bg p-2">
              <div className="flex items-baseline justify-between gap-2 text-xs text-keep-muted">
                <span>
                  <span className="font-semibold text-keep-text">{r.reporterDisplayName}</span> reported a message in{" "}
                  <span className="font-semibold text-keep-text">{r.roomName}</span>
                  {" · "}
                  <span title={new Date(r.createdAt).toLocaleString()}>{new Date(r.createdAt).toLocaleString()}</span>
                </span>
                <span
                  className={`rounded px-1 ${
                    r.status === "open"
                      ? "bg-keep-accent/15 text-keep-accent"
                      : "bg-keep-action/15 text-keep-action"
                  }`}
                >
                  {r.status}
                </span>
              </div>
              <div className="mt-1 rounded border border-keep-rule/50 bg-keep-panel/30 p-2 text-xs">
                <div className="text-keep-muted">
                  {new Date(r.messageCreatedAt).toLocaleTimeString()} — <span className="font-semibold">{r.messageDisplayName}</span>
                </div>
                <div className="whitespace-pre-wrap break-words">{r.messageBody}</div>
              </div>
              {r.reason ? (
                <div className="mt-1 text-xs italic">Reporter note: {r.reason}</div>
              ) : null}
              {r.resolvedAt && r.resolvedByDisplayName ? (
                <div className="mt-1 text-[11px] text-keep-muted">
                  Resolved by {r.resolvedByDisplayName}
                  {r.resolutionNote ? ` — ${r.resolutionNote}` : ""}
                </div>
              ) : null}
              {r.status === "open" ? (
                <div className="mt-2 flex gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => resolve(r.id, "reviewed")}
                    className="rounded border border-keep-action/60 bg-keep-action/10 px-2 py-0.5 text-keep-action hover:bg-keep-action/20"
                  >
                    Reviewed (acted on)
                  </button>
                  <button
                    type="button"
                    onClick={() => resolve(r.id, "dismissed")}
                    className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                  >
                    Dismiss
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* =========================================================
 *  Audit tab — append-only feed of admin/mod actions
 * ========================================================= */
function AuditTab() {
  const [actionFilter, setActionFilter] = useState("");
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    const qs = actionFilter ? `?action=${encodeURIComponent(actionFilter)}` : "";
    fetch(`/admin/audit${qs}`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return r.json() as Promise<{ entries: AuditEntry[] }>;
      })
      .then((j) => { if (!cancelled) setEntries(j.entries); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "load failed"); });
    return () => { cancelled = true; };
  }, [actionFilter, refreshKey]);

  return (
    <section className="space-y-2 text-sm">
      <header className="flex items-center justify-between">
        <h3 className="font-action text-base">Audit log</h3>
        <div className="flex items-center gap-2 text-xs">
          <input
            type="text"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value.trim())}
            placeholder="Filter by action (e.g. ban)"
            className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5"
          />
          <button
            type="button"
            onClick={() => setRefreshKey((k) => k + 1)}
            className="rounded border border-keep-rule bg-keep-banner/40 px-2 py-0.5 hover:bg-keep-banner"
          >
            Refresh
          </button>
        </div>
      </header>
      {error ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div> : null}
      {entries === null ? (
        <p className="italic text-keep-muted">Loading audit entries...</p>
      ) : entries.length === 0 ? (
        <p className="italic text-keep-muted">No matching entries.</p>
      ) : (
        <ul className="space-y-1">
          {entries.map((e) => (
            <li key={e.id} className="rounded border border-keep-rule/60 bg-keep-bg p-2 text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span>
                  <span className="font-mono uppercase text-keep-action">{e.action}</span>
                  {" · "}
                  <span className="font-semibold">{e.actorDisplayName}</span>
                  {e.targetDisplayName ? (
                    <>
                      {" → "}
                      <span className="font-semibold">{e.targetDisplayName}</span>
                    </>
                  ) : null}
                  {e.targetRoomName ? (
                    <>
                      {" in "}
                      <span className="italic">{e.targetRoomName}</span>
                    </>
                  ) : null}
                </span>
                <span className="text-keep-muted" title={new Date(e.createdAt).toLocaleString()}>
                  {new Date(e.createdAt).toLocaleString()}
                </span>
              </div>
              {e.reason ? <div className="mt-1 italic">"{e.reason}"</div> : null}
              {e.metadata && Object.keys(e.metadata).length > 0 ? (
                <div className="mt-1 font-mono text-[10px] text-keep-muted">
                  {JSON.stringify(e.metadata)}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* =========================================================
 *  Affiliates tab — partners / sponsors carousel manager
 * =========================================================
 *
 * Each row is admin-trusted raw HTML (topsite networks like toprpsites
 * require a specific anchor + tracking-pixel snippet). The HTML is rendered
 * verbatim on the splash via dangerouslySetInnerHTML; sanitizing it would
 * strip the very tracking pixels these networks are validating against.
 *
 * Same trust posture as customHeadHtml in Settings - if an admin pastes
 * hostile HTML, that's an admin-account-compromise problem.
 */
interface AffiliateRow {
  id: string;
  label: string;
  html: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

function AffiliatesTab() {
  const [rows, setRows] = useState<AffiliateRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    setError(null);
    try {
      const r = await fetch("/admin/affiliates", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { affiliates: AffiliateRow[] };
      setRows(j.affiliates);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    }
  }
  useEffect(() => { load(); }, []);

  async function remove(id: string) {
    if (!window.confirm("Delete this affiliate entry?")) return;
    try {
      const r = await fetch(`/admin/affiliates/${id}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    }
  }

  async function patch(id: string, body: Partial<{ label: string; html: string; enabled: boolean; sortOrder: number }>) {
    try {
      const r = await fetch(`/admin/affiliates/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    }
  }

  return (
    <section className="space-y-3 text-sm">
      <header className="flex items-center justify-between">
        <h3 className="font-action text-base">Affiliates / Partners / Sponsors</h3>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded border border-keep-rule bg-keep-banner px-2 py-0.5 text-xs hover:bg-keep-banner/80"
        >
          + Add
        </button>
      </header>
      <p className="text-[11px] text-keep-muted">
        Each entry is rendered as raw HTML in the splash carousel. Topsite networks (toprpsites etc.) require their
        own anchor and tracking-pixel snippet, so the HTML you paste is NOT sanitized. Treat the field the same as
        analytics scripts in Settings: only paste HTML you trust.
      </p>
      {error ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
      ) : null}
      {creating ? (
        <AffiliateForm
          mode="create"
          onCancel={() => setCreating(false)}
          onSaved={async () => { setCreating(false); await load(); }}
        />
      ) : null}
      {rows === null ? (
        <p className="italic text-keep-muted">Loading...</p>
      ) : rows.length === 0 ? (
        <p className="italic text-keep-muted">No affiliates yet. Add one to surface it on the splash.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <AffiliateListItem
              key={r.id}
              row={r}
              onPatch={(body) => patch(r.id, body)}
              onDelete={() => remove(r.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function AffiliateListItem({
  row,
  onPatch,
  onDelete,
}: {
  row: AffiliateRow;
  onPatch: (body: Partial<{ label: string; html: string; enabled: boolean; sortOrder: number }>) => Promise<void>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <li>
        <AffiliateForm
          mode="edit"
          initial={row}
          onCancel={() => setEditing(false)}
          onSaved={async (body) => { await onPatch(body); setEditing(false); }}
        />
      </li>
    );
  }
  return (
    <li className="rounded border border-keep-rule/60 bg-keep-bg p-2 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <span className={`mr-2 inline-block h-2 w-2 rounded-full ${row.enabled ? "bg-keep-action" : "bg-keep-rule"}`} />
          <span className="font-semibold">{row.label}</span>
          <span className="ml-2 text-[10px] text-keep-muted">order: {row.sortOrder}</span>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => onPatch({ enabled: !row.enabled })}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
          >
            {row.enabled ? "Disable" : "Enable"}
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="keep-button rounded border border-keep-accent/50 bg-keep-bg px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10"
          >
            Delete
          </button>
        </div>
      </div>
      <details className="mt-1">
        <summary className="cursor-pointer text-[10px] uppercase tracking-widest text-keep-muted">HTML preview</summary>
        <div
          className="mt-1 rounded border border-keep-rule/40 bg-keep-panel/30 p-2 [&_img]:max-h-12"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: row.html }}
        />
        <pre className="mt-1 overflow-x-auto rounded bg-keep-panel/30 p-2 text-[10px] text-keep-muted">{row.html}</pre>
      </details>
    </li>
  );
}

function AffiliateForm({
  mode,
  initial,
  onCancel,
  onSaved,
}: {
  mode: "create" | "edit";
  initial?: AffiliateRow;
  onCancel: () => void;
  onSaved: (body: { label: string; html: string; enabled: boolean; sortOrder: number }) => Promise<void>;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [html, setHtml] = useState(initial?.html ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [sortOrder, setSortOrder] = useState(initial?.sortOrder ?? 0);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!label.trim() || !html.trim()) return;
    setBusy(true);
    try {
      if (mode === "create") {
        const r = await fetch("/admin/affiliates", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: label.trim(), html, enabled, sortOrder }),
        });
        if (!r.ok) throw new Error(await readError(r));
        await onSaved({ label: label.trim(), html, enabled, sortOrder });
      } else {
        await onSaved({ label: label.trim(), html, enabled, sortOrder });
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded border border-keep-action/40 bg-keep-bg p-2 text-xs">
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Label (admin-only)</span>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={80}
          placeholder="e.g. Top RP Sites"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
        />
      </label>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">HTML snippet</span>
        <textarea
          value={html}
          onChange={(e) => setHtml(e.target.value)}
          rows={6}
          placeholder='<a href="..."><img src="..." alt="..." /></a>'
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-[11px] outline-none focus:border-keep-action"
        />
        <span className="mt-0.5 block text-[10px] text-keep-muted">
          Paste verbatim from the affiliate's provided code. Tracking pixels and similar pass through unchanged.
        </span>
      </label>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>Enabled</span>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-keep-muted">Sort order:</span>
          <input
            type="number"
            min={0}
            max={1000}
            value={sortOrder}
            onChange={(e) => setSortOrder(parseInt(e.target.value, 10) || 0)}
            className="w-16 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 outline-none focus:border-keep-action"
          />
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-0.5 hover:bg-keep-banner"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || !label.trim() || !html.trim()}
          className="keep-button rounded border border-keep-rule bg-keep-banner px-3 py-0.5 hover:bg-keep-banner/80 disabled:opacity-50"
        >
          {busy ? "Saving..." : mode === "create" ? "Create" : "Save"}
        </button>
      </div>
    </form>
  );
}
