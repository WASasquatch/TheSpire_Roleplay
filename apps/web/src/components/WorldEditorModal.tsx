import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Theme, WorldDetail, WorldPage, WorldVisibility } from "@thekeep/shared";
import { DEFAULT_THEME, WORLD_PAGE_DEPTH_CAP } from "@thekeep/shared";
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

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
            className="keep-button rounded border border-keep-rule bg-keep-banner px-3 py-0.5 hover:bg-keep-banner/80 disabled:opacity-50"
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
            className="keep-button rounded border border-keep-rule bg-keep-banner px-3 py-0.5 hover:bg-keep-banner/80 disabled:opacity-50"
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
          className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || !title.trim()}
          className="keep-button rounded border border-keep-rule bg-keep-banner px-3 py-0.5 hover:bg-keep-banner/80 disabled:opacity-50"
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

