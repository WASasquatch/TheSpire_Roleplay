import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Role } from "@thekeep/shared";
import { readError } from "../../lib/http.js";
import { formatDate, formatDateTime, formatNumber, formatTime } from "../../lib/intlFormat.js";

/* =============================================================
 * OVERVIEW TAB
 * =============================================================
 *
 * Admin dashboard. Polls /admin/overview every 30s and renders a card
 * grid of headline counters plus a 7-day daily-series block covering
 * messages, topics, logins, and registrations. Distinct from the public
 * /stats endpoint, this one carries DAU/WAU/MAU, moderation volume,
 * and per-day login/registration counts that aren't appropriate for
 * the anonymous splash view.
 */

interface OverviewDayPoint {
  day: string;
  count: number;
}

interface AdminOverviewRecentReg {
  userId: string;
  username: string;
  role: Role;
  createdAt: number;
  lastLoginAt: number | null;
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
    recentRegistrations: AdminOverviewRecentReg[];
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

export function OverviewTab() {
  const { t } = useTranslation("admin");
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // Pass the viewer's timezone offset so the server's day-bucket
        // SQL aligns with the panel's local-time grouping. Without
        // this the two widgets disagreed on which side of midnight a
        // signup belonged to. `getTimezoneOffset` returns minutes
        // west of UTC (positive for the Americas, negative for Asia).
        const tzOffsetMin = new Date().getTimezoneOffset();
        const r = await fetch(`/admin/overview?tzOffsetMin=${tzOffsetMin}`, { credentials: "include" });
        if (!r.ok) throw new Error(await readError(r));
        const j = (await r.json()) as AdminOverview;
        if (!cancelled) { setData(j); setError(null); }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t("loadFailed"));
      }
    }
    load();
    const id = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [t]);

  if (!data) {
    return <div className="text-keep-muted text-xs">{error ?? t("loading")}</div>;
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-keep-muted">
        {t("overview.description")}
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <OverviewCard anchor="overview.onlineNow" title={t("overview.onlineNow")} hint={t("overview.onlineNowHint")}>
          <BigStat value={data.online} accent={data.online > 0} />
        </OverviewCard>

        <OverviewCard anchor="overview.registeredUsers" title={t("overview.registeredUsers")} hint={t("overview.registeredUsersHint")}>
          <BigStat value={data.users.total} />
          <SubStats items={[
            { label: t("overview.new7d"), value: data.users.newLast7d },
            { label: t("overview.new30d"), value: data.users.newLast30d },
          ]} />
        </OverviewCard>

        <OverviewCard anchor="overview.activeUsers" title={t("overview.activeUsers")} hint={t("overview.activeUsersHint")}>
          <SubStats items={[
            { label: t("overview.dau"), value: data.users.dau },
            { label: t("overview.wau"), value: data.users.wau },
            { label: t("overview.mau"), value: data.users.mau },
          ]} />
        </OverviewCard>

        <OverviewCard anchor="overview.rooms" title={t("overview.rooms")} hint={t("overview.roomsHint")}>
          <BigStat value={data.rooms.total} />
          <SubStats items={[
            { label: t("overview.public"), value: data.rooms.public },
            { label: t("overview.private"), value: data.rooms.private },
          ]} />
        </OverviewCard>

        <OverviewCard anchor="overview.chatMessages" title={t("overview.chatMessages")} hint={t("overview.chatMessagesHint")}>
          <SubStats items={[
            { label: t("overview.h24"), value: data.messages.last24h },
            { label: t("overview.d7"), value: data.messages.last7d },
            { label: t("overview.d30"), value: data.messages.last30d },
          ]} />
        </OverviewCard>

        <OverviewCard anchor="overview.forumActivity" title={t("overview.forumActivity")} hint={t("overview.forumActivityHint")}>
          <SubStats items={[
            { label: t("overview.topics"), value: data.forum.topics },
            { label: t("overview.replies"), value: data.forum.replies },
            { label: t("overview.topics7d"), value: data.forum.topicsLast7d },
            { label: t("overview.replies7d"), value: data.forum.repliesLast7d },
          ]} />
        </OverviewCard>

        <OverviewCard anchor="overview.content" title={t("overview.content")} hint={t("overview.contentHint")}>
          <SubStats items={[
            { label: t("overview.characters"), value: data.content.characters },
            { label: t("overview.worlds"), value: data.content.worlds },
          ]} />
        </OverviewCard>

        <OverviewCard anchor="overview.moderation7d" title={t("overview.moderation7d")} hint={t("overview.moderation7dHint")}>
          <SubStats items={[
            { label: t("overview.reports"), value: data.moderation.reportsLast7d },
            { label: t("overview.audit"), value: data.moderation.auditLast7d },
          ]} />
        </OverviewCard>
      </div>

      <RecentRegistrationsPanel rows={data.users.recentRegistrations} />

      <fieldset data-admin-anchor="overview.thisWeek" className="rounded border border-keep-rule p-3">
        <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">{t("overview.thisWeek")}</legend>
        <div className="space-y-2">
          <SparklineRow label={t("overview.seriesMessages")} series={data.series.messages} colorClass="bg-keep-action/70" />
          <SparklineRow label={t("overview.seriesTopics")} series={data.series.topics} colorClass="bg-keep-accent/70" />
          <SparklineRow label={t("overview.seriesLogins")} series={data.series.logins} colorClass="bg-keep-action/70" />
          <SparklineRow label={t("overview.seriesRegistrations")} series={data.series.registrations} colorClass="bg-keep-accent/70" />
          <SparklineAxis days={data.series.messages.map((d) => d.day)} />
        </div>
      </fieldset>

      {error ? <div className="text-xs text-keep-accent">{error}</div> : null}
    </div>
  );
}

function OverviewCard({ title, hint, anchor, children }: { title: string; hint?: string; anchor?: string; children: React.ReactNode }) {
  return (
    // `anchor` is the find-a-setting jump target (adminSearchIndex.ts): the
    // card's own catalog label key, stamped verbatim as data-admin-anchor.
    <fieldset {...(anchor ? { "data-admin-anchor": anchor } : {})} className="rounded border border-keep-rule p-3" title={hint}>
      <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">{title}</legend>
      <div className="space-y-2">{children}</div>
    </fieldset>
  );
}

/**
 * Per-day buckets of the last 5 days of registrations. Newest day first,
 * empty days included so the panel always shows the rolling window
 * (an empty day is a useful signal too). Grouped by date in the
 * viewer's local time zone, registration timestamps are absolute, but
 * "did anyone sign up yesterday" reads in local time.
 */
function RecentRegistrationsPanel({ rows }: { rows: AdminOverviewRecentReg[] }) {
  const { t } = useTranslation("admin");
  const dayKeys: { key: string; label: string; date: Date }[] = [];
  const now = new Date();
  for (let i = 0; i < 5; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const label = i === 0 ? t("overview.today") : i === 1 ? t("overview.yesterday") : formatDate(d.getTime(), { weekday: "short", month: "short", day: "numeric" });
    dayKeys.push({ key, label, date: d });
  }
  const buckets = new Map<string, AdminOverviewRecentReg[]>();
  for (const { key } of dayKeys) buckets.set(key, []);
  for (const u of rows) {
    const d = new Date(u.createdAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (buckets.has(key)) buckets.get(key)!.push(u);
  }
  const total = rows.length;

  return (
    <fieldset className="rounded border border-keep-rule p-3">
      <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">
        {t("overview.recentRegistrations", { count: total })}
      </legend>
      {total === 0 ? (
        <p className="text-xs text-keep-muted">{t("overview.noNewAccounts")}</p>
      ) : (
        <div className="space-y-2">
          {dayKeys.map(({ key, label }) => {
            const dayRows = buckets.get(key) ?? [];
            return (
              <div key={key}>
                <div className="flex items-baseline gap-2 text-[10px] uppercase tracking-widest text-keep-muted">
                  <span className="font-semibold text-keep-text/80">{label}</span>
                  <span className="tabular-nums">{t("overview.signups", { count: dayRows.length })}</span>
                </div>
                {dayRows.length === 0 ? (
                  <div className="text-xs text-keep-muted/60 italic">-</div>
                ) : (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {dayRows.map((u) => {
                      const time = formatTime(u.createdAt, { hour: "2-digit", minute: "2-digit" });
                      const neverLoggedIn = u.lastLoginAt == null;
                      const roleTag = u.role !== "user" ? u.role : null;
                      return (
                        <span
                          key={u.userId}
                          className="inline-flex items-center gap-1 rounded border border-keep-rule bg-keep-bg px-1.5 py-0.5 text-xs"
                          title={`${t("overview.registeredTitle", { time: formatDateTime(u.createdAt) })}${u.lastLoginAt ? t("overview.lastLoginLine", { time: formatDateTime(u.lastLoginAt) }) : t("overview.neverLoggedInLine")}`}
                        >
                          <span className="font-semibold">{u.username}</span>
                          {roleTag ? (
                            <span className="rounded bg-keep-accent/20 px-1 text-[9px] uppercase tracking-widest text-keep-accent">
                              {t(`overview.role.${roleTag}`)}
                            </span>
                          ) : null}
                          {neverLoggedIn ? (
                            <span className="text-[10px] text-keep-muted">{t("overview.neverLoggedInChip")}</span>
                          ) : null}
                          <span className="text-[10px] text-keep-muted/70 tabular-nums">· {time}</span>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

function BigStat({ value, accent }: { value: number; accent?: boolean }) {
  return (
    <div className={`text-2xl font-semibold tabular-nums ${accent ? "text-keep-action" : "text-keep-text"}`}>
      {formatNumber(value)}
    </div>
  );
}

function SubStats({ items }: { items: { label: string; value: number }[] }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
      {items.map((it) => (
        <div key={it.label} className="flex items-baseline gap-1.5">
          <span className="font-semibold tabular-nums text-keep-text">{formatNumber(it.value)}</span>
          <span className="text-keep-muted">{it.label}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * One labeled sparkline row in the "This week" panel. The plot area is a
 * fixed-height (`h-8`) box so every row occupies the same vertical extent
 * regardless of its peak, otherwise quiet rows shrink and busy rows grow
 * and the panel gets a ragged baseline. Per-day date labels live once at
 * the bottom in `SparklineAxis` rather than under every row.
 */
function SparklineRow({ label, series, colorClass }: { label: string; series: OverviewDayPoint[]; colorClass: string }) {
  const { t } = useTranslation("admin");
  if (series.length === 0) return null;
  const max = Math.max(1, ...series.map((d) => d.count));
  const total = series.reduce((s, d) => s + d.count, 0);
  return (
    <div
      className="grid items-center gap-2 text-xs sm:grid-cols-[110px_1fr_64px]"
      title={t("overview.thisWeekTotal", { total: formatNumber(total) })}
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
              title={t("overview.dayCount", { day: d.day, count: formatNumber(d.count) })}
            >
              <div className={`${colorClass} w-full rounded-sm`} style={{ height: `${h}px` }} />
            </div>
          );
        })}
      </div>
      <span className="text-right font-semibold tabular-nums text-keep-text">
        {formatNumber(total)}
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
