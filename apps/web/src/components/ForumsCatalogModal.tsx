/**
 * Forums Catalog (Forums revamp).
 *
 * Near-full-screen on desktop, edge-to-edge on mobile (the shared
 * mobile-fullscreen modal recipe). Layout mirrors the chat shell:
 * content pane on the left, a "Forums" rail on the right (the system
 * forum pinned first, then featured, then A→Z). On <lg the rail
 * collapses into a horizontal strip above the content.
 *
 * The forum view hosts the REAL forum renderer — MessageList's nested
 * mode, the same component the in-chat forums shipped with — fed over
 * HTTP (boards are never joined as socket rooms): category sections,
 * rich topic cards, inline reply chains, and the full post toolbar.
 * Posting rides the forum:post socket event; toolbar mutations refetch
 * via the store's forumActionTick (the socket echo can't reach us).
 * Forum-to-forum switches play the viewer's equipped room transition.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, Bell, FolderOpen, Globe, Landmark, MessagesSquare, Plus, Settings as SettingsIcon, Star, Users } from "lucide-react";
import {
  DEFAULT_THEME,
  FORUM_NAME_MAX,
  FORUM_NAME_MIN,
  FORUM_PURPOSE_MAX,
  FORUM_PURPOSE_MIN,
  normalizeTheme,
  type Theme,
} from "@thekeep/shared";
import type {
  ChatMessage,
  ForumCreationApplicationWire,
  ForumDetail,
  ForumMembershipApplicationWire,
  ForumNotificationWire,
  ForumSummary,
  RoomOccupant,
  ThreadCategory,
} from "@thekeep/shared";
import {
  applyForumMembership,
  archiveBoard,
  banFromForum,
  checkForumSlug,
  createBoard,
  createRoomCategory,
  deleteRoomCategory,
  fetchForumBans,
  fetchForumDetail,
  fetchForumMembershipApplications,
  fetchForumNotifications,
  fetchForumRoles,
  fetchForums,
  fetchMyForumApplications,
  fetchMyWorlds,
  markForumNotificationsRead,
  markTopicRead,
  setTopicWatch,
  fetchRoomCategories,
  fetchTopicThread,
  grantForumMod,
  leaveForum,
  liftForumBan,
  markForumVisited,
  patchRoomCategory,
  postToBoard,
  readImageFile,
  relTime,
  reviewForumMembershipApplication,
  revokeForumMod,
  setCategoryIcon,
  setForumImage,
  submitForumApplication,
  updateBoard,
  updateForum,
  withdrawForumMembership,
  type ForumBanRow,
  type ForumRoles,
  type SlugCheck,
} from "../lib/forums.js";
import { inkClass, isDarkSurface, themeStyle, useActiveTheme, useScopedRootDesign } from "../lib/theme.js";
import { playRoomTransition } from "../lib/transitions/orchestrator.js";
import { Modal } from "./Modal.js";
import { StylePicker } from "./AdminPanel.js";
import { CloseButton } from "./CloseButton.js";
import { FormattingToolbar } from "./FormattingToolbar.js";
import { MessageList } from "./MessageList.js";
import { ThemePicker } from "./ThemePicker.js";
import { useChat } from "../state/store.js";

/** In-modal navigation. The forum view IS the full forum (header +
 *  MessageList's nested renderer; topics expand inline exactly like the
 *  deployed in-chat forums did); the owner console rides its own view. */
type CatalogView =
  | { kind: "forum" }
  | { kind: "settings" };

interface Props {
  /** Land on this forum (slug or id) instead of the system default. */
  initialKey?: string | null;
  /** Open straight onto a topic's thread (bookmark / search jumps,
   *  permalinks). Pair with `initialKey` = the board's forum. Optional
   *  postId highlights one specific post in the thread. */
  initialTopic?: { boardId: string; topicId: string; postId?: string } | null;
  onClose: () => void;
  /** Open the world viewer (linked-world strip's View World). The viewer
   *  stacks above this modal and carries the join/apply flow itself. */
  onOpenWorld?: (worldId: string) => void;
  /** App-level handlers the hosted forum renderer (MessageList nested
   *  mode) forwards: profile/whisper clicks, @mentions, @world: links. */
  onIconClick: (userId: string, displayName: string, characterId?: string | null) => void;
  onNameClick: (userId: string, displayName: string, characterId?: string | null) => void;
  onMentionClick: (name: string) => void;
  onWorldMentionClick: (slug: string) => void;
  /** Viewer's identities for self-mention highlighting (same memo chat uses). */
  selfNames: ReadonlyArray<string>;
  fontStep: 0 | 1 | 2 | 3;
}

export function ForumsCatalogModal({ initialKey, initialTopic, onClose, onOpenWorld, onIconClick, onNameClick, onMentionClick, onWorldMentionClick, selfNames, fontStep }: Props) {
  const me = useChat((s) => s.me);
  const myActiveTransitionKey = useChat((s) => s.myActiveTransitionKey);
  // Per-send identity claim for forum posts — the same source of truth
  // the chat composer ships with every send.
  const activeCharacterId = useChat((s) => s.activeCharacterId);
  const chrome: ForumChrome = {
    onIconClick, onNameClick, onMentionClick,
    onWorldClick: onWorldMentionClick,
    selfNames, fontStep,
  };

  const [list, setList] = useState<ForumSummary[] | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initialKey ?? null);
  const [detail, setDetail] = useState<ForumDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  // The topic the forum view should land on: seeded by the deep-link
  // prop, retargeted by notification clicks.
  const [navTopic, setNavTopic] = useState<{ boardId: string; topicId: string; postId?: string } | null>(initialTopic ?? null);
  const [notifOpen, setNotifOpen] = useState(false);
  // The topic currently open in the board view — mirrored into the URL.
  const [urlTopicId, setUrlTopicId] = useState<string | null>(null);
  const forumNotifUnread = useChat((s) => s.forumNotifUnread);
  const canApply = !!me?.permissions?.includes("apply_create_forum");

  /** Notification click: land on its topic (switching forums if needed). */
  function openNotification(n: ForumNotificationWire) {
    setNotifOpen(false);
    // postId = the exact post that triggered the notice — flashes it.
    setNavTopic({ boardId: n.boardRoomId, topicId: n.topicId, postId: n.messageId });
    if (n.forumId !== selected || view.kind !== "forum") navigateToForum(n.forumId);
  }

  // The transition orchestrator snapshots THIS wrapper (rail + content
  // together, like the chat's wrapper covers chat + userlist).
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // `isReady` for the rite's midpoint re-clone: true once the rendered
  // detail matches the navigation target.
  const detailKeyRef = useRef<string | null>(null);
  useEffect(() => {
    detailKeyRef.current = detail ? detail.id : null;
  }, [detail]);

  useEffect(() => {
    let alive = true;
    fetchForums()
      .then((f) => {
        if (!alive) return;
        setList(f);
        // Default selection: explicit initialKey, else the system forum,
        // else the first row. Stored as the forum ID so isReady compares
        // one canonical key regardless of whether a slug was passed.
        if (!selected) {
          const init = initialKey
            ? f.find((x) => x.slug === initialKey || x.id === initialKey)
            : undefined;
          const target = init ?? f.find((x) => x.isSystem) ?? f[0];
          if (target) setSelected(target.id);
        }
      })
      .catch((e) => { if (alive) setListErr(e instanceof Error ? e.message : "load failed"); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // detailTick lets the owner console force a refetch after a save
  // without re-running the selection logic.
  const [detailTick, setDetailTick] = useState(0);
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setDetailErr(null);
    fetchForumDetail(selected)
      .then((d) => { if (alive) setDetail(d); })
      .catch((e) => { if (alive) setDetailErr(e instanceof Error ? e.message : "load failed"); });
    return () => { alive = false; };
  }, [selected, detailTick]);

  // Visit marker: selecting a forum stamps "seen" server-side and clears
  // its rail dot locally (signed-in only; the stamp is fire-and-forget).
  useEffect(() => {
    if (!selected || !me) return;
    markForumVisited(selected);
    setList((cur) => cur
      ? cur.map((f) => (f.id === selected && f.unseen ? { ...f, unseen: false } : f))
      : cur);
  }, [selected, me?.id]);

  // ── In-modal navigation (forum front page → board → topic) ──────────
  // Deep-linked topics (bookmark / search jumps) open inside the forum
  // view: ForumContent selects the board and activates the topic inline.
  const [view, setView] = useState<CatalogView>({ kind: "forum" });

  /** All in-modal hops (forum switch, board open, topic open, back) run
   *  through the same equipped-transition path as chat room switches. */
  function transitionTo(swap: () => void, isReady: () => boolean) {
    const permitted = !!me?.permissions?.includes("use_room_transitions");
    const key = permitted ? myActiveTransitionKey : null;
    void playRoomTransition(key, { wrapperEl: bodyRef.current, swap, isReady });
  }

  function navigateToForum(forumId: string) {
    if (forumId === selected && view.kind === "forum") return;
    transitionTo(
      () => { setSelected(forumId); setView({ kind: "forum" }); },
      () => detailKeyRef.current === forumId,
    );
  }

  function navigateView(next: CatalogView) {
    transitionTo(() => setView(next), () => true);
  }

  // Address-bar mirroring: while the catalog is open the URL is always
  // the copyable permalink for what's on screen — /f/<slug> for the
  // forum, /f/<slug>/t/<topicId> with a topic open. replaceState (not
  // push) so browsing never spams browser history; closing the catalog
  // restores the app path.
  useEffect(() => {
    if (!detail) return;
    const url = view.kind === "forum" && urlTopicId
      ? `/f/${detail.slug}/t/${urlTopicId}`
      : `/f/${detail.slug}`;
    if (window.location.pathname !== url) window.history.replaceState(null, "", url);
  }, [detail, urlTopicId, view.kind]);
  useEffect(() => () => {
    if (window.location.pathname.startsWith("/f/")) window.history.replaceState(null, "", "/");
  }, []);

  // Per-forum theme (Phase 6): normalized server-side; applied as inline
  // CSS vars on THIS card only (the ProfileModal pattern — CSP-safe, and
  // chat / the userlist never see it).
  const forumTheme = useMemo(() => {
    if (!detail?.themeJson) return null;
    try { return normalizeTheme(JSON.parse(detail.themeJson)); } catch { return null; }
  }, [detail?.themeJson]);
  // Per-forum DESIGN (ornaments/chrome — glass, medieval, …). Designs
  // can't be subtree-scoped (their CSS keys off html[data-theme-style],
  // and the viewer's own design would keep matching inside the card),
  // so the hook swaps the ROOT design while the catalog is open and
  // restores the viewer's on close. No forum style chosen = the
  // viewer's design stays — preferences fill gaps, never override.
  const activeTheme = useActiveTheme();
  useScopedRootDesign(forumTheme ?? activeTheme, detail?.themeStyleKey ?? null, !!detail, activeTheme);

  return (
    <Modal onClose={onClose} variant="mobile-fullscreen">
      {/* Full-screen card (per user): fills the viewport over the chat —
          edge-to-edge on mobile, a slim backdrop ring on lg+ (the
          variant's p-4) — instead of MODAL_CARD_CONTENT's 75vw/90vh.
          The title bar's X (top right) is the close affordance. */}
      <div
        // text-keep-text on the CARD re-anchors the inherited text color
        // to the forum's scoped palette. Without it, plain text inside
        // inherits the color computed at the APP shell (the viewer's
        // theme) — white text washing out over a parchment forum.
        className="keep-frame relative flex h-full w-full flex-col overflow-hidden border border-keep-rule bg-keep-bg text-keep-text"
        style={forumTheme ? themeStyle(forumTheme) : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {/* No big title bar: the forum's own banner IS the header. The
            app chrome lives in a slim bar at the top of the CONTENT
            pane (see below) — breadcrumbs left, actions right — so it
            never floats over the rail column. */}

        {/* Body = content + rail; the transition wrapper covers BOTH. */}
        <div ref={bodyRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
          {/* Content pane */}
          <div className="order-2 flex min-h-0 flex-1 flex-col lg:order-1">
            {/* Chrome bar: breadcrumbs on the left, actions (settings ·
                notifications · close) aligned right. One predictable
                home for the controls on every view — nothing floats
                over the banner or the rail. The notification panel
                anchors under this bar. */}
            <div className="relative shrink-0 border-b border-keep-rule bg-keep-banner/30">
              <div className="flex items-center justify-between gap-2 px-3 py-1.5">
                <nav className="flex min-w-0 items-center gap-1.5 text-xs">
                  {view.kind === "settings" && detail ? (
                    <>
                      <button
                        type="button"
                        onClick={() => navigateView({ kind: "forum" })}
                        className="flex items-center gap-1 rounded text-keep-muted hover:text-keep-action"
                      >
                        <ArrowLeft className="h-3 w-3" aria-hidden="true" />
                        <span className="max-w-[12rem] truncate">{detail.name}</span>
                      </button>
                      <span className="text-keep-rule">›</span>
                      <span className="min-w-0 truncate text-keep-text">Settings</span>
                    </>
                  ) : (
                    <span className="min-w-0 truncate font-action text-sm text-keep-text">
                      {detail?.name ?? "Forums"}
                    </span>
                  )}
                </nav>
                <div className="flex shrink-0 items-center gap-1.5">
                  {view.kind === "forum" && detail && (detail.viewer?.canManage || detail.viewer?.role === "mod") ? (
                    <button
                      type="button"
                      onClick={() => navigateView({ kind: "settings" })}
                      title="Forum settings - name, description, boards, categories"
                      aria-label="Forum settings"
                      className="rounded border border-keep-rule bg-keep-bg/70 p-1.5 text-keep-muted hover:border-keep-action hover:text-keep-action"
                    >
                      <SettingsIcon className="h-4 w-4" aria-hidden="true" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setNotifOpen((o) => !o)}
                    title="Forum notifications - replies to your topics, quotes, watched topics"
                    aria-label={`Forum notifications${forumNotifUnread > 0 ? ` (${forumNotifUnread} unread)` : ""}`}
                    className="flex items-center gap-1 rounded border border-keep-rule bg-keep-bg/70 p-1.5 text-keep-muted hover:border-keep-action hover:text-keep-action"
                  >
                    <Bell className="h-4 w-4" aria-hidden="true" />
                    {forumNotifUnread > 0 ? (
                      <span className="rounded-full bg-keep-accent px-1.5 text-[10px] font-bold leading-4 text-keep-bg">
                        {forumNotifUnread > 99 ? "99+" : forumNotifUnread}
                      </span>
                    ) : null}
                  </button>
                  <CloseButton onClick={onClose} />
                </div>
              </div>
              {notifOpen ? (
                <ForumNotifPanel onOpen={openNotification} onClose={() => setNotifOpen(false)} />
              ) : null}
            </div>
            {/* The forum view is a flex column (MessageList owns its own
                scroll region); the settings view scrolls as a page. */}
            {view.kind === "forum" ? (
              <div className="flex min-h-0 flex-1 flex-col">
                {detailErr ? (
                  <p className="px-4 py-6 text-sm text-keep-accent">{detailErr}</p>
                ) : !detail ? (
                  <p className="px-4 py-6 text-sm italic text-keep-muted">Opening the boards…</p>
                ) : (
                  <ForumContent
                    detail={detail}
                    asCharacterId={activeCharacterId}
                    chrome={chrome}
                    initialTopic={navTopic}
                    onChanged={() => setDetailTick((t) => t + 1)}
                    {...(onOpenWorld ? { onOpenWorld } : {})}
                    onActiveTopicChange={setUrlTopicId}
                  />
                )}
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto">
                {detail ? (
                  <ForumSettingsView
                    detail={detail}
                    onSaved={() => setDetailTick((t) => t + 1)}
                    onBoardArchived={() => setDetailTick((t) => t + 1)}
                  />
                ) : (
                  <p className="px-4 py-6 text-sm italic text-keep-muted">Loading…</p>
                )}
              </div>
            )}
          </div>

          {/* Forums rail — right on desktop (mirrors the userlist), a
              horizontal strip on mobile. */}
          <aside className="order-1 shrink-0 border-b border-keep-rule bg-keep-banner/20 lg:order-2 lg:flex lg:w-64 lg:flex-col lg:border-b-0 lg:border-l">
            <div className="hidden items-center justify-between px-3 py-1.5 lg:flex">
              <span className="text-xs uppercase tracking-widest text-keep-muted">
                Forums <span className="text-keep-rule">({list?.length ?? "…"})</span>
              </span>
            </div>
            {canApply ? (
              <div className="px-2 pt-2 lg:pt-0">
                <button
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  title="Apply to create your own forum - reviewed by the site's moderators"
                  className="flex w-full items-center justify-center gap-1.5 rounded border border-keep-action/60 bg-keep-action/10 px-2 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-action transition-colors hover:bg-keep-action/20"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  Create your Forum
                </button>
              </div>
            ) : null}
            {listErr ? (
              <p className="px-3 py-2 text-xs text-keep-accent">{listErr}</p>
            ) : !list ? (
              <p className="px-3 py-2 text-xs italic text-keep-muted">Loading…</p>
            ) : (
              <ul className="flex gap-1 overflow-x-auto px-2 py-2 lg:block lg:max-h-full lg:space-y-1 lg:overflow-y-auto lg:px-2">
                {list.map((f) => (
                  <ForumRailRow
                    key={f.id}
                    forum={f}
                    active={detail?.id === f.id || selected === f.id}
                    onClick={() => navigateToForum(f.id)}
                  />
                ))}
              </ul>
            )}
          </aside>
        </div>
      </div>
      {createOpen ? <CreateForumModal onClose={() => setCreateOpen(false)} /> : null}
    </Modal>
  );
}

/**
 * "Create your Forum" application form (Phase 2). Stacks above the
 * catalog (z 50, like the world viewer over profiles). Three fields:
 * display name, slug (auto-suggested from the name until hand-edited,
 * live availability check), and the purpose prose the reviewers read.
 * When the caller already has a PENDING application, the form is
 * replaced by its status; a recent rejection shows the review note.
 */
function CreateForumModal({ onClose }: { onClose: () => void }) {
  const [mine, setMine] = useState<ForumCreationApplicationWire[] | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugCheck, setSlugCheck] = useState<SlugCheck | null>(null);
  const [purpose, setPurpose] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchMyForumApplications()
      .then((a) => { if (alive) setMine(a); })
      .catch(() => { if (alive) setMine([]); });
    return () => { alive = false; };
  }, []);

  // Auto-suggest the slug from the name until the user edits it directly.
  useEffect(() => {
    if (slugTouched) return;
    const suggested = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    setSlug(suggested);
  }, [name, slugTouched]);

  // Debounced live availability check.
  useEffect(() => {
    if (slug.length < 3) { setSlugCheck(null); return; }
    let alive = true;
    const t = setTimeout(() => {
      checkForumSlug(slug).then((c) => { if (alive) setSlugCheck(c); }).catch(() => {});
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [slug]);

  const pending = mine?.find((a) => a.status === "pending") ?? null;
  const lastRejected = mine?.find((a) => a.status === "rejected") ?? null;

  async function submit() {
    setBusy(true); setErr(null);
    try {
      await submitForumApplication({ name: name.trim(), slug, purpose: purpose.trim() });
      setSubmitted(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Submit failed.");
    } finally {
      setBusy(false);
    }
  }

  const slugNote = !slugCheck || slug.length < 3
    ? null
    : slugCheck.ok
      ? { text: "available", tone: "text-keep-action" }
      : {
          text: slugCheck.reason === "taken" ? "already a forum"
            : slugCheck.reason === "pending" ? "claimed by a pending application"
            : slugCheck.reason === "reserved" ? "reserved word"
            : "lowercase letters, numbers, _ only (3-40)",
          tone: "text-keep-accent",
        };
  const purposeLen = purpose.trim().length;
  const canSubmit = !busy
    && name.trim().length >= FORUM_NAME_MIN && name.trim().length <= FORUM_NAME_MAX
    && slugCheck?.ok === true
    && purposeLen >= FORUM_PURPOSE_MIN && purposeLen <= FORUM_PURPOSE_MAX;

  return (
    <Modal onClose={onClose} zIndex={50}>
      <div
        className="keep-frame w-full max-w-lg rounded border border-keep-rule bg-keep-bg p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-action text-lg text-keep-text">Create your Forum</h3>
          <CloseButton onClick={onClose} />
        </div>

        {mine === null ? (
          <p className="text-sm italic text-keep-muted">Checking your applications…</p>
        ) : submitted ? (
          <div className="space-y-2 text-sm text-keep-text">
            <p><strong>Application sent.</strong> The site's moderators will review it; you'll get a notice here and in chat when it's decided.</p>
            <button type="button" onClick={onClose} className="rounded border border-keep-rule px-3 py-1 text-xs hover:bg-keep-panel">Close</button>
          </div>
        ) : pending ? (
          <div className="space-y-2 text-sm text-keep-text">
            <p>
              Your application for <strong>{pending.requestedName}</strong>
              <span className="text-keep-muted"> (/f/{pending.requestedSlug})</span> is
              <span className="text-keep-action"> pending review</span>.
            </p>
            <p className="text-xs text-keep-muted">One application at a time - you can apply again once it's decided.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {lastRejected?.reviewNote ? (
              <p className="rounded border border-keep-rule bg-keep-panel/40 px-2 py-1.5 text-xs text-keep-muted">
                Your last application was declined{lastRejected.reviewNote ? `: "${lastRejected.reviewNote}"` : "."}
              </p>
            ) : null}
            <label className="block text-sm">
              <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">Forum name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={FORUM_NAME_MAX}
                placeholder="Shadows of Darkness"
                className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">
                Address <span className="normal-case text-keep-rule">/f/</span>
                {slugNote ? <span className={`ml-2 normal-case ${slugNote.tone}`}>{slugNote.text}</span> : null}
              </span>
              <input
                value={slug}
                onChange={(e) => { setSlugTouched(true); setSlug(e.target.value.toLowerCase()); }}
                maxLength={40}
                placeholder="shadows_of_darkness"
                className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 font-mono text-sm outline-none focus:border-keep-action"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">
                What is your forum for?
                <span className={`ml-2 normal-case tabular-nums ${purposeLen > 0 && purposeLen < FORUM_PURPOSE_MIN ? "text-keep-accent" : "text-keep-rule"}`}>
                  {purposeLen}/{FORUM_PURPOSE_MAX}{purposeLen < FORUM_PURPOSE_MIN ? ` (min ${FORUM_PURPOSE_MIN})` : ""}
                </span>
              </span>
              <textarea
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                maxLength={FORUM_PURPOSE_MAX}
                rows={4}
                placeholder="Tell the reviewers what community this forum gathers and what its boards will hold."
                className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
              />
            </label>
            {err ? <p className="text-xs text-keep-accent">{err}</p> : null}
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-keep-muted">Reviewed by the site's moderators. Approved forums appear in the catalog with you as Keeper.</p>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSubmit}
                className="shrink-0 rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
              >
                {busy ? "…" : "Apply"}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function ForumRailRow({ forum, active, onClick }: {
  forum: ForumSummary;
  active: boolean;
  onClick: () => void;
}) {
  const pulse = relTime(forum.lastActivityAt);
  return (
    <li className="shrink-0">
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left transition-colors ${
          active
            ? "border-keep-action/60 bg-keep-action/10"
            : "border-transparent hover:border-keep-rule hover:bg-keep-panel/40"
        }`}
      >
        {/* Logo thumb or initial chip */}
        {forum.logoUrl ? (
          <img src={forum.logoUrl} alt="" className="h-7 w-7 shrink-0 object-contain" />
        ) : (
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-keep-rule bg-keep-banner text-[11px] font-semibold uppercase text-keep-muted">
            {forum.name.slice(0, 2)}
          </span>
        )}
        <span className="min-w-0">
          <span className="flex items-center gap-1">
            <span className="truncate text-sm font-semibold text-keep-text">{forum.name}</span>
            {forum.isSystem ? (
              <Landmark className="h-3 w-3 shrink-0 text-keep-accent" aria-hidden="true" />
            ) : forum.status === "featured" ? (
              <Star className="h-3 w-3 shrink-0 text-keep-accent" aria-hidden="true" />
            ) : null}
            {forum.unseen ? (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-keep-action"
                title="New activity since your last visit"
                aria-label="New activity"
              />
            ) : null}
          </span>
          <span className="block truncate text-[10px] text-keep-muted">
            {forum.boardCount} board{forum.boardCount === 1 ? "" : "s"}
            {pulse ? ` · ${pulse}` : ""}
          </span>
        </span>
      </button>
    </li>
  );
}

function ForumContent({ detail, asCharacterId, chrome, initialTopic, onChanged, onOpenWorld, onActiveTopicChange }: {
  detail: ForumDetail;
  asCharacterId: string | null;
  /** App-level handlers + viewer context the REAL forum renderer
   *  (MessageList nested mode) needs — profile clicks, mentions, font
   *  step, the viewer's names for self-mention highlighting. */
  chrome: ForumChrome;
  /** Deep-link / notification target: open this board with the topic
   *  active (and optionally one post flashed). */
  initialTopic?: { boardId: string; topicId: string; postId?: string } | null;
  /** Refetch the detail after apply/withdraw/leave so the viewer state
   *  (pending chip, member count) stays honest. */
  onChanged: () => void;
  onOpenWorld?: (worldId: string) => void;
  /** URL mirroring: reports the active topic id (null = none open). */
  onActiveTopicChange?: (topicId: string | null) => void;
}) {
  // Surface sampling for the header band: image banners are dark by
  // construction (scrim); otherwise the FORUM's palette (the one that
  // actually paints this header) decides — not the viewer's.
  const viewerTheme = useActiveTheme();
  const headerPalette = useMemo(() => {
    if (detail.themeJson) {
      try { return normalizeTheme(JSON.parse(detail.themeJson)); } catch { /* viewer theme */ }
    }
    return viewerTheme;
  }, [detail.themeJson, viewerTheme]);
  const headerDark = isDarkSurface(headerPalette, { imageOverlay: !!detail.bannerImageUrl });

  const banStrip = detail.viewer?.ban ? (
    <div className="border-b border-keep-rule bg-keep-system/10 px-4 py-2 text-sm text-keep-system">
      You are banned from this forum
      {detail.viewer.ban.until ? ` until ${new Date(detail.viewer.ban.until).toLocaleDateString()}` : ""}
      {detail.viewer.ban.reason ? ` — ${detail.viewer.ban.reason}` : ""}.
    </div>
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header band: banner image (when set) behind logo + name + meta. */}
      <header
        className="relative shrink-0 border-b border-keep-rule bg-keep-banner/30 px-5 py-6 md:px-8 md:py-12"
        style={detail.bannerImageUrl ? {
          backgroundImage: `linear-gradient(rgba(0,0,0,.55), rgba(0,0,0,.5)), url(${detail.bannerImageUrl})`,
          backgroundSize: "cover",
          backgroundPosition: `center ${detail.bannerFocusY ?? 50}%`,
        } : undefined}
      >
        <div className="flex items-center gap-3 md:gap-5">
          {detail.logoUrl ? (
            // Borderless + contain: alpha-transparent crests/icons render
            // as themselves, no box forced around them.
            <img src={detail.logoUrl} alt="" className="h-14 w-14 shrink-0 object-contain drop-shadow-lg md:h-20 md:w-20" />
          ) : (
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded border border-keep-rule bg-keep-bg/60 md:h-20 md:w-20">
              <MessagesSquare className="h-7 w-7 text-keep-accent md:h-10 md:w-10" aria-hidden="true" />
            </span>
          )}
          <div className="min-w-0">
            {/* Ink follows the SURFACE (lib/theme isDarkSurface): banner
                images always carry a dark scrim → light ink; otherwise
                the palette's luminance decides. The viewer can't recolor
                someone else's banner, so the renderer must get it right. */}
            <h3 className={`truncate font-action text-2xl md:text-4xl ${inkClass.title(headerDark)}`}>{detail.name}</h3>
            {detail.tagline ? (
              <p className={`truncate text-sm md:text-base ${inkClass.sub(headerDark)}`}>{detail.tagline}</p>
            ) : null}
            <p className={`mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] md:text-xs ${inkClass.meta(headerDark)}`}>
              <span>kept by <span className={inkClass.strong(headerDark)}>{detail.ownerUsername}</span></span>
              {detail.viewer?.role === "mod" ? (
                <span
                  title="You moderate this forum: sticky, lock, and tidy topics (the owner's posts and settings stay theirs)."
                  className="rounded border border-keep-system/60 bg-keep-system/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-keep-system"
                >
                  Forum Mod
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1">
                <Users className="h-3 w-3" aria-hidden="true" />
                {detail.memberCount > 0 ? `${detail.memberCount} member${detail.memberCount === 1 ? "" : "s"}` : "open to all"}
              </span>
              {detail.linkedWorld ? <span>world: {detail.linkedWorld.name}</span> : null}
              <span>founded {new Date(detail.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}</span>
            </p>
          </div>
        </div>
      </header>
      {/* Linked-world strip (Phase 6): the forum's setting in one line —
          world name + description with View World (join/apply live in the
          viewer, the canonical flow). */}
      {detail.linkedWorld ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-keep-rule bg-keep-accent/5 px-4 py-2">
          <Globe className="h-4 w-4 shrink-0 text-keep-accent" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <span className="text-sm font-semibold text-keep-text">{detail.linkedWorld.name}</span>
            <span className="ml-2 text-[11px] text-keep-muted">a world by {detail.linkedWorld.ownerUsername}</span>
            {detail.linkedWorld.description ? (
              <span className="block truncate text-xs text-keep-muted">{detail.linkedWorld.description}</span>
            ) : null}
          </div>
          {onOpenWorld ? (
            <button
              type="button"
              onClick={() => onOpenWorld(detail.linkedWorld!.id)}
              title="Open this world - join or apply from its page"
              className="shrink-0 rounded border border-keep-accent/60 bg-keep-accent/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-accent hover:bg-keep-accent/20"
            >
              View World
            </button>
          ) : null}
        </div>
      ) : null}
      {banStrip}
      <MembershipStrip detail={detail} onChanged={onChanged} />

      {/* Boards — rendered by the REAL forum renderer (MessageList's
          nested mode), the same component the deployed in-chat forums
          used: category sections with collapse + per-section "+ New
          Topic", rich topic cards (BorderedAvatar, name styles, pin/lock
          chips), inline reply chains, and the full post toolbar (Reply /
          Quote / Edit / Pin / Lock / Delete / Bookmark / React). Data
          arrives over HTTP (no socket-room membership), posting rides
          forum:post, and the store's forumActionTick refetches after
          toolbar mutations since the socket echo can't reach us. */}
      {detail.boards.length === 0 ? (
        <p className="px-4 py-3 text-sm italic text-keep-muted">No boards yet — the owner hasn't raised any.</p>
      ) : (
        <ForumBoards
          detail={detail}
          asCharacterId={asCharacterId}
          chrome={chrome}
          initialTopic={initialTopic ?? null}
          {...(onActiveTopicChange ? { onActiveTopicChange } : {})}
        />
      )}
      <ForumFooter detail={detail} />
    </div>
  );
}

/**
 * Traditional three-band forum footer (matches the public /f/ landing's
 * footer so both faces of a forum read identically): Who's online →
 * Board statistics → vitals + "Hosted by". Numbers ride the detail
 * payload; "browsing" counts visit markers from the last 15 minutes
 * since boards carry no live presence by design.
 */
function ForumFooter({ detail }: { detail: ForumDetail }) {
  const siteName = useChat((st) => st.branding.siteName) || "The Spire";
  const s = detail.stats;
  if (!s) return null;
  const onlineTotal = s.online.publicNames.length + s.online.hiddenCount;
  return (
    <footer className="shrink-0 border-t border-keep-rule bg-keep-banner/30 px-4 py-2 text-[11px] text-keep-muted">
      <div className="truncate border-b border-keep-rule/50 pb-1.5">
        <span className="font-semibold uppercase tracking-widest">Who's online</span>{" "}
        {onlineTotal === 0 ? (
          <span className="italic">The halls are quiet right now.</span>
        ) : (
          <>
            {s.online.publicNames.length > 0 ? (
              <span className="text-keep-text">{s.online.publicNames.join(", ")}</span>
            ) : null}
            {s.online.hiddenCount > 0
              ? `${s.online.publicNames.length > 0 ? " and " : ""}${s.online.hiddenCount} keeping to the shadows`
              : ""}
            {s.online.browsingRecently > 0
              ? ` · ${s.online.browsingRecently} browsing this forum right now`
              : ""}
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 border-b border-keep-rule/50 py-1.5">
        <span className="font-semibold uppercase tracking-widest">Board statistics</span>
        <span><b className="tabular-nums text-keep-text">{s.topics.toLocaleString()}</b> topics</span>
        <span><b className="tabular-nums text-keep-text">{s.replies.toLocaleString()}</b> replies</span>
        <span><b className="tabular-nums text-keep-text">{s.writers.toLocaleString()}</b> writers</span>
        <span>
          <b className="tabular-nums text-keep-text">{detail.memberCount > 0 ? detail.memberCount.toLocaleString() : "—"}</b>{" "}
          {detail.memberCount > 0 ? "members" : "open to all"}
        </span>
        <span><b className="tabular-nums text-keep-text">{onlineTotal.toLocaleString()}</b> online now</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 pt-1.5">
        <span>Posting: <span className="text-keep-text">{detail.postingMode === "application" ? "by application" : "open to all"}</span></span>
        <span>Keeper: <span className="text-keep-text">{detail.ownerUsername}</span></span>
        {detail.linkedWorld ? (
          <span>World: <span className="text-keep-text">{detail.linkedWorld.name}</span></span>
        ) : null}
        <span>Founded: <span className="text-keep-text">{new Date(detail.createdAt).toLocaleDateString()}</span></span>
        <span className="ml-auto">Hosted by <span className="text-keep-text">{siteName}</span></span>
      </div>
    </footer>
  );
}

/** App-level context the hosted forum renderer needs. */
interface ForumChrome {
  onIconClick: (userId: string, displayName: string, characterId?: string | null) => void;
  onNameClick: (userId: string, displayName: string, characterId?: string | null) => void;
  onMentionClick: (name: string) => void;
  onWorldClick: (slug: string) => void;
  selfNames: ReadonlyArray<string>;
  fontStep: 0 | 1 | 2 | 3;
}

const NO_OCCUPANTS: RoomOccupant[] = [];

/**
 * Board strip + the selected board's forum. One board renders at a time
 * (MessageList owns its own scroll region); multi-board forums get a tab
 * strip. With a single board this is exactly the deployed forum layout.
 */
function ForumBoards({ detail, asCharacterId, chrome, initialTopic, onActiveTopicChange }: {
  detail: ForumDetail;
  asCharacterId: string | null;
  chrome: ForumChrome;
  initialTopic: { boardId: string; topicId: string; postId?: string } | null;
  onActiveTopicChange?: (topicId: string | null) => void;
}) {
  const [boardId, setBoardId] = useState<string>(
    initialTopic?.boardId && detail.boards.some((b) => b.roomId === initialTopic.boardId)
      ? initialTopic.boardId
      : detail.boards[0]!.roomId,
  );
  // Notification / deep-link retarget: when the requested topic changes
  // after mount, follow its board too.
  useEffect(() => {
    if (initialTopic?.boardId && detail.boards.some((b) => b.roomId === initialTopic.boardId)) {
      setBoardId(initialTopic.boardId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTopic?.boardId, initialTopic?.topicId]);
  const active = detail.boards.find((b) => b.roomId === boardId) ?? detail.boards[0]!;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {detail.boards.length > 1 ? (
        <div className="flex flex-wrap gap-1 border-b border-keep-rule bg-keep-banner/20 px-3 py-1.5">
          {detail.boards.map((b) => (
            <button
              key={b.roomId}
              type="button"
              onClick={() => setBoardId(b.roomId)}
              title={b.topic ?? b.name}
              className={`rounded border px-2.5 py-1 text-xs ${
                b.roomId === active.roomId
                  ? "border-keep-action text-keep-action"
                  : "border-keep-rule text-keep-muted hover:text-keep-text"
              }`}
            >
              {b.name}
              <span className="ml-1.5 text-[10px] text-keep-rule">{b.topicCount}</span>
            </button>
          ))}
        </div>
      ) : null}
      <BoardHost
        key={active.roomId}
        boardId={active.roomId}
        forumSlug={detail.slug}
        canParticipate={detail.viewer?.canParticipate ?? false}
        canModerate={!!detail.viewer && (detail.viewer.canManage || detail.viewer.role === "mod")}
        canAdminEdit={!!detail.viewer?.canManage}
        asCharacterId={asCharacterId}
        chrome={chrome}
        initialTopicId={initialTopic?.boardId === active.roomId ? initialTopic.topicId : null}
        initialPostId={initialTopic?.boardId === active.roomId ? initialTopic.postId ?? null : null}
        {...(onActiveTopicChange ? { onActiveTopicChange } : {})}
      />
    </div>
  );
}

/**
 * Hosts MessageList's forum mode for one board, feeding it the same
 * store-backed data shapes chat uses:
 *   - categories: GET /rooms/:id/thread-categories (local state)
 *   - topic buckets: GET /rooms/:id/topics?category&page → the store's
 *     forumTopicsByRoom (same setters App uses for chat forums)
 *   - replies: GET .../messages/:topicId/thread on topic activation,
 *     merged into messagesByRoom so TopicCard's reply chain renders
 *   - mutations: the toolbar's own HTTP handlers work as-is; the store's
 *     forumActionTick triggers a refetch where chat relies on the echo
 * The composer underneath posts over forum:post (new topic or reply to
 * the active topic) — boards are never joined as rooms.
 */
function BoardHost({ boardId, forumSlug, canParticipate, canModerate, canAdminEdit, asCharacterId, chrome, initialTopicId, initialPostId, onActiveTopicChange }: {
  boardId: string;
  /** For permalink building: /f/<slug>/t/<topicId>#p-<postId>. */
  forumSlug: string;
  canParticipate: boolean;
  canModerate: boolean;
  canAdminEdit: boolean;
  asCharacterId: string | null;
  chrome: ForumChrome;
  initialTopicId: string | null;
  /** Optional: one post inside the initial topic to flash after opening. */
  initialPostId: string | null;
  /** Reports the active topic so the modal can mirror it into the URL. */
  onActiveTopicChange?: (topicId: string | null) => void;
}) {
  const me = useChat((s) => s.me);
  const messages = useChat((s) => s.messagesByRoom[boardId]) ?? NO_MESSAGES;
  const setMessages = useChat((s) => s.setMessages);
  const buckets = useChat((s) => s.forumTopicsByRoom[boardId]);
  const setForumTopicsPage = useChat((s) => s.setForumTopicsPage);
  const setForumTopicsLoading = useChat((s) => s.setForumTopicsLoading);
  const flushPendingForumTopics = useChat((s) => s.flushPendingForumTopics);
  const forumActionTick = useChat((s) => s.forumActionTick);

  const [cats, setCats] = useState<ThreadCategory[] | null>(null);
  const [activeTopicId, setActiveTopicId] = useState<string | null>(initialTopicId);
  const [composerCat, setComposerCat] = useState<string | null | undefined>(undefined); // undefined = topic composer closed
  // Per-topic unread + watch state, seeded from each topics-page fetch.
  const [unreadTopics, setUnreadTopics] = useState<Set<string>>(new Set());
  const [watchedTopics, setWatchedTopics] = useState<Set<string>>(new Set());

  // Report the active topic upward (URL mirroring). Fires on mount too,
  // so a board switch resets the modal's notion to this board's state.
  useEffect(() => {
    onActiveTopicChange?.(activeTopicId);
  }, [activeTopicId, onActiveTopicChange]);
  // Quote button payload for the ghost reply composer. The nonce makes
  // repeat quotes of the same post re-fire the composer's seed effect.
  const [quoteSeed, setQuoteSeed] = useState<{ text: string; nonce: number } | null>(null);

  // Categories, then first pages for every bucket (cat ids + _uncat).
  useEffect(() => {
    let alive = true;
    fetchRoomCategories(boardId)
      .then((c) => { if (alive) setCats(c); })
      .catch(() => { if (alive) setCats([]); });
    return () => { alive = false; };
  }, [boardId]);

  const loadBucketPage = useCallback(async (categoryKey: string, page: number) => {
    setForumTopicsLoading(boardId, categoryKey, true);
    const categoryParam = categoryKey === "_uncat" ? "" : categoryKey;
    try {
      const r = await fetch(
        `/rooms/${encodeURIComponent(boardId)}/topics?category=${encodeURIComponent(categoryParam)}&page=${page}`,
        { credentials: "include" },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as {
        topics: ChatMessage[]; page: number | null; perPage: number; totalPages: number; totalCount: number;
        unreadTopicIds?: string[]; watchedTopicIds?: string[];
      };
      setForumTopicsPage(boardId, categoryKey, j.topics, {
        currentPage: j.page ?? page,
        totalPages: j.totalPages || 1,
        totalCount: j.totalCount || 0,
        perPage: j.perPage || 20,
      });
      // Refresh this page's unread/watch flags: clear every topic on the
      // page, then re-add the server's current truth.
      const pageIds = j.topics.map((t) => t.id);
      setUnreadTopics((prev) => {
        const next = new Set(prev);
        for (const id of pageIds) next.delete(id);
        for (const id of j.unreadTopicIds ?? []) next.add(id);
        return next;
      });
      setWatchedTopics((prev) => {
        const next = new Set(prev);
        for (const id of pageIds) next.delete(id);
        for (const id of j.watchedTopicIds ?? []) next.add(id);
        return next;
      });
    } catch {
      setForumTopicsLoading(boardId, categoryKey, false);
    }
  }, [boardId, setForumTopicsLoading, setForumTopicsPage]);

  useEffect(() => {
    if (!cats) return;
    const existing = useChat.getState().forumTopicsByRoom[boardId] ?? {};
    const keys = [...cats.map((c) => c.id), "_uncat"].filter((k) => !existing[k]);
    for (const k of keys) void loadBucketPage(k, 1);
  }, [cats, boardId, loadBucketPage]);

  /** Pull a topic's full thread into the room buffer so the expanded
   *  card's reply chain renders. Dedupes by id; fresh rows win so an
   *  edit/lock from the toolbar reflects after the action-tick refetch. */
  const hydrateThread = useCallback(async (topicId: string) => {
    try {
      const t = await fetchTopicThread(boardId, topicId);
      const cur = useChat.getState().messagesByRoom[boardId] ?? [];
      const fresh = new Map<string, ChatMessage>();
      for (const m of [t.topic, ...t.replies]) fresh.set(m.id, m);
      const merged = [
        ...cur.filter((m) => !fresh.has(m.id)),
        ...fresh.values(),
      ].sort((a, b) => a.createdAt - b.createdAt);
      setMessages(boardId, merged);
    } catch { /* topic may have been deleted; refetch paths handle it */ }
  }, [boardId, setMessages]);

  // Deep-link / notification navigation: respond to initialTopicId
  // CHANGES too (the notification panel retargets an already-mounted
  // board), not just the mount value. When a specific post is named,
  // flash it once the thread has hydrated.
  useEffect(() => {
    if (!initialTopicId) return;
    setComposerCat(undefined);
    setActiveTopicId(initialTopicId);
    markTopicRead(initialTopicId);
    setUnreadTopics((prev) => { const n = new Set(prev); n.delete(initialTopicId); return n; });
    void hydrateThread(initialTopicId).then(() => {
      if (!initialPostId) return;
      requestAnimationFrame(() => requestAnimationFrame(() => setHighlightId(initialPostId)));
    });
  }, [initialTopicId, initialPostId, hydrateThread]);

  // Quote-reference jumps: the `[wrote:](msg:<id>)` chips in post bodies
  // dispatch a DOM event (the markdown renderer is pure). Resolve the
  // quoted post — fetching its thread if it isn't loaded — activate its
  // topic, and flash it via MessageList's highlight machinery.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  useEffect(() => {
    const onRef = (ev: Event) => {
      const messageId = (ev as CustomEvent<{ messageId?: string }>).detail?.messageId;
      if (!messageId) return;
      void (async () => {
        let row = (useChat.getState().messagesByRoom[boardId] ?? []).find((m) => m.id === messageId);
        if (!row) {
          try {
            const r = await fetch(
              `/rooms/${encodeURIComponent(boardId)}/messages/${encodeURIComponent(messageId)}/thread`,
              { credentials: "include" },
            );
            if (!r.ok) return; // quoted post lives on another board (or is gone)
            const j = (await r.json()) as { topic: ChatMessage; replies: ChatMessage[] };
            const cur = useChat.getState().messagesByRoom[boardId] ?? [];
            const fresh = new Map<string, ChatMessage>();
            for (const m of [j.topic, ...j.replies]) fresh.set(m.id, m);
            const merged = [...cur.filter((m) => !fresh.has(m.id)), ...fresh.values()]
              .sort((a, b) => a.createdAt - b.createdAt);
            setMessages(boardId, merged);
            row = merged.find((m) => m.id === messageId);
          } catch { return; }
        }
        if (!row) return;
        activateTopic(row.replyToId ?? row.id);
        // Two frames: let the activation/expansion render before the
        // highlight effect goes looking for the node.
        requestAnimationFrame(() => requestAnimationFrame(() => setHighlightId(messageId)));
      })();
    };
    window.addEventListener("spire:quote-ref", onRef);
    return () => window.removeEventListener("spire:quote-ref", onRef);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId]);

  // Toolbar mutations (pin/lock/delete/edit) fire this tick after their
  // HTTP success — refetch the loaded buckets + the open thread.
  const tickRef = useRef(forumActionTick);
  useEffect(() => {
    if (tickRef.current === forumActionTick) return;
    tickRef.current = forumActionTick;
    const loaded = Object.entries(useChat.getState().forumTopicsByRoom[boardId] ?? {});
    for (const [key, b] of loaded) void loadBucketPage(key, b.currentPage || 1);
    if (activeTopicId) void hydrateThread(activeTopicId);
  }, [forumActionTick, boardId, activeTopicId, loadBucketPage, hydrateThread]);

  function activateTopic(id: string | null) {
    setActiveTopicId(id);
    if (id) {
      setComposerCat(undefined);
      void hydrateThread(id);
      // Opening a topic reads it: stamp server-side, clear the dot.
      markTopicRead(id);
      setUnreadTopics((prev) => { const n = new Set(prev); n.delete(id); return n; });
    }
  }

  /** Per-post permalink for the toolbar's Link pill: /f/<slug>/t/<topic>#p-<post>.
   *  Topic-level URLs need no button — the address bar mirrors them. */
  function postPermalink(messageId: string): string {
    const row = (useChat.getState().messagesByRoom[boardId] ?? []).find((m) => m.id === messageId);
    const topicId = row?.replyToId ?? row?.id ?? messageId;
    return `${window.location.origin}/f/${forumSlug}/t/${topicId}#p-${messageId}`;
  }

  /** Bell toggle: optimistic, reverts on failure. */
  function toggleTopicWatch(topicId: string, watch: boolean) {
    setWatchedTopics((prev) => {
      const n = new Set(prev);
      if (watch) n.add(topicId); else n.delete(topicId);
      return n;
    });
    void setTopicWatch(topicId, watch).catch(() => {
      setWatchedTopics((prev) => {
        const n = new Set(prev);
        if (watch) n.delete(topicId); else n.add(topicId);
        return n;
      });
    });
  }

  /** Ghost reply submit: persists, then re-pulls the thread + loaded
   *  buckets so the placeholder becomes the real post in place. Your own
   *  reply re-stamps your read marker — otherwise the refetch would flag
   *  the topic unread for YOU (your post outran your old stamp). */
  async function submitReply(topicId: string, text: string) {
    await postToBoard({ roomId: boardId, text, asCharacterId, replyToId: topicId });
    await markTopicRead(topicId); // before the refetch, so server truth includes it
    setUnreadTopics((prev) => { const n = new Set(prev); n.delete(topicId); return n; });
    await hydrateThread(topicId);
    const loaded = Object.entries(useChat.getState().forumTopicsByRoom[boardId] ?? {});
    for (const [key, b] of loaded) void loadBucketPage(key, b.currentPage || 1);
  }

  /** Ghost topic submit: persists, refreshes the section's first page,
   *  and opens the freshly-raised topic. */
  async function submitTopic(title: string, text: string) {
    const categoryId = composerCat ?? null;
    const messageId = await postToBoard({
      roomId: boardId,
      text,
      asCharacterId,
      threadTitle: title,
      ...(categoryId ? { threadCategoryId: categoryId } : {}),
    });
    setComposerCat(undefined);
    await loadBucketPage(categoryId ?? "_uncat", 1);
    if (messageId) activateTopic(messageId);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MessageList
        messages={messages}
        occupants={NO_OCCUPANTS}
        selfUserId={me?.id ?? null}
        selfNames={chrome.selfNames}
        roomType="public"
        replyMode="nested"
        roomId={boardId}
        threadCategories={cats ?? []}
        activeTopicId={activeTopicId}
        onSetActiveTopic={activateTopic}
        canModerate={canModerate}
        canPin={canModerate}
        canAdminEdit={canAdminEdit}
        onPopoutTopic={(id) => activateTopic(id)}
        onQuotePost={(quote) => {
          setQuoteSeed((cur) => ({ text: quote, nonce: (cur?.nonce ?? 0) + 1 }));
        }}
        forumBuckets={buckets ?? {}}
        onGoToForumPage={(key, page) => void loadBucketPage(key, page)}
        onFlushPendingTopics={(key) => flushPendingForumTopics(boardId, key)}
        onActivateCategory={() => {}}
        onStartTopicInCategory={(categoryId) => {
          setActiveTopicId(null);
          setComposerCat(categoryId);
        }}
        onIconClick={chrome.onIconClick}
        onNameClick={chrome.onNameClick}
        onMentionClick={chrome.onMentionClick}
        onWorldClick={chrome.onWorldClick}
        onTimeClick={(msgId) => {
          const inBuffer = messages.find((m) => m.id === msgId);
          activateTopic(inBuffer?.replyToId ?? msgId);
        }}
        fontStep={chrome.fontStep}
        unreadTopicIds={unreadTopics}
        watchedTopicIds={watchedTopics}
        onToggleTopicWatch={toggleTopicWatch}
        postPermalink={postPermalink}
        highlightMessageId={highlightId}
        onHighlightDone={() => setHighlightId(null)}
        renderTopicComposer={(topic) => {
          if (topic.lockedAt) return null; // the lock notice is the card's own chip
          if (!canParticipate) {
            return (
              <p className="rounded border border-keep-rule bg-keep-panel/20 px-3 py-1.5 text-xs italic text-keep-muted">
                Posting here needs the keeper's approval - apply from the forum's front page.
              </p>
            );
          }
          return (
            <GhostReplyComposer
              topicId={topic.id}
              quoteSeed={quoteSeed}
              onSubmit={(text) => submitReply(topic.id, text)}
            />
          );
        }}
        renderNewTopicForm={(categoryKey) => {
          if (composerCat === undefined) return null;
          if ((composerCat ?? "_uncat") !== categoryKey) return null;
          if (!canParticipate) {
            return (
              <p className="rounded border border-keep-rule bg-keep-panel/20 px-3 py-1.5 text-xs italic text-keep-muted">
                Posting here needs the keeper's approval - apply from the forum's front page.
              </p>
            );
          }
          return (
            <GhostTopicComposer
              onSubmit={(title, text) => submitTopic(title, text)}
              onCancel={() => setComposerCat(undefined)}
            />
          );
        }}
      />
    </div>
  );
}

/**
 * Ghost reply post (Forums Catalog): rendered INSIDE the active topic
 * card at the end of its reply chain, where the real post will appear.
 * Draft state lives here so typing never re-renders the forum tree.
 */
function GhostReplyComposer({ topicId, quoteSeed, onSubmit }: {
  topicId: string;
  quoteSeed: { text: string; nonce: number } | null;
  onSubmit: (text: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Quote button payload: append the blockquote to the draft and focus.
  const seenNonce = useRef(0);
  useEffect(() => {
    if (!quoteSeed || quoteSeed.nonce === seenNonce.current) return;
    seenNonce.current = quoteSeed.nonce;
    setDraft((d) => (d ? `${d}\n${quoteSeed.text}` : quoteSeed.text));
    requestAnimationFrame(() => ref.current?.focus());
  }, [quoteSeed]);

  // Fresh composer per topic (a leftover draft from another thread
  // shouldn't follow the user around).
  useEffect(() => { setDraft(""); setErr(null); }, [topicId]);

  async function go() {
    setBusy(true); setErr(null);
    try { await onSubmit(draft); setDraft(""); }
    catch (e) { setErr(e instanceof Error ? e.message : "post failed"); }
    finally { setBusy(false); }
  }

  return (
    <div className="rounded border border-dashed border-keep-action/40 bg-keep-bg/40 p-2">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-keep-muted">Your reply</p>
      <FormattingToolbar inputRef={ref} value={draft} onChange={setDraft} disabled={busy} />
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={3}
        placeholder="Write your reply…"
        className="mt-1 w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
      />
      {err ? <p className="mt-1 text-xs text-keep-accent">{err}</p> : null}
      <div className="mt-1.5 flex justify-end">
        <button
          type="button"
          disabled={busy || !draft.trim()}
          onClick={() => void go()}
          className="rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
        >
          {busy ? "…" : "Reply"}
        </button>
      </div>
    </div>
  );
}

/**
 * Ghost topic card (Forums Catalog): rendered at the top of the category
 * section the user clicked "+ New Topic" in — title + opening post,
 * styled like the card it's about to become. Category comes from the
 * section itself, so there's no category picker.
 */
function GhostTopicComposer({ onSubmit, onCancel }: {
  onSubmit: (title: string, text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { titleRef.current?.focus(); }, []);

  async function go() {
    setBusy(true); setErr(null);
    try { await onSubmit(title.trim(), draft); }
    catch (e) { setErr(e instanceof Error ? e.message : "post failed"); setBusy(false); }
  }

  return (
    <div className="keep-frame rounded border border-dashed border-keep-action/50 bg-keep-banner/40 p-2.5">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-keep-muted">New topic</p>
      <input
        ref={titleRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={120}
        placeholder="Topic title"
        className="mb-1.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm font-semibold outline-none focus:border-keep-action"
      />
      <FormattingToolbar inputRef={ref} value={draft} onChange={setDraft} disabled={busy} />
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={4}
        placeholder="The opening post…"
        className="mt-1 w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
      />
      {err ? <p className="mt-1 text-xs text-keep-accent">{err}</p> : null}
      <div className="mt-1.5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-keep-rule px-3 py-1 text-[11px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !draft.trim() || !title.trim()}
          onClick={() => void go()}
          className="rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
        >
          {busy ? "…" : "Post topic"}
        </button>
      </div>
    </div>
  );
}

const NO_MESSAGES: ChatMessage[] = [];

/**
 * Notification inbox dropdown (under the floating bell). Replies to
 * your topics, quotes of you, watched-topic activity — newest first,
 * unread tinted, click lands on the topic. Mark-all-read up top.
 */
function ForumNotifPanel({ onOpen, onClose }: {
  onOpen: (n: ForumNotificationWire) => void;
  onClose: () => void;
}) {
  const setForumNotifUnread = useChat((s) => s.setForumNotifUnread);
  const [rows, setRows] = useState<ForumNotificationWire[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchForumNotifications(40)
      .then((r) => {
        if (!alive) return;
        setRows(r.notifications);
        setForumNotifUnread(r.unread);
      })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "load failed"); });
    return () => { alive = false; };
  }, [setForumNotifUnread]);

  function verb(kind: ForumNotificationWire["kind"]): string {
    if (kind === "reply") return "replied to your topic";
    if (kind === "quote") return "quoted you in";
    return "posted in";
  }
  function glyph(kind: ForumNotificationWire["kind"]): string {
    if (kind === "reply") return "↩";
    if (kind === "quote") return "❝";
    return "🔔";
  }

  async function markAll() {
    const unread = await markForumNotificationsRead("all").catch(() => null);
    if (unread !== null) {
      setForumNotifUnread(unread);
      setRows((cur) => cur ? cur.map((n) => ({ ...n, read: true })) : cur);
    }
  }

  function open(n: ForumNotificationWire) {
    if (!n.read) {
      setRows((cur) => cur ? cur.map((x) => (x.id === n.id ? { ...x, read: true } : x)) : cur);
      void markForumNotificationsRead([n.id])
        .then((unread) => setForumNotifUnread(unread))
        .catch(() => { /* badge corrects on the next pulse */ });
    }
    onOpen(n);
  }

  return (
    <>
      {/* Click-away backdrop (transparent; the panel sits above it). */}
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div className="absolute right-2 top-full z-50 mt-1 w-[22rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-keep-rule bg-keep-bg shadow-2xl">
        <div className="flex items-center justify-between border-b border-keep-rule bg-keep-banner/40 px-3 py-1.5">
          <span className="text-xs uppercase tracking-widest text-keep-muted">Notifications</span>
          <button
            type="button"
            onClick={() => void markAll()}
            className="rounded border border-keep-rule px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
          >
            Mark all read
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {err ? (
            <p className="px-3 py-4 text-xs text-keep-accent">{err}</p>
          ) : !rows ? (
            <p className="px-3 py-4 text-xs italic text-keep-muted">Checking…</p>
          ) : rows.length === 0 ? (
            <p className="px-3 py-4 text-xs italic text-keep-muted">
              Nothing yet - replies to your topics, quotes of your posts, and watched topics land here.
            </p>
          ) : (
            <ul>
              {rows.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => open(n)}
                    className={`flex w-full items-start gap-2 border-b border-keep-rule/50 px-3 py-2 text-left hover:bg-keep-panel/40 ${
                      n.read ? "" : "bg-keep-action/10"
                    }`}
                  >
                    <span aria-hidden className="mt-0.5 shrink-0 text-keep-accent">{glyph(n.kind)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs text-keep-text">
                        <b>{n.actorName}</b> {verb(n.kind)} <b className="break-words">{n.topicTitle}</b>
                      </span>
                      {n.snippet ? (
                        <span className="block truncate text-[11px] text-keep-muted">{n.snippet}</span>
                      ) : null}
                      <span className="block text-[10px] text-keep-muted">{relTime(n.createdAt)}</span>
                    </span>
                    {!n.read ? (
                      <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-keep-accent" />
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Membership strip (Phase 5). Renders under the forum header for
 * application-mode forums (and for members anywhere): the apply state
 * machine none → pending → member, plus the quiet leave action. The
 * server re-checks every transition; this strip is just honest UI.
 */
function MembershipStrip({ detail, onChanged }: {
  detail: ForumDetail;
  onChanged: () => void;
}) {
  const v = detail.viewer;
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!v || v.ban) return null;

  async function act(fn: () => Promise<void>) {
    setBusy(true); setErr(null);
    try { await fn(); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "failed"); }
    finally { setBusy(false); }
  }

  // Members (not the owner) get the leave affordance; owner/staff get nothing.
  if (v.role && !v.canManage) {
    return (
      <div className="flex items-center justify-between gap-2 border-b border-keep-rule bg-keep-panel/20 px-4 py-1.5 text-xs text-keep-muted">
        <span>
          You're a {v.role === "mod" ? "moderator" : "member"} of this forum.
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (!window.confirm(`Leave ${detail.name}?${v.role === "mod" ? " You'll also give up your mod chair." : ""}${detail.postingMode === "application" ? " You'd need to re-apply to return." : ""}`)) return;
            void act(() => leaveForum(detail.id));
          }}
          className="rounded border border-keep-rule px-2 py-0.5 text-[10px] uppercase tracking-widest hover:text-keep-text"
        >
          Leave
        </button>
      </div>
    );
  }

  if (detail.postingMode !== "application" || v.canManage || v.canParticipate) return null;

  if (v.membershipPending) {
    return (
      <div className="flex items-center justify-between gap-2 border-b border-keep-rule bg-keep-action/5 px-4 py-1.5 text-xs">
        <span className="text-keep-action">Your application is pending the keeper's review.</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(() => withdrawForumMembership(detail.id))}
          className="rounded border border-keep-rule px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
        >
          Withdraw
        </button>
      </div>
    );
  }

  return (
    <div className="border-b border-keep-rule bg-keep-panel/20 px-4 py-2">
      {!open ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-keep-muted">
            This forum accepts posts from approved members. You can read everything meanwhile.
          </p>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded border border-keep-action bg-keep-action/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/20"
          >
            Apply to join
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-keep-muted">
            {detail.applicationPrompt?.trim() || "Tell the keeper why you'd like to join."}
          </p>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="Your answer (optional but persuasive)"
            className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
          />
          {err ? <p className="text-xs text-keep-accent">{err}</p> : null}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(async () => { await applyForumMembership(detail.id, answer); setOpen(false); setAnswer(""); })}
              className="rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
            >
              {busy ? "…" : "Submit"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded border border-keep-rule px-3 py-1 text-[11px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Owner console (Phase 3): Overview (name/tagline/description), Boards
 * (raise/rename/topic/reorder/archive, 10-board cap), Categories (per
 * board, riding the existing room-category endpoints — a board IS a room
 * owned by the forum owner). Visible to the owner + managing staff;
 * forum MODS never see it (topic-level powers only, per the matrix).
 */
function ForumSettingsView({ detail, onSaved, onBoardArchived }: {
  detail: ForumDetail;
  onSaved: () => void;
  onBoardArchived: (roomId: string) => void;
}) {
  // The matrix in one line: owners (and managing staff) see everything;
  // Forum Mods reach ONLY the Applications queue (they review joiners but
  // never touch settings, boards, categories, roles, or bans).
  const canManage = !!detail.viewer?.canManage;
  // Categories are managed inline per board (Boards tab) — every tab
  // here operates on exactly the forum you opened, nothing cross-forum
  // and no secondary pickers.
  const tabs = canManage
    ? (["overview", "boards", "roles", "applications", "bans", "appearance"] as const)
    : (["applications"] as const);
  const [tab, setTab] = useState<(typeof tabs)[number]>(canManage ? "overview" : "applications");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setErr(null);
    try { await fn(); }
    catch (e) { setErr(e instanceof Error ? e.message : "save failed"); }
    finally { setBusy(false); }
  }

  return (
    <div className="px-4 py-3">
      <div className="mb-3 flex flex-wrap gap-1">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded border px-2.5 py-1 text-xs uppercase tracking-widest ${
              tab === t ? "border-keep-action text-keep-action" : "border-keep-rule text-keep-muted hover:text-keep-text"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      {err ? <p className="mb-2 text-xs text-keep-accent">{err}</p> : null}
      {tab === "overview" ? (
        <OverviewSettings detail={detail} busy={busy} run={run} onSaved={onSaved} />
      ) : tab === "boards" ? (
        <BoardsSettings detail={detail} busy={busy} run={run} onSaved={onSaved} onBoardArchived={onBoardArchived} />
      ) : tab === "roles" ? (
        <RolesSettings detail={detail} busy={busy} run={run} />
      ) : tab === "applications" ? (
        <ApplicationsSettings detail={detail} busy={busy} run={run} />
      ) : tab === "appearance" ? (
        <AppearanceSettings detail={detail} busy={busy} run={run} onSaved={onSaved} />
      ) : (
        <BansSettings detail={detail} busy={busy} run={run} />
      )}
    </div>
  );
}

/**
 * Appearance tab (Phase 6): per-forum theme (ThemePicker, the same editor
 * worlds use — scoped to the catalog modal + future /f/ page only), the
 * banner + logo uploads (data-URL pipeline, content-hashed server-side),
 * and the linked-world picker (the owner's non-private worlds).
 */
function AppearanceSettings({ detail, busy, run, onSaved }: {
  detail: ForumDetail;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onSaved: () => void;
}) {
  const initialTheme = useMemo<Theme | null>(() => {
    if (!detail.themeJson) return null;
    try { return normalizeTheme(JSON.parse(detail.themeJson)); } catch { return null; }
  }, [detail.themeJson]);
  const [theme, setTheme] = useState<Theme | null>(initialTheme);
  const [styleKey, setStyleKey] = useState<string | null>(detail.themeStyleKey);
  const [bannerFocus, setBannerFocus] = useState<number>(detail.bannerFocusY ?? 50);
  const [worlds, setWorlds] = useState<Array<{ id: string; name: string; visibility: string }> | null>(null);
  const [worldId, setWorldId] = useState<string>(detail.linkedWorld?.id ?? "");

  useEffect(() => {
    let alive = true;
    fetchMyWorlds()
      .then((w) => { if (alive) setWorlds(w.filter((x) => x.visibility !== "private")); })
      .catch(() => { if (alive) setWorlds([]); });
    return () => { alive = false; };
  }, []);

  async function pickImage(kind: "logo" | "banner", file: File) {
    const maxBytes = kind === "logo" ? 512 * 1024 : 2 * 1024 * 1024;
    await run(async () => {
      const dataUrl = await readImageFile(file, maxBytes);
      await setForumImage(detail.id, kind, dataUrl);
      onSaved();
    });
  }

  const themeDirty = JSON.stringify(theme) !== JSON.stringify(initialTheme);
  const styleDirty = styleKey !== detail.themeStyleKey;
  const focusDirty = bannerFocus !== (detail.bannerFocusY ?? 50);
  const worldDirty = worldId !== (detail.linkedWorld?.id ?? "");

  return (
    <div className="max-w-xl space-y-4">
      <section>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">Images</p>
        <div className="space-y-2 rounded border border-keep-rule bg-keep-panel/20 p-2.5">
          {(["logo", "banner"] as const).map((kind) => {
            const current = kind === "logo" ? detail.logoUrl : detail.bannerImageUrl;
            return (
              <div key={kind} className="flex flex-wrap items-center gap-2">
                <span className="w-16 text-xs uppercase tracking-widest text-keep-muted">{kind}</span>
                {current ? (
                  <img src={current} alt="" className={kind === "logo" ? "h-8 w-8 rounded border border-keep-rule object-cover" : "h-8 w-20 rounded border border-keep-rule object-cover"} />
                ) : (
                  <span className="text-xs italic text-keep-muted">none</span>
                )}
                <label className="cursor-pointer rounded border border-keep-rule px-2 py-1 text-[11px] uppercase tracking-widest text-keep-muted hover:text-keep-text">
                  Upload
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="hidden"
                    disabled={busy}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) void pickImage(kind, f);
                    }}
                  />
                </label>
                {current ? (
                  <button
                    type="button" disabled={busy}
                    onClick={() => void run(async () => { await setForumImage(detail.id, kind, null); onSaved(); })}
                    className="rounded border border-keep-accent/60 px-2 py-1 text-[11px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10"
                  >Clear</button>
                ) : null}
                <span className="text-[10px] text-keep-muted">{kind === "logo" ? "square, ≤512KB" : "wide, ≤2MB"}</span>
              </div>
            );
          })}
          {/* Banner focus: which band of the image survives the header's
              cover-crop. Live preview; Save persists. */}
          {detail.bannerImageUrl ? (
            <div className="space-y-1.5 border-t border-keep-rule/60 pt-2">
              <div
                className="h-16 w-full rounded border border-keep-rule"
                style={{
                  backgroundImage: `url(${detail.bannerImageUrl})`,
                  backgroundSize: "cover",
                  backgroundPosition: `center ${bannerFocus}%`,
                }}
                aria-hidden
              />
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-widest text-keep-muted">Focus</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={bannerFocus}
                  onChange={(e) => setBannerFocus(Number(e.target.value))}
                  disabled={busy}
                  className="min-w-0 flex-1 accent-[rgb(var(--keep-action))]"
                  aria-label="Banner vertical focus"
                />
                <span className="w-8 text-right text-[10px] tabular-nums text-keep-muted">{bannerFocus}%</span>
                {focusDirty ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(async () => {
                      await updateForum(detail.id, { bannerFocusY: bannerFocus });
                      onSaved();
                    })}
                    className="rounded border border-keep-action bg-keep-action px-2.5 py-1 text-[10px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
                  >
                    Save
                  </button>
                ) : null}
              </div>
              <p className="text-[10px] text-keep-muted">
                Slide to choose which part of the banner shows - 0% keeps the top, 100% the bottom.
              </p>
            </div>
          ) : null}
        </div>
      </section>

      <section>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">Theme</p>
        <p className="mb-2 text-[11px] text-keep-muted">
          A palette for this forum's pages only - chat and the userlist are untouched.
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
            <ThemePicker theme={theme} onChange={(t) => setTheme(t)} onReset={() => setTheme(DEFAULT_THEME)} />
            <button
              type="button"
              onClick={() => setTheme(null)}
              className="mt-2 rounded border border-keep-accent/40 bg-keep-bg px-2 py-1 text-[11px] text-keep-accent hover:bg-keep-accent/10"
            >
              Remove custom theme
            </button>
          </>
        )}
        {themeDirty ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(async () => {
              await updateForum(detail.id, { themeJson: theme ? JSON.stringify(theme) : null });
              onSaved();
            })}
            className="ml-2 mt-2 rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
          >
            Save theme
          </button>
        ) : null}
      </section>

      <section>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">Design style</p>
        <p className="mb-2 text-[11px] text-keep-muted">
          The visual treatment - ornaments, borders, textures (Glass, etc.). Orthogonal to the
          palette above; applies to this forum's pages for every visitor. "Use default" follows
          each visitor's own design.
        </p>
        <StylePicker
          value={styleKey}
          onChange={setStyleKey}
          allowInherit
        />
        {styleDirty ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(async () => {
              await updateForum(detail.id, { themeStyleKey: styleKey });
              onSaved();
            })}
            className="mt-2 rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
          >
            Save style
          </button>
        ) : null}
      </section>

      <section>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">Linked world</p>
        <p className="mb-2 text-[11px] text-keep-muted">
          Show one of your worlds on the forum's header - visitors can view it and join or
          apply from its page. Private worlds can't be linked.
        </p>
        <div className="flex gap-2">
          <select
            value={worldId}
            onChange={(e) => setWorldId(e.target.value)}
            disabled={!worlds}
            className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
          >
            <option value="">(no world)</option>
            {(worlds ?? []).map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || !worldDirty}
            onClick={() => void run(async () => {
              await updateForum(detail.id, { linkedWorldId: worldId || null });
              onSaved();
            })}
            className="rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * Applications tab (Phase 5): the membership queue for application-mode
 * forums. Owner + Forum Mods review; approve seats the applicant as a
 * member in the same transaction server-side.
 */
function ApplicationsSettings({ detail, busy, run }: {
  detail: ForumDetail;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [pending, setPending] = useState<ForumMembershipApplicationWire[] | null>(null);
  const [recent, setRecent] = useState<ForumMembershipApplicationWire[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchForumMembershipApplications(detail.id)
      .then((j) => { if (!alive) return; setPending(j.pending); setRecent(j.recent); })
      .catch(() => { if (alive) setPending([]); });
    return () => { alive = false; };
  }, [detail.id, tick]);

  return (
    <div className="max-w-xl space-y-3">
      {detail.postingMode !== "application" ? (
        <p className="rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5 text-xs text-keep-muted">
          This forum is currently open - everyone may post without applying. The queue below
          only fills while posting is set to "application" (Overview tab).
        </p>
      ) : null}
      <div>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">
          Pending {pending ? `(${pending.length})` : ""}
        </p>
        {!pending ? (
          <p className="text-sm italic text-keep-muted">Loading…</p>
        ) : pending.length === 0 ? (
          <p className="text-xs italic text-keep-muted">No one is waiting at the gate.</p>
        ) : (
          <ul className="space-y-1.5">
            {pending.map((a) => (
              <li key={a.id} className="rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-keep-text">{a.applicantUsername}</span>
                  <span className="text-[10px] text-keep-muted">{new Date(a.submittedAt).toLocaleString()}</span>
                </div>
                {a.answer ? (
                  <p className="mt-1 whitespace-pre-wrap text-xs text-keep-text/90">{a.answer}</p>
                ) : (
                  <p className="mt-1 text-xs italic text-keep-muted">(no answer given)</p>
                )}
                <div className="mt-1.5 flex gap-2">
                  <button
                    type="button" disabled={busy}
                    onClick={() => void run(async () => {
                      await reviewForumMembershipApplication(detail.id, a.id, "approve");
                      setTick((t) => t + 1);
                    })}
                    className="rounded border border-keep-action bg-keep-action/15 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-keep-action disabled:opacity-50"
                  >Approve</button>
                  <button
                    type="button" disabled={busy}
                    onClick={() => {
                      const v = window.prompt(`Decline ${a.applicantUsername}? Optional note shown to them:`, "");
                      if (v === null) return;
                      void run(async () => {
                        await reviewForumMembershipApplication(detail.id, a.id, "reject", v.trim() || undefined);
                        setTick((t) => t + 1);
                      });
                    }}
                    className="rounded border border-keep-accent/60 bg-keep-accent/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-keep-accent disabled:opacity-50"
                  >Decline</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {recent.length > 0 ? (
        <div>
          <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">Recent decisions</p>
          <ul className="space-y-0.5">
            {recent.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 rounded border border-keep-rule/50 px-2 py-0.5 text-[11px] text-keep-muted">
                <span className={a.status === "approved" ? "font-semibold uppercase text-keep-action" : "font-semibold uppercase text-keep-accent"}>{a.status}</span>
                <span className="text-keep-text">{a.applicantUsername}</span>
                {a.reviewedByUsername ? <span>by {a.reviewedByUsername}</span> : null}
                {a.reviewedAt ? <span>· {new Date(a.reviewedAt).toLocaleDateString()}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Roles tab: the owner line + Forum Moderators. Targets accept bare
 * names or paste-ready @id:/@cid: tokens (the profile's copy-token chip)
 * — ambiguous names get told to paste the token. Mods hold topic-level
 * powers only; the console itself stays owner-only.
 */
function RolesSettings({ detail, busy, run }: {
  detail: ForumDetail;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [roles, setRoles] = useState<ForumRoles | null>(null);
  const [target, setTarget] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchForumRoles(detail.id).then((r) => { if (alive) setRoles(r); }).catch(() => { if (alive) setRoles(null); });
    return () => { alive = false; };
  }, [detail.id, tick]);

  return (
    <div className="max-w-xl space-y-3">
      {!roles ? (
        <p className="text-sm italic text-keep-muted">Loading…</p>
      ) : (
        <>
          <p className="text-sm text-keep-text">
            <span className="text-xs uppercase tracking-widest text-keep-muted">Keeper</span>{" "}
            <span className="font-semibold">{roles.owner.username}</span>
          </p>
          <div>
            <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">
              Forum Moderators ({roles.mods.length})
            </p>
            {roles.mods.length === 0 ? (
              <p className="text-xs italic text-keep-muted">
                None yet. Mods can sticky, lock, and tidy topics - but never touch your posts,
                categories, or settings.
              </p>
            ) : (
              <ul className="space-y-1">
                {roles.mods.map((m) => (
                  <li key={m.userId} className="flex items-center gap-2 rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1">
                    <span className="min-w-0 flex-1 truncate text-sm text-keep-text">{m.username}</span>
                    <span className="text-[10px] text-keep-muted">since {new Date(m.since).toLocaleDateString()}</span>
                    <button
                      type="button" disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`Remove ${m.username} as Forum Moderator?`)) return;
                        void run(async () => { await revokeForumMod(detail.id, m.userId); setTick((t) => t + 1); });
                      }}
                      className="rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10"
                    >Remove</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex gap-2">
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="Name or @id: token (copy it from their profile)"
              className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
            />
            <button
              type="button"
              disabled={busy || !target.trim()}
              onClick={() => void run(async () => {
                await grantForumMod(detail.id, target.trim());
                setTarget("");
                setTick((t) => t + 1);
              })}
              className="rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
            >
              Appoint
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Bans tab: ban by name/token with duration presets, list with lift.
 * Bans are scoped to THIS forum's boards only — never the wider site —
 * and banning strips any mod/member chair the target held here.
 */
function BansSettings({ detail, busy, run }: {
  detail: ForumDetail;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [bans, setBans] = useState<ForumBanRow[] | null>(null);
  const [target, setTarget] = useState("");
  const [hours, setHours] = useState<string>("168");
  const [reason, setReason] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchForumBans(detail.id).then((b) => { if (alive) setBans(b); }).catch(() => { if (alive) setBans([]); });
    return () => { alive = false; };
  }, [detail.id, tick]);

  return (
    <div className="max-w-xl space-y-3">
      <p className="text-[11px] text-keep-muted">
        A forum ban blocks this forum's boards only - the rest of the Spire is untouched.
        Banned users still see the forum in the catalog with a clear notice.
      </p>
      {!bans ? (
        <p className="text-sm italic text-keep-muted">Loading…</p>
      ) : bans.length === 0 ? (
        <p className="text-xs italic text-keep-muted">No bans. May it stay that way.</p>
      ) : (
        <ul className="space-y-1">
          {bans.map((b) => (
            <li key={b.userId} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1 text-sm">
              <span className="font-semibold text-keep-text">{b.username}</span>
              <span className={`text-[11px] ${b.expired ? "text-keep-muted line-through" : "text-keep-muted"}`}>
                {b.until ? `until ${new Date(b.until).toLocaleDateString()}` : "permanent"}
                {b.expired ? " (expired)" : ""}
              </span>
              {b.reason ? <span className="min-w-0 flex-1 truncate text-[11px] italic text-keep-muted">"{b.reason}"</span> : <span className="flex-1" />}
              <button
                type="button" disabled={busy}
                onClick={() => void run(async () => { await liftForumBan(detail.id, b.userId); setTick((t) => t + 1); })}
                className="rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
              >Lift</button>
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-2 rounded border border-keep-rule bg-keep-panel/20 p-2.5">
        <div className="flex flex-wrap gap-2">
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="Name or @id: token"
            className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
          />
          <select
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
          >
            <option value="24">1 day</option>
            <option value="168">7 days</option>
            <option value="720">30 days</option>
            <option value="perm">Permanent</option>
          </select>
        </div>
        <div className="flex gap-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={300}
            placeholder="Reason (shown to them)"
            className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
          />
          <button
            type="button"
            disabled={busy || !target.trim()}
            onClick={() => {
              const label = hours === "perm" ? "permanently" : `for ${hours === "24" ? "1 day" : hours === "168" ? "7 days" : "30 days"}`;
              if (!window.confirm(`Ban "${target.trim()}" from ${detail.name} ${label}?`)) return;
              void run(async () => {
                await banFromForum(detail.id, {
                  target: target.trim(),
                  hours: hours === "perm" ? null : parseInt(hours, 10),
                  ...(reason.trim() ? { reason: reason.trim() } : {}),
                });
                setTarget(""); setReason("");
                setTick((t) => t + 1);
              });
            }}
            className="rounded border border-keep-system/70 bg-keep-system/15 px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-system disabled:opacity-50"
          >
            Ban
          </button>
        </div>
      </div>
    </div>
  );
}

function OverviewSettings({ detail, busy, run, onSaved }: {
  detail: ForumDetail;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onSaved: () => void;
}) {
  const [name, setName] = useState(detail.name);
  const [tagline, setTagline] = useState(detail.tagline ?? "");
  const [description, setDescription] = useState(detail.descriptionHtml ?? "");
  const [postingMode, setPostingMode] = useState<"open" | "application">(detail.postingMode);
  const [prompt, setPrompt] = useState(detail.applicationPrompt ?? "");
  const [publicBrowsing, setPublicBrowsing] = useState(detail.publicBrowsing);
  const dirty = name !== detail.name
    || tagline !== (detail.tagline ?? "")
    || description !== (detail.descriptionHtml ?? "")
    || postingMode !== detail.postingMode
    || prompt !== (detail.applicationPrompt ?? "")
    || publicBrowsing !== detail.publicBrowsing;
  return (
    <div className="max-w-xl space-y-3">
      <label className="block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={FORUM_NAME_MAX}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">Tagline</span>
        <input
          value={tagline}
          onChange={(e) => setTagline(e.target.value)}
          maxLength={200}
          placeholder="One line under the forum's name."
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={6}
          maxLength={5000}
          placeholder="The long-form welcome. Same HTML rules as profile bios; shown on the forum's front page."
          className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
        />
      </label>
      <div className="rounded border border-keep-rule bg-keep-panel/20 p-2.5">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">Who may post</span>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="postingMode"
            checked={postingMode === "open"}
            onChange={() => setPostingMode("open")}
            className="mt-0.5"
          />
          <span><span className="font-semibold text-keep-text">Open</span>
            <span className="block text-xs text-keep-muted">Any signed-in user can enter the boards and post.</span></span>
        </label>
        <label className="mt-1.5 flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="postingMode"
            checked={postingMode === "application"}
            onChange={() => setPostingMode("application")}
            className="mt-0.5"
          />
          <span><span className="font-semibold text-keep-text">Application</span>
            <span className="block text-xs text-keep-muted">Everyone can read; posting requires your (or your mods') approval. Existing members keep their seats.</span></span>
        </label>
        {postingMode === "application" ? (
          <label className="mt-2 block text-sm">
            <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">Application prompt</span>
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={300}
              placeholder="Tell the keeper why you'd like to join."
              className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
            />
          </label>
        ) : null}
      </div>
      <div className="rounded border border-keep-rule bg-keep-panel/20 p-2.5">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">Public browsing</span>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={publicBrowsing}
            onChange={(e) => setPublicBrowsing(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-semibold text-keep-text">Let anyone read this forum</span>
            <span className="block text-xs text-keep-muted">
              Visitors on /f/{detail.slug} can browse the boards, topics, and replies without an
              account. Posting and joining always require signing in. Off = visitors see the front
              page only.
            </span>
          </span>
        </label>
      </div>
      <p className="text-[11px] text-keep-muted">
        The address (/f/{detail.slug}) is permanent so shared links never break.
      </p>
      <button
        type="button"
        disabled={!dirty || busy || name.trim().length < FORUM_NAME_MIN}
        onClick={() => void run(async () => {
          await updateForum(detail.id, {
            name: name.trim(),
            tagline: tagline.trim() ? tagline.trim() : null,
            descriptionHtml: description.trim() ? description : null,
            postingMode,
            applicationPrompt: prompt.trim() ? prompt.trim() : null,
            publicBrowsing,
          });
          onSaved();
        })}
        className="rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
      >
        {busy ? "…" : "Save"}
      </button>
    </div>
  );
}

function BoardsSettings({ detail, busy, run, onSaved, onBoardArchived }: {
  detail: ForumDetail;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onSaved: () => void;
  onBoardArchived: (roomId: string) => void;
}) {
  const [newName, setNewName] = useState("");
  const [newTopic, setNewTopic] = useState("");
  // Which board's category editor is expanded (one at a time keeps the
  // list scannable). Categories belong to a board, so they're managed
  // HERE, inline — not on a separate tab with a board dropdown.
  const [catsOpenFor, setCatsOpenFor] = useState<string | null>(null);
  const atCap = detail.boards.length >= 10;

  function move(roomId: string, dir: -1 | 1) {
    const order = detail.boards.map((b) => b.roomId);
    const i = order.indexOf(roomId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    void run(async () => { await updateForum(detail.id, { boardOrder: order }); onSaved(); });
  }

  return (
    <div className="max-w-xl space-y-3">
      <ul className="space-y-1.5">
        {detail.boards.map((b, i) => (
          <li key={b.roomId} className="rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-keep-text">{b.name}</span>
                <span className="block truncate text-xs text-keep-muted">{b.topic ?? "no topic line"}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <button
                  type="button" disabled={busy || i === 0} onClick={() => move(b.roomId, -1)}
                  title="Move up" aria-label={`Move ${b.name} up`}
                  className="rounded border border-keep-rule p-1 text-keep-muted hover:text-keep-text disabled:opacity-30"
                ><ArrowUp className="h-3 w-3" aria-hidden="true" /></button>
                <button
                  type="button" disabled={busy || i === detail.boards.length - 1} onClick={() => move(b.roomId, 1)}
                  title="Move down" aria-label={`Move ${b.name} down`}
                  className="rounded border border-keep-rule p-1 text-keep-muted hover:text-keep-text disabled:opacity-30"
                ><ArrowDown className="h-3 w-3" aria-hidden="true" /></button>
                <button
                  type="button" disabled={busy}
                  onClick={() => {
                    const v = window.prompt(`Rename "${b.name}" (board names are site-wide):`, b.name);
                    if (v === null || !v.trim() || v.trim() === b.name) return;
                    void run(async () => { await updateBoard(detail.id, b.roomId, { name: v.trim() }); onSaved(); });
                  }}
                  className="rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
                >Rename</button>
                <button
                  type="button" disabled={busy}
                  onClick={() => {
                    const v = window.prompt(`Topic line for "${b.name}" (blank clears):`, b.topic ?? "");
                    if (v === null) return;
                    void run(async () => { await updateBoard(detail.id, b.roomId, { topic: v.trim() ? v.trim() : null }); onSaved(); });
                  }}
                  className="rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
                >Topic</button>
                <button
                  type="button"
                  onClick={() => setCatsOpenFor((cur) => (cur === b.roomId ? null : b.roomId))}
                  aria-expanded={catsOpenFor === b.roomId}
                  className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${
                    catsOpenFor === b.roomId
                      ? "border-keep-action text-keep-action"
                      : "border-keep-rule text-keep-muted hover:text-keep-text"
                  }`}
                >Categories</button>
                <button
                  type="button" disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`Archive "${b.name}"? Its ${b.topicCount} topic${b.topicCount === 1 ? "" : "s"} are kept but the board leaves the forum. Site admins can restore it.`)) return;
                    void run(async () => { await archiveBoard(detail.id, b.roomId); onBoardArchived(b.roomId); });
                  }}
                  className="rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10"
                >Archive</button>
              </span>
            </div>
            {catsOpenFor === b.roomId ? (
              <div className="mt-2 border-t border-keep-rule/50 pt-2">
                <BoardCategoriesEditor detail={detail} boardId={b.roomId} busy={busy} run={run} />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="rounded border border-keep-rule bg-keep-panel/20 p-2.5">
        <p className="mb-1.5 text-xs uppercase tracking-widest text-keep-muted">
          Raise a board {atCap ? <span className="text-keep-accent">(at the 10-board limit)</span> : `(${detail.boards.length}/10)`}
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={40}
            placeholder="Board name (site-wide unique)"
            className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
          />
          <input
            value={newTopic}
            onChange={(e) => setNewTopic(e.target.value)}
            maxLength={200}
            placeholder="Topic line (optional)"
            className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
          />
          <button
            type="button"
            disabled={busy || atCap || !newName.trim()}
            onClick={() => void run(async () => {
              await createBoard(detail.id, {
                name: newName.trim(),
                ...(newTopic.trim() ? { topic: newTopic.trim() } : {}),
              });
              setNewName(""); setNewTopic("");
              onSaved();
            })}
            className="rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
          >
            Raise
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Category / subcategory designer for ONE board, embedded in the Boards
 * tab. Rows mirror the board's real hierarchy — top-level categories
 * render as section bars, their subcategories as indented sub-bars — and
 * each row carries reorder arrows + a single Edit toggle that opens an
 * inline panel (name, subtitle, parent, icon, delete). No window.prompt,
 * no cross-board pickers; "+ Sub" on a section adds a child under it.
 */
function BoardCategoriesEditor({ detail, boardId, busy, run }: {
  detail: ForumDetail;
  boardId: string;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [cats, setCats] = useState<ThreadCategory[] | null>(null);
  const [tick, setTick] = useState(0);
  // One inline panel open at a time: editing an existing category, or
  // adding a new one (optionally pre-parented under a section).
  const [panel, setPanel] = useState<
    | { kind: "edit"; id: string }
    | { kind: "add"; parentId: string | null }
    | null
  >(null);

  useEffect(() => {
    if (!boardId) return;
    let alive = true;
    setCats(null);
    fetchRoomCategories(boardId).then((c) => { if (alive) setCats(c); }).catch(() => { if (alive) setCats([]); });
    return () => { alive = false; };
  }, [boardId, tick]);

  const refresh = () => setTick((t) => t + 1);
  const closeAndRefresh = () => { setPanel(null); refresh(); };

  // Tree: top-level sections (orphans whose parent is missing or itself a
  // child promote to top level) each followed by their subcategories.
  const all = cats ?? [];
  const topLevel = all.filter((c) => !c.parentId || !all.some((p) => p.id === c.parentId && !p.parentId));
  const subsOf = (id: string) => all.filter((c) => c.parentId === id && !topLevel.includes(c));
  const hasChildren = (id: string) => all.some((c) => c.parentId === id && !topLevel.includes(c));

  /** Reorder within SIBLINGS only (same parent). */
  function moveSibling(cat: ThreadCategory, dir: -1 | 1) {
    const siblings = cat.parentId && !topLevel.includes(cat) ? subsOf(cat.parentId) : topLevel;
    const i = siblings.findIndex((s) => s.id === cat.id);
    const j = i + dir;
    const other = siblings[j];
    if (i < 0 || !other) return;
    void run(async () => {
      await patchRoomCategory(boardId, cat.id, { sortOrder: j });
      await patchRoomCategory(boardId, other.id, { sortOrder: i });
      refresh();
    });
  }

  if (!cats) return <p className="text-sm italic text-keep-muted">Loading categories…</p>;

  const renderRow = (c: ThreadCategory, isSub: boolean) => {
    const siblings = isSub ? subsOf(c.parentId!) : topLevel;
    const si = siblings.findIndex((s) => s.id === c.id);
    const editingHere = panel?.kind === "edit" && panel.id === c.id;
    return (
      <div key={c.id} className={isSub ? "ml-6" : ""}>
        <div className={`flex items-center gap-2 rounded border border-keep-rule px-2.5 py-1.5 ${
          isSub ? "bg-keep-panel/40" : "bg-keep-banner/40"
        }`}>
          {isSub ? <span aria-hidden className="shrink-0 text-keep-muted">↳</span> : null}
          {c.iconUrl ? (
            <img src={c.iconUrl} alt="" className="h-5 w-5 shrink-0 object-contain" />
          ) : (
            <FolderOpen className="h-4 w-4 shrink-0 text-keep-accent/70" aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1">
            <span className={`block truncate text-keep-text ${isSub ? "text-sm" : "text-sm font-semibold uppercase tracking-wide"}`}>
              {c.name}
            </span>
            {c.subtitle ? <span className="block truncate text-[11px] text-keep-muted">{c.subtitle}</span> : null}
          </span>
          {!isSub && hasChildren(c.id) ? (
            <span className="shrink-0 text-[10px] tabular-nums text-keep-muted">{subsOf(c.id).length} sub</span>
          ) : null}
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button" disabled={busy || si <= 0} onClick={() => moveSibling(c, -1)}
              title="Move up" aria-label={`Move ${c.name} up`}
              className="rounded border border-keep-rule p-1 text-keep-muted hover:text-keep-text disabled:opacity-30"
            ><ArrowUp className="h-3 w-3" aria-hidden="true" /></button>
            <button
              type="button" disabled={busy || si === siblings.length - 1} onClick={() => moveSibling(c, 1)}
              title="Move down" aria-label={`Move ${c.name} down`}
              className="rounded border border-keep-rule p-1 text-keep-muted hover:text-keep-text disabled:opacity-30"
            ><ArrowDown className="h-3 w-3" aria-hidden="true" /></button>
            {!isSub ? (
              <button
                type="button" disabled={busy}
                onClick={() => setPanel({ kind: "add", parentId: c.id })}
                title={`Add a subcategory under ${c.name}`}
                className="rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
              >+ Sub</button>
            ) : null}
            <button
              type="button"
              onClick={() => setPanel(editingHere ? null : { kind: "edit", id: c.id })}
              aria-expanded={editingHere}
              className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-widest ${
                editingHere ? "border-keep-action text-keep-action" : "border-keep-rule text-keep-muted hover:text-keep-text"
              }`}
            >Edit</button>
          </span>
        </div>
        {editingHere ? (
          <div className="mt-1">
            <CategoryForm
              forumId={detail.id}
              boardId={boardId}
              run={run}
              existing={c}
              canReparent={!hasChildren(c.id)}
              parentOptions={topLevel.filter((t) => t.id !== c.id)}
              onDone={closeAndRefresh}
              onCancel={() => setPanel(null)}
            />
          </div>
        ) : null}
        {panel?.kind === "add" && panel.parentId === c.id ? (
          <div className="ml-6 mt-1">
            <CategoryForm
              forumId={detail.id}
              boardId={boardId}
              run={run}
              existing={null}
              defaultParentId={c.id}
              canReparent={false}
              parentOptions={[]}
              onDone={closeAndRefresh}
              onCancel={() => setPanel(null)}
            />
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="space-y-2">
      {all.length === 0 ? (
        <p className="text-xs italic text-keep-muted">
          No categories yet — topics land in one flat list. Add one to group them into sections.
        </p>
      ) : (
        <div className="space-y-1.5">
          {topLevel.flatMap((t) => [
            renderRow(t, false),
            ...subsOf(t.id).map((s) => renderRow(s, true)),
          ])}
        </div>
      )}

      {/* Add a top-level category. */}
      {panel?.kind === "add" && panel.parentId === null ? (
        <CategoryForm
          forumId={detail.id}
          boardId={boardId}
          run={run}
          existing={null}
          defaultParentId={null}
          canReparent
          parentOptions={topLevel}
          onDone={closeAndRefresh}
          onCancel={() => setPanel(null)}
        />
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => setPanel({ kind: "add", parentId: null })}
          className="flex items-center gap-1.5 rounded border border-keep-action/60 bg-keep-action/10 px-2.5 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/20"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add category
        </button>
      )}
    </div>
  );
}

/**
 * Inline category panel — add OR edit. Name, subtitle, and (when the
 * category can be re-parented) a section picker batch into one save;
 * the icon upload/clear and Delete act immediately (separate endpoints).
 */
function CategoryForm({ forumId, boardId, run, existing, defaultParentId = null, canReparent, parentOptions, onDone, onCancel }: {
  forumId: string;
  boardId: string;
  run: (fn: () => Promise<void>) => Promise<void>;
  /** The category being edited, or null when adding. */
  existing: ThreadCategory | null;
  /** Pre-selected parent when adding a subcategory. */
  defaultParentId?: string | null;
  /** Whether the parent picker is offered (hidden for sections with subs). */
  canReparent: boolean;
  /** Sections selectable as a parent. */
  parentOptions: ThreadCategory[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [subtitle, setSubtitle] = useState(existing?.subtitle ?? "");
  const [parentId, setParentId] = useState<string>(existing?.parentId ?? defaultParentId ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { nameRef.current?.focus(); }, []);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const sub = subtitle.trim() ? subtitle.trim().slice(0, 140) : null;
    setBusy(true); setErr(null);
    try {
      if (existing) {
        await patchRoomCategory(boardId, existing.id, {
          name: trimmed,
          subtitle: sub,
          ...(canReparent ? { parentId: parentId || null } : {}),
        });
      } else {
        await createRoomCategory(boardId, trimmed, 9999, sub, parentId || null);
      }
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded border border-dashed border-keep-action/50 bg-keep-bg/60 p-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-keep-muted">
        {existing ? "Edit category" : defaultParentId ? "New subcategory" : "New category"}
      </p>
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Name</span>
        <input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          placeholder="Category name"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
        />
      </label>
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Subtitle <span className="normal-case text-keep-rule">(what belongs here, optional)</span></span>
        <input
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
          maxLength={140}
          placeholder="Shown under the category name on the board"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
        />
      </label>
      {canReparent ? (
        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Section</span>
          <select
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
          >
            <option value="">Top level (its own section)</option>
            {parentOptions.map((t) => (
              <option key={t.id} value={t.id}>Under {t.name}</option>
            ))}
          </select>
        </label>
      ) : null}

      {/* Icon + delete only make sense for an existing category. */}
      {existing ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-keep-rule/50 pt-2">
          <span className="text-[10px] uppercase tracking-widest text-keep-muted">Icon</span>
          {existing.iconUrl ? (
            <img src={existing.iconUrl} alt="" className="h-5 w-5 rounded-sm object-contain" />
          ) : (
            <FolderOpen className="h-4 w-4 text-keep-accent/70" aria-hidden="true" />
          )}
          <label className={`cursor-pointer rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text ${busy ? "opacity-50" : ""}`}>
            Upload
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                void run(async () => {
                  const dataUrl = await readImageFile(f, 128 * 1024);
                  await setCategoryIcon(forumId, boardId, existing.id, dataUrl);
                  onDone();
                });
              }}
            />
          </label>
          {existing.iconUrl ? (
            <button
              type="button" disabled={busy}
              onClick={() => void run(async () => { await setCategoryIcon(forumId, boardId, existing.id, null); onDone(); })}
              className="rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
            >Clear</button>
          ) : null}
          <span className="text-[10px] text-keep-rule">square, ≤128KB</span>
          <button
            type="button" disabled={busy}
            onClick={() => {
              if (!window.confirm(`Delete "${existing.name}"? Its topics fall back to the uncategorized list.`)) return;
              void run(async () => { await deleteRoomCategory(boardId, existing.id); onDone(); });
            }}
            className="ml-auto rounded border border-keep-accent/60 px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10"
          >Delete</button>
        </div>
      ) : null}

      {err ? <p className="text-xs text-keep-accent">{err}</p> : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-keep-rule px-3 py-1 text-[11px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
        >Cancel</button>
        <button
          type="button"
          disabled={busy || !name.trim()}
          onClick={() => void save()}
          className="rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
        >{busy ? "…" : existing ? "Save" : "Create"}</button>
      </div>
    </div>
  );
}

