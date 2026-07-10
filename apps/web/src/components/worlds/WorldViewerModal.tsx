import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorldDetail } from "@thekeep/shared";
import { sweepOrphanedUserBioStyles } from "../../lib/userHtml.js";
import { useCopyToClipboard } from "../../lib/useCopyToClipboard.js";
import { parseWorldFromUrl, syncWorldUrl, worldShareUrl } from "../../lib/worlds.js";
import { readError } from "../../lib/http.js";
import { ActiveThemeContext, themeStyle, useActiveTheme } from "../../lib/theme.js";
import { Modal, MODAL_CARD_CONTENT } from "../cosmetics/Modal.js";
import { CloseButton } from "../shared/CloseButton.js";
import { ApplicationFormModal } from "./ApplicationFormModal.js";
import { WorldKnowledgeBase } from "./WorldKnowledgeBase.js";

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
   * When false, hide membership/edit/primary controls, anonymous viewers
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
  const { t } = useTranslation("worlds");
  const [detail, setDetail] = useState<WorldDetail | null>(initialDetail ?? null);
  const [error, setError] = useState<string | null>(null);
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
      // Normalize the URL: callers may have opened the viewer with the
      // world's id (chat banner, primary-world chip) but the canonical
      // shareable form is /w/<slug>. Replace - not push - so back button
      // behaviour stays sane (one history entry per viewer open).
      syncWorldUrl(j.world.slug, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errors.loadFailed"));
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
  //, same posture as ProfileModal's unmount sweep. The portal-and-
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
    } catch (e) { setError(e instanceof Error ? e.message : t("errors.joinFailed")); }
    finally { setBusy(false); }
  }
  async function leave() {
    if (!window.confirm(t("viewer.confirmLeave"))) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/worlds/${worldId}/members`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : t("errors.leaveFailed")); }
    finally { setBusy(false); }
  }
  // setPrimary was removed alongside the primary-world feature in
  // migration 0187, per-identity memberships made a cross-identity
  // primary signal meaningless. Memberships still exist, just without
  // the "this one is your headline affiliation" flag.

  // "Copy link" feedback: brief flash so the user knows the click did
  // something, since clipboard APIs are silent by default.
  const { copied, copy: copyToClipboard } = useCopyToClipboard({
    resetMs: 1500,
    // Fallback: drop the URL into a temporary input the user can copy
    // manually. Most modern browsers grant clipboard-write to user-
    // initiated handlers, but some (Safari pre-13.1, sandboxed iframes)
    // don't, so we surface the URL inline as a backstop.
    onError: (url) => window.prompt(t("viewer.copyPrompt"), url),
  });
  function copyLink() {
    if (!detail) return;
    void copyToClipboard(worldShareUrl(detail.world.slug));
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
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate font-action text-lg">{detail?.world.name ?? t("viewer.fallbackTitle")}</h2>
              {detail?.world.isNsfw ? (
                <span
                  className="shrink-0 rounded bg-keep-accent/90 px-1.5 py-0 text-[10px] font-semibold uppercase tracking-widest text-keep-bg"
                  title={t("nsfwChipTitle")}
                >
                  {t("common:rating.nsfw")}
                </span>
              ) : null}
            </div>
            {detail ? (
              <div className="text-[11px] text-keep-muted">
                {t("byOwner", { name: detail.world.ownerUsername })}
                <span className="mx-1">·</span>
                {t("pageCount", { count: detail.world.pageCount })}
                <span className="mx-1">·</span>
                <button
                  type="button"
                  onClick={copyLink}
                  title={t("viewer.copyLinkTitle", { url: worldShareUrl(detail.world.slug) })}
                  className="rounded border border-keep-rule/60 px-1 font-mono text-[10px] hover:border-keep-action hover:text-keep-action"
                >
                  {copied ? t("viewer.copied") : `/w/${detail.world.slug}`}
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
                {t("actions.edit")}
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
          <p className="p-4 italic text-keep-muted">{t("common:loadingDots")}</p>
        ) : detail !== null ? (
          <WorldKnowledgeBase
            worldId={worldId}
            detail={detail}
            membership={{ isAuthenticated, busy, onJoin: join, onLeave: leave, onApply: () => setShowApplicationForm(true) }}
          />
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
            // strictly required, the application status doesn't
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
  const { t } = useTranslation("worlds");
  if (detail.viewerIsMember) {
    return (
      <button
        type="button"
        onClick={onLeave}
        disabled={busy}
        className="keep-button rounded border border-keep-accent/50 bg-keep-bg px-2 py-0.5 text-sm text-keep-accent hover:bg-keep-accent/10 disabled:opacity-50"
      >
        {t("actions.leave")}
      </button>
    );
  }
  // Non-member branches, driven by joinMode INDEPENDENT of visibility. Visibility
  // gates who can SEE the world (resolveWorld — if the viewer reached this modal
  // they can see it); joinMode gates how they get IN. This matches the editor's
  // own contract ("independent of visibility — a public / link-shared world still
  // takes applications"). The old `visibility !== "open"` guard hid Apply/Join on
  // every non-"open" world, so a PUBLIC application-mode world showed no way in
  // for anyone — including site staff who can moderate it but don't own it.
  const joinMode = detail.world.joinMode ?? "open";
  if (joinMode === "invite-only") {
    // Static informational chip. Looks like a button but isn't one,
    // there's nothing to do here besides ask the author. Title is
    // the actionable guidance.
    return (
      <span
        title={t("viewer.inviteOnlyTitle")}
        className="inline-flex items-center rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs italic text-keep-muted"
      >
        {t("viewer.inviteOnlyChip")}
      </span>
    );
  }
  if (joinMode === "application") {
    const app = detail.viewerApplication;
    if (app && app.status === "pending") {
      return (
        <span
          title={t("viewer.applicationPendingTitle")}
          className="inline-flex items-center rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs italic text-keep-muted"
        >
          {t("viewer.applicationPending")}
        </span>
      );
    }
    return (
      <button
        type="button"
        onClick={onApply}
        disabled={busy}
        title={app && app.status === "rejected"
          ? t("viewer.reapplyTitle")
          : t("viewer.applyTitle")}
        className="keep-button rounded border border-keep-rule bg-keep-banner px-2 py-0.5 text-sm hover:bg-keep-banner/80 disabled:opacity-50"
      >
        {app && app.status === "rejected" ? t("actions.reapply") : t("actions.apply")}
      </button>
    );
  }
  // joinMode === "open" → classic one-click Join, same posture as before.
  return (
    <button
      type="button"
      onClick={onJoin}
      disabled={busy}
      title={t("viewer.joinTitle")}
      className="keep-button rounded border border-keep-rule bg-keep-banner px-2 py-0.5 text-sm hover:bg-keep-banner/80 disabled:opacity-50"
    >
      {t("actions.join")}
    </button>
  );
}
