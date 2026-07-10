import { useCallback, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type {
  StoryReport,
  StoryReportStatus,
  StoryReportTargetKind,
  StoryRating,
} from "@thekeep/shared";
import { STORY_RATINGS } from "@thekeep/shared";
import { readError } from "../../lib/http.js";
import { formatDateTime } from "../../lib/intlFormat.js";

/**
 * Admin queue for Scriptorium reports. Shows open reports first, then
 * resolved / dismissed when the filter is widened. Each report renders
 * the snapshot captured at file-time so a queue entry stays useful even
 * if the author has since deleted the content.
 *
 * Available actions per report:
 *   - Mark reviewed (with optional note)
 *   - Dismiss (with optional note)
 *   - Force-rate the parent story (story reports + sometimes review/chapter)
 *   - Hide the parent story (set visibility to private)
 *   - Delete the parent story (hard delete; cascades)
 *
 * All actions are audit-logged on the server. The UI re-fetches the
 * queue after each successful action so state stays fresh.
 */
export function AdminScriptoriumTab() {
  const { t } = useTranslation("admin");
  const [reports, setReports] = useState<StoryReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StoryReportStatus | "all">("open");
  const [kindFilter, setKindFilter] = useState<StoryReportTargetKind | "all">("all");

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (kindFilter !== "all") params.set("targetKind", kindFilter);
      const r = await fetch(`/admin/scriptorium/reports?${params.toString()}`, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { reports: StoryReport[] };
      setReports(j.reports);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("loadFailed"));
    }
  }, [statusFilter, kindFilter, t]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-3 p-4">
      <header data-admin-anchor="scriptorium.title" className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="font-action text-base">{t("scriptorium.title")}</h3>
        <span className="text-xs text-keep-muted">
          {reports == null ? t("common:loading") : t("scriptorium.shown", { count: reports.length })}
        </span>
      </header>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          <span className="uppercase tracking-widest text-keep-muted">{t("scriptorium.statusLabel")}</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StoryReportStatus | "all")}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5"
          >
            <option value="open">{t("scriptorium.filterOpen")}</option>
            <option value="reviewed">{t("scriptorium.filterReviewed")}</option>
            <option value="dismissed">{t("scriptorium.filterDismissed")}</option>
            <option value="all">{t("scriptorium.filterAll")}</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="uppercase tracking-widest text-keep-muted">{t("scriptorium.kindLabel")}</span>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as StoryReportTargetKind | "all")}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5"
          >
            <option value="all">{t("scriptorium.filterAll")}</option>
            <option value="story">{t("scriptorium.filterStories")}</option>
            <option value="chapter">{t("scriptorium.filterChapters")}</option>
            <option value="review">{t("scriptorium.filterReviews")}</option>
            <option value="review_reply">{t("scriptorium.filterReviewReplies")}</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => void load()}
          className="ml-auto rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-keep-muted hover:text-keep-text"
        >
          {t("refresh")}
        </button>
      </div>

      {error ? (
        <p className="rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">{error}</p>
      ) : null}

      {reports === null ? (
        <p className="italic text-keep-muted">{t("common:loading")}</p>
      ) : reports.length === 0 ? (
        <p className="italic text-keep-muted">{t("scriptorium.noMatches")}</p>
      ) : (
        <ul className="space-y-3">
          {reports.map((r) => (
            <ReportCard key={r.id} report={r} onChanged={load} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ReportCard({ report, onChanged }: { report: StoryReport; onChanged: () => Promise<void> | void }) {
  const { t } = useTranslation("admin");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function resolve(status: "reviewed" | "dismissed") {
    if (busy) return;
    const note = window.prompt(status === "reviewed" ? t("scriptorium.reviewNotePrompt") : t("scriptorium.dismissNotePrompt"));
    if (note === null) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/admin/scriptorium/reports/${report.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ status, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      if (!r.ok) throw new Error(await readError(r));
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function forceRate() {
    const next = window.prompt(
      t("scriptorium.forceRatePrompt", { ratings: STORY_RATINGS.join(" / ") }),
      "PG-13",
    );
    if (!next) return;
    const trimmed = next.trim() as StoryRating;
    if (!(STORY_RATINGS as readonly string[]).includes(trimmed)) {
      window.alert(t("scriptorium.invalidRating", { ratings: STORY_RATINGS.join(", ") }));
      return;
    }
    const note = window.prompt(t("scriptorium.auditNotePrompt"));
    if (note === null) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/admin/scriptorium/stories/${report.storyId}/force-rate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ rating: trimmed, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      if (!r.ok) throw new Error(await readError(r));
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("scriptorium.forceRateFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function hide() {
    if (!window.confirm(t("scriptorium.hideConfirm", { title: report.storyTitle }))) return;
    const revokeEarnings = window.confirm(t("scriptorium.revokeConfirm"));
    const note = window.prompt(t("scriptorium.auditNotePrompt"));
    if (note === null) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/admin/scriptorium/stories/${report.storyId}/hide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ...(note.trim() ? { note: note.trim() } : {}), ...(revokeEarnings ? { revokeEarnings: true } : {}) }),
      });
      if (!r.ok) throw new Error(await readError(r));
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("scriptorium.hideFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function deleteStory() {
    if (!window.confirm(t("scriptorium.deleteConfirm", { title: report.storyTitle }))) return;
    const revokeEarnings = window.confirm(t("scriptorium.revokeConfirm"));
    const note = window.prompt(t("scriptorium.deleteNotePrompt"));
    if (note === null) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/admin/scriptorium/stories/${report.storyId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ note: note.trim(), ...(revokeEarnings ? { revokeEarnings: true } : {}) }),
      });
      if (!r.ok) throw new Error(await readError(r));
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("deleteFailed"));
    } finally {
      setBusy(false);
    }
  }

  const open = report.status === "open";

  return (
    <li className={`rounded border p-3 ${open ? "border-keep-accent/50 bg-keep-accent/5" : "border-keep-rule/40 bg-keep-panel/30"}`}>
      <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${kindBadgeClass(report.targetKind)}`}>
            {t(`scriptorium.kind.${report.targetKind}`)}
          </span>
          <h4 className="font-action text-sm">{report.storyTitle}</h4>
          <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${statusBadgeClass(report.status)}`}>
            {t(`scriptorium.status.${report.status}`)}
          </span>
        </div>
        <span className="text-[10px] text-keep-muted">
          {formatDateTime(report.createdAt)}
        </span>
      </header>

      <div className="mb-2 text-xs">
        <Trans t={t} i18nKey="scriptorium.reportedBy" values={{ name: report.reporterUsername }}>
          <span className="text-keep-muted">Reported by</span>
          {" "}
          <b>{"{{name}}"}</b>
        </Trans>
        {report.reason ? (
          <>
            {" "}<span className="italic">· {report.reason}</span>
          </>
        ) : null}
      </div>

      <pre className="mb-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-keep-rule/40 bg-keep-bg/40 p-2 text-[11px] text-keep-text/85">
        {JSON.stringify(report.snapshot, null, 2)}
      </pre>

      {report.resolvedByUsername ? (
        <div className="mb-2 text-[10px] text-keep-muted">
          <Trans t={t} i18nKey="scriptorium.resolvedBy" values={{ name: report.resolvedByUsername }}>
            {"Resolved by "}
            <b>{"{{name}}"}</b>
          </Trans>{" "}
          {report.resolvedAt ? formatDateTime(report.resolvedAt) : ""}
          {report.resolutionNote ? <>: <i>{report.resolutionNote}</i></> : null}
        </div>
      ) : null}

      {err ? <p className="mb-2 text-xs text-keep-accent">{err}</p> : null}

      <div className="flex flex-wrap gap-2 text-xs">
        {open ? (
          <>
            <button type="button" onClick={() => resolve("reviewed")} disabled={busy}
              className="rounded border border-keep-action bg-keep-action px-2 py-0.5 font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">
              {t("scriptorium.markReviewed")}
            </button>
            <button type="button" onClick={() => resolve("dismissed")} disabled={busy}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-keep-muted hover:text-keep-text">
              {t("scriptorium.dismiss")}
            </button>
          </>
        ) : null}
        <span className="text-keep-rule">|</span>
        <button type="button" onClick={forceRate} disabled={busy}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-keep-muted hover:text-keep-text">
          {t("scriptorium.forceRate")}
        </button>
        <button type="button" onClick={hide} disabled={busy}
          className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-300">
          {t("scriptorium.hideStory")}
        </button>
        <button type="button" onClick={deleteStory} disabled={busy}
          className="rounded border border-keep-accent/60 bg-keep-accent/15 px-2 py-0.5 text-keep-accent">
          {t("scriptorium.deleteStory")}
        </button>
      </div>
    </li>
  );
}

function statusBadgeClass(s: StoryReportStatus): string {
  switch (s) {
    case "open":      return "bg-keep-accent/15 text-keep-accent";
    case "reviewed":  return "bg-emerald-500/15 text-emerald-300";
    case "dismissed": return "bg-keep-muted/25 text-keep-muted";
  }
}

function kindBadgeClass(k: StoryReportTargetKind): string {
  switch (k) {
    case "story":         return "bg-sky-500/15 text-sky-300";
    case "chapter":       return "bg-indigo-500/15 text-indigo-300";
    case "review":        return "bg-amber-500/15 text-amber-300";
    case "review_reply":  return "bg-rose-500/15 text-rose-300";
  }
}
