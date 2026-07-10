import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { StoryReportTargetKind } from "@thekeep/shared";

/**
 * Generic report-this affordance for Scriptorium surfaces. Tiny outline
 * button → confirm prompt for an optional reason → POST /stories/:id/reports.
 * Second click on the same target silently no-ops server-side thanks to
 * the unique (reporter, target) index.
 *
 * Used for story-level reports from the reader header and review-level
 * reports inline on each review card. Lives in its own file so both
 * surfaces can import it without creating a circular dependency between
 * StoryReaderModal and StoryReviewsPanel.
 */
export function ScriptoriumReportButton({
  storyId,
  targetKind,
  targetId,
  label,
  compact,
}: {
  storyId: string;
  targetKind: StoryReportTargetKind;
  targetId: string;
  label: string;
  /** Smaller chip variant for inline use inside review cards. */
  compact?: boolean;
}) {
  const { t } = useTranslation("scriptorium");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function report() {
    if (busy || done) return;
    const reason = window.prompt(t("report.promptReason", { target: targetKind.replace("_", " ") }));
    // Cancel returns null; we still allow empty-string submissions.
    if (reason === null) return;
    setBusy(true);
    try {
      const r = await fetch(`/stories/${storyId}/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetKind,
          targetId,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        }),
      });
      if (r.ok) setDone(true);
    } finally {
      setBusy(false);
    }
  }

  const baseClasses = "rounded-full border transition";
  const sizeClasses = compact
    ? "px-1.5 py-0.5 text-[10px]"
    : "px-2.5 py-1 text-xs";
  const stateClasses = done
    ? "border-keep-rule bg-keep-bg/40 text-keep-muted"
    : "border-keep-rule bg-keep-bg/40 text-keep-muted hover:border-keep-accent/60 hover:text-keep-accent";

  return (
    <button
      type="button"
      onClick={report}
      disabled={busy || done}
      title={label}
      className={`${baseClasses} ${sizeClasses} ${stateClasses}`}
    >
      <span aria-hidden>🚩</span>
      <span className="ml-1">{done ? t("report.reported") : t("report.report")}</span>
    </button>
  );
}
