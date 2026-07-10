import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { ReportEntry } from "@thekeep/shared";
import { readError } from "../../lib/http.js";
import { formatDateTime, formatTime } from "../../lib/intlFormat.js";

/* =========================================================
 *  Reports tab, triage queue for user-filed public reports
 * ========================================================= */
export function ReportsTab() {
  const { t } = useTranslation("admin");
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
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : t("loadFailed")); });
    return () => { cancelled = true; };
  }, [statusFilter, refreshKey, t]);

  async function resolve(id: string, status: "reviewed" | "dismissed") {
    const note = window.prompt(
      status === "reviewed"
        ? t("reports.reviewPrompt")
        : t("reports.dismissPrompt"),
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
      window.alert(err instanceof Error ? err.message : t("reports.resolveFailed"));
    }
  }

  return (
    <section className="space-y-2 text-sm">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="font-action text-base">{t("reports.title")}</h3>
        <div className="flex flex-wrap gap-2 text-xs">
          {(["open", "reviewed", "dismissed", "all"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`rounded border border-keep-rule px-2 py-0.5 ${
                statusFilter === s ? "bg-keep-bg" : "bg-keep-banner/40 hover:bg-keep-banner"
              }`}
            >
              {t(`reports.status.${s}`)}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setRefreshKey((k) => k + 1)}
            className="rounded border border-keep-rule bg-keep-banner/40 px-2 py-0.5 hover:bg-keep-banner"
          >
            {t("refresh")}
          </button>
        </div>
      </header>
      {error ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div> : null}
      {reports === null ? (
        <p className="italic text-keep-muted">{t("reports.loading")}</p>
      ) : reports.length === 0 ? (
        <p className="italic text-keep-muted">{t("reports.none")}</p>
      ) : (
        <ul className="space-y-2">
          {reports.map((r) => (
            <li key={r.id} className="rounded border border-keep-rule bg-keep-bg p-2">
              <div className="flex items-baseline justify-between gap-2 text-xs text-keep-muted">
                <span>
                  <Trans
                    t={t}
                    i18nKey="reports.reportedIn"
                    values={{ reporter: r.reporterDisplayName, room: r.roomName }}
                  >
                    <span className="font-semibold text-keep-text">{"{{reporter}}"}</span>
                    {" reported a message in "}
                    <span className="font-semibold text-keep-text">{"{{room}}"}</span>
                  </Trans>
                  {" · "}
                  <span title={formatDateTime(r.createdAt)}>{formatDateTime(r.createdAt)}</span>
                </span>
                <span
                  className={`rounded px-1 ${
                    r.status === "open"
                      ? "bg-keep-accent/15 text-keep-accent"
                      : "bg-keep-action/15 text-keep-action"
                  }`}
                >
                  {t(`reports.status.${r.status}`)}
                </span>
              </div>
              <div className="mt-1 rounded border border-keep-rule/50 bg-keep-panel/30 p-2 text-xs">
                <div className="text-keep-muted">
                  {formatTime(r.messageCreatedAt)}, <span className="font-semibold">{r.messageDisplayName}</span>
                </div>
                <div className="whitespace-pre-wrap break-words">{r.messageBody}</div>
              </div>
              {r.reason ? (
                <div className="mt-1 text-xs italic">{t("reports.reporterNote", { reason: r.reason })}</div>
              ) : null}
              {r.resolvedAt && r.resolvedByDisplayName ? (
                <div className="mt-1 text-[11px] text-keep-muted">
                  {r.resolutionNote
                    ? t("reports.resolvedByWithNote", { name: r.resolvedByDisplayName, note: r.resolutionNote })
                    : t("reports.resolvedBy", { name: r.resolvedByDisplayName })}
                </div>
              ) : null}
              {r.status === "open" ? (
                <div className="mt-2 flex gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => resolve(r.id, "reviewed")}
                    className="rounded border border-keep-action/60 bg-keep-action/10 px-2 py-0.5 text-keep-action hover:bg-keep-action/20"
                  >
                    {t("reports.reviewedAction")}
                  </button>
                  <button
                    type="button"
                    onClick={() => resolve(r.id, "dismissed")}
                    className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                  >
                    {t("reports.dismiss")}
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
