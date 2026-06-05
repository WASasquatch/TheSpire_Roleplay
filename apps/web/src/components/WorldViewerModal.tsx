import { useEffect, useMemo, useState } from "react";
import { legibleHtmlColors, sanitizeUserHtml, sweepOrphanedUserBioStyles, USER_HTML_SCOPE_CLASS } from "../lib/userHtml.js";
import type { WorldDetail, WorldMemberRef, WorldPage } from "@thekeep/shared";
import { cropStyleFor } from "../lib/avatarCrop.js";
import { buildWorldTree, parseWorldFromUrl, syncWorldUrl, worldShareUrl, type WorldTreeNode } from "../lib/worlds.js";
import { readError } from "../lib/http.js";
import { ActiveThemeContext, themeStyle, useActiveTheme } from "../lib/theme.js";
import { Modal, MODAL_CARD_CONTENT } from "./Modal.js";
import { CloseButton } from "./CloseButton.js";
import { ApplicationFormModal } from "./ApplicationFormModal.js";

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
  /**
   * When true, mount the ApplicationFormModal on top of the viewer at
   * open time. Used by the `/world join <slug>` slash-command path:
   * the server emits `open-world` + `world-application-prompt`, and
   * App.tsx forwards the second hint as this prop. Without it the
   * applicant would have to find the Apply button themselves after
   * the viewer opened.
   */
  openApplicationOnMount?: boolean;
}

/**
 * Read-only viewer for a world. Layout mirrors the editor (tree on the left,
 * content on the right), but the right pane renders the page body as
 * sanitized HTML instead of an editor. Public/open worlds are reachable by
 * non-owners; private ones only resolve for the owner.
 */
export function WorldViewerModal({ worldId, onClose, onEdit, initialDetail, isAuthenticated = true, openApplicationOnMount = false }: Props) {
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
  // Application form overlay. The catalog opens this same component
  // via its own `applyingTo` state; here we drive it from either the
  // Apply chip in MembershipControls OR the `openApplicationOnMount`
  // prop fired from the `/world join` slash-command flow.
  const [showApplicationForm, setShowApplicationForm] = useState(openApplicationOnMount);

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

  // Belt-and-suspenders cleanup for the page-author's `<style>` blocks
  // — same posture as ProfileModal's unmount sweep. The portal-and-
  // dangerouslySetInnerHTML pipeline normally cleans up its own
  // styles on unmount, but a reported transition from the public
  // deep-link viewer back to the login modal showed page CSS bleeding
  // into the next mount. Sweeping orphans on close guarantees nothing
  // marker-tagged survives the world view's teardown.
  useEffect(() => {
    return () => { sweepOrphanedUserBioStyles(); };
  }, []);

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
  // setPrimary was removed alongside the primary-world feature in
  // migration 0187 — per-identity memberships made a cross-identity
  // primary signal meaningless. Memberships still exist, just without
  // the "this one is your headline affiliation" flag.

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
  const viewerTheme = useActiveTheme();
  const scopedTheme = detail?.world.theme ?? viewerTheme;
  const modalStyle = detail?.world.theme ? themeStyle(detail.world.theme) : undefined;
  return (
    <Modal onClose={onClose} variant="mobile-fullscreen" zIndex={50}>
      {/* Republish the scoped theme on React context so descendant
          components calling `useActiveTheme()` (resolveMessageColor,
          legibility passes on user HTML, mention chips, etc.) measure
          contrast against the world's bg instead of the viewer's
          document-level chat theme. Without the provider the CSS vars
          flipped correctly but the React-context-driven legibility
          nudges still computed against the WRONG background, so user-
          picked colors that read fine on light Parchment chat went
          invisible on a dark navy world. */}
      <ActiveThemeContext.Provider value={scopedTheme}>
      <div
        style={modalStyle}
        className={`${MODAL_CARD_CONTENT} keep-frame keep-frame--reading bg-keep-bg text-keep-text lg:rounded`}
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
                onApply={() => setShowApplicationForm(true)}
              />
            ) : null}
            {/* Edit button only shows when the viewer can actually edit
                (owner, admin, or invited collaborator). Previously this
                rendered for any logged-in user, so non-editors could
                open the editor UI and only learn they lacked permission
                when the first save returned 403. The server still
                enforces the same gate on every mutation. */}
            {onEdit && isAuthenticated && detail?.viewerCanEdit ? (
              <button
                type="button"
                onClick={onEdit}
                className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-sm hover:bg-keep-banner"
              >
                Edit
              </button>
            ) : null}
            <CloseButton onClick={onClose} />
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

            <section className="min-h-0 flex-1 overflow-y-auto">
              <MemberGallery members={detail.members} />
              <div className="p-5">
                {selectedPage ? (
                  <PageView page={selectedPage} description={null} />
                ) : (
                  <PageView
                    page={null}
                    description={detail.world.description}
                  />
                )}
              </div>
            </section>
          </div>
        ) : null}
      </div>
      </ActiveThemeContext.Provider>
      {showApplicationForm && detail ? (
        <ApplicationFormModal
          worldId={detail.world.id}
          worldName={detail.world.name}
          onClose={() => setShowApplicationForm(false)}
          onSubmitted={() => {
            // Close on submit. The viewer's load() refresh isn't
            // strictly required — the application status doesn't
            // change membership yet (still pending review), and the
            // catalog card the user came from will reflect "pending"
            // on its next mount. Keeping the close-only posture
            // matches the catalog's Apply flow.
            setShowApplicationForm(false);
          }}
        />
      ) : null}
    </Modal>
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
  // The viewer context here is already the world's scoped theme (the
  // modal wraps PageView in <ActiveThemeContext.Provider>), so `bg`
  // is the actual background user-styled text is painted against —
  // which is what legibleHtmlColors needs to compute its nudges.
  const themeBg = useActiveTheme().bg;
  const safeHtml = useMemo(() => {
    if (!page || !page.bodyHtml.trim()) return "";
    return legibleHtmlColors(sanitizeUserHtml(page.bodyHtml), themeBg);
  }, [page?.bodyHtml, themeBg]);
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
          className={`prose prose-sm max-w-none text-sm leading-relaxed [&_a]:text-keep-action [&_blockquote]:border-l-2 [&_blockquote]:border-keep-rule [&_blockquote]:pl-3 [&_h3]:font-action [&_h4]:font-action [&_h5]:font-action [&_h6]:font-action [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5 ${USER_HTML_SCOPE_CLASS}`}
          dangerouslySetInnerHTML={{ __html: safeHtml }}
        />
      ) : (
        <p className="italic text-keep-muted">This page is empty.</p>
      )}
    </article>
  );
}

/**
 * Member avatars rendered above the world body as a flex gallery
 * spanning the section width. Capped at three rows tall (~144px) via
 * a hard max-height + overflow-hidden so a popular world with many
 * members doesn't push the page content below the fold. Members are
 * ordered with primary affiliations first (server sort), then by
 * join date.
 *
 * Privacy: the server-side filter in `memberListFor` already drops
 * users whose master profile is private or NSFW — they explicitly
 * opted out of public affiliation, so they never appear here. The
 * client takes the wire list at face value.
 *
 * No-op render when the list is empty so a young world doesn't carry
 * a hollow "Members" strip.
 */
function MemberGallery({ members }: { members: WorldMemberRef[] }) {
  if (members.length === 0) return null;
  return (
    <section
      aria-label="World members"
      className="border-b border-keep-rule bg-keep-banner/30 px-4 pb-2 pt-3"
    >
      <header className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-widest text-keep-muted">
          Members
        </span>
        <span className="text-[10px] text-keep-muted">
          {members.length} {members.length === 1 ? "member" : "members"}
        </span>
      </header>
      {/* Cap at 3 rows: 40px avatar + 8px gap = 48px per row, three rows
          = 144px tall. Overflow clips additional members; the count in
          the header still surfaces the true total. */}
      <div
        className="flex flex-wrap gap-2 overflow-hidden"
        style={{ maxHeight: 144 }}
      >
        {members.map((m) => (
          <MemberAvatar key={m.userId} member={m} />
        ))}
      </div>
    </section>
  );
}

function MemberAvatar({ member }: { member: WorldMemberRef }) {
  const [errored, setErrored] = useState(false);
  // Display the identity that joined: character name when present
  // (with master in parens for accountability), master username for
  // OOC memberships.
  const title = member.characterId !== null
    ? `${member.displayName} (${member.username})`
    : member.displayName;
  // Shared crop resolver — see `lib/avatarCrop`. Default crop maps to
  // `undefined` so the legacy centered-cover render is byte-identical.
  const cropStyle = cropStyleFor(member.avatarCrop);
  return (
    <span
      title={title}
      className="relative inline-block h-10 w-10 shrink-0 rounded-full"
    >
      <span className="absolute inset-0 overflow-hidden rounded-full border border-keep-rule bg-keep-bg">
        {member.avatarUrl && !errored ? (
          <img
            src={member.avatarUrl}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setErrored(true)}
            className="absolute inset-0 h-full w-full object-cover"
            style={cropStyle}
          />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold text-keep-muted">
            {member.displayName.slice(0, 2).toUpperCase()}
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * Membership action chips for the viewer header. Per migration 0187
 * primary-world is gone, so the controls are just Join / Apply /
 * Leave scoped to the viewer's CURRENT identity:
 *   - already a member → "Leave"
 *   - non-member + visibility="open" + joinMode="open" → "Join"
 *   - non-member + visibility="open" + joinMode="application" → "Apply" (opens ApplicationFormModal)
 *   - non-member + visibility="open" + joinMode="invite-only" → static "Invite-only" chip
 *   - non-member + visibility=private/public → nothing (no public path)
 *
 * Application-mode chips reflect any in-flight application: a
 * pending application disables the button and shows "Application
 * pending"; a rejected application shows "Reapply" so the user has
 * an explicit second-chance affordance.
 */
function MembershipControls({
  detail,
  busy,
  onJoin,
  onLeave,
  onApply,
}: {
  detail: WorldDetail;
  busy: boolean;
  onJoin: () => void;
  onLeave: () => void;
  onApply: () => void;
}) {
  if (detail.viewerIsMember) {
    return (
      <button
        type="button"
        onClick={onLeave}
        disabled={busy}
        className="keep-button rounded border border-keep-accent/50 bg-keep-bg px-2 py-0.5 text-sm text-keep-accent hover:bg-keep-accent/10 disabled:opacity-50"
      >
        Leave
      </button>
    );
  }
  // Non-member branches. Visibility !== "open" means there's no
  // public path in here at all (private worlds resolve only for the
  // owner; public ones aren't catalog-joinable). Show nothing.
  if (detail.world.visibility !== "open") return null;
  const joinMode = detail.world.joinMode ?? "open";
  if (joinMode === "invite-only") {
    // Static informational chip. Looks like a button but isn't one —
    // there's nothing to do here besides ask the author. Title is
    // the actionable guidance.
    return (
      <span
        title="The author of this world adds members directly. Message them if you'd like in."
        className="inline-flex items-center rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs italic text-keep-muted"
      >
        Invite-only
      </span>
    );
  }
  if (joinMode === "application") {
    const app = detail.viewerApplication;
    if (app && app.status === "pending") {
      return (
        <span
          title="Your application is waiting on the author."
          className="inline-flex items-center rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs italic text-keep-muted"
        >
          Application pending
        </span>
      );
    }
    return (
      <button
        type="button"
        onClick={onApply}
        disabled={busy}
        title={app && app.status === "rejected"
          ? "Your last application was declined. You can apply again."
          : "Send the author an application to join this world."}
        className="keep-button rounded border border-keep-rule bg-keep-banner px-2 py-0.5 text-sm hover:bg-keep-banner/80 disabled:opacity-50"
      >
        {app && app.status === "rejected" ? "Reapply" : "Apply"}
      </button>
    );
  }
  // joinMode === "open" → classic one-click Join, same posture as before.
  return (
    <button
      type="button"
      onClick={onJoin}
      disabled={busy}
      title="Join this world as your current identity. Doesn't change room access."
      className="keep-button rounded border border-keep-rule bg-keep-banner px-2 py-0.5 text-sm hover:bg-keep-banner/80 disabled:opacity-50"
    >
      Join
    </button>
  );
}
