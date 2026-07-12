import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import type {
  Theme,
  WorldApplicationEntry,
  WorldApplicationList,
  WorldDetail,
  WorldGenre,
  WorldJoinMode,
  WorldPacing,
  WorldPage,
  WorldStatus,
  WorldVibeStats,
  WorldVisibility,
} from "@thekeep/shared";
import {
  CANONICAL_TAGS,
  CONTENT_WARNINGS,
  DEFAULT_THEME,
  WORLD_APP_MAX_QUESTIONS,
  WORLD_APP_QUESTION_MAX_LEN,
  WORLD_APP_REVIEW_NOTE_MAX_LEN,
  WORLD_PAGE_DEPTH_CAP,
  WORLD_VIBE_AXES,
} from "@thekeep/shared";
import {
  addWorldCollaborator,
  buildWorldTree,
  deriveSlug,
  removeWorldCollaborator,
  type WorldTreeNode,
} from "../../lib/worlds.js";
import { formatDateTime, formatTime } from "../../lib/intlFormat.js";
import { readError } from "../../lib/http.js";
import { ActiveThemeContext, themeStyle, useActiveTheme } from "../../lib/theme.js";
import { FloatingWindow } from "../shared/FloatingWindow.js";
import { ThemePicker } from "../cosmetics/ThemePicker.js";
import { useChat } from "../../state/store.js";
import { WorldEntitiesTab } from "./WorldEntitiesTab.js";
import { WorldArcsTab } from "./WorldArcsTab.js";
import { WorldSessionsTab } from "./WorldSessionsTab.js";

interface Props {
  worldId: string;
  onClose: () => void;
  onDeleted?: () => void;
}

/**
 * Owner-only editor for a world. Left rail is the page tree (with add/select),
 * right pane is either the world-meta editor (when no page is selected) or the
 * page editor for the selected node. Saves go straight to the REST API; the
 * tree refetches on every mutation so sortOrder/parent moves stay in sync.
 */
export function WorldEditorModal({ worldId, onClose, onDeleted }: Props) {
  const { t } = useTranslation("worlds");
  const [detail, setDetail] = useState<WorldDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [creatingUnderParent, setCreatingUnderParent] = useState<string | "root" | null>(null);
  // Which knowledge-base surface (if any) the right pane is showing instead of
  // the page / world-settings editors.
  const [kbView, setKbView] = useState<null | "entries" | "arcs" | "sessions">(null);

  async function load() {
    setError(null);
    try {
      const r = await fetch(`/worlds/${worldId}`, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as WorldDetail;
      setDetail(j);
      // If the selected page no longer exists (deleted from under us), drop the selection.
      if (selectedPageId && !j.pages.find((p) => p.id === selectedPageId)) {
        setSelectedPageId(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errors.loadFailed"));
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [worldId]);

  const tree = useMemo(() => (detail ? buildWorldTree(detail.pages) : []), [detail]);
  const selectedPage = detail?.pages.find((p) => p.id === selectedPageId) ?? null;

  async function deleteWorld() {
    if (!detail) return;
    if (!window.confirm(
      t("confirmDeleteWorld", { name: detail.world.name, pages: detail.world.pageCount }),
    )) return;
    try {
      const r = await fetch(`/worlds/${worldId}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      onDeleted?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errors.deleteFailed"));
    }
  }

  async function deletePage(p: WorldPage) {
    const childCount = detail?.pages.filter((x) => x.parentPageId === p.id).length ?? 0;
    const msg = childCount > 0
      ? t("editor.confirmDeletePageChildren", { title: p.title, count: childCount })
      : t("editor.confirmDeletePage", { title: p.title });
    if (!window.confirm(msg)) return;
    try {
      const r = await fetch(`/worlds/${worldId}/pages/${p.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      if (selectedPageId === p.id) setSelectedPageId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errors.deleteFailed"));
    }
  }

  // Scope the world's theme to this modal only - styleOverride flows down
  // through CSS vars so all the keep-* tailwind colors inside this card use
  // the world author's palette without leaking into the chat behind us.
  const viewerTheme = useActiveTheme();
  const scopedTheme = detail?.world.theme ?? viewerTheme;
  const modalStyle = detail?.world.theme ? themeStyle(detail.world.theme) : undefined;
  return (
    <FloatingWindow
      onClose={onClose}
      zIndex={50}
      {...(modalStyle ? { style: modalStyle } : {})}
      className="keep-frame keep-frame--reading rounded bg-keep-bg text-keep-text"
      title={
        <>
          {detail ? t("editor.titleNamed", { name: detail.world.name }) : t("editor.title")}
          {detail ? <span className="ml-2 text-xs font-normal text-keep-muted">/{detail.world.slug}</span> : null}
        </>
      }
    >
      <ActiveThemeContext.Provider value={scopedTheme}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {error ? (
          <div className="mx-4 mt-3 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">
            {error}
          </div>
        ) : null}

        {detail === null ? (
          <p className="p-4 italic text-keep-muted">{t("common:loadingDots")}</p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col [@container(min-width:768px)]:flex-row">
            {/* Left: page tree */}
            <aside className="flex shrink-0 flex-col border-keep-rule [@container(min-width:768px)]:w-72 [@container(min-width:768px)]:border-r">
              <div className="flex shrink-0 items-center justify-between border-b border-keep-rule bg-keep-banner/40 px-3 py-1.5 text-xs">
                <span className="uppercase tracking-widest text-keep-muted">{t("editor.pages")}</span>
                <button
                  type="button"
                  onClick={() => { setCreatingUnderParent("root"); setSelectedPageId(null); setKbView(null); }}
                  className="rounded border border-keep-rule bg-keep-bg px-1.5 py-0.5 text-[11px] hover:bg-keep-banner"
                  title={t("editor.addPageTitle")}
                >
                  {t("editor.addPage")}
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-1 text-sm">
                <button
                  type="button"
                  onClick={() => { setSelectedPageId(null); setCreatingUnderParent(null); setKbView(null); }}
                  className={`block w-full rounded px-2 py-1 text-left text-xs uppercase tracking-widest ${
                    selectedPageId === null && creatingUnderParent === null && kbView === null
                      ? "bg-keep-action/15 text-keep-action"
                      : "text-keep-muted hover:bg-keep-muted/25"
                  }`}
                >
                  {t("editor.worldSettings")}
                </button>
                {([
                  ["entries", t("editor.navEntries"), t("editor.navEntriesTitle")],
                  ["arcs", t("editor.navArcs"), t("editor.navArcsTitle")],
                  ["sessions", t("editor.navSessions"), t("editor.navSessionsTitle")],
                ] as const).map(([key, label, title]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => { setKbView(key); setSelectedPageId(null); setCreatingUnderParent(null); }}
                    className={`block w-full rounded px-2 py-1 text-left text-xs uppercase tracking-widest ${
                      kbView === key ? "bg-keep-action/15 text-keep-action" : "text-keep-muted hover:bg-keep-muted/25"
                    }`}
                    title={title}
                  >
                    {label}
                  </button>
                ))}
                <div className="mt-1 border-t border-keep-rule/40 pt-1 text-[10px] uppercase tracking-widest text-keep-muted">{t("editor.lorePages")}</div>
                {tree.length === 0 ? (
                  <p className="p-2 italic text-keep-muted">{t("editor.noPages")}</p>
                ) : (
                  <PageTree
                    nodes={tree}
                    selectedId={selectedPageId}
                    onSelect={(id) => { setSelectedPageId(id); setCreatingUnderParent(null); setKbView(null); }}
                    onAddChild={(id) => { setCreatingUnderParent(id); setSelectedPageId(null); setKbView(null); }}
                  />
                )}
              </div>
            </aside>

            {/* Right: editor pane */}
            <section className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
              {kbView === "entries" ? (
                <WorldEntitiesTab worldId={worldId} detail={detail} onChanged={load} />
              ) : kbView === "arcs" ? (
                <WorldArcsTab worldId={worldId} detail={detail} onChanged={load} />
              ) : kbView === "sessions" ? (
                <WorldSessionsTab worldId={worldId} detail={detail} onChanged={load} />
              ) : creatingUnderParent !== null ? (
                <NewPageForm
                  worldId={worldId}
                  parentId={creatingUnderParent === "root" ? null : creatingUnderParent}
                  parentTitle={
                    creatingUnderParent === "root"
                      ? null
                      : (detail.pages.find((p) => p.id === creatingUnderParent)?.title ?? null)
                  }
                  onCancel={() => setCreatingUnderParent(null)}
                  onCreated={async (newPage) => {
                    setCreatingUnderParent(null);
                    await load();
                    setSelectedPageId(newPage.id);
                  }}
                />
              ) : selectedPage ? (
                <PageEditor
                  key={selectedPage.id}
                  worldId={worldId}
                  page={selectedPage}
                  pages={detail.pages}
                  onSaved={() => load()}
                  onDelete={() => deletePage(selectedPage)}
                />
              ) : (
                <WorldMetaEditor
                  worldId={worldId}
                  detail={detail}
                  onSaved={() => load()}
                  onDelete={() => deleteWorld()}
                />
              )}
            </section>
          </div>
        )}
      </div>
      </ActiveThemeContext.Provider>
    </FloatingWindow>
  );
}

/* ------------------------------------------------------------ *
 *  Tree
 * ------------------------------------------------------------ */

function PageTree({
  nodes,
  selectedId,
  onSelect,
  onAddChild,
}: {
  nodes: WorldTreeNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddChild: (parentId: string) => void;
}) {
  const { t } = useTranslation("worlds");
  return (
    <ul className="space-y-0.5">
      {nodes.map((n) => (
        <li key={n.page.id}>
          <div
            className={`group flex items-center justify-between gap-1 rounded px-2 py-1 text-xs ${
              selectedId === n.page.id ? "bg-keep-action/15 text-keep-action" : "hover:bg-keep-muted/25"
            }`}
            style={{ paddingLeft: `${n.depth * 12 + 8}px` }}
          >
            <button
              type="button"
              onClick={() => onSelect(n.page.id)}
              className="min-w-0 flex-1 truncate text-left"
              title={n.page.title}
            >
              {n.page.title}
            </button>
            {n.depth < WORLD_PAGE_DEPTH_CAP - 1 ? (
              <button
                type="button"
                onClick={() => onAddChild(n.page.id)}
                className="hidden rounded border border-keep-rule bg-keep-bg px-1 text-[10px] text-keep-muted hover:bg-keep-banner group-hover:inline"
                title={t("editor.addChildTitle")}
              >
                +
              </button>
            ) : null}
          </div>
          {n.children.length > 0 ? (
            <PageTree
              nodes={n.children}
              selectedId={selectedId}
              onSelect={onSelect}
              onAddChild={onAddChild}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------ *
 *  World meta (name / slug / description / visibility) editor
 * ------------------------------------------------------------ */

function WorldMetaEditor({
  worldId,
  detail,
  onSaved,
  onDelete,
}: {
  worldId: string;
  detail: WorldDetail;
  onSaved: () => Promise<void> | void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("worlds");
  const w = detail.world;
  // "Can manage collaborators", computed client-side so the panel
  // works even when the server response predates the viewerIsOwner
  // field. Two paths qualify: the actual owner (id match against the
  // world summary's ownerUserId), and any admin role. Mirrors the
  // server's POST/DELETE /worlds/:id/collaborators gate so the UI
  // doesn't show controls that would 403 on submit.
  const me = useChat((s) => s.me);
  const viewerIsAdult = useChat((s) => s.viewerAge.isAdult);
  const myId = me?.id ?? null;
  const canManageCollaborators =
    (!!myId && myId === w.ownerUserId)
    || (!!me && me.permissions.includes("edit_others_world"));
  // The "18+ world" flag is owner-set (or edit_others_world staff) and
  // adults only — the server rejects everyone else, so the checkbox
  // simply doesn't render for viewers who can't flip it (age plan
  // Phase 4; collaborators edit pages, not the world's rating).
  const canSetNsfw = viewerIsAdult && canManageCollaborators;
  const [name, setName] = useState(w.name);
  const [slug, setSlug] = useState(w.slug);
  const [description, setDescription] = useState(w.description ?? "");
  const [visibility, setVisibility] = useState<WorldVisibility>(w.visibility);
  const [isNsfw, setIsNsfw] = useState<boolean>(w.isNsfw ?? false);
  // null = "no theme set" (fall back to viewer's chat theme); a Theme object
  // = author has explicit colors. Both states need to round-trip via PATCH.
  const [theme, setTheme] = useState<Theme | null>(w.theme);
  // Phase-1 catalog metadata. Local state stays as primitive types
  // (genre + tags + CWs + pacing + cover URL + status); the submit
  // path diffs each against the server-side copy so we only PATCH
  // when something actually changed.
  const [genre, setGenre] = useState<WorldGenre>(w.genre);
  const [tags, setTags] = useState<string[]>(w.tags);
  const [tagDraft, setTagDraft] = useState("");
  const [cws, setCws] = useState<string[]>(w.contentWarnings);
  const [coverImageUrl, setCoverImageUrl] = useState(w.coverImageUrl ?? "");
  const [pacing, setPacing] = useState<WorldPacing | "">(w.pacing ?? "");
  // Vibe stats, eight 0..100 axes; null means "author hasn't tuned
  // this axis". State stays as a partial bag so per-axis "clear"
  // doesn't disturb other axes.
  const [vibeStats, setVibeStats] = useState<WorldVibeStats>(w.vibeStats);
  // Application gating: joinMode + the question list. Empty list is
  // legal (an application with no Q&A captures just intent).
  const [joinMode, setJoinMode] = useState<WorldJoinMode>(w.joinMode);
  const [applicationQuestions, setApplicationQuestions] = useState<string[]>(w.applicationQuestions);
  // Status: owners pick `active` or `archived`; the `featured` slot is
  // admin-only (the server silently downgrades any attempt to
  // self-promote). We surface `featured` here read-only so an admin
  // viewer sees the actual state.
  const [status, setStatus] = useState<WorldStatus>(w.status);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  function addTag(t: string) {
    const norm = t.trim().toLowerCase();
    if (!norm || tags.includes(norm)) return;
    setTags([...tags, norm]);
    setTagDraft("");
  }
  function removeTag(t: string) {
    setTags(tags.filter((x) => x !== t));
  }
  function toggleCw(c: string) {
    setCws(cws.includes(c) ? cws.filter((x) => x !== c) : [...cws, c]);
  }

  // Order canonical tags as: those already selected (so they stay
  // visible after click), then the rest. Custom tags the owner has
  // added (not in CANONICAL_TAGS) render as chips alongside.
  const canonicalNotSelected = CANONICAL_TAGS.filter((t) => !tags.includes(t));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {};
      if (name.trim() !== w.name) body.name = name.trim();
      if (slug.trim() && slug.trim().toLowerCase() !== w.slug) body.slug = slug.trim().toLowerCase();
      if ((description.trim() || null) !== w.description) body.description = description.trim() || null;
      if (visibility !== w.visibility) body.visibility = visibility;
      if (isNsfw !== (w.isNsfw ?? false)) body.isNsfw = isNsfw;
      // Theme diff: stringify-compare so we only send when something actually
      // changed. Null vs null is a no-op; null vs Theme (or vice versa) writes.
      if (JSON.stringify(theme) !== JSON.stringify(w.theme)) body.theme = theme;
      if (genre !== w.genre) body.genre = genre;
      // Tag/CW arrays compare via canonical join, the server normalizes
      // the same way (trim + lowercase + dedupe via parseTagList), so
      // a join() round-trip is the right yardstick for "changed."
      if (tags.join(",") !== w.tags.join(",")) body.tags = tags;
      if (cws.join(",") !== w.contentWarnings.join(",")) body.contentWarnings = cws;
      if (status !== w.status) body.status = status;
      const coverTrimmed = coverImageUrl.trim();
      const coverNext = coverTrimmed === "" ? null : coverTrimmed;
      if (coverNext !== (w.coverImageUrl ?? null)) body.coverImageUrl = coverNext;
      const pacingNext = (pacing === "" ? null : pacing) as WorldPacing | null;
      if (pacingNext !== (w.pacing ?? null)) body.pacing = pacingNext;
      // Vibe stats: emit only the axes that actually changed. Empty
      // object = no axes touched, skip the field entirely so we
      // don't write "vibeStats: {}" which serializes to a no-op
      // request body but eats a round trip.
      const vibeDelta: Partial<WorldVibeStats> = {};
      for (const axis of WORLD_VIBE_AXES) {
        if (vibeStats[axis.key] !== w.vibeStats[axis.key]) {
          vibeDelta[axis.key] = vibeStats[axis.key];
        }
      }
      if (Object.keys(vibeDelta).length > 0) body.vibeStats = vibeDelta;
      if (joinMode !== w.joinMode) body.joinMode = joinMode;
      // JSON.stringify comparison so questions containing spaces (or
      // pairs like ["a b","c"] vs ["a","b c"] that join to the same
      // string) can never false-match. Keeps the diff honest at the
      // cost of one stringify per save.
      if (JSON.stringify(applicationQuestions) !== JSON.stringify(w.applicationQuestions)) {
        body.applicationQuestions = applicationQuestions;
      }
      if (Object.keys(body).length === 0) { setBusy(false); return; }
      const r = await fetch(`/worlds/${worldId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await readError(r));
      setSavedAt(Date.now());
      await onSaved();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : t("errors.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 text-xs">
      <h3 className="font-action text-base">{t("editor.worldSettings")}</h3>
      <p className="text-[11px] text-keep-muted">
        {t("editor.metaIntro", { count: detail.pages.length })}
      </p>

      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("fields.name")}</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
        />
      </label>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("fields.slug")}</span>
        <input
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono outline-none focus:border-keep-action"
        />
        <span className="mt-0.5 block text-[10px] text-keep-muted">
          {t("editor.slugHint")}
        </span>
      </label>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("fields.description")}</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          maxLength={2000}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
        />
      </label>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("fields.visibility")}</span>
        <select
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as WorldVisibility)}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
        >
          <option value="private">{t("visibilityOption.private")}</option>
          <option value="public">{t("visibilityOption.public")}</option>
          <option value="open">{t("visibilityOption.open")}</option>
        </select>
        <span className="mt-0.5 block text-[10px] text-keep-muted">
          {t("editor.visibilityHint")}
        </span>
      </label>

      {canSetNsfw ? (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={isNsfw}
            onChange={(e) => setIsNsfw(e.target.checked)}
            className="mt-0.5"
          />
          <span className="min-w-0">
            <span className="block uppercase tracking-widest text-keep-muted">{t("editor.nsfwLabel")}</span>
            <span className="mt-0.5 block text-[10px] text-keep-muted">
              {t("editor.nsfwHint")}
            </span>
          </span>
        </label>
      ) : null}

      <fieldset className="rounded border border-keep-rule p-3 space-y-3">
        <legend className="px-1 text-[10px] uppercase tracking-widest text-keep-muted">
          {t("editor.catalogMetadata")}
        </legend>
        <p className="text-[11px] text-keep-muted">
          {t("editor.catalogIntro")}
        </p>

        <label className="block">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("editor.genre")}</span>
          <select
            value={genre}
            onChange={(e) => setGenre(e.target.value as WorldGenre)}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="fantasy">{t("genre.fantasy")}</option>
            <option value="modern">{t("genre.modern")}</option>
            <option value="scifi">{t("genre.scifi")}</option>
            <option value="horror">{t("genre.horror")}</option>
            <option value="western">{t("genre.western")}</option>
            <option value="steampunk">{t("genre.steampunk")}</option>
            <option value="mythological">{t("genre.mythological")}</option>
            <option value="other">{t("genre.other")}</option>
          </select>
        </label>

        <div>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("editor.tags")}</span>
          {tags.length > 0 ? (
            <div className="mb-1 flex flex-wrap gap-1">
              {tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => removeTag(tag)}
                  title={t("editor.removeTagTitle", { tag })}
                  className="rounded border border-keep-action/40 bg-keep-action/10 px-1.5 py-0 text-[11px] text-keep-action hover:bg-keep-accent/15 hover:text-keep-accent"
                >
                  {tag} <span aria-hidden>×</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="mb-1 text-[10px] italic text-keep-muted">{t("editor.noTags")}</div>
          )}
          <div className="mb-1 flex gap-1">
            <input
              type="text"
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTag(tagDraft);
                }
              }}
              placeholder={t("editor.addTagPlaceholder")}
              maxLength={32}
              className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
            />
            <button
              type="button"
              onClick={() => addTag(tagDraft)}
              disabled={!tagDraft.trim()}
              className="rounded border border-keep-rule bg-keep-banner px-2 py-1 text-[11px] hover:bg-keep-banner/80 disabled:opacity-50"
            >
              {t("editor.addTag")}
            </button>
          </div>
          {canonicalNotSelected.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              <span className="text-[10px] uppercase tracking-widest text-keep-muted">{t("editor.commonLabel")}</span>
              {canonicalNotSelected.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => addTag(tag)}
                  className="rounded border border-keep-rule bg-keep-bg/50 px-1.5 py-0 text-[11px] text-keep-muted hover:border-keep-action hover:bg-keep-action/10 hover:text-keep-action"
                >
                  + {tag}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("editor.contentWarnings")}</span>
          <div className="flex flex-wrap gap-2 text-[11px]">
            {CONTENT_WARNINGS.map((c) => (
              <label key={c} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={cws.includes(c)}
                  onChange={() => toggleCw(c)}
                />
                {c}
              </label>
            ))}
          </div>
        </div>

        <label className="block">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("editor.coverImageUrl")}</span>
          <input
            type="url"
            value={coverImageUrl}
            onChange={(e) => setCoverImageUrl(e.target.value)}
            placeholder={t("editor.coverPlaceholder")}
            maxLength={2000}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
          />
          {coverImageUrl ? (
            <div className="mt-1">
              {/* Live preview at the same aspect the catalog card will use
                  (3:2). `referrerPolicy="no-referrer"` matches the inline
                  image preview in chat, keeps the chat URL from leaking
                  via Referer to whoever hosts the image. */}
              <img
                src={coverImageUrl}
                alt={t("editor.coverPreviewAlt")}
                referrerPolicy="no-referrer"
                className="block max-h-32 max-w-full rounded border border-keep-rule object-cover"
              />
            </div>
          ) : null}
        </label>

        <label className="block">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("editor.pacing")}</span>
          <select
            value={pacing}
            onChange={(e) => setPacing(e.target.value as WorldPacing | "")}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="">{t("editor.pacingUnspecified")}</option>
            <option value="freeform">{t("editor.pacingFreeform")}</option>
            <option value="drop-in">{t("editor.pacingDropIn")}</option>
            <option value="casual">{t("editor.pacingCasual")}</option>
            <option value="slice-of-life">{t("editor.pacingSliceOfLife")}</option>
            <option value="structured">{t("editor.pacingStructured")}</option>
            <option value="long-form">{t("editor.pacingLongForm")}</option>
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("fields.status")}</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as WorldStatus)}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="active">{t("editor.statusActive")}</option>
            <option value="archived">{t("editor.statusArchived")}</option>
            {status === "featured" ? (
              <option value="featured">{t("editor.statusFeatured")}</option>
            ) : null}
          </select>
          <span className="mt-0.5 block text-[10px] text-keep-muted">
            {t("editor.statusHint")}
          </span>
        </label>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 space-y-3">
        <legend className="px-1 text-[10px] uppercase tracking-widest text-keep-muted">
          {t("editor.vibeStats")}
        </legend>
        <p className="text-[11px] text-keep-muted">
          {t("editor.vibeIntro")}
        </p>
        <ul className="grid grid-cols-1 gap-2 [@container(min-width:640px)]:grid-cols-2">
          {WORLD_VIBE_AXES.map((axis) => {
            const value = vibeStats[axis.key];
            return (
              <li key={axis.key} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2">
                  <label
                    className="text-keep-text"
                    htmlFor={`vibe-${axis.key}`}
                    title={t(`vibeAxes.${axis.key}.desc`)}
                  >
                    {t(`vibeAxes.${axis.key}.label`)}
                  </label>
                  {/* Live percentage readout doubles as a typeable
                      number input, handy when you want an exact
                      value (e.g. 73) without nudging the slider one
                      tick at a time. Empty string clears the axis;
                      out-of-range values clamp to 0..100. */}
                  <div className="flex items-baseline gap-1 text-[10px] text-keep-muted">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={value ?? ""}
                      placeholder={t("editor.vibeUnset")}
                      onChange={(e) => {
                        const raw = e.target.value;
                        if (raw === "") {
                          setVibeStats({ ...vibeStats, [axis.key]: null });
                          return;
                        }
                        const v = parseInt(raw, 10);
                        if (Number.isNaN(v)) return;
                        const clamped = Math.max(0, Math.min(100, v));
                        setVibeStats({ ...vibeStats, [axis.key]: clamped });
                      }}
                      aria-label={t("editor.vibePercentAria", { axis: t(`vibeAxes.${axis.key}.label`) })}
                      className="w-12 rounded border border-keep-rule bg-keep-bg px-1 py-0 text-right tabular-nums text-keep-text outline-none focus:border-keep-action"
                    />
                    <span>%</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id={`vibe-${axis.key}`}
                    type="range"
                    min={0}
                    max={100}
                    value={value ?? 0}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      setVibeStats({ ...vibeStats, [axis.key]: v });
                    }}
                    className="flex-1"
                  />
                  {value !== null ? (
                    <button
                      type="button"
                      onClick={() => setVibeStats({ ...vibeStats, [axis.key]: null })}
                      className="rounded border border-keep-rule bg-keep-bg px-1.5 py-0 text-[10px] text-keep-muted hover:bg-keep-banner hover:text-keep-text"
                      title={t("editor.vibeClearTitle")}
                    >
                      {t("editor.vibeClear")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setVibeStats({ ...vibeStats, [axis.key]: 50 })}
                      className="rounded border border-keep-rule bg-keep-bg px-1.5 py-0 text-[10px] text-keep-muted hover:bg-keep-banner hover:text-keep-text"
                      title={t("editor.vibeSetTitle")}
                    >
                      {t("editor.vibeSet")}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 space-y-3">
        <legend className="px-1 text-[10px] uppercase tracking-widest text-keep-muted">
          {t("editor.membership")}
        </legend>
        <label className="block">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("editor.joinMode")}</span>
          <select
            value={joinMode}
            onChange={(e) => setJoinMode(e.target.value as WorldJoinMode)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="open">{t("editor.joinModeOpen")}</option>
            <option value="application">{t("editor.joinModeApplication")}</option>
            <option value="invite-only">{t("editor.joinModeInviteOnly")}</option>
          </select>
          <span className="mt-0.5 block text-[10px] text-keep-muted">
            {t("editor.joinModeHint")}
          </span>
        </label>

        {/* Mode-specific clarification on HOW people get in.
            Especially important for "invite-only": without this
            line, owners pick the mode and then have no idea how to
            actually seat anyone. */}
        {joinMode === "invite-only" ? (
          <div className="rounded border border-keep-action/40 bg-keep-action/10 p-2 text-[11px] text-keep-muted">
            <span className="font-semibold text-keep-action">{t("editor.inviteOnlyLabel")}</span>{" "}
            <Trans t={t} i18nKey="editor.inviteOnlyBody">
              the catalog Join button is disabled for everyone. The only way someone becomes a member is if you add them directly using the search field below. Switch to <em>Application</em> if you want would-be members to apply for review instead.
            </Trans>
          </div>
        ) : null}

        {joinMode === "application" ? (
          <ApplicationQuestionsEditor
            questions={applicationQuestions}
            onChange={setApplicationQuestions}
          />
        ) : null}

        {joinMode === "application" && (myId === w.ownerUserId || canManageCollaborators) ? (
          <PendingApplicationsPanel worldId={worldId} onChanged={onSaved} />
        ) : null}

        {/* Direct invite panel. Available in every join mode (the
            owner may want to pre-seat someone on an open world too)
            but visually emphasized when invite-only is the active
            mode via the hint above. */}
        {(myId === w.ownerUserId || canManageCollaborators) ? (
          <InviteMemberPanel worldId={worldId} onInvited={onSaved} />
        ) : null}
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3">
        <legend className="px-1 text-[10px] uppercase tracking-widest text-keep-muted">
          {t("editor.theme")}
        </legend>
        <p className="mb-2 text-[11px] text-keep-muted">
          {t("editor.themeIntro")}
        </p>
        {theme === null ? (
          <button
            type="button"
            onClick={() => setTheme(DEFAULT_THEME)}
            className="rounded border border-keep-rule bg-keep-banner px-2 py-1 text-xs hover:bg-keep-banner/80"
          >
            {t("editor.addTheme")}
          </button>
        ) : (
          <>
            <ThemePicker
              theme={theme}
              onChange={(next) => setTheme(next)}
              onReset={() => setTheme(DEFAULT_THEME)}
            />
            <button
              type="button"
              onClick={() => setTheme(null)}
              className="mt-2 rounded border border-keep-accent/40 bg-keep-bg px-2 py-1 text-[11px] text-keep-accent hover:bg-keep-accent/10"
            >
              {t("editor.removeTheme")}
            </button>
          </>
        )}
      </fieldset>

      <CollaboratorsPanel
        worldId={worldId}
        viewerIsOwner={canManageCollaborators}
        initialCollaborators={detail.collaborators ?? []}
        onChanged={onSaved}
      />

      {/* Sticky save footer: pins Delete/Save to the bottom of the
          editor pane's scroll container so a long settings form never
          hides the Save button below the fold. Same idiom as the
          StoryCatalogModal pagination bar (negative margins cancel the
          pane's p-4 so the bar spans edge to edge and rests flush). */}
      <div className="sticky bottom-0 -mx-4 -mb-4 flex items-center justify-between border-t border-keep-rule bg-keep-bg/95 px-4 py-2 backdrop-blur">
        <button
          type="button"
          onClick={onDelete}
          className="keep-button rounded border border-keep-accent/50 bg-keep-bg px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10"
        >
          {t("editor.deleteWorld")}
        </button>
        <div className="flex min-w-0 items-center gap-3">
          {err ? (
            <span className="min-w-0 truncate text-[11px] text-keep-accent" title={err}>
              {err}
            </span>
          ) : savedAt ? (
            <span className="text-[10px] text-keep-muted">{t("editor.savedAt", { time: formatTime(savedAt) })}</span>
          ) : null}
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="keep-button rounded border border-keep-action bg-keep-action/15 px-3 py-0.5 font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
          >
            {busy ? t("common:savingDots") : t("common:save")}
          </button>
        </div>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------ *
 *  Collaborators panel (inline, owner-only add/remove)
 * ------------------------------------------------------------ */

function CollaboratorsPanel({
  worldId,
  viewerIsOwner,
  initialCollaborators,
  onChanged,
}: {
  worldId: string;
  viewerIsOwner: boolean;
  initialCollaborators: WorldDetail["collaborators"];
  onChanged: () => Promise<void> | void;
}) {
  const { t } = useTranslation("worlds");
  const [list, setList] = useState(initialCollaborators);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Keep local list in sync if the parent re-fetches the world detail
  // (e.g. after the metadata save round-trips a fresh snapshot).
  useEffect(() => { setList(initialCollaborators); }, [initialCollaborators]);

  async function add() {
    const name = draft.trim();
    if (!name || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await addWorldCollaborator(worldId, name);
      setList(r.collaborators);
      setDraft("");
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("errors.couldNotAdd"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: string) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await removeWorldCollaborator(worldId, userId);
      setList(r.collaborators);
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("errors.couldNotRemove"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-keep-rule p-3 text-xs">
      <div className="flex items-baseline justify-between">
        <h4 className="font-action text-sm">{t("collab.heading")}</h4>
        <span className="text-[10px] text-keep-muted">
          {t("collab.count", { count: list.length })}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-keep-muted">
        {viewerIsOwner
          ? t("collab.ownerDescription")
          : t("collab.viewerDescription")}
      </p>
      {list.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {list.map((c) => (
            <li
              key={c.userId}
              className="flex items-center justify-between rounded border border-keep-rule/60 bg-keep-bg/40 px-2 py-1"
            >
              <span className="font-mono">{c.username}</span>
              {viewerIsOwner ? (
                <button
                  type="button"
                  onClick={() => void remove(c.userId)}
                  disabled={busy}
                  className="rounded border border-keep-rule bg-keep-bg px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:bg-keep-accent/10 hover:text-keep-accent disabled:opacity-50"
                >
                  {t("collab.remove")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 italic text-keep-muted">{t("collab.none")}</p>
      )}
      {viewerIsOwner ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void add();
              }
            }}
            placeholder={t("collab.placeholder")}
            maxLength={80}
            className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs"
          />
          <button
            type="button"
            onClick={() => void add()}
            disabled={busy || draft.trim().length === 0}
            className="rounded border border-keep-action bg-keep-action/15 px-2 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
          >
            {busy ? "..." : t("collab.add")}
          </button>
        </div>
      ) : null}
      {err ? (
        <div className="mt-2 rounded border border-keep-accent/50 bg-keep-accent/10 p-2 text-[11px] text-keep-accent">
          {err}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ *
 *  Page editor (existing page)
 * ------------------------------------------------------------ */

function PageEditor({
  worldId,
  page,
  pages,
  onSaved,
  onDelete,
}: {
  worldId: string;
  page: WorldPage;
  pages: WorldPage[];
  onSaved: () => Promise<void> | void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("worlds");
  const [title, setTitle] = useState(page.title);
  const [slug, setSlug] = useState(page.slug);
  const [bodyHtml, setBodyHtml] = useState(page.bodyHtml);
  const [sortOrder, setSortOrder] = useState<number>(page.sortOrder);
  const [parentPageId, setParentPageId] = useState<string | "">(page.parentPageId ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Parent options: every page in this world EXCEPT the current page and its
  // descendants (server would reject the cycle anyway, but pre-filter the list
  // so the user can't pick something invalid).
  const descendantIds = useMemo(() => collectDescendants(pages, page.id), [pages, page.id]);
  const parentOptions = pages.filter((p) => p.id !== page.id && !descendantIds.has(p.id));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {};
      if (title.trim() !== page.title) body.title = title.trim();
      if (slug.trim().toLowerCase() !== page.slug) body.slug = slug.trim().toLowerCase();
      if (bodyHtml !== page.bodyHtml) body.bodyHtml = bodyHtml;
      if (sortOrder !== page.sortOrder) body.sortOrder = sortOrder;
      const newParent = parentPageId === "" ? null : parentPageId;
      if (newParent !== (page.parentPageId ?? null)) body.parentPageId = newParent;
      if (Object.keys(body).length === 0) { setBusy(false); return; }
      const r = await fetch(`/worlds/${worldId}/pages/${page.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await readError(r));
      setSavedAt(Date.now());
      await onSaved();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : t("errors.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 text-xs">
      <h3 className="font-action text-base">{page.title}</h3>

      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("fields.title")}</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
        />
      </label>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("fields.slug")}</span>
        <input
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono outline-none focus:border-keep-action"
        />
      </label>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("page.bodyHtml")}</span>
        <textarea
          value={bodyHtml}
          onChange={(e) => setBodyHtml(e.target.value)}
          rows={14}
          placeholder={t("page.bodyPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-[11px] outline-none focus:border-keep-action"
        />
        <span className="mt-0.5 block text-[10px] text-keep-muted">
          {t("page.sanitizedHint")}
        </span>
      </label>

      <div className="grid grid-cols-1 gap-3 [@container(min-width:640px)]:grid-cols-2">
        <label className="block">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("page.parentPage")}</span>
          <select
            value={parentPageId}
            onChange={(e) => setParentPageId(e.target.value)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="">{t("page.topLevel")}</option>
            {parentOptions.map((p) => (
              <option key={p.id} value={p.id}>{p.title}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("page.sortOrder")}</span>
          <input
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(parseInt(e.target.value, 10) || 0)}
            min={0}
            max={10000}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
          />
          <span className="mt-0.5 block text-[10px] text-keep-muted">
            {t("page.sortOrderHint")}
          </span>
        </label>
      </div>

      {/* Same sticky footer treatment as the world-settings form. */}
      <div className="sticky bottom-0 -mx-4 -mb-4 flex items-center justify-between border-t border-keep-rule bg-keep-bg/95 px-4 py-2 backdrop-blur">
        <button
          type="button"
          onClick={onDelete}
          className="keep-button rounded border border-keep-accent/50 bg-keep-bg px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10"
        >
          {t("page.deletePage")}
        </button>
        <div className="flex min-w-0 items-center gap-3">
          {err ? (
            <span className="min-w-0 truncate text-[11px] text-keep-accent" title={err}>
              {err}
            </span>
          ) : savedAt ? (
            <span className="text-[10px] text-keep-muted">{t("editor.savedAt", { time: formatTime(savedAt) })}</span>
          ) : null}
          <button
            type="submit"
            disabled={busy || !title.trim()}
            className="keep-button rounded border border-keep-action bg-keep-action/15 px-3 py-0.5 font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
          >
            {busy ? t("common:savingDots") : t("common:save")}
          </button>
        </div>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------ *
 *  New page form
 * ------------------------------------------------------------ */

function NewPageForm({
  worldId,
  parentId,
  parentTitle,
  onCancel,
  onCreated,
}: {
  worldId: string;
  parentId: string | null;
  parentTitle: string | null;
  onCancel: () => void;
  onCreated: (p: WorldPage) => void;
}) {
  const { t } = useTranslation("worlds");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        parentPageId: parentId,
      };
      if (slug.trim()) body.slug = slug.trim();
      if (bodyHtml.trim()) body.bodyHtml = bodyHtml;
      const r = await fetch(`/worlds/${worldId}/pages`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await readError(r));
      const p = (await r.json()) as WorldPage;
      onCreated(p);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : t("errors.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  const previewSlug = slug.trim() ? slug.trim().toLowerCase() : deriveSlug(title);

  return (
    <form onSubmit={submit} className="space-y-3 text-xs">
      <h3 className="font-action text-base">
        {t("page.newPage")}
        {parentTitle ? <span className="ml-2 text-xs text-keep-muted">{t("page.under", { title: parentTitle })}</span> : null}
      </h3>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("fields.title")}</span>
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
        />
      </label>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("page.slugOptional")}</span>
        <input
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder={previewSlug || t("page.slugPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono outline-none focus:border-keep-action"
        />
      </label>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("page.bodyOptional")}</span>
        <textarea
          value={bodyHtml}
          onChange={(e) => setBodyHtml(e.target.value)}
          rows={6}
          placeholder={t("page.bodyOptionalPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-[11px] outline-none focus:border-keep-action"
        />
      </label>

      {err ? <div className="text-[11px] text-keep-accent">{err}</div> : null}

      <div className="flex justify-end gap-2 border-t border-keep-rule pt-3">
        <button
          type="button"
          onClick={onCancel}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-keep-muted hover:bg-keep-banner hover:text-keep-text"
        >
          {t("common:cancel")}
        </button>
        <button
          type="submit"
          disabled={busy || !title.trim()}
          className="keep-button rounded border border-keep-action bg-keep-action/15 px-3 py-0.5 font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
        >
          {busy ? t("creating") : t("page.createPage")}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------ */

function collectDescendants(pages: WorldPage[], rootId: string): Set<string> {
  const byParent = new Map<string, WorldPage[]>();
  for (const p of pages) {
    if (p.parentPageId) {
      const arr = byParent.get(p.parentPageId) ?? [];
      arr.push(p);
      byParent.set(p.parentPageId, arr);
    }
  }
  const out = new Set<string>();
  function walk(id: string) {
    for (const child of byParent.get(id) ?? []) {
      if (out.has(child.id)) continue;
      out.add(child.id);
      walk(child.id);
    }
  }
  walk(rootId);
  return out;
}

/* ------------------------------------------------------------ *
 *  InviteMemberPanel, owner directly adds a named identity to
 *  the world. Search-and-select shape: typing into the input
 *  hits `/users?q=...` debounced, results enumerate each
 *  identity (master OOC row + every character) so an owner can
 *  pick exactly which face of an account to seat. Click → POST
 *  /worlds/:id/invites with the corresponding `@id:` / `@cid:`
 *  token, which the server's `resolveIdentityArg` recognizes
 *  without any name-collision ambiguity.
 *
 *  Identity disambiguation is essential here: two different
 *  master accounts CAN have a character with the same name, so
 *  free-text name-typing would force the server to return an
 *  ambiguous-candidates list and the owner to redo the dance.
 *  Picking from search results sidesteps that entirely, every
 *  row in the dropdown carries the unambiguous token.
 * ------------------------------------------------------------ */

interface InviteSearchRow {
  /** The identity being offered. `@id:<userId>` for the master
   *  OOC row, `@cid:<characterId>` for a character row. */
  token: string;
  /** Display label rendered as the row's primary text. */
  label: string;
  /** Master username for character rows (so owners can tell two
   *  Jaggers apart); null for the master OOC row itself. The
   *  sublabel copy is derived at render time so it follows a
   *  language switch. */
  masterUsername: string | null;
  /** Live online state from the directory; surfaced as a tiny
   *  dot so an owner has some signal whether the invitee will
   *  see the membership immediately. */
  online: boolean;
}

function InviteMemberPanel({
  worldId,
  onInvited,
}: {
  worldId: string;
  /** Called after a successful invite so the parent can refresh
   *  the member gallery. */
  onInvited: () => Promise<void> | void;
}) {
  const { t } = useTranslation("worlds");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<InviteSearchRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [inviting, setInviting] = useState<string | null>(null);
  // Successful invites get a one-line "Invited <name>" confirmation
  // that auto-clears after a few seconds, same UX as a toast but
  // anchored to the panel so the owner can see it next to the row
  // they just acted on.
  const [lastInvited, setLastInvited] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  // Debounced live search. The server-side `/users?q=` is the same
  // endpoint the @-mention autocomplete uses, so we don't ship a
  // dedicated invite-search route.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setRows([]);
      return;
    }
    const myReq = ++reqIdRef.current;
    setSearching(true);
    const handle = window.setTimeout(() => {
      fetch(`/users?q=${encodeURIComponent(q)}&limit=10`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (myReq !== reqIdRef.current) return;
          if (!j || !Array.isArray(j.users)) { setRows([]); return; }
          const lc = q.toLowerCase();
          const out: InviteSearchRow[] = [];
          for (const u of j.users as Array<{
            userId: string;
            username: string;
            online: boolean;
            characters?: Array<{ id: string; name: string }>;
          }>) {
            // Master OOC row, match if the username contains the
            // query. Substring (not prefix) so typing the middle of
            // a long handle still surfaces it.
            if (u.username.toLowerCase().includes(lc)) {
              out.push({
                token: `@id:${u.userId}`,
                label: u.username,
                masterUsername: null,
                online: u.online,
              });
            }
            for (const c of u.characters ?? []) {
              if (!c.name.toLowerCase().includes(lc)) continue;
              out.push({
                token: `@cid:${c.id}`,
                label: c.name,
                // Master parenthetical disambiguates same-named
                // characters across accounts, the whole point of
                // doing this through tokens.
                masterUsername: u.username,
                online: u.online,
              });
            }
          }
          setRows(out);
        })
        .catch(() => { if (myReq === reqIdRef.current) setRows([]); })
        .finally(() => { if (myReq === reqIdRef.current) setSearching(false); });
    }, 180);
    return () => window.clearTimeout(handle);
  }, [query]);

  async function invite(row: InviteSearchRow) {
    setInviting(row.token);
    setError(null);
    try {
      const r = await fetch(`/worlds/${worldId}/invites`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: row.token }),
      });
      if (!r.ok) throw new Error(await readError(r));
      const data = (await r.json()) as { ok: true; displayName?: string; alreadyMember?: boolean };
      const name = data.displayName ?? row.label;
      setLastInvited(data.alreadyMember ? t("editor.invite.alreadyMember", { name }) : t("editor.invite.invited", { name }));
      // Auto-clear the confirmation so a string of invites doesn't
      // leave a stale row on screen.
      window.setTimeout(() => setLastInvited(null), 4_000);
      await onInvited();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errors.inviteFailed"));
    } finally {
      setInviting(null);
    }
  }

  return (
    <div className="space-y-2 rounded border border-keep-rule/60 bg-keep-banner/30 p-2">
      <span className="text-[10px] uppercase tracking-widest text-keep-muted">
        {t("editor.invite.heading")}
      </span>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("editor.invite.searchPlaceholder")}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
        aria-label={t("editor.invite.searchAria")}
      />
      {error ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-1.5 text-[11px] text-keep-accent">
          {error}
        </div>
      ) : null}
      {lastInvited ? (
        <div className="rounded border border-keep-action/40 bg-keep-action/10 p-1.5 text-[11px] text-keep-action">
          {lastInvited}
        </div>
      ) : null}
      {query.trim().length < 2 ? (
        <p className="text-[11px] italic text-keep-muted">
          {t("editor.invite.typeMore")}
        </p>
      ) : searching && rows.length === 0 ? (
        <p className="text-[11px] italic text-keep-muted">{t("editor.invite.searching")}</p>
      ) : rows.length === 0 ? (
        <p className="text-[11px] italic text-keep-muted">{t("editor.invite.noMatches")}</p>
      ) : (
        <ul className="divide-y divide-keep-rule/40 overflow-hidden rounded border border-keep-rule/40">
          {rows.map((row) => (
            <li key={row.token} className="flex items-center gap-2 bg-keep-bg/40 px-2 py-1">
              <span
                aria-hidden
                title={row.online ? t("editor.invite.onlineNow") : t("editor.invite.offline")}
                className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                  row.online ? "bg-keep-action" : "bg-keep-muted/50"
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-keep-text">{row.label}</div>
                <div className="truncate text-[10px] text-keep-muted">
                  {row.masterUsername !== null
                    ? t("editor.invite.characterSublabel", { name: row.masterUsername })
                    : t("editor.invite.oocSublabel")}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void invite(row)}
                disabled={inviting !== null}
                className="shrink-0 rounded border border-keep-action/60 bg-keep-action/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/30 disabled:opacity-50"
              >
                {inviting === row.token ? "…" : t("editor.invite.invite")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ *
 *  ApplicationQuestionsEditor, author tunes the 0..5 prompt list
 * ------------------------------------------------------------ */

function ApplicationQuestionsEditor({
  questions,
  onChange,
}: {
  questions: string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslation("worlds");
  function setAt(i: number, v: string) {
    const next = [...questions];
    next[i] = v;
    onChange(next);
  }
  function add() {
    if (questions.length >= WORLD_APP_MAX_QUESTIONS) return;
    onChange([...questions, ""]);
  }
  function removeAt(i: number) {
    onChange(questions.filter((_, j) => j !== i));
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= questions.length) return;
    const next = [...questions];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  }
  return (
    <div className="space-y-2 rounded border border-keep-rule/60 bg-keep-banner/30 p-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-widest text-keep-muted">
          {t("editor.questions.header", { current: questions.length, max: WORLD_APP_MAX_QUESTIONS })}
        </span>
        <button
          type="button"
          onClick={add}
          disabled={questions.length >= WORLD_APP_MAX_QUESTIONS}
          className="rounded border border-keep-rule bg-keep-bg px-1.5 py-0 text-[10px] hover:bg-keep-banner disabled:opacity-50"
        >
          {t("editor.questions.add")}
        </button>
      </div>
      {questions.length === 0 ? (
        <p className="text-[11px] italic text-keep-muted">
          {t("editor.questions.empty")}
        </p>
      ) : (
        <ul className="space-y-1">
          {questions.map((q, i) => (
            <li key={i} className="flex gap-1">
              <span className="shrink-0 pt-1 text-[10px] tabular-nums text-keep-muted">{i + 1}.</span>
              <input
                type="text"
                value={q}
                maxLength={WORLD_APP_QUESTION_MAX_LEN}
                placeholder={t("editor.questions.placeholder")}
                onChange={(e) => setAt(i, e.target.value)}
                className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
              />
              <div className="flex shrink-0 flex-col gap-0.5">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  className="rounded border border-keep-rule bg-keep-bg px-1 text-[8px] hover:bg-keep-banner disabled:opacity-30"
                  title={t("editor.questions.moveUp")}
                >▲</button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === questions.length - 1}
                  className="rounded border border-keep-rule bg-keep-bg px-1 text-[8px] hover:bg-keep-banner disabled:opacity-30"
                  title={t("editor.questions.moveDown")}
                >▼</button>
              </div>
              <button
                type="button"
                onClick={() => removeAt(i)}
                className="rounded border border-keep-accent/40 bg-keep-bg px-1.5 py-0 text-[10px] text-keep-accent hover:bg-keep-accent/10"
                title={t("editor.questions.removeTitle")}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ *
 *  PendingApplicationsPanel, owner reviews + approves / rejects
 * ------------------------------------------------------------ */

function PendingApplicationsPanel({
  worldId,
  onChanged,
}: {
  worldId: string;
  /** Called after a successful approve/reject so the parent can
   *  refresh members list (approved applicant joined). */
  onChanged: () => Promise<void> | void;
}) {
  const { t } = useTranslation("worlds");
  const [loading, setLoading] = useState(true);
  const [list, setList] = useState<WorldApplicationList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [showRecent, setShowRecent] = useState(false);
  // Per-application review note draft. Local state so a typed note
  // doesn't vanish when the list refreshes after another action.
  const [notes, setNotes] = useState<Record<string, string>>({});

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/worlds/${worldId}/applications`, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const data = (await r.json()) as WorldApplicationList;
      setList(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [worldId]);

  async function review(app: WorldApplicationEntry, action: "approve" | "reject") {
    setReviewing(app.id);
    setError(null);
    try {
      const body = {
        action,
        reviewNote: notes[app.id]?.trim() || null,
      };
      const r = await fetch(
        `/worlds/${worldId}/applications/${encodeURIComponent(app.id)}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!r.ok) throw new Error(await readError(r));
      // Clear the per-app note draft after submit, refresh the
      // list, and re-broadcast member info up to the parent.
      setNotes((m) => { const next = { ...m }; delete next[app.id]; return next; });
      await refresh();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errors.reviewFailed"));
    } finally {
      setReviewing(null);
    }
  }

  return (
    <div className="space-y-2 rounded border border-keep-rule/60 bg-keep-banner/30 p-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-widest text-keep-muted">
          {t("editor.apps.pendingHeader")} {list ? `(${list.pending.length})` : ""}
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="rounded border border-keep-rule bg-keep-bg px-1.5 py-0 text-[10px] hover:bg-keep-banner disabled:opacity-50"
        >
          {loading ? t("editor.apps.refreshing") : t("editor.apps.refresh")}
        </button>
      </div>
      {error ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-1.5 text-[11px] text-keep-accent">
          {error}
        </div>
      ) : null}
      {loading && !list ? (
        <p className="text-[11px] italic text-keep-muted">{t("editor.apps.loading")}</p>
      ) : list && list.pending.length === 0 ? (
        <p className="text-[11px] italic text-keep-muted">{t("editor.apps.none")}</p>
      ) : list ? (
        <ul className="space-y-2">
          {list.pending.map((app) => (
            <li key={app.id} className="rounded border border-keep-rule bg-keep-bg p-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold text-keep-text">{app.applicantUsername}</span>
                <span className="text-[10px] text-keep-muted">
                  {formatDateTime(app.submittedAt)}
                </span>
              </div>
              {app.questions.length === 0 ? (
                <p className="mt-1 text-[11px] italic text-keep-muted">
                  {t("editor.apps.noQuestions")}
                </p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {app.questions.map((q, i) => (
                    <li key={i} className="rounded border border-keep-rule/40 bg-keep-banner/30 p-1.5">
                      <div className="text-[10px] uppercase tracking-widest text-keep-muted">{q}</div>
                      <div className="mt-0.5 whitespace-pre-wrap text-[12px] text-keep-text">
                        {app.answers[i] || <span className="italic text-keep-muted">{t("application.emptyAnswer")}</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 space-y-1">
                <textarea
                  rows={2}
                  value={notes[app.id] ?? ""}
                  maxLength={WORLD_APP_REVIEW_NOTE_MAX_LEN}
                  placeholder={t("editor.apps.notePlaceholder")}
                  onChange={(e) => setNotes((m) => ({ ...m, [app.id]: e.target.value }))}
                  className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-[11px] outline-none focus:border-keep-action"
                />
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => void review(app, "approve")}
                    disabled={reviewing === app.id}
                    className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-[11px] text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
                  >
                    {reviewing === app.id ? "…" : t("editor.apps.approve")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void review(app, "reject")}
                    disabled={reviewing === app.id}
                    className="rounded border border-keep-accent/60 bg-keep-accent/10 px-2 py-0.5 text-[11px] text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
                  >
                    {t("editor.apps.reject")}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {list && list.recent.length > 0 ? (
        <details
          open={showRecent}
          onToggle={(e) => setShowRecent((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary className="cursor-pointer text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text">
            {t("editor.apps.recentDecisions", { total: list.recent.length })}
          </summary>
          <ul className="mt-1 space-y-1">
            {list.recent.map((app) => (
              <li
                key={app.id}
                className="flex flex-wrap items-baseline gap-2 rounded border border-keep-rule/40 bg-keep-banner/20 p-1.5 text-[11px]"
              >
                <span className="font-semibold">{app.applicantUsername}</span>
                <span className={
                  app.status === "approved"
                    ? "text-keep-action"
                    : app.status === "rejected"
                    ? "text-keep-accent"
                    : "text-keep-muted"
                }>
                  {t(`appStatus.${app.status}`)}
                </span>
                <span className="text-[10px] text-keep-muted">
                  {app.reviewedAt ? formatDateTime(app.reviewedAt) : ""}
                </span>
                {app.reviewNote ? (
                  <span className="basis-full italic text-keep-muted">{t("editor.apps.reviewNoteQuoted", { note: app.reviewNote })}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

