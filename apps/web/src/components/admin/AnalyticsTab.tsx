/**
 * Admin → Analytics tab (plan_ext.md §6).
 *
 * Reads the two staff-only, pre-aggregated read endpoints:
 *   GET /admin/analytics/public — hits over time, top referrers, coarse geo,
 *                                 top pages, bot-vs-human split.
 *   GET /admin/analytics/inapp  — top modals / sub-tabs / rooms / servers /
 *                                 features + a per-day event series.
 *
 * Both are gated by `view_admin_analytics` (the outer AdminPanel already hides
 * the whole tab; the server re-checks the permission on every call). A shared
 * range selector (7/30/90d) and a human/bot toggle drive both fetches at once.
 *
 * No charting dependency: the "hits over time" view is a hand-rolled inline
 * bar/column drawn with plain divs (CSS height percentages), which keeps the
 * bundle flat and matches the no-new-deps scope of this feature.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDate, formatNumber } from "../../lib/intlFormat.js";

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

const RANGES: Range[] = [7, 30, 90];

/** Compact 'MM-DD' label for a 'YYYY-MM-DD' day key. */
function shortDay(day: string): string {
  return day.length >= 10 ? day.slice(5) : day;
}

function fmtNum(n: number): string {
  return formatNumber(n);
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

/**
 * Dependency-free "hits over time" column chart. Two series (pageviews +
 * visitors) drawn as side-by-side CSS-height bars per day. Heights are scaled
 * to the max pageview count in-window so the tallest bar fills the plot.
 */
function HitsChart({ series }: { series: PublicSeriesPoint[] }) {
  const { t } = useTranslation("admin");
  const max = Math.max(1, ...series.map((p) => p.pageviews));
  if (series.length === 0) {
    return <p className="text-keep-muted">{t("analytics.noData")}</p>;
  }
  return (
    <div>
      <div className="flex items-end gap-[2px] h-32 border-b border-l border-keep-rule pl-1 pb-px">
        {series.map((p) => (
          <div
            key={p.day}
            className="flex flex-1 items-end justify-center gap-[1px]"
            title={t("analytics.dayTooltip", { day: p.day, views: fmtNum(p.pageviews), visitors: fmtNum(p.visitors) })}
          >
            <div
              className="w-full max-w-[10px] bg-keep-accent/70"
              style={{ height: `${(p.pageviews / max) * 100}%` }}
            />
            <div
              className="w-full max-w-[10px] bg-keep-muted/50"
              style={{ height: `${(p.visitors / max) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] text-keep-muted">
        <span>{series.length ? shortDay(series[0]!.day) : ""}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 bg-keep-accent/70" /> {t("analytics.pageviews")}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 bg-keep-muted/50" /> {t("analytics.visitors")}
          </span>
        </span>
        <span>{series.length ? shortDay(series[series.length - 1]!.day) : ""}</span>
      </div>
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

export function AnalyticsTab() {
  const { t } = useTranslation("admin");
  const [range, setRange] = useState<Range>(30);
  const [includeBots, setIncludeBots] = useState(false);
  const [pub, setPub] = useState<PublicResponse | null>(null);
  const [inapp, setInapp] = useState<InappResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const qs = `range=${range}${includeBots ? "&includeBots=1" : ""}`;
    try {
      const [pr, ir] = await Promise.all([
        fetch(`/admin/analytics/public?${qs}`, { credentials: "include" }),
        fetch(`/admin/analytics/inapp?${qs}`, { credentials: "include" }),
      ]);
      if (!pr.ok) throw new Error(t("analytics.publicStatus", { status: pr.status }));
      if (!ir.ok) throw new Error(t("analytics.inappStatus", { status: ir.status }));
      setPub((await pr.json()) as PublicResponse);
      setInapp((await ir.json()) as InappResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("analytics.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [range, includeBots, t]);

  useEffect(() => {
    void load();
  }, [load]);

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

  return (
    <div className="space-y-3 text-xs">
      {/* ----- controls ----- */}
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

      {/* ----- headline + hits over time ----- */}
      <Section anchor="analytics.hitsOverTime" title={t("analytics.hitsOverTime")}>
        <div className="mb-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label={t("analytics.pageviews")} value={fmtNum(totals.pageviews)} />
          <Stat label={t("analytics.uniqueVisitors")} value={fmtNum(totals.visitors)} />
          <Stat label={t("analytics.humanHits")} value={pub ? fmtNum(pub.botSplit.human) : "—"} />
          <Stat label={t("analytics.botHits")} value={pub ? fmtNum(pub.botSplit.bot) : "—"} />
        </div>
        <HitsChart series={pub?.series ?? []} />
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
    </div>
  );
}
