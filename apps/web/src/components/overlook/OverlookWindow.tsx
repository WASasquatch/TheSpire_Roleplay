/**
 * The Overlook window: a room's or world's sketch canvas in a FloatingWindow.
 *
 * Owns everything except the drawing surface itself: fetching the scene,
 * tracking unsaved changes, saving with a conflict guard, and the editor
 * roster. The Excalidraw instance lives behind a lazy boundary in
 * OverlookCanvas so this chrome paints while that (large) chunk downloads.
 *
 * Saving is explicit rather than autosaved. Autosave on a shared canvas
 * would turn every idle pan into a version bump and make the 409 conflict
 * guard fire constantly; an explicit Save also gives "someone else saved
 * first" somewhere honest to surface.
 */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Eye, RotateCcw, Save, UserMinus, Users } from "lucide-react";
import type { OverlookDetail, OverlookEditor, OverlookScope, WorldEntityLight } from "@thekeep/shared";
import { FloatingWindow } from "../shared/FloatingWindow.js";
import {
  fetchOverlook,
  removeOverlookEditor,
  saveOverlook,
  type OverlookSaveConflict,
} from "../../lib/overlook.js";
import type { OverlookScene } from "./OverlookCanvas.js";

/** Excalidraw is large and ESM-only; keep it out of the shell's chunk. */
const OverlookCanvas = lazy(() =>
  import("./OverlookCanvas.js").then((m) => ({ default: m.OverlookCanvas })),
);

interface Props {
  scope: OverlookScope;
  /** Room id, or world id-or-slug. */
  scopeId: string;
  /** Shown in the titlebar until the payload arrives with the real name. */
  fallbackName: string;
  onClose: () => void;
  /**
   * World entries, when this canvas belongs to a world the viewer has open.
   * Enables the "pull in entries" seeding button. Absent for room canvases.
   */
  worldEntities?: WorldEntityLight[];
}

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string }
  | { kind: "conflict"; by: string | null };

export function OverlookWindow({
  scope,
  scopeId,
  fallbackName,
  onClose,
  worldEntities,
}: Props) {
  const { t } = useTranslation("common");
  const [detail, setDetail] = useState<OverlookDetail | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [editorsOpen, setEditorsOpen] = useState(false);
  const [editors, setEditors] = useState<OverlookEditor[]>([]);
  // Latest scene from the canvas. A ref, not state: it changes on every
  // brush stroke and re-rendering the window at that rate would be absurd.
  const sceneRef = useRef<OverlookScene | null>(null);
  // Content signature as of the last load or successful save. Excalidraw
  // fires onChange for viewport changes too, so "did a callback happen" is
  // NOT a usable definition of dirty; this is. Null until the canvas
  // reports for the first time, which is what establishes the baseline.
  const savedSigRef = useRef<string | null>(null);
  /** Signature of what's on the canvas right now, to promote on save. */
  const latestSigRef = useRef<string | null>(null);
  // Bumped to force a canvas remount after a reload, so the fresh scene
  // actually replaces what's on screen.
  const [sceneKey, setSceneKey] = useState(0);

  const load = useCallback(
    async (opts?: { remount?: boolean }) => {
      setLoadError(false);
      try {
        const d = await fetchOverlook(scope, scopeId);
        setDetail(d);
        setEditors(d.editors);
        sceneRef.current = null;
        // Drop the baseline so the reloaded canvas's first onChange
        // re-establishes it; keeping the old one would show the freshly
        // loaded scene as already dirty.
        savedSigRef.current = null;
        latestSigRef.current = null;
        setDirty(false);
        setSave({ kind: "idle" });
        if (opts?.remount) setSceneKey((k) => k + 1);
      } catch {
        setLoadError(true);
      }
    },
    [scope, scopeId],
  );

  useEffect(() => { void load(); }, [load]);

  const onSceneChange = useCallback((scene: OverlookScene, signature: string) => {
    sceneRef.current = scene;
    latestSigRef.current = signature;
    // First report after a load establishes the baseline rather than marking
    // the canvas dirty: Excalidraw calls onChange once on mount.
    if (savedSigRef.current === null) {
      savedSigRef.current = signature;
      return;
    }
    const changed = signature !== savedSigRef.current;
    setDirty(changed);
    if (!changed) return;
    // Clear a stale "Saved" chip on the first real edit after a save, but
    // leave a conflict warning up: it stays until the viewer reloads.
    setSave((s) => (s.kind === "saved" ? { kind: "idle" } : s));
  }, []);

  const doSave = useCallback(async () => {
    if (!detail || !sceneRef.current) return;
    setSave({ kind: "saving" });
    try {
      const result = await saveOverlook(
        scope,
        scopeId,
        JSON.stringify(sceneRef.current),
        detail.version,
      );
      if (result.kind === "conflict") {
        const c: OverlookSaveConflict = result;
        setSave({ kind: "conflict", by: c.updatedByUsername });
        return;
      }
      setDetail((d) => (d ? { ...d, version: result.version } : d));
      // What's on the canvas now IS what's on the server now.
      savedSigRef.current = latestSigRef.current;
      setDirty(false);
      setSave({ kind: "saved" });
    } catch (e) {
      setSave({ kind: "error", message: e instanceof Error ? e.message : t("overlook.saveFailed") });
    }
  }, [detail, scope, scopeId, t]);

  /**
   * Warn before the tab closes with unsaved work. Deliberately NOT wired to
   * the window's own close button: a workspace window that argues with you
   * about closing is worse than one that forgets, and the scene is one
   * reopen away. This only guards the case with no way back.
   */
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const dropEditor = useCallback(
    async (userId: string) => {
      if (!detail) return;
      try {
        setEditors(await removeOverlookEditor(detail.id, userId));
      } catch {
        /* the list just doesn't change; the roster is re-read on reopen */
      }
    },
    [detail],
  );

  const title = t("overlook.title", { name: detail?.scopeName ?? fallbackName });
  const canEdit = detail?.canEdit ?? false;

  return (
    <FloatingWindow
      title={title}
      onClose={onClose}
      // Near-fullscreen: a canvas in a 420px box is useless. Same sizing as
      // the forums catalog, the other full-workspace surface.
      initialWidth={window.innerWidth - 32}
      initialHeight={window.innerHeight - 32}
      className="keep-frame border border-keep-rule bg-keep-bg text-keep-text"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Toolbar. Container queries, not viewport ones: the window is
            user-resizable so `sm:`/`lg:` would lie about the space here. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-keep-rule/60 bg-keep-banner/30 px-2 py-1.5 text-xs">
          {canEdit ? (
            <>
              <button
                type="button"
                onClick={() => void doSave()}
                disabled={!dirty || save.kind === "saving"}
                className="flex items-center gap-1 rounded border border-keep-action/50 bg-keep-action/15 px-2 py-1 text-keep-action hover:border-keep-action hover:bg-keep-action/30 disabled:opacity-40 disabled:hover:bg-keep-action/15"
                title={t("overlook.save")}
              >
                <Save size={12} aria-hidden />
                {save.kind === "saving" ? t("overlook.saving") : t("overlook.save")}
              </button>
              {dirty ? (
                <span className="text-keep-muted">{t("overlook.unsaved")}</span>
              ) : save.kind === "saved" ? (
                <span className="text-keep-action">{t("overlook.saved")}</span>
              ) : null}
            </>
          ) : (
            <span className="flex items-center gap-1 text-keep-muted" title={t("overlook.readOnlyHint")}>
              <Eye size={12} aria-hidden />
              {t("overlook.readOnly")}
            </span>
          )}

          {detail?.canManageEditors ? (
            <button
              type="button"
              onClick={() => setEditorsOpen((v) => !v)}
              aria-expanded={editorsOpen}
              className="ml-auto flex items-center gap-1 rounded border border-keep-rule px-2 py-1 text-keep-muted hover:border-keep-action hover:text-keep-action"
              title={t("overlook.editors")}
            >
              <Users size={12} aria-hidden />
              <span className="hidden [@container(min-width:520px)]:inline">{t("overlook.editors")}</span>
            </button>
          ) : null}
        </div>

        {/* Conflict + save-failure banners. A conflict is not an error state:
            it means the canvas on screen is stale, so the only safe action is
            reload, and Save stays available for the person who decides their
            copy is the good one. */}
        {save.kind === "conflict" ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-keep-accent/40 bg-keep-accent/10 px-2 py-1.5 text-xs text-keep-text">
            <AlertTriangle size={12} aria-hidden className="text-keep-accent" />
            <span className="min-w-0 flex-1">
              {save.by
                ? t("overlook.conflict", { name: save.by })
                : t("overlook.conflictAnon")}
            </span>
            <button
              type="button"
              onClick={() => void load({ remount: true })}
              className="flex items-center gap-1 rounded border border-keep-accent/60 px-2 py-0.5 text-keep-accent hover:bg-keep-accent/20"
            >
              <RotateCcw size={12} aria-hidden />
              {t("overlook.reload")}
            </button>
          </div>
        ) : save.kind === "error" ? (
          <div className="shrink-0 border-b border-keep-accent/40 bg-keep-accent/10 px-2 py-1.5 text-xs text-keep-accent">
            {save.message}
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1">
            {loadError ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-keep-muted">
                <p>{t("overlook.loadFailed")}</p>
                <button
                  type="button"
                  onClick={() => void load({ remount: true })}
                  className="rounded border border-keep-rule px-2 py-1 text-xs hover:border-keep-action hover:text-keep-action"
                >
                  {t("overlook.retry")}
                </button>
              </div>
            ) : !detail ? (
              <div className="flex h-full items-center justify-center text-sm text-keep-muted">
                {t("overlook.loading")}
              </div>
            ) : (
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-sm text-keep-muted">
                    {t("overlook.loading")}
                  </div>
                }
              >
                <OverlookCanvas
                  key={`${detail.id}:${sceneKey}`}
                  sceneJson={detail.sceneJson}
                  canEdit={canEdit}
                  uploadsEnabled={detail.uploadsEnabled}
                  onSceneChange={onSceneChange}
                  {...(canEdit && worldEntities?.length
                    ? { seedEntities: worldEntities }
                    : {})}
                />
              </Suspense>
            )}
          </div>

          {/* Editor roster. Adding people is `/overlook add` (it needs the
              chat identity picker to disambiguate characters); this pane is
              for seeing and revoking. */}
          {editorsOpen && detail?.canManageEditors ? (
            <aside className="w-56 shrink-0 overflow-y-auto border-l border-keep-rule/60 bg-keep-banner/20 p-2">
              <h3 className="mb-1 text-[10px] font-action uppercase tracking-widest text-keep-muted">
                {t("overlook.editors")}
              </h3>
              <p className="mb-2 text-[11px] leading-snug text-keep-muted/80">
                {t("overlook.editorsHint")}
              </p>
              {editors.length === 0 ? (
                <p className="text-xs italic text-keep-muted/70">{t("overlook.editorsEmpty")}</p>
              ) : (
                <ul className="space-y-1">
                  {editors.map((e) => (
                    <li key={e.userId} className="group flex items-center gap-1 text-xs">
                      <span className="min-w-0 flex-1 truncate">{e.username}</span>
                      <button
                        type="button"
                        onClick={() => void dropEditor(e.userId)}
                        title={t("overlook.removeEditor", { name: e.username })}
                        aria-label={t("overlook.removeEditor", { name: e.username })}
                        className="shrink-0 rounded border border-keep-rule/60 p-0.5 text-keep-muted opacity-0 hover:border-keep-accent hover:text-keep-accent group-hover:opacity-100"
                      >
                        <UserMinus size={11} aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          ) : null}
        </div>
      </div>
    </FloatingWindow>
  );
}
