/**
 * "Export PDF" control in the world viewer's tab strip.
 *
 * The typesetter and its three rasterizing libraries are megabytes, so this
 * button owns the only import of them and pulls the chunk on first click.
 * Everything it renders is status: the run takes seconds on a big world
 * (one canvas per page), and a button that looked idle the whole time would
 * get clicked again.
 */
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileDown, Loader2 } from "lucide-react";
import { useActiveTheme } from "../../lib/theme.js";
import { useChat } from "../../state/store.js";

interface Props {
  worldId: string;
}

type Progress = { stage: "fetching" | "composing" | "rendering"; done: number; total: number };

export function WorldPdfButton({ worldId }: Props) {
  const { t } = useTranslation("worlds");
  const { t: tRoot } = useTranslation();
  // Inside the viewer this is already the WORLD's palette when the author set
  // one (WorldViewerModal republishes it on context), so the export is themed
  // the same way the wiki on screen is.
  const theme = useActiveTheme();
  const siteName = useChat((s) => s.branding.siteName);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  async function run() {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setProgress({ stage: "fetching", done: 0, total: 0 });
    try {
      const { exportWorldPdf } = await import("../../lib/worldPdf/index.js");
      await exportWorldPdf({
        worldId,
        viewerTheme: theme,
        t,
        tRoot,
        siteName,
        onProgress: (stage, done, total) => setProgress({ stage, done: done ?? 0, total: total ?? 0 }),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("pdf.failed"));
    } finally {
      busyRef.current = false;
      setProgress(null);
    }
  }

  const label = progress
    ? progress.stage === "rendering" && progress.total > 0
      ? t("pdf.progressPages", { done: progress.done, total: progress.total })
      : t(progress.stage === "fetching" ? "pdf.progressFetching" : "pdf.progressComposing")
    : t("pdf.export");

  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={progress !== null}
      title={error ?? t("pdf.exportTitle")}
      aria-label={t("pdf.exportTitle")}
      className={`flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-[11px] uppercase tracking-widest disabled:opacity-70 ${
        error
          ? "border-keep-accent/60 text-keep-accent"
          : "border-keep-rule/60 text-keep-muted hover:border-keep-action/50 hover:text-keep-action"
      }`}
    >
      {progress ? (
        <Loader2 size={12} className="animate-spin" aria-hidden />
      ) : (
        <FileDown size={12} aria-hidden />
      )}
      {error ? t("pdf.failed") : label}
    </button>
  );
}
