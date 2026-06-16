import { lazy, Suspense, useEffect, useState } from "react";
import { Code2, Paintbrush2 } from "lucide-react";
import { Modal, MODAL_CARD_CONTENT } from "./Modal.js";
import { useChat } from "../state/store.js";

// Same lazy GrapesJS designer the profile editor uses. Heavy, so it only
// loads when a moderator actually switches into Designer mode.
const ProfileDesigner = lazy(() => import("./ProfileDesigner.js"));

/** Designer is mouse/drag-oriented, gate it to desktop widths exactly like
 *  ProfileEditor's `isDesignerViewport`. Site availability is separately
 *  gated by `branding.profileDesignerEnabled`. */
function isDesignerViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(min-width: 900px)").matches;
}

/**
 * Standalone "Edit Bio" modal launched from the profile modal's mod
 * actions. It edits ONE bio string and hands the result back via `onSave`,
 * the caller owns the actual PATCH (character vs master endpoint). Mirrors
 * the profile editor's bio tab: a Designer/Source toggle over the same
 * `bioHtml` string, with the designer available only when the site flag is
 * on AND the viewport is wide enough; otherwise it's raw HTML source.
 *
 * This is a moderation tool (mods editing other users' bios). It carries no
 * preview of the owner's theme, just the editor + save, intentionally
 * lightweight versus the full self-service ProfileEditor.
 */
export function EditBioModal({
  initialBio,
  targetLabel,
  maxBioLength,
  onSave,
  onClose,
}: {
  initialBio: string;
  /** Shown in the header, e.g. "Sigrid" or "Sigrid (OOC)". */
  targetLabel: string;
  maxBioLength: number;
  onSave: (bioHtml: string) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [bioHtml, setBioHtml] = useState(initialBio);
  const [bioMode, setBioMode] = useState<"source" | "designer">("designer");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const designerSiteEnabled = useChat((s) => s.branding.profileDesignerEnabled);
  const [isWideViewport, setIsWideViewport] = useState(isDesignerViewport);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 900px)");
    const onChange = () => setIsWideViewport(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const designerAvailable = designerSiteEnabled && isWideViewport;
  // Fall back to source whenever the designer isn't available so the
  // editor pane never renders a blank designer slot.
  const effectiveMode = designerAvailable ? bioMode : "source";

  const tooLong = bioHtml.length > maxBioLength;

  async function save() {
    if (saving || tooLong) return;
    setSaving(true);
    setErr(null);
    try {
      await onSave(bioHtml);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} variant="mobile-fullscreen" zIndex={70}>
      <div
        className={`${MODAL_CARD_CONTENT} keep-frame rounded bg-keep-bg`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-keep-rule px-4 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-keep-text">Edit Bio</div>
            <div className="truncate text-xs text-keep-muted">{targetLabel}</div>
          </div>
          <div className="flex items-center gap-2">
            {designerAvailable ? (
              <div className="inline-flex items-center gap-1 rounded-lg border border-keep-rule bg-keep-bg/60 p-1">
                {([
                  { m: "designer", label: "Designer", Icon: Paintbrush2 },
                  { m: "source", label: "Source", Icon: Code2 },
                ] as const).map(({ m, label, Icon }) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setBioMode(m)}
                    aria-pressed={bioMode === m}
                    className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors ${
                      bioMode === m
                        ? "bg-keep-accent text-keep-bg shadow"
                        : "text-keep-muted hover:bg-keep-accent/10 hover:text-keep-text"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden />
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded border border-keep-rule bg-keep-panel text-base text-keep-text hover:bg-keep-banner"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Editor */}
        <div className="flex min-h-0 flex-1 flex-col p-3">
          {effectiveMode === "designer" ? (
            <div className="min-h-0 flex-1 overflow-hidden rounded border border-keep-rule">
              <Suspense
                fallback={<div className="flex h-full items-center justify-center text-xs italic text-keep-muted">Loading the designer…</div>}
              >
                <ProfileDesigner value={bioHtml} onChange={setBioHtml} />
              </Suspense>
            </div>
          ) : (
            <textarea
              value={bioHtml}
              onChange={(e) => setBioHtml(e.target.value)}
              className="min-h-0 w-full flex-1 resize-none rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-xs outline-none focus:border-keep-action"
              placeholder="<p>Bio HTML…</p>"
            />
          )}
          <div className={`mt-1 text-right text-[10px] tabular-nums ${tooLong ? "text-[#e06070]" : "text-keep-muted"}`}>
            {bioHtml.length.toLocaleString()} / {maxBioLength.toLocaleString()}
          </div>
          {err ? <div className="mt-1 text-xs text-[#e06070]">{err}</div> : null}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-keep-rule px-4 py-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-keep-rule bg-keep-panel px-3 py-1.5 text-xs text-keep-text hover:bg-keep-banner"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || tooLong}
            className="rounded border border-keep-action/80 bg-keep-action px-3 py-1.5 text-xs font-semibold text-keep-bg disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save Bio"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
