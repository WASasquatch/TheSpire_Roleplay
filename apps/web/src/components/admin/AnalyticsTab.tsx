/**
 * Admin → Analytics tab (plan_ext.md §6 + the engagement overhaul).
 *
 * Reads the three staff-only, pre-aggregated read endpoints:
 *   GET /admin/analytics/public     — hits over time, top referrers, coarse
 *                                     geo, top pages, bot-vs-human split.
 *   GET /admin/analytics/inapp      — top modals / sub-tabs / rooms / servers /
 *                                     features + a per-day event series.
 *   GET /admin/analytics/engagement — durable per-day registrations / active
 *                                     users / messages / forum posts, D1/D7
 *                                     retention cohorts and the per-feature /
 *                                     per-server ledger breakdown.
 *
 * All are gated by `view_admin_analytics` (the outer AdminPanel already hides
 * the whole tab; the server re-checks the permission on every call). A shared
 * range selector (7/30/90d) and a human/bot toggle drive every fetch at once.
 *
 * Organized into four internal subtabs (Overview / Engagement / Traffic /
 * Features) following the AdminSettingsTab pattern: hidden sections stay
 * MOUNTED (HTML `hidden`), subtab switches record
 * `recordNav("tab", "admin:analytics:<sub>")`, and find-a-setting jumps ride
 * the `findRequest` prop so an anchor on a hidden subtab is un-hidden before
 * the scroll + flash runs.
 *
 * No charting dependency: line charts are the hand-rolled SVG primitives in
 * analyticsCharts.tsx (theme-token colors, crosshair tooltips, legends,
 * table-view twins); ranked breakdowns keep the CountTable proportional bars.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDate, formatNumber } from "../../lib/intlFormat.js";
import { useReducedMotion } from "../../lib/reducedMotion.js";
import { recordNav } from "../../lib/nav-metrics.js";
import { TabBtn } from "../shared/TabBtn.js";
import { afterNextPaint, flashAnchor } from "./FindSetting.js";
import type { AnalyticsSubtab } from "./adminSearchIndex.js";
import { ChartWithTable, StatTile, type ChartSeries } from "./analyticsCharts.js";

type Range = 7 | 30 | 90;

interface PublicSeriesPoint {
  day: string;
  pageviews: number;
  visitors: number;
}
interface PublicResponse {
  range: Range;
  includeBots: boolean;
  series: PublicSeriesPoint[];
  topPages: Array<{ path: string; count: number }>;
  referrers: Array<{ medium: string; source: string | null; count: number }>;
  geo: Array<{ country: string; count: number }>;
  botSplit: { human: number; bot: number };
}

interface KeyCount {
  key: string;
  count: number;
  /** Human-readable label resolved server-side; falls back to `key`. */
  label?: string;
}
interface InappResponse {
  range: Range;
  includeBots: boolean;
  series: Array<{ day: string; count: number }>;
  modals: KeyCount[];
  tabs: KeyCount[];
  rooms: KeyCount[];
  servers: KeyCount[];
  features: KeyCount[];
  pages: KeyCount[];
  profiles: KeyCount[];
  worlds: KeyCount[];
  forums: KeyCount[];
  serverPages: KeyCount[];
  stories: KeyCount[];
  faqs: KeyCount[];
}

interface EngagementResponse {
  range: Range;
  series: Array<{
    day: string;
    registrations: number;
    actives: number;
    messages: number;
    forumPosts: number;
  }>;
  /** d1/d7 are retained-user COUNTS; null while the cohort window is open. */
  retention: Array<{ day: string; registrations: number; d1: number | null; d7: number | null }>;
  features: Array<{ bucket: string; serverId: string; count: number }>;
  servers: Array<{ id: string; label: string }>;
}

const RANGES: Range[] = [7, 30, 90];

/** Subtab strip order. Ids double as the recordNav suffix — never change. */
const ANALYTICS_SUBTABS: readonly AnalyticsSubtab[] = [
  "overview",
  "engagement",
  "traffic",
  "features",
];

/** Feature buckets with curated labels; unknown buckets fall back to the key. */
const FEATURE_BUCKET_KEYS = new Set([
  "games",
  "purchases",
  "items",
  "scriptorium",
  "presence",
  "transfers",
  "other",
]);

function fmtNum(n: number): string {
  return formatNumber(n);
}

/** Signed delta text ("+3" / "-2") in the active locale. */
function signedNum(n: number): string {
  return n > 0 ? `+${formatNumber(n)}` : formatNumber(n);
}

/** Section frame matching the other admin tabs' fieldset style. */
function Section({ title, anchor, children, hint }: { title: string; anchor?: string; children: React.ReactNode; hint?: string }) {
  return (
    // `anchor` is the find-a-setting jump target (adminSearchIndex.ts): the
    // section's own catalog title key, stamped verbatim as data-admin-anchor.
    <fieldset {...(anchor ? { "data-admin-anchor": anchor } : {})} className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">{title}</legend>
      {hint ? <p className="mb-2 text-[10px] text-keep-muted">{hint}</p> : null}
      {children}
    </fieldset>
  );
}

/** A simple headline stat. */
function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-keep-muted">{label}</span>
      <span className="font-mono text-base text-keep-text">{value}</span>
    </div>
  );
}

/** A ranked count table with an inline proportional bar per row. */
function CountTable({
  rows,
  labelHead,
  renderLabel,
  empty,
}: {
  rows: Array<{ count: number }>;
  labelHead: string;
  renderLabel: (row: any, i: number) => React.ReactNode;
  empty: string;
}) {
  const { t } = useTranslation("admin");
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (rows.length === 0) return <p className="text-keep-muted">{empty}</p>;
  return (
    <table className="w-full text-left">
      <thead>
        <tr className="text-[10px] uppercase tracking-wider text-keep-muted">
          <th className="pb-1 font-normal">{labelHead}</th>
          <th className="pb-1 text-right font-normal">{t("analytics.countHead")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-keep-rule/50">
            <td className="py-1 pr-2">
              <div className="relative">
                <div
                  className="absolute inset-y-0 left-0 bg-keep-accent/15"
                  style={{ width: `${(r.count / max) * 100}%` }}
                  aria-hidden
                />
                <span className="relative block truncate text-keep-text">{renderLabel(r, i)}</span>
              </div>
            </td>
            <td className="py-1 text-right font-mono text-keep-text">{fmtNum(r.count)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface GeoStatus {
  configured: boolean;
  loaded: boolean;
  dbMtimeMs: number | null;
  lastDownloadMs: number | null;
  lastError: string | null;
}

/**
 * Optional MaxMind GeoIP2 accuracy upgrade. Country geo always works from a
 * bundled database; supplying a free MaxMind Account ID + License key lets the
 * server download a fresher GeoLite2-City database for city-level accuracy. The
 * key is write-only — the server only reports whether it's configured, never
 * the value. Saving triggers an immediate download so the result is shown here.
 */
function GeoAccuracy() {
  const { t } = useTranslation("admin");
  const [status, setStatus] = useState<GeoStatus | null>(null);
  const [accountId, setAccountId] = useState("");
  const [licenseKey, setLicenseKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch("/admin/geo/status", { credentials: "include" });
      if (r.ok) setStatus((await r.json()) as GeoStatus);
    } catch {
      /* leave status null — the section just shows the bundled-data baseline */
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const save = useCallback(
    async (clear: boolean) => {
      setBusy(true);
      setMsg(null);
      try {
        const r = await fetch("/admin/geo/maxmind", {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(clear ? { accountId: "", licenseKey: "" } : { accountId, licenseKey }),
        });
        if (!r.ok) {
          setMsg(
            r.status === 403
              ? t("analytics.saveFailedPermission")
              : t("analytics.saveFailedStatus", { status: r.status }),
          );
          return;
        }
        const s = (await r.json()) as GeoStatus;
        setStatus(s);
        setAccountId("");
        setLicenseKey("");
        if (clear) setMsg(t("analytics.geoReverted"));
        else if (s.loaded) setMsg(t("analytics.geoSavedActive"));
        else setMsg(s.lastError ? t("analytics.geoSavedDownloadFailed", { error: s.lastError }) : t("saved"));
      } catch (err) {
        setMsg(err instanceof Error ? err.message : t("analytics.saveFailedDot"));
      } finally {
        setBusy(false);
      }
    },
    [accountId, licenseKey, t],
  );

  const input = "rounded border border-keep-rule bg-keep-bg px-2 py-1 text-keep-text";
  const btn =
    "keep-button rounded border border-keep-rule bg-keep-bg px-2 py-1 hover:bg-keep-banner/60 disabled:opacity-50";

  return (
    <Section
      anchor="analytics.geoAccuracyTitle"
      title={t("analytics.geoAccuracyTitle")}
      hint={t("analytics.geoAccuracyHint")}
    >
      <div className="mb-2 text-keep-muted">
        {status?.loaded ? (
          <span className="text-keep-text">
            {status.dbMtimeMs
              ? t("analytics.geoUpgradedWithDate", { date: formatDate(status.dbMtimeMs) })
              : t("analytics.geoUpgraded")}
          </span>
        ) : status?.configured ? (
          <span>
            {status.lastError
              ? t("analytics.geoKeySavedError", { error: status.lastError })
              : t("analytics.geoKeySaved")}
          </span>
        ) : (
          <span>{t("analytics.geoBundled")}</span>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-keep-muted">{t("analytics.accountId")}</span>
          <input
            className={input + " w-28"}
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-keep-muted">{t("analytics.licenseKey")}</span>
          <input
            className={input + " w-56"}
            type="password"
            value={licenseKey}
            onChange={(e) => setLicenseKey(e.target.value)}
            autoComplete="off"
            placeholder={status?.configured ? t("analytics.keySetPlaceholder") : ""}
          />
        </label>
        <button
          type="button"
          className={btn}
          disabled={busy || !accountId.trim() || !licenseKey.trim()}
          onClick={() => void save(false)}
        >
          {busy ? t("common:saving") : t("analytics.saveDownload")}
        </button>
        {status?.configured ? (
          <button type="button" className={btn} disabled={busy} onClick={() => void save(true)}>
            {t("analytics.removeKey")}
          </button>
        ) : null}
      </div>
      {msg ? <p className="mt-2 text-[10px] text-keep-muted">{msg}</p> : null}
    </Section>
  );
}

interface AnalyticsTabProps {
  /** Find-a-setting jump handed down by the AdminPanel shell: land on
   *  `subtab`, then scroll to + flash `data-admin-anchor={anchor}`.
   *  Mirrors the SettingsTab contract (docs/ADMIN_IA.md §5.3). */
  findRequest?: { subtab: AnalyticsSubtab; anchor: string } | null;
  /** Called once the jump has been handled so the shell can disarm it. */
  onFindHandled?: () => void;
}

export function AnalyticsTab({ findRequest, onFindHandled }: AnalyticsTabProps = {}) {
  const { t } = useTranslation("admin");
  const [range, setRange] = useState<Range>(30);
  const [includeBots, setIncludeBots] = useState(false);
  const [pub, setPub] = useState<PublicResponse | null>(null);
  const [inapp, setInapp] = useState<InappResponse | null>(null);
  const [eng, setEng] = useState<EngagementResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Feature breakdown's server scope ("" = all). Client-side filter over the
  // per-server dim rows — no refetch, and series colors never re-assign.
  const [serverFilter, setServerFilter] = useState("");

  // Which section is on screen. Sections stay MOUNTED and toggle the HTML
  // `hidden` attribute (AdminSettingsTab pattern) so chart hover state and
  // the geo form survive subtab hops.
  const [subtab, setSubtab] = useState<AnalyticsSubtab>("overview");
  const changeSubtab = (next: AnalyticsSubtab) => {
    // Same section-switch analytics choke point as the outer tab strip
    // (stable enum key, never free text). Find-a-setting jumps set the
    // state directly instead — the pick already went through the panel's
    // changeTab recordNav, so routing them here would double-count.
    if (next !== subtab) recordNav("tab", `admin:analytics:${next}`);
    setSubtab(next);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const qs = `range=${range}${includeBots ? "&includeBots=1" : ""}`;
    try {
      const [pr, ir, er] = await Promise.all([
        fetch(`/admin/analytics/public?${qs}`, { credentials: "include" }),
        fetch(`/admin/analytics/inapp?${qs}`, { credentials: "include" }),
        fetch(`/admin/analytics/engagement?range=${range}`, { credentials: "include" }),
      ]);
      if (!pr.ok) throw new Error(t("analytics.publicStatus", { status: pr.status }));
      if (!ir.ok) throw new Error(t("analytics.inappStatus", { status: ir.status }));
      if (!er.ok) throw new Error(t("analytics.engagementStatus", { status: er.status }));
      setPub((await pr.json()) as PublicResponse);
      setInapp((await ir.json()) as InappResponse);
      setEng((await er.json()) as EngagementResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("analytics.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [range, includeBots, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Drop the server filter when its target leaves the fetched server list
  // (e.g. a range switch): otherwise the select shows an unmatched value —
  // or unmounts entirely — while the feature table keeps filtering on it.
  useEffect(() => {
    if (serverFilter && !(eng?.servers ?? []).some((s) => s.id === serverFilter)) {
      setServerFilter("");
    }
  }, [eng, serverFilter]);

  // Find-a-setting jump: un-hide the owning subtab FIRST (a hidden element
  // can't be scrolled to), then scroll + flash after that swap has painted.
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    if (!findRequest) return;
    setSubtab(findRequest.subtab);
    return afterNextPaint(() => {
      flashAnchor(findRequest.anchor, reduceMotion);
      onFindHandled?.();
    });
  }, [findRequest, reduceMotion, onFindHandled]);

  const totals = useMemo(() => {
    if (!pub) return { pageviews: 0, visitors: 0 };
    let pageviews = 0;
    let visitors = 0;
    for (const p of pub.series) {
      pageviews += p.pageviews;
      visitors += p.visitors;
    }
    return { pageviews, visitors };
  }, [pub]);

  /* ----- KPI tiles (Overview) ----- */
  const kpis = useMemo(() => {
    const s = eng?.series ?? [];
    const len = s.length;
    const yesterday = len >= 2 ? s[len - 2]! : null;
    const dayBefore = len >= 3 ? s[len - 3]! : null;
    const sumLast = (days: number, offset: number, pick: (p: (typeof s)[number]) => number) => {
      let sum = 0;
      let seen = 0;
      for (let i = len - 1 - offset; i >= 0 && seen < days; i--, seen++) sum += pick(s[i]!);
      return seen === days ? sum : null;
    };
    const reg7 = sumLast(7, 0, (p) => p.registrations);
    const reg7Prev = sumLast(7, 7, (p) => p.registrations);

    // D1 retention: average over the most recent CLOSED cohorts in-window
    // (up to 7), weighted by cohort size.
    let d1Num = 0;
    let d1Den = 0;
    let cohorts = 0;
    const ret = eng?.retention ?? [];
    for (let i = ret.length - 1; i >= 0 && cohorts < 7; i--) {
      const r = ret[i]!;
      if (r.d1 == null || r.registrations <= 0) continue;
      d1Num += r.d1;
      d1Den += r.registrations;
      cohorts++;
    }

    const sparkOf = (pick: (p: (typeof s)[number]) => number) =>
      s.slice(-14).map((p) => pick(p));

    return {
      activesYesterday: yesterday ? yesterday.actives : null,
      activesDelta: yesterday && dayBefore ? yesterday.actives - dayBefore.actives : null,
      activesSpark: sparkOf((p) => p.actives),
      messagesYesterday: yesterday ? yesterday.messages : null,
      messagesDelta: yesterday && dayBefore ? yesterday.messages - dayBefore.messages : null,
      messagesSpark: sparkOf((p) => p.messages),
      reg7,
      reg7Delta: reg7 != null && reg7Prev != null ? reg7 - reg7Prev : null,
      regSpark: sparkOf((p) => p.registrations),
      d1Pct: d1Den > 0 ? Math.round((100 * d1Num) / d1Den) : null,
    };
  }, [eng]);

  /* ----- Engagement chart series (fixed slot order: action, accent) ----- */
  const engDays = useMemo(() => (eng?.series ?? []).map((p) => p.day), [eng]);
  const regSeries = useMemo<ChartSeries[]>(
    () => [
      {
        key: "registrations",
        label: t("analytics.seriesRegistrations"),
        values: (eng?.series ?? []).map((p) => p.registrations),
      },
    ],
    [eng, t],
  );
  const activeSeries = useMemo<ChartSeries[]>(
    () => [
      {
        key: "actives",
        label: t("analytics.seriesActives"),
        values: (eng?.series ?? []).map((p) => p.actives),
      },
    ],
    [eng, t],
  );
  const messageSeries = useMemo<ChartSeries[]>(
    () => [
      {
        key: "chat",
        label: t("analytics.seriesChat"),
        values: (eng?.series ?? []).map((p) => p.messages),
      },
      {
        key: "forum",
        label: t("analytics.seriesForum"),
        values: (eng?.series ?? []).map((p) => p.forumPosts),
      },
    ],
    [eng, t],
  );
  const retentionDays = useMemo(() => (eng?.retention ?? []).map((r) => r.day), [eng]);
  const retentionSeries = useMemo<ChartSeries[]>(() => {
    const pct = (retained: number | null, regs: number): number | null =>
      retained == null || regs <= 0 ? null : Math.round((100 * retained) / regs);
    return [
      {
        key: "d1",
        label: t("analytics.seriesD1"),
        values: (eng?.retention ?? []).map((r) => pct(r.d1, r.registrations)),
      },
      {
        key: "d7",
        label: t("analytics.seriesD7"),
        values: (eng?.retention ?? []).map((r) => pct(r.d7, r.registrations)),
      },
    ];
  }, [eng, t]);

  /* ----- Traffic chart series ----- */
  const trafficDays = useMemo(() => (pub?.series ?? []).map((p) => p.day), [pub]);
  const trafficSeries = useMemo<ChartSeries[]>(
    () => [
      {
        key: "pageviews",
        label: t("analytics.pageviews"),
        values: (pub?.series ?? []).map((p) => p.pageviews),
      },
      {
        key: "visitors",
        label: t("analytics.visitors"),
        values: (pub?.series ?? []).map((p) => p.visitors),
      },
    ],
    [pub, t],
  );

  /* ----- Feature breakdown (per-server dim, filtered client-side) ----- */
  const featureRows = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of eng?.features ?? []) {
      if (serverFilter && f.serverId !== serverFilter) continue;
      m.set(f.bucket, (m.get(f.bucket) ?? 0) + f.count);
    }
    return [...m.entries()]
      .map(([bucket, count]) => ({ bucket, count }))
      .sort((a, b) => b.count - a.count);
  }, [eng, serverFilter]);
  const bucketLabel = (bucket: string): string =>
    FEATURE_BUCKET_KEYS.has(bucket) ? t(`analytics.featureBucket.${bucket}`) : bucket;

  const pctFmt = (n: number) => `${formatNumber(n)}%`;

  return (
    <div className="space-y-3 text-xs">
      {/* ----- controls (one filter row; scopes every subtab below) ----- */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-keep-muted">{t("analytics.range")}</span>
          <div className="flex overflow-hidden rounded border border-keep-rule">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={`px-2 py-1 ${range === r ? "bg-keep-accent/30 text-keep-text" : "bg-keep-bg text-keep-muted hover:bg-keep-banner/60"}`}
              >
                {t("analytics.rangeDays", { days: r })}
              </button>
            ))}
          </div>
          <label className="ml-2 flex items-center gap-1 text-keep-muted">
            <input
              type="checkbox"
              checked={includeBots}
              onChange={(e) => setIncludeBots(e.target.checked)}
            />
            {t("analytics.includeBots")}
          </label>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-1 hover:bg-keep-banner/60"
        >
          {loading ? t("common:loading") : t("refresh")}
        </button>
      </div>

      {error ? (
        <div className="rounded border border-keep-rule p-3 text-keep-muted">
          {t("analytics.loadError", { error })}
        </div>
      ) : null}

      {/* ----- subtab strip (AdminSettingsTab pattern) ----- */}
      <nav
        aria-label={t("analytics.subtabAria")}
        className="flex flex-wrap items-center gap-1 text-xs uppercase tracking-widest"
      >
        {ANALYTICS_SUBTABS.map((s) => (
          <TabBtn key={s} active={subtab === s} onClick={() => changeSubtab(s)}>
            {t(`analytics.subtab.${s}`)}
          </TabBtn>
        ))}
      </nav>

      {/* ================= OVERVIEW ================= */}
      <section hidden={subtab !== "overview"} className="space-y-3">
        <Section anchor="analytics.kpiTitle" title={t("analytics.kpiTitle")} hint={t("analytics.kpiHint")}>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <StatTile
              label={t("analytics.kpiActivesYesterday")}
              value={kpis.activesYesterday != null ? fmtNum(kpis.activesYesterday) : "—"}
              delta={
                kpis.activesDelta != null
                  ? t("analytics.kpiVsPrior", { value: signedNum(kpis.activesDelta) })
                  : null
              }
              spark={kpis.activesSpark}
            />
            <StatTile
              label={t("analytics.kpiRetentionD1")}
              value={kpis.d1Pct != null ? `${kpis.d1Pct}%` : "—"}
              delta={kpis.d1Pct == null ? t("analytics.kpiNoDelta") : null}
            />
            <StatTile
              label={t("analytics.kpiMessagesYesterday")}
              value={kpis.messagesYesterday != null ? fmtNum(kpis.messagesYesterday) : "—"}
              delta={
                kpis.messagesDelta != null
                  ? t("analytics.kpiVsPrior", { value: signedNum(kpis.messagesDelta) })
                  : null
              }
              spark={kpis.messagesSpark}
            />
            <StatTile
              label={t("analytics.kpiRegistrations7d")}
              value={kpis.reg7 != null ? fmtNum(kpis.reg7) : "—"}
              delta={
                kpis.reg7Delta != null
                  ? t("analytics.kpiVsPrior7", { value: signedNum(kpis.reg7Delta) })
                  : t("analytics.kpiNoDelta")
              }
              spark={kpis.regSpark}
            />
          </div>
        </Section>
        <Section title={t("analytics.engActives")} hint={t("analytics.engHint")}>
          <ChartWithTable
            days={engDays}
            series={activeSeries}
            fillArea
            ariaLabel={t("analytics.chartAria", { title: t("analytics.engActives") })}
          />
        </Section>
      </section>

      {/* ================= ENGAGEMENT ================= */}
      <section hidden={subtab !== "engagement"} className="space-y-3">
        <Section
          anchor="analytics.engRegistrations"
          title={t("analytics.engRegistrations")}
          hint={t("analytics.engHint")}
        >
          <ChartWithTable
            days={engDays}
            series={regSeries}
            fillArea
            ariaLabel={t("analytics.chartAria", { title: t("analytics.engRegistrations") })}
          />
        </Section>
        <Section
          anchor="analytics.engActives"
          title={t("analytics.engActives")}
          hint={t("analytics.engActivesHint")}
        >
          <ChartWithTable
            days={engDays}
            series={activeSeries}
            fillArea
            ariaLabel={t("analytics.chartAria", { title: t("analytics.engActives") })}
          />
        </Section>
        <Section
          anchor="analytics.engMessages"
          title={t("analytics.engMessages")}
          hint={t("analytics.engMessagesHint")}
        >
          <ChartWithTable
            days={engDays}
            series={messageSeries}
            ariaLabel={t("analytics.chartAria", { title: t("analytics.engMessages") })}
          />
        </Section>
        <Section
          anchor="analytics.engRetention"
          title={t("analytics.engRetention")}
          hint={t("analytics.engRetentionHint")}
        >
          <ChartWithTable
            days={retentionDays}
            series={retentionSeries}
            yMax={100}
            formatValue={pctFmt}
            ariaLabel={t("analytics.chartAria", { title: t("analytics.engRetention") })}
          />
        </Section>
      </section>

      {/* ================= TRAFFIC ================= */}
      <section hidden={subtab !== "traffic"} className="space-y-3">
        <Section anchor="analytics.hitsOverTime" title={t("analytics.hitsOverTime")}>
          <div className="mb-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label={t("analytics.pageviews")} value={fmtNum(totals.pageviews)} />
            <Stat label={t("analytics.uniqueVisitors")} value={fmtNum(totals.visitors)} />
            <Stat label={t("analytics.humanHits")} value={pub ? fmtNum(pub.botSplit.human) : "—"} />
            <Stat label={t("analytics.botHits")} value={pub ? fmtNum(pub.botSplit.bot) : "—"} />
          </div>
          <ChartWithTable
            days={trafficDays}
            series={trafficSeries}
            ariaLabel={t("analytics.chartAria", { title: t("analytics.hitsOverTime") })}
          />
        </Section>

        <div className="grid gap-3 md:grid-cols-2">
          <Section anchor="analytics.topReferrers" title={t("analytics.topReferrers")}>
            <CountTable
              rows={pub?.referrers ?? []}
              labelHead={t("analytics.sourceMedium")}
              empty={t("analytics.noReferrers")}
              renderLabel={(r) => (
                <>
                  {r.source ? <span>{r.source}</span> : <span className="text-keep-muted">{t("analytics.noneSource")}</span>}
                  <span className="text-keep-muted"> · {r.medium}</span>
                </>
              )}
            />
          </Section>

          <Section anchor="analytics.geoBreakdown" title={t("analytics.geoBreakdown")} hint={t("analytics.geoHint")}>
            <CountTable
              rows={pub?.geo ?? []}
              labelHead={t("analytics.country")}
              empty={t("analytics.noGeo")}
              renderLabel={(r) => <span className="font-mono">{r.country}</span>}
            />
          </Section>
        </div>

        <GeoAccuracy />

        <Section anchor="analytics.topPages" title={t("analytics.topPages")}>
          <CountTable
            rows={pub?.topPages ?? []}
            labelHead={t("analytics.pathTemplate")}
            empty={t("analytics.noPageviews")}
            renderLabel={(r) => <span className="font-mono">{r.path}</span>}
          />
        </Section>
      </section>

      {/* ================= FEATURES ================= */}
      <section hidden={subtab !== "features"} className="space-y-3">
        <Section
          anchor="analytics.featureUsageTitle"
          title={t("analytics.featureUsageTitle")}
          hint={
            // The server-picker sentence only when the picker renders (>1).
            t("analytics.featureUsageHint") +
            ((eng?.servers.length ?? 0) > 1 ? " " + t("analytics.featureUsageServerHint") : "")
          }
        >
          {(eng?.servers.length ?? 0) > 1 ? (
            <label className="mb-2 flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider text-keep-muted">
                {t("analytics.serverFilterLabel")}
              </span>
              <select
                value={serverFilter}
                onChange={(e) => setServerFilter(e.target.value)}
                className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-keep-text"
              >
                <option value="">{t("analytics.serverFilterAll")}</option>
                {(eng?.servers ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <CountTable
            rows={featureRows}
            labelHead={t("analytics.feature")}
            empty={t("analytics.noEngagement")}
            renderLabel={(r) => <span>{bucketLabel(r.bucket)}</span>}
          />
        </Section>

        {/* ----- in-app destinations ----- */}
        <Section
          anchor="analytics.inAppTitle"
          title={t("analytics.inAppTitle")}
          hint={t("analytics.inAppHint")}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-keep-muted">{t("analytics.modals")}</p>
              <CountTable
                rows={inapp?.modals ?? []}
                labelHead={t("analytics.modal")}
                empty={t("analytics.noModals")}
                renderLabel={(r) => <span className="font-mono">{r.key}</span>}
              />
            </div>
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-keep-muted">{t("analytics.subTabs")}</p>
              <CountTable
                rows={inapp?.tabs ?? []}
                labelHead={t("analytics.tab")}
                empty={t("analytics.noTabs")}
                renderLabel={(r) => <span className="font-mono">{r.key}</span>}
              />
            </div>
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-keep-muted">{t("analytics.rooms")}</p>
              <CountTable
                rows={inapp?.rooms ?? []}
                labelHead={t("analytics.room")}
                empty={t("analytics.noRooms")}
                renderLabel={(r) => <span>{r.label ?? r.key}</span>}
              />
            </div>
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-keep-muted">{t("analytics.servers")}</p>
              <CountTable
                rows={inapp?.servers ?? []}
                labelHead={t("analytics.server")}
                empty={t("analytics.noServers")}
                renderLabel={(r) => <span>{r.label ?? r.key}</span>}
              />
            </div>
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-keep-muted">{t("analytics.features")}</p>
              <CountTable
                rows={inapp?.features ?? []}
                labelHead={t("analytics.feature")}
                empty={t("analytics.noFeatures")}
                renderLabel={(r) => <span className="font-mono">{r.key}</span>}
              />
            </div>
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-keep-muted">{t("analytics.publicPages")}</p>
              <CountTable
                rows={inapp?.pages ?? []}
                labelHead={t("analytics.page")}
                empty={t("analytics.noPublicPages")}
                renderLabel={(r) => <span className="font-mono">{r.key}</span>}
              />
            </div>
          </div>
        </Section>

        {/* ----- public entity views (which specific page, by name) ----- */}
        <Section
          anchor="analytics.entityTitle"
          title={t("analytics.entityTitle")}
          hint={t("analytics.entityHint")}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-keep-muted">{t("analytics.profilesViewed")}</p>
              <CountTable
                rows={inapp?.profiles ?? []}
                labelHead={t("analytics.profile")}
                empty={t("analytics.noProfiles")}
                renderLabel={(r) => <span>{r.label ?? r.key}</span>}
              />
            </div>
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-keep-muted">{t("analytics.worldsViewed")}</p>
              <CountTable
                rows={inapp?.worlds ?? []}
                labelHead={t("analytics.world")}
                empty={t("analytics.noWorlds")}
                renderLabel={(r) => <span>{r.label ?? r.key}</span>}
              />
            </div>
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-keep-muted">{t("analytics.forumsViewed")}</p>
              <CountTable
                rows={inapp?.forums ?? []}
                labelHead={t("analytics.forum")}
                empty={t("analytics.noForums")}
                renderLabel={(r) => <span>{r.label ?? r.key}</span>}
              />
            </div>
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-keep-muted">{t("analytics.serverPagesViewed")}</p>
              <CountTable
                rows={inapp?.serverPages ?? []}
                labelHead={t("analytics.serverPage")}
                empty={t("analytics.noServerPages")}
                renderLabel={(r) => <span>{r.label ?? r.key}</span>}
              />
            </div>
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-keep-muted">{t("analytics.storiesViewed")}</p>
              <CountTable
                rows={inapp?.stories ?? []}
                labelHead={t("analytics.story")}
                empty={t("analytics.noStories")}
                renderLabel={(r) => <span>{r.label ?? r.key}</span>}
              />
            </div>
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-keep-muted">{t("analytics.faqsViewed")}</p>
              <CountTable
                rows={inapp?.faqs ?? []}
                labelHead={t("analytics.faq")}
                empty={t("analytics.noFaqs")}
                renderLabel={(r) => <span>{r.label ?? r.key}</span>}
              />
            </div>
          </div>
        </Section>
      </section>
    </div>
  );
}
