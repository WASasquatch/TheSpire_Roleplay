/**
 * Hand-rolled SVG chart primitives for the admin Analytics tab.
 *
 * No charting dependency (docs/ADMIN_IA.md forbids new deps) and CSP-safe:
 * inline SVG + React style PROPS only, never a runtime <style> element.
 * Colors come exclusively from the theme tokens via `rgb(var(--keep-*) / a)`
 * so every palette (light + the dark presets + user themes) works. Series
 * colors are assigned by FIXED position — action, accent, system, muted —
 * and never re-assigned when a filter changes the series count.
 *
 * Accessibility contract: every chart is paired with a "view as table"
 * twin (see ChartWithTable), a legend renders whenever there are two or
 * more series, and the crosshair tooltip is reachable by keyboard
 * (arrow keys move the focused day). Identity is never color-alone.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../../lib/intlFormat.js";

/** Fixed series slots. Order is load-bearing: never re-assign on filter. */
const SERIES_TOKENS = ["--keep-action", "--keep-accent", "--keep-system", "--keep-muted"] as const;

export function seriesColor(i: number, alpha = 1): string {
  const token = SERIES_TOKENS[Math.min(i, SERIES_TOKENS.length - 1)];
  return alpha >= 1 ? `rgb(var(${token}))` : `rgb(var(${token}) / ${alpha})`;
}

export interface ChartSeries {
  key: string;
  label: string;
  /** One value per day; null = no data point (e.g. an open retention window). */
  values: Array<number | null>;
}

/** Compact 'MM-DD' label for a 'YYYY-MM-DD' day key. */
function shortDay(day: string): string {
  return day.length >= 10 ? day.slice(5) : day;
}

/** Round a max up to a "nice" axis ceiling (1/2/2.5/5 × 10^k). */
function niceMax(rawMax: number): number {
  if (rawMax <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(rawMax)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (rawMax <= m * mag) return m * mag;
  }
  return 10 * mag;
}

/** Track the rendered width of a container so the SVG re-measures on any
 *  resize — including FloatingWindow drags — via ResizeObserver. */
function useContainerWidth(): { ref: RefObject<HTMLDivElement>; width: number } {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(Math.round(e.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

interface LineChartProps {
  days: string[];
  series: ChartSeries[];
  /** Fixed axis ceiling (e.g. 100 for percent charts); default = nice(max). */
  yMax?: number;
  formatValue?: (n: number) => string;
  /** 10%-alpha area wash under the line; only sensible for one series. */
  fillArea?: boolean;
  height?: number;
  ariaLabel: string;
}

/**
 * Multi-series line chart: 2px round-capped lines, recessive hairline
 * grid, ONE y-axis, crosshair + all-series tooltip on hover/focus, legend
 * for ≥2 series and a selective direct label at each line's endpoint.
 */
export function LineChart({
  days,
  series,
  yMax,
  formatValue,
  fillArea,
  height = 150,
  ariaLabel,
}: LineChartProps) {
  const { t } = useTranslation("admin");
  const { ref, width } = useContainerWidth();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const fmt = formatValue ?? ((n: number) => formatNumber(n));
  const n = days.length;
  if (n === 0) return <p className="text-keep-muted">{t("analytics.noData")}</p>;

  const rawMax = Math.max(
    1,
    ...series.flatMap((s) => s.values.filter((v): v is number => v != null)),
  );
  const max = yMax ?? niceMax(rawMax);
  // Counts get whole-number ticks (fractional people/messages read wrong on
  // low-volume charts); an explicit yMax (percent axes) keeps even quarters.
  const ticks =
    yMax != null
      ? [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax)
      : (() => {
          const step = Math.max(1, Math.ceil(max / 4));
          const out: number[] = [];
          for (let v = 0; v <= max; v += step) out.push(v);
          return out;
        })();

  const tickLabels = ticks.map((v) => fmt(v));
  const padLeft = 8 + Math.max(...tickLabels.map((l) => l.length)) * 6;
  // Room for the endpoint direct labels, sized like padLeft: from the widest
  // last value actually rendered (fixed 34px clipped "12,345"-scale labels).
  const endLabelLen = Math.max(
    0,
    ...series.map((s) => {
      const last = [...s.values].reverse().find((v) => v != null);
      return last == null ? 0 : fmt(last).length;
    }),
  );
  const padRight = 10 + endLabelLen * 6;
  const padTop = 6;
  const axisBand = 16; // x labels live INSIDE the svg height (no clipping)
  const w = Math.max(width, 240);
  const svgH = height + padTop + axisBand;
  const plotW = w - padLeft - padRight;
  const plotH = height;

  const xAt = (i: number) => padLeft + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yAt = (v: number) => padTop + plotH - (Math.min(v, max) / max) * plotH;

  /** Build one path per contiguous non-null run so gaps stay gaps. */
  const pathFor = (values: Array<number | null>): string => {
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? " L" : " M"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`;
      pen = true;
    });
    return d.trim();
  };

  const areaFor = (values: Array<number | null>): string => {
    const pts = values
      .map((v, i) => (v == null ? null : `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`))
      .filter((p): p is string => p != null);
    if (pts.length < 2) return "";
    const firstIdx = values.findIndex((v) => v != null);
    let lastIdx = -1;
    values.forEach((v, i) => {
      if (v != null) lastIdx = i;
    });
    const base = padTop + plotH;
    return `M${xAt(firstIdx).toFixed(1)},${base} L${pts.join(" L")} L${xAt(lastIdx).toFixed(1)},${base} Z`;
  };

  // Endpoint direct labels (last non-null value per series), nudged apart
  // vertically when they would collide. Text wears text tokens, never the
  // series color — the colored endpoint dot beside it carries identity.
  const endLabels = series
    .map((s, si) => {
      let lastIdx = -1;
      s.values.forEach((v, i) => {
        if (v != null) lastIdx = i;
      });
      if (lastIdx < 0) return null;
      const v = s.values[lastIdx]!;
      return { si, x: xAt(lastIdx), y: yAt(v), value: v };
    })
    .filter((l): l is { si: number; x: number; y: number; value: number } => l != null)
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < endLabels.length; i++) {
    if (endLabels[i]!.y - endLabels[i - 1]!.y < 11) {
      endLabels[i]!.y = endLabels[i - 1]!.y + 11;
    }
  }

  // X labels: first, last, and up to three interior days.
  const xLabelIdx = new Set<number>([0, n - 1]);
  if (n > 4) {
    const step = (n - 1) / 4;
    for (let k = 1; k < 4; k++) xLabelIdx.add(Math.round(k * step));
  }

  const idxFromClientX = (clientX: number): number => {
    const el = ref.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left - padLeft;
    const frac = plotW <= 0 ? 0 : x / plotW;
    return Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));
  };

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => setHoverIdx(idxFromClientX(e.clientX));
  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const cur = hoverIdx ?? n - 1;
      setHoverIdx(Math.max(0, Math.min(n - 1, cur + (e.key === "ArrowRight" ? 1 : -1))));
    } else if (e.key === "Escape") {
      setHoverIdx(null);
    }
  };

  const hover = hoverIdx != null && hoverIdx >= 0 && hoverIdx < n ? hoverIdx : null;
  const hoverX = hover != null ? xAt(hover) : 0;
  const tooltipOnLeft = hover != null && hoverX > w / 2;

  return (
    <div>
      <div ref={ref} className="relative">
        <svg
          width={w}
          height={svgH}
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          className="block max-w-full outline-none"
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHoverIdx(null)}
          onKeyDown={onKeyDown}
          onFocus={() => setHoverIdx((v) => v ?? n - 1)}
          onBlur={() => setHoverIdx(null)}
        >
          {/* recessive hairline grid + y ticks */}
          {ticks.map((v) => (
            <g key={v}>
              <line
                x1={padLeft}
                x2={w - padRight}
                y1={yAt(v)}
                y2={yAt(v)}
                stroke="rgb(var(--keep-border) / 0.35)"
                strokeWidth={1}
              />
              <text
                x={padLeft - 4}
                y={yAt(v) + 3}
                textAnchor="end"
                fontSize={9}
                fill="rgb(var(--keep-muted))"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {fmt(v)}
              </text>
            </g>
          ))}

          {/* x labels */}
          {[...xLabelIdx].map((i) => (
            <text
              key={i}
              x={xAt(i)}
              y={padTop + plotH + 12}
              textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
              fontSize={9}
              fill="rgb(var(--keep-muted))"
            >
              {shortDay(days[i]!)}
            </text>
          ))}

          {/* area wash (single-series option) */}
          {fillArea && series.length === 1 ? (
            <path d={areaFor(series[0]!.values)} fill={seriesColor(0, 0.1)} />
          ) : null}

          {/* series lines: 2px, round join/cap */}
          {series.map((s, si) => (
            <path
              key={s.key}
              d={pathFor(s.values)}
              fill="none"
              stroke={seriesColor(si)}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

          {/* endpoint dots + selective direct labels */}
          {endLabels.map((l) => (
            <g key={series[l.si]!.key}>
              <circle
                cx={l.x}
                cy={yAt(l.value)}
                r={3}
                fill={seriesColor(l.si)}
                stroke="rgb(var(--keep-bg))"
                strokeWidth={2}
              />
              <text
                x={l.x + 6}
                y={l.y + 3}
                fontSize={9}
                fill="rgb(var(--keep-text))"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {fmt(l.value)}
              </text>
            </g>
          ))}

          {/* crosshair + hover dots (surface-ringed) */}
          {hover != null ? (
            <g>
              <line
                x1={hoverX}
                x2={hoverX}
                y1={padTop}
                y2={padTop + plotH}
                stroke="rgb(var(--keep-border) / 0.8)"
                strokeWidth={1}
              />
              {series.map((s, si) => {
                const v = s.values[hover];
                if (v == null) return null;
                return (
                  <circle
                    key={s.key}
                    cx={hoverX}
                    cy={yAt(v)}
                    r={4}
                    fill={seriesColor(si)}
                    stroke="rgb(var(--keep-bg))"
                    strokeWidth={2}
                  />
                );
              })}
            </g>
          ) : null}
        </svg>

        {/* tooltip: one readout, every series at that day; values lead */}
        {hover != null ? (
          <div
            className="pointer-events-none absolute top-1 z-10 rounded border border-keep-rule bg-keep-panel px-2 py-1 text-[10px] shadow"
            style={{
              left: hoverX,
              transform: tooltipOnLeft ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
            }}
          >
            <div className="mb-0.5 font-semibold text-keep-text">{days[hover]}</div>
            {series.map((s, si) => (
              <div key={s.key} className="flex items-center gap-1.5 whitespace-nowrap">
                <span
                  aria-hidden
                  className="inline-block h-[2px] w-3"
                  style={{ backgroundColor: seriesColor(si) }}
                />
                <span className="font-semibold text-keep-text" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {s.values[hover] == null ? "—" : fmt(s.values[hover]!)}
                </span>
                <span className="text-keep-muted">{s.label}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* legend: mandatory identity channel whenever ≥2 series */}
      {series.length >= 2 ? (
        <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px] text-keep-muted">
          {series.map((s, si) => (
            <span key={s.key} className="flex items-center gap-1">
              <span
                aria-hidden
                className="inline-block h-[2px] w-4"
                style={{ backgroundColor: seriesColor(si) }}
              />
              {s.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The chart's accessible twin: same days × series as a plain table. */
export function SeriesTable({
  days,
  series,
  formatValue,
}: {
  days: string[];
  series: ChartSeries[];
  formatValue?: ((n: number) => string) | undefined;
}) {
  const { t } = useTranslation("admin");
  const fmt = formatValue ?? ((n: number) => formatNumber(n));
  // Newest first: the row someone is looking for is almost always recent.
  const order = days.map((_, i) => i).reverse();
  return (
    <div className="max-h-56 overflow-y-auto">
      <table className="w-full text-left">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-keep-muted">
            <th className="pb-1 pr-2 font-normal">{t("analytics.tableDay")}</th>
            {series.map((s) => (
              <th key={s.key} className="pb-1 text-right font-normal">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {order.map((i) => (
            <tr key={days[i]} className="border-t border-keep-rule/50">
              <td className="py-0.5 pr-2 font-mono text-keep-muted">{days[i]}</td>
              {series.map((s) => (
                <td
                  key={s.key}
                  className="py-0.5 text-right text-keep-text"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {s.values[i] == null ? "—" : fmt(s.values[i]!)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Line chart + its "view as table" toggle (the CVD/accessibility fallback). */
export function ChartWithTable(props: LineChartProps) {
  const { t } = useTranslation("admin");
  const [asTable, setAsTable] = useState(false);
  return (
    <div>
      <div className="mb-1 flex justify-end">
        <button
          type="button"
          className="text-[10px] text-keep-muted underline hover:text-keep-text"
          onClick={() => setAsTable((v) => !v)}
        >
          {asTable ? t("analytics.viewAsChart") : t("analytics.viewAsTable")}
        </button>
      </div>
      {asTable ? (
        <SeriesTable days={props.days} series={props.series} formatValue={props.formatValue} />
      ) : (
        <LineChart {...props} />
      )}
    </div>
  );
}

/**
 * KPI stat tile: label, hero-ish number (proportional figures), an
 * optional delta line and a small de-emphasis sparkline whose endpoint
 * dot marks the current period.
 */
export function StatTile({
  label,
  value,
  delta,
  spark,
}: {
  label: string;
  value: string;
  delta?: string | null;
  spark?: Array<number | null>;
}) {
  const pts = (spark ?? []).filter((v): v is number => v != null);
  const sparkSvg = (() => {
    if (!spark || pts.length < 2) return null;
    const w = 64;
    const h = 18;
    const max = Math.max(1, ...pts);
    const n = spark.length;
    const coords = spark
      .map((v, i) =>
        v == null
          ? null
          : `${((i / (n - 1)) * (w - 4) + 2).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`,
      )
      .filter((p): p is string => p != null);
    if (coords.length < 2) return null;
    const last = coords[coords.length - 1]!.split(",");
    return (
      <svg width={w} height={h} aria-hidden className="mt-1 block">
        <polyline
          points={coords.join(" ")}
          fill="none"
          stroke="rgb(var(--keep-muted) / 0.6)"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={last[0]} cy={last[1]} r={2} fill="rgb(var(--keep-action))" />
      </svg>
    );
  })();

  return (
    <div className="flex flex-col rounded border border-keep-rule bg-keep-bg/40 p-2">
      <span className="text-[10px] uppercase tracking-wider text-keep-muted">{label}</span>
      <span className="mt-0.5 text-xl font-semibold text-keep-text">{value}</span>
      {delta ? <span className="text-[10px] text-keep-muted">{delta}</span> : null}
      {sparkSvg}
    </div>
  );
}
