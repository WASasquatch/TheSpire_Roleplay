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
}

const RANGES: Range[] = [7, 30, 90];

/** Compact 'MM-DD' label for a 'YYYY-MM-DD' day key. */
function shortDay(day: string): string {
  return day.length >= 10 ? day.slice(5) : day;
}

function fmtNum(n: number): string {
  return n.toLocaleString();
}

/** Section frame matching the other admin tabs' fieldset style. */
function Section({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
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
  const max = Math.max(1, ...series.map((p) => p.pageviews));
  if (series.length === 0) {
    return <p className="text-keep-muted">No data in this range yet.</p>;
  }
  return (
    <div>
      <div className="flex items-end gap-[2px] h-32 border-b border-l border-keep-rule pl-1 pb-px">
        {series.map((p) => (
          <div
            key={p.day}
            className="flex flex-1 items-end justify-center gap-[1px]"
            title={`${p.day}: ${fmtNum(p.pageviews)} views, ${fmtNum(p.visitors)} visitors`}
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
            <span className="inline-block h-2 w-2 bg-keep-accent/70" /> Pageviews
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 bg-keep-muted/50" /> Visitors
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
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (rows.length === 0) return <p className="text-keep-muted">{empty}</p>;
  return (
    <table className="w-full text-left">
      <thead>
        <tr className="text-[10px] uppercase tracking-wider text-keep-muted">
          <th className="pb-1 font-normal">{labelHead}</th>
          <th className="pb-1 text-right font-normal">Count</th>
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
              ? "Save failed (needs the Edit site settings permission)."
              : `Save failed (${r.status}).`,
          );
          return;
        }
        const s = (await r.json()) as GeoStatus;
        setStatus(s);
        setAccountId("");
        setLicenseKey("");
        if (clear) setMsg("Reverted to the bundled country database.");
        else if (s.loaded) setMsg("Saved. GeoLite2-City database downloaded and active.");
        else setMsg(s.lastError ? `Saved, but the download failed: ${s.lastError}` : "Saved.");
      } catch (err) {
        setMsg(err instanceof Error ? err.message : "Save failed.");
      } finally {
        setBusy(false);
      }
    },
    [accountId, licenseKey],
  );

  const input = "rounded border border-keep-rule bg-keep-bg px-2 py-1 text-keep-text";
  const btn =
    "keep-button rounded border border-keep-rule bg-keep-bg px-2 py-1 hover:bg-keep-banner/60 disabled:opacity-50";

  return (
    <Section
      title="Geo accuracy (optional)"
      hint="Country geo works out of the box from a bundled database. For fresher, city-level accuracy, paste a free MaxMind Account ID + License key (from your MaxMind account). The key is stored securely and never shown again."
    >
      <div className="mb-2 text-keep-muted">
        {status?.loaded ? (
          <span className="text-keep-text">
            Upgraded: GeoLite2-City active
            {status.dbMtimeMs ? ` (database from ${new Date(status.dbMtimeMs).toLocaleDateString()})` : ""}.
          </span>
        ) : status?.configured ? (
          <span>
            Key saved, but the database isn&apos;t loaded yet
            {status.lastError ? `: ${status.lastError}` : "."}
          </span>
        ) : (
          <span>Using the bundled country database.</span>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-keep-muted">Account ID</span>
          <input
            className={input + " w-28"}
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-keep-muted">License key</span>
          <input
            className={input + " w-56"}
            type="password"
            value={licenseKey}
            onChange={(e) => setLicenseKey(e.target.value)}
            autoComplete="off"
            placeholder={status?.configured ? "set — enter both to replace" : ""}
          />
        </label>
        <button
          type="button"
          className={btn}
          disabled={busy || !accountId.trim() || !licenseKey.trim()}
          onClick={() => void save(false)}
        >
          {busy ? "Saving…" : "Save & download"}
        </button>
        {status?.configured ? (
          <button type="button" className={btn} disabled={busy} onClick={() => void save(true)}>
            Remove key
          </button>
        ) : null}
      </div>
      {msg ? <p className="mt-2 text-[10px] text-keep-muted">{msg}</p> : null}
    </Section>
  );
}

export function AnalyticsTab() {
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
      if (!pr.ok) throw new Error(`public ${pr.status}`);
      if (!ir.ok) throw new Error(`inapp ${ir.status}`);
      setPub((await pr.json()) as PublicResponse);
      setInapp((await ir.json()) as InappResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load analytics");
    } finally {
      setLoading(false);
    }
  }, [range, includeBots]);

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

  // Coarse country comes from the bundled GeoLite2 snapshot (geoip-lite); it
  // only fills in for hits recorded after that shipped, so recent ranges read
  // truer than long ones. Edge Fly-Region is stored separately as a weak PoP
  // fallback tag and isn't surfaced as its own series.
  const geoHint =
    "Coarse country from IP (bundled GeoLite2). Older hits recorded before this was enabled show no country. Edge Fly-Region is stored as a weak fallback tag on each hit.";

  return (
    <div className="space-y-3 text-xs">
      {/* ----- controls ----- */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-keep-muted">Range</span>
          <div className="flex overflow-hidden rounded border border-keep-rule">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={`px-2 py-1 ${range === r ? "bg-keep-accent/30 text-keep-text" : "bg-keep-bg text-keep-muted hover:bg-keep-banner/60"}`}
              >
                {r}d
              </button>
            ))}
          </div>
          <label className="ml-2 flex items-center gap-1 text-keep-muted">
            <input
              type="checkbox"
              checked={includeBots}
              onChange={(e) => setIncludeBots(e.target.checked)}
            />
            Include bots
          </label>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-1 hover:bg-keep-banner/60"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error ? (
        <div className="rounded border border-keep-rule p-3 text-keep-muted">
          Couldn't load analytics: {error}
        </div>
      ) : null}

      {/* ----- headline + hits over time ----- */}
      <Section title="Hits over time">
        <div className="mb-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Pageviews" value={fmtNum(totals.pageviews)} />
          <Stat label="Unique visitors" value={fmtNum(totals.visitors)} />
          <Stat label="Human hits" value={pub ? fmtNum(pub.botSplit.human) : "—"} />
          <Stat label="Bot hits" value={pub ? fmtNum(pub.botSplit.bot) : "—"} />
        </div>
        <HitsChart series={pub?.series ?? []} />
      </Section>

      <div className="grid gap-3 md:grid-cols-2">
        <Section title="Top referrers">
          <CountTable
            rows={pub?.referrers ?? []}
            labelHead="Source / medium"
            empty="No referrers recorded yet."
            renderLabel={(r) => (
              <>
                {r.source ? <span>{r.source}</span> : <span className="text-keep-muted">(none)</span>}
                <span className="text-keep-muted"> · {r.medium}</span>
              </>
            )}
          />
        </Section>

        <Section title="Geo breakdown" hint={geoHint}>
          <CountTable
            rows={pub?.geo ?? []}
            labelHead="Country"
            empty="No geo data yet."
            renderLabel={(r) => <span className="font-mono">{r.country}</span>}
          />
        </Section>
      </div>

      <GeoAccuracy />

      <Section title="Top pages">
        <CountTable
          rows={pub?.topPages ?? []}
          labelHead="Path template"
          empty="No pageviews recorded yet."
          renderLabel={(r) => <span className="font-mono">{r.path}</span>}
        />
      </Section>

      {/* ----- in-app destinations ----- */}
      <Section
        title="In-app destinations"
        hint="Where authed users go inside the app: modals opened, admin/server sub-tabs switched to, rooms and servers entered, and other tracked features."
      >
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wider text-keep-muted">Modals</p>
            <CountTable
              rows={inapp?.modals ?? []}
              labelHead="Modal"
              empty="No modal opens recorded yet."
              renderLabel={(r) => <span className="font-mono">{r.key}</span>}
            />
          </div>
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wider text-keep-muted">Sub-tabs</p>
            <CountTable
              rows={inapp?.tabs ?? []}
              labelHead="Tab"
              empty="No sub-tab switches recorded yet."
              renderLabel={(r) => <span className="font-mono">{r.key}</span>}
            />
          </div>
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wider text-keep-muted">Rooms</p>
            <CountTable
              rows={inapp?.rooms ?? []}
              labelHead="Room"
              empty="No room switches recorded yet."
              renderLabel={(r) => <span className="font-mono">{r.key}</span>}
            />
          </div>
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wider text-keep-muted">Servers</p>
            <CountTable
              rows={inapp?.servers ?? []}
              labelHead="Server"
              empty="No server switches recorded yet."
              renderLabel={(r) => <span className="font-mono">{r.key}</span>}
            />
          </div>
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wider text-keep-muted">Features</p>
            <CountTable
              rows={inapp?.features ?? []}
              labelHead="Feature"
              empty="No feature use recorded yet."
              renderLabel={(r) => <span className="font-mono">{r.key}</span>}
            />
          </div>
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wider text-keep-muted">Public pages</p>
            <CountTable
              rows={inapp?.pages ?? []}
              labelHead="Page"
              empty="No public page views recorded yet."
              renderLabel={(r) => <span className="font-mono">{r.key}</span>}
            />
          </div>
        </div>
      </Section>
    </div>
  );
}
