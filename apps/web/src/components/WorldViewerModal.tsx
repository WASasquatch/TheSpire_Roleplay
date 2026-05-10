import { useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import type { WorldDetail, WorldPage } from "@thekeep/shared";
import { buildWorldTree, parseWorldFromUrl, syncWorldUrl, worldShareUrl, type WorldTreeNode } from "../lib/worlds.js";
import { themeStyle } from "../lib/theme.js";

interface Props {
  worldId: string;
  onClose: () => void;
  /** Shown only when the viewer is the owner; lets them jump to the editor. */
  onEdit?: () => void;
  /**
   * Pre-fetched world detail. When provided we skip the initial /worlds/:id
   * fetch and render directly from this data. Used by the anonymous public-
   * viewer path where App.tsx already fetched the detail to decide between
   * standalone-view vs auth-gate; passing it through avoids a duplicate hit.
   */
  initialDetail?: WorldDetail;
  /**
   * When false, hide membership/edit/primary controls — anonymous viewers
   * have no way to call those endpoints (the server rejects them) so the
   * buttons would just produce 401s. Defaults true.
   */
  isAuthenticated?: boolean;
}

async function readError(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { error?: string; message?: string };
    return j.error ?? j.message ?? `${r.status} ${r.statusText}`;
  } catch {
    return `${r.status} ${r.statusText}`;
  }
}

/**
 * Read-only viewer for a world. Layout mirrors the editor (tree on the left,
 * content on the right), but the right pane renders the page body as
 * sanitized HTML instead of an editor. Public/open worlds are reachable by
 * non-owners; private ones only resolve for the owner.
 */
export function WorldViewerModal({ worldId, onClose, onEdit, initialDetail, isAuthenticated = true }: Props) {
  const [detail, setDetail] = useState<WorldDetail | null>(initialDetail ?? null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(() => {
    // Seed the selected page from initialDetail so the standalone view doesn't
    // flash the "pick a page" placeholder before useEffect runs.
    if (!initialDetail) return null;
    const firstTop = initialDetail.pages
      .filter((p) => p.parentPageId === null)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)[0];
    return firstTop?.id ?? null;
  });
  const [busy, setBusy] = useState(false);

  async function load() {
    setError(null);
    try {
      const r = await fetch(`/worlds/${worldId}`, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as WorldDetail;
      setDetail(j);
      if (selectedPageId === null) {
        const firstTop = j.pages
          .filter((p) => p.parentPageId === null)
          .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)[0];
        if (firstTop) setSelectedPageId(firstTop.id);
      }
      // Normalize the URL: callers may have opened the viewer with the
      // world's id (chat banner, primary-world chip) but the canonical
      // shareable form is /w/<slug>. Replace - not push - so back button
      // behaviour stays sane (one history entry per viewer open).
      syncWorldUrl(j.world.slug, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }
  useEffect(() => {
    if (initialDetail) {
      // Caller pre-fetched (anon public-view path). The detail is already
      // seeded into state via useState init; just align the URL with the
      // canonical slug. If we arrived from another /w/<X> URL (the deep-
      // link case) replace so /w/<id> rewrites to /w/<slug>; if we're
      // transitioning from a non-world URL (e.g. a profile's world chip)
      // push so back-button returns to the underlying view.
      const fromWorldUrl = parseWorldFromUrl() !== null;
      syncWorldUrl(initialDetail.world.slug, fromWorldUrl ? { replace: true } : {});
      return;
    }
    load();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [worldId]);

  async function join() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/worlds/${worldId}/members`, { method: "POST", credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "join failed"); }
    finally { setBusy(false); }
  }
  async function leave() {
    if (!window.confirm("Leave this world? You can re-join from the catalog any time.")) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/worlds/${worldId}/members`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "leave failed"); }
    finally { setBusy(false); }
  }
  async function setPrimary(makePrimary: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/me/primary-world", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worldId: makePrimary ? worldId : null }),
      });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "save failed"); }
    finally { setBusy(false); }
  }

  const tree = useMemo(() => (detail ? buildWorldTree(detail.pages) : []), [detail]);
  const selectedPage = detail?.pages.find((p) => p.id === selectedPageId) ?? null;

  // "Copy link" feedback: brief flash so the user knows the click did
  // something, since clipboard APIs are silent by default.
  const [copied, setCopied] = useState(false);
  async function copyLink() {
    if (!detail) return;
    const url = worldShareUrl(detail.world.slug);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback: drop the URL into a temporary input the user can copy
      // manually. Most modern browsers grant clipboard-write to user-
      // initiated handlers, but some (Safari pre-13.1, sandboxed iframes)
      // don't, so we surface the URL inline as a backstop.
      window.prompt("Copy this link:", url);
    }
  }

  // Scope the world's theme to this modal only via CSS-var override on the
  // card root. Falls back to the viewer's chat theme when the author hasn't
  // set one (theme === null).
  const modalStyle = detail?.world.theme ? themeStyle(detail.world.theme) : undefined;
  return (
    <div
      // Mobile: edge-to-edge sheet (no backdrop padding); dismiss via the
      // close button in the header. Desktop (md+): 75vw with breathing
      // room from the screen edge. See ProfileModal for the matching
      // sizing rationale — both modals follow the same shape so a viewer
      // moving between profile and world doesn't see a layout jump.
      className="fixed inset-0 z-50 flex items-stretch justify-stretch bg-black/40 md:items-center md:justify-center md:p-4"
      onClick={onClose}
    >
      <div
        style={modalStyle}
        className="flex h-dvh w-full flex-col overflow-hidden bg-keep-bg text-keep-text md:h-auto md:max-h-[92vh] md:w-[75vw] md:max-w-[1600px] md:rounded md:border md:border-keep-rule md:shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-keep-rule bg-keep-banner px-4 py-2">
          <div className="min-w-0">
            <h2 className="truncate font-action text-lg">{detail?.world.name ?? "World"}</h2>
            {detail ? (
              <div className="text-[11px] text-keep-muted">
                by {detail.world.ownerUsername}
                <span className="mx-1">·</span>
                {detail.world.pageCount} {detail.world.pageCount === 1 ? "page" : "pages"}
                <span className="mx-1">·</span>
                <button
                  type="button"
                  onClick={copyLink}
                  title={`Copy ${worldShareUrl(detail.world.slug)}`}
                  className="rounded border border-keep-rule/60 px-1 font-mono text-[10px] hover:border-keep-action hover:text-keep-action"
                >
                  {copied ? "copied!" : `/w/${detail.world.slug}`}
                </button>
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {detail && isAuthenticated ? (
              <MembershipControls
                detail={detail}
                busy={busy}
                onJoin={join}
                onLeave={leave}
                onSetPrimary={setPrimary}
              />
            ) : null}
            {onEdit && isAuthenticated ? (
              <button
                type="button"
                onClick={onEdit}
                className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-sm hover:bg-keep-banner"
              >
                Edit
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="text-sm text-keep-muted hover:text-keep-text"
            >
              close
            </button>
          </div>
        </header>

        {error ? (
          <div className="mx-4 mt-3 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">
            {error}
          </div>
        ) : null}

        {detail === null && error === null ? (
          <p className="p-4 italic text-keep-muted">Loading...</p>
        ) : detail !== null ? (
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <aside className="flex shrink-0 flex-col border-keep-rule md:w-72 md:border-r">
              <div className="shrink-0 border-b border-keep-rule bg-keep-banner/40 px-3 py-1.5 text-xs uppercase tracking-widest text-keep-muted">
                Pages
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-1 text-sm">
                {tree.length === 0 ? (
                  <p className="p-2 italic text-keep-muted">This world has no pages yet.</p>
                ) : (
                  <ViewerTree
                    nodes={tree}
                    selectedId={selectedPageId}
                    onSelect={(id) => setSelectedPageId(id)}
                  />
                )}
              </div>
            </aside>

            <section className="min-h-0 flex-1 overflow-y-auto p-5">
              {selectedPage ? (
                <PageView page={selectedPage} description={null} />
              ) : (
                <PageView
                  page={null}
                  description={detail.world.description}
                />
              )}
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ViewerTree({
  nodes,
  selectedId,
  onSelect,
}: {
  nodes: WorldTreeNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((n) => (
        <li key={n.page.id}>
          <button
            type="button"
            onClick={() => onSelect(n.page.id)}
            className={`block w-full truncate rounded px-2 py-1 text-left text-xs ${
              selectedId === n.page.id
                ? "bg-keep-action/15 text-keep-action"
                : "hover:bg-keep-muted/25"
            }`}
            style={{ paddingLeft: `${n.depth * 12 + 8}px` }}
            title={n.page.title}
          >
            {n.page.title}
          </button>
          {n.children.length > 0 ? (
            <ViewerTree nodes={n.children} selectedId={selectedId} onSelect={onSelect} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function PageView({ page, description }: { page: WorldPage | null; description: string | null }) {
  if (!page) {
    return (
      <div className="prose prose-sm max-w-none text-sm">
        {description ? (
          <p className="italic text-keep-muted">{description}</p>
        ) : (
          <p className="italic text-keep-muted">Pick a page from the sidebar.</p>
        )}
      </div>
    );
  }
  return (
    <article>
      <h3 className="mb-2 font-action text-xl">{page.title}</h3>
      {page.bodyHtml.trim() ? (
        <div
          className="prose prose-sm max-w-none text-sm leading-relaxed [&_a]:text-keep-action [&_blockquote]:border-l-2 [&_blockquote]:border-keep-rule [&_blockquote]:pl-3 [&_h3]:font-action [&_h4]:font-action [&_h5]:font-action [&_h6]:font-action [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(page.bodyHtml) }}
        />
      ) : (
        <p className="italic text-keep-muted">This page is empty.</p>
      )}
    </article>
  );
}

/**
 * Membership action chips for the viewer header. Visible buttons depend on
 * the world's visibility + the viewer's current membership state:
 *   - non-member + open world → "Join"
 *   - member, not primary    → "Set as primary" + "Leave"
 *   - member, is primary     → "Unset primary" + "Leave"
 *   - non-member + private/public → no controls (you can't join those)
 */
function MembershipControls({
  detail,
  busy,
  onJoin,
  onLeave,
  onSetPrimary,
}: {
  detail: WorldDetail;
  busy: boolean;
  onJoin: () => void;
  onLeave: () => void;
  onSetPrimary: (makePrimary: boolean) => void;
}) {
  const isOpen = detail.world.visibility === "open";
  if (!detail.viewerIsMember) {
    if (!isOpen) return null;
    return (
      <button
        type="button"
        onClick={onJoin}
        disabled={busy}
        title="Join this world to declare an affiliation. Doesn't change your room access."
        className="rounded border border-keep-rule bg-keep-banner px-2 py-0.5 text-sm hover:bg-keep-banner/80 disabled:opacity-50"
      >
        Join
      </button>
    );
  }
  return (
    <>
      {detail.viewerPrimary ? (
        <button
          type="button"
          onClick={() => onSetPrimary(false)}
          disabled={busy}
          title="Stop using this world as your primary. You'll appear unaffiliated in chat userlists."
          className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-sm hover:bg-keep-banner disabled:opacity-50"
        >
          Unset primary
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onSetPrimary(true)}
          disabled={busy}
          title="Use this world as your primary affiliation. Groups you with other members in chat userlists."
          className="rounded border border-keep-rule bg-keep-banner px-2 py-0.5 text-sm hover:bg-keep-banner/80 disabled:opacity-50"
        >
          Set as primary
        </button>
      )}
      <button
        type="button"
        onClick={onLeave}
        disabled={busy}
        className="rounded border border-keep-accent/50 bg-keep-bg px-2 py-0.5 text-sm text-keep-accent hover:bg-keep-accent/10 disabled:opacity-50"
      >
        Leave
      </button>
    </>
  );
}
