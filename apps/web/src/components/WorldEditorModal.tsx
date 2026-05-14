import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  Theme,
  WorldDetail,
  WorldGenre,
  WorldPacing,
  WorldPage,
  WorldStatus,
  WorldVisibility,
} from "@thekeep/shared";
import {
  CANONICAL_TAGS,
  CONTENT_WARNINGS,
  DEFAULT_THEME,
  WORLD_PAGE_DEPTH_CAP,
} from "@thekeep/shared";
import { buildWorldTree, deriveSlug, type WorldTreeNode } from "../lib/worlds.js";
import { readError } from "../lib/http.js";
import { themeStyle } from "../lib/theme.js";
import { Modal } from "./Modal.js";
import { ThemePicker } from "./ThemePicker.js";

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
  const [detail, setDetail] = useState<WorldDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [creatingUnderParent, setCreatingUnderParent] = useState<string | "root" | null>(null);

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
      setError(e instanceof Error ? e.message : "load failed");
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [worldId]);

  const tree = useMemo(() => (detail ? buildWorldTree(detail.pages) : []), [detail]);
  const selectedPage = detail?.pages.find((p) => p.id === selectedPageId) ?? null;

  async function deleteWorld() {
    if (!detail) return;
    if (!window.confirm(
      `Delete "${detail.world.name}"? This cascades to all ${detail.world.pageCount} pages and removes any room links. Cannot be undone.`,
    )) return;
    try {
      const r = await fetch(`/worlds/${worldId}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      onDeleted?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    }
  }

  async function deletePage(p: WorldPage) {
    const childCount = detail?.pages.filter((x) => x.parentPageId === p.id).length ?? 0;
    const tail = childCount > 0 ? ` and its ${childCount} child page${childCount === 1 ? "" : "s"}` : "";
    if (!window.confirm(`Delete "${p.title}"${tail}? Cannot be undone.`)) return;
    try {
      const r = await fetch(`/worlds/${worldId}/pages/${p.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      if (selectedPageId === p.id) setSelectedPageId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    }
  }

  // Scope the world's theme to this modal only - styleOverride flows down
  // through CSS vars so all the keep-* tailwind colors inside this card use
  // the world author's palette without leaking into the chat behind us.
  const modalStyle = detail?.world.theme ? themeStyle(detail.world.theme) : undefined;
  return (
    <Modal onClose={onClose} zIndex={50}>
      <div
        style={modalStyle}
        className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded border border-keep-rule bg-keep-bg text-keep-text shadow-xl md:w-[78vw] md:max-w-[1400px]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-keep-rule bg-keep-banner px-4 py-2">
          <h2 className="font-action text-lg">
            {detail ? `Edit world: ${detail.world.name}` : "Edit world"}
            {detail ? <span className="ml-2 text-xs text-keep-muted">/{detail.world.slug}</span> : null}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-keep-muted hover:text-keep-text"
          >
            close
          </button>
        </header>

        {error ? (
          <div className="mx-4 mt-3 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">
            {error}
          </div>
        ) : null}

        {detail === null ? (
          <p className="p-4 italic text-keep-muted">Loading...</p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            {/* Left: page tree */}
            <aside className="flex shrink-0 flex-col border-keep-rule md:w-72 md:border-r">
              <div className="flex shrink-0 items-center justify-between border-b border-keep-rule bg-keep-banner/40 px-3 py-1.5 text-xs">
                <span className="uppercase tracking-widest text-keep-muted">Pages</span>
                <button
                  type="button"
                  onClick={() => { setCreatingUnderParent("root"); setSelectedPageId(null); }}
                  className="rounded border border-keep-rule bg-keep-bg px-1.5 py-0.5 text-[11px] hover:bg-keep-banner"
                  title="Add a top-level page"
                >
                  + Page
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-1 text-sm">
                <button
                  type="button"
                  onClick={() => { setSelectedPageId(null); setCreatingUnderParent(null); }}
                  className={`block w-full rounded px-2 py-1 text-left text-xs uppercase tracking-widest ${
                    selectedPageId === null && creatingUnderParent === null
                      ? "bg-keep-action/15 text-keep-action"
                      : "text-keep-muted hover:bg-keep-muted/25"
                  }`}
                >
                  World settings
                </button>
                {tree.length === 0 ? (
                  <p className="p-2 italic text-keep-muted">No pages yet.</p>
                ) : (
                  <PageTree
                    nodes={tree}
                    selectedId={selectedPageId}
                    onSelect={(id) => { setSelectedPageId(id); setCreatingUnderParent(null); }}
                    onAddChild={(id) => { setCreatingUnderParent(id); setSelectedPageId(null); }}
                  />
                )}
              </div>
            </aside>

            {/* Right: editor pane */}
            <section className="min-h-0 flex-1 overflow-y-auto p-4">
              {creatingUnderParent !== null ? (
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
    </Modal>
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
                title="Add child page"
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
  const w = detail.world;
  const [name, setName] = useState(w.name);
  const [slug, setSlug] = useState(w.slug);
  const [description, setDescription] = useState(w.description ?? "");
  const [visibility, setVisibility] = useState<WorldVisibility>(w.visibility);
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
      // Theme diff: stringify-compare so we only send when something actually
      // changed. Null vs null is a no-op; null vs Theme (or vice versa) writes.
      if (JSON.stringify(theme) !== JSON.stringify(w.theme)) body.theme = theme;
      if (genre !== w.genre) body.genre = genre;
      // Tag/CW arrays compare via canonical join — the server normalizes
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
      setErr(e2 instanceof Error ? e2.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 text-xs">
      <h3 className="font-action text-base">World settings</h3>
      <p className="text-[11px] text-keep-muted">
        {detail.pages.length} {detail.pages.length === 1 ? "page" : "pages"}. Visibility controls who can read this
        world: private = only you, public = anyone with the URL, open = also listed in the catalog and linkable from
        other people's rooms.
      </p>

      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
        />
      </label>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Slug</span>
        <input
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono outline-none focus:border-keep-action"
        />
        <span className="mt-0.5 block text-[10px] text-keep-muted">
          Used in URLs and the /world link slash command. Lowercase letters, numbers, hyphens; 1-60 chars.
        </span>
      </label>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          maxLength={2000}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
        />
      </label>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Visibility</span>
        <select
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as WorldVisibility)}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
        >
          <option value="private">Private (only you)</option>
          <option value="public">Public (anyone with the link)</option>
          <option value="open">Open (catalog-listed, others can link to their rooms)</option>
        </select>
      </label>

      <fieldset className="rounded border border-keep-rule p-3 space-y-3">
        <legend className="px-1 text-[10px] uppercase tracking-widest text-keep-muted">
          Catalog metadata
        </legend>
        <p className="text-[11px] text-keep-muted">
          Surfaces in the World Catalog filter UI. Genre and tags help readers find your
          world; content warnings let them filter what they'd rather not encounter.
        </p>

        <label className="block">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Genre</span>
          <select
            value={genre}
            onChange={(e) => setGenre(e.target.value as WorldGenre)}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="fantasy">Fantasy</option>
            <option value="modern">Modern</option>
            <option value="scifi">Sci-Fi</option>
            <option value="horror">Horror</option>
            <option value="western">Western</option>
            <option value="steampunk">Steampunk</option>
            <option value="mythological">Mythological</option>
            <option value="other">Other</option>
          </select>
        </label>

        <div>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Tags</span>
          {tags.length > 0 ? (
            <div className="mb-1 flex flex-wrap gap-1">
              {tags.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => removeTag(t)}
                  title={`Remove "${t}"`}
                  className="rounded border border-keep-action/40 bg-keep-action/10 px-1.5 py-0 text-[11px] text-keep-action hover:bg-keep-accent/15 hover:text-keep-accent"
                >
                  {t} <span aria-hidden>×</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="mb-1 text-[10px] italic text-keep-muted">No tags yet.</div>
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
              placeholder="add a custom tag..."
              maxLength={32}
              className="flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
            />
            <button
              type="button"
              onClick={() => addTag(tagDraft)}
              disabled={!tagDraft.trim()}
              className="rounded border border-keep-rule bg-keep-banner px-2 py-1 text-[11px] hover:bg-keep-banner/80 disabled:opacity-50"
            >
              add
            </button>
          </div>
          {canonicalNotSelected.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              <span className="text-[10px] uppercase tracking-widest text-keep-muted">Common:</span>
              {canonicalNotSelected.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => addTag(t)}
                  className="rounded border border-keep-rule bg-keep-bg/50 px-1.5 py-0 text-[11px] text-keep-muted hover:border-keep-action hover:bg-keep-action/10 hover:text-keep-action"
                >
                  + {t}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Content warnings</span>
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
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Cover image URL</span>
          <input
            type="url"
            value={coverImageUrl}
            onChange={(e) => setCoverImageUrl(e.target.value)}
            placeholder="https://example.com/cover.jpg"
            maxLength={2000}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
          />
          {coverImageUrl ? (
            <div className="mt-1">
              {/* Live preview at the same aspect the catalog card will use
                  (3:2). `referrerPolicy="no-referrer"` matches the inline
                  image preview in chat — keeps the chat URL from leaking
                  via Referer to whoever hosts the image. */}
              <img
                src={coverImageUrl}
                alt="cover preview"
                referrerPolicy="no-referrer"
                className="block max-h-32 max-w-full rounded border border-keep-rule object-cover"
              />
            </div>
          ) : null}
        </label>

        <label className="block">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Pacing</span>
          <select
            value={pacing}
            onChange={(e) => setPacing(e.target.value as WorldPacing | "")}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="">(unspecified)</option>
            <option value="casual">Casual (pick-up scenes, low commitment)</option>
            <option value="structured">Structured (planned scenes / arcs)</option>
            <option value="long-form">Long-form (extended arcs, deep commitment)</option>
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Status</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as WorldStatus)}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="active">Active</option>
            <option value="archived">Archived (hidden from catalog)</option>
            {status === "featured" ? (
              <option value="featured">Featured (admin-curated)</option>
            ) : null}
          </select>
          <span className="mt-0.5 block text-[10px] text-keep-muted">
            Featured status is admin-curated only; owners can move between Active and Archived.
          </span>
        </label>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3">
        <legend className="px-1 text-[10px] uppercase tracking-widest text-keep-muted">
          Theme
        </legend>
        <p className="mb-2 text-[11px] text-keep-muted">
          A custom palette for this world's editor and viewer modals only. Doesn't affect chat
          or the userlist - just the wiki views your readers see.
        </p>
        {theme === null ? (
          <button
            type="button"
            onClick={() => setTheme(DEFAULT_THEME)}
            className="rounded border border-keep-rule bg-keep-banner px-2 py-1 text-xs hover:bg-keep-banner/80"
          >
            Add a custom theme
          </button>
        ) : (
          <>
            <ThemePicker
              theme={theme}
              onChange={(t) => setTheme(t)}
              onReset={() => setTheme(DEFAULT_THEME)}
            />
            <button
              type="button"
              onClick={() => setTheme(null)}
              className="mt-2 rounded border border-keep-accent/40 bg-keep-bg px-2 py-1 text-[11px] text-keep-accent hover:bg-keep-accent/10"
            >
              Remove custom theme (use viewer's chat theme)
            </button>
          </>
        )}
      </fieldset>

      {err ? <div className="text-[11px] text-keep-accent">{err}</div> : null}

      <div className="flex items-center justify-between border-t border-keep-rule pt-3">
        <button
          type="button"
          onClick={onDelete}
          className="keep-button rounded border border-keep-accent/50 bg-keep-bg px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10"
        >
          Delete world
        </button>
        <div className="flex items-center gap-3">
          {savedAt ? (
            <span className="text-[10px] text-keep-muted">saved {new Date(savedAt).toLocaleTimeString()}</span>
          ) : null}
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="keep-button rounded border border-keep-action bg-keep-action/15 px-3 py-0.5 font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
          >
            {busy ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </form>
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
      setErr(e2 instanceof Error ? e2.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 text-xs">
      <h3 className="font-action text-base">{page.title}</h3>

      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Title</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
        />
      </label>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Slug</span>
        <input
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono outline-none focus:border-keep-action"
        />
      </label>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Body (HTML)</span>
        <textarea
          value={bodyHtml}
          onChange={(e) => setBodyHtml(e.target.value)}
          rows={14}
          placeholder="<p>Write the page body here. Same HTML allow-list as your bio (b, i, em, p, ul/ol/li, blockquote, h3-h6, etc.).</p>"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-[11px] outline-none focus:border-keep-action"
        />
        <span className="mt-0.5 block text-[10px] text-keep-muted">
          HTML is sanitized server-side. Disallowed tags and attributes are stripped on save.
        </span>
      </label>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Parent page</span>
          <select
            value={parentPageId}
            onChange={(e) => setParentPageId(e.target.value)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="">(top level)</option>
            {parentOptions.map((p) => (
              <option key={p.id} value={p.id}>{p.title}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Sort order</span>
          <input
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(parseInt(e.target.value, 10) || 0)}
            min={0}
            max={10000}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
          />
          <span className="mt-0.5 block text-[10px] text-keep-muted">
            Lower = higher in the sidebar. Ties broken by creation time.
          </span>
        </label>
      </div>

      {err ? <div className="text-[11px] text-keep-accent">{err}</div> : null}

      <div className="flex items-center justify-between border-t border-keep-rule pt-3">
        <button
          type="button"
          onClick={onDelete}
          className="keep-button rounded border border-keep-accent/50 bg-keep-bg px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10"
        >
          Delete page
        </button>
        <div className="flex items-center gap-3">
          {savedAt ? (
            <span className="text-[10px] text-keep-muted">saved {new Date(savedAt).toLocaleTimeString()}</span>
          ) : null}
          <button
            type="submit"
            disabled={busy || !title.trim()}
            className="keep-button rounded border border-keep-action bg-keep-action/15 px-3 py-0.5 font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
          >
            {busy ? "Saving..." : "Save"}
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
      setErr(e2 instanceof Error ? e2.message : "create failed");
    } finally {
      setBusy(false);
    }
  }

  const previewSlug = slug.trim() ? slug.trim().toLowerCase() : deriveSlug(title);

  return (
    <form onSubmit={submit} className="space-y-3 text-xs">
      <h3 className="font-action text-base">
        New page
        {parentTitle ? <span className="ml-2 text-xs text-keep-muted">under {parentTitle}</span> : null}
      </h3>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Title</span>
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
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Slug (optional)</span>
        <input
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder={previewSlug || "e.g. cities-of-aerith"}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono outline-none focus:border-keep-action"
        />
      </label>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Body (HTML, optional)</span>
        <textarea
          value={bodyHtml}
          onChange={(e) => setBodyHtml(e.target.value)}
          rows={6}
          placeholder="You can fill this in later."
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
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || !title.trim()}
          className="keep-button rounded border border-keep-action bg-keep-action/15 px-3 py-0.5 font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
        >
          {busy ? "Creating..." : "Create page"}
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

