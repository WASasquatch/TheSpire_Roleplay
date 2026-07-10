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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import DOMPurify from "dompurify";
import { ArrowDown, ArrowLeft, ArrowUp, BarChart3, Bell, Compass, FolderOpen, Globe, HelpCircle, Landmark, Lock, MessagesSquare, Plus, Search, Settings as SettingsIcon, Star, Users, X } from "lucide-react";
import {
  type ChatMessage,
  type ForumCreationApplicationWire,
  type ForumDetail,
  type ForumMemberEntry,
  type ForumMembershipApplicationWire,
  type ForumModEntry,
  type ForumModLogEntry,
  type ForumModPermission,
  type ForumNotificationWire,
  type ForumReportWire,
  type ForumSummary,
  type ForumUserSearchHit,
  type NpcStat,
  type RoomOccupant,
  type ThreadCategory,
  type UserNpcWire,
  DEFAULT_THEME,
  FORUM_NAME_MAX,
  FORUM_NAME_MIN,
  FORUM_PURPOSE_MAX,
  FORUM_PURPOSE_MIN,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  POLL_OPTION_MAX,
  POLL_QUESTION_MAX,
  FORUM_MOD_PERMISSIONS,
  FORUM_MOD_PERMISSION_META,
  FORUM_MOD_DEFAULT_PERMISSIONS,
  FORUM_PERMISSIONS,
  FORUM_PERMISSION_META,
  FORUM_FEATURE_PERMISSIONS,
  FORUM_AUTO_RULE_META,
  FORUM_MAX_AUTO_RULES,
  forumPermissionCategory,
  FORUM_PREFIX_TOOLTIP_MAX,
  prefixAppliesToCategory,
  resolveMessageColor,
  normalizeTheme,
  normalizeTag,
  MAX_TAGS_PER_ENTITY,
  deriveSlug,
  type Theme,
  type ForumPermission,
  type ForumAutoRule,
  type ForumAutoRuleKind,
  type ForumUsergroupWire,
  type ForumUsergroupMemberWire} from "@thekeep/shared";
import {
  applyForumMembership,
  archiveBoard,
  banFromForum,
  checkForumSlug,
  createBoard,
  createRoomCategory,
  deleteRoomCategory,
  fetchForumBans,
  fetchForumMembers,
  fetchForumModLog,
  fetchForumReports,
  resolveForumReport,
  removeForumMember,
  fetchForumDetail,
  fetchForumDiscover,
  fetchForumMembershipApplications,
  fetchForumNotifications,
  fetchForumRegistrationRules,
  fetchForumRoles,
  fetchForumTags,
  fetchForums,
  searchForums,
  fetchMyForumApplications,
  fetchMyWorlds,
  markForumNotificationsRead,
  markTopicRead,
  setTopicWatch,
  fetchRoomCategories,
  fetchTopicThread,
  grantForumMod,
  joinForum,
  leaveForum,
  liftForumBan,
  markForumVisited,
  fetchMyNpcs,
  createNpc,
  updateNpc,
  deleteNpc,
  setTopicPrefix,
  setTopicNsfw,
  setDefaultForum,
  createForumPrefix,
  updateForumPrefix,
  deleteForumPrefix,
  patchRoomCategory,
  postToBoard,
  reportForumPost,
  readImageFile,
  relTime,
  reviewForumMembershipApplication,
  revokeForumMod,
  setForumModPermissions,
  fetchForumUsergroups,
  createForumUsergroup,
  updateForumUsergroup,
  deleteForumUsergroup,
  fetchForumUsergroupMembers,
  addForumUsergroupMember,
  removeForumUsergroupMember,
  setCategoryIcon,
  setForumImage,
  submitForumApplication,
  updateBoard,
  updateForum,
  withdrawForumMembership,
  type ForumBanRow,
  type ForumRoles,
  type ForumUsergroupsResponse,
  type SlugCheck,
} from "../../lib/forums.js";
import { listServers, type ServerSummary } from "../../lib/servers.js";
import { formatDate, formatDateTime, formatNumber } from "../../lib/intlFormat.js";
import { forumBannerInk, inkClass, isDarkSurface, themeStyle, useActiveTheme, useImageAverageColor, useScopedRootDesign } from "../../lib/theme.js";
import { ForumReportContext } from "../../lib/forumReportContext.js";
import { ForumTopicAdminContext } from "../../lib/forumTopicAdminContext.js";
import { ForumPrefixContext } from "../../lib/forumPrefixContext.js";
import { playRoomTransition } from "../../lib/transitions/orchestrator.js";
import { Modal } from "../cosmetics/Modal.js";
import { UserLookupPicker } from "../moderation/UserLookupPicker.js";
import { StylePicker } from "../admin/AdminPanel.js";
import { CloseButton } from "../shared/CloseButton.js";
import { FloatingWindow } from "../shared/FloatingWindow.js";
import { RatingChip } from "../shared/RatingChip.js";
import { ContextualTour } from "../tours/ContextualTour.js";
import { FormattingToolbar } from "../shared/FormattingToolbar.js";
import { MessageList } from "../chat/MessageList.js";
import { ThemePicker } from "../cosmetics/ThemePicker.js";
import { useChat } from "../../state/store.js";
import { useReducedMotion } from "../../lib/reducedMotion.js";

/** In-modal navigation. The forum view IS the full forum (header +
 *  MessageList's nested renderer; topics expand inline exactly like the
 *  deployed in-chat forums did); the owner console rides its own view. */
type CatalogView =
  | { kind: "forum" }
  | { kind: "settings" }
  | { kind: "discover" };

interface Props {
  /** Land on this forum (slug or id) instead of the system default. */
  initialKey?: string | null;
  /** Open straight onto a topic's thread (bookmark / search jumps,
   *  permalinks). Pair with `initialKey` = the board's forum. Optional
   *  postId highlights one specific post in the thread. */
  initialTopic?: { boardId: string; topicId: string; postId?: string } | null;
  /** Open straight onto the "Create your Forum" application form (Tools →
   *  Forums → Create a Forum, or `/forums create`). Ignored for viewers
   *  without `apply_create_forum`. */
  initialCreate?: boolean;
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

export function ForumsCatalogModal({ initialKey, initialTopic, initialCreate, onClose, onOpenWorld, onIconClick, onNameClick, onMentionClick, onWorldMentionClick, selfNames, fontStep }: Props) {
  const { t } = useTranslation("forums");
  const me = useChat((s) => s.me);
  const setForcedTourId = useChat((s) => s.setForcedTourId);
  const toursToShow = useChat((s) => s.toursToShow);
  const forcedTourId = useChat((s) => s.forcedTourId);
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
  // prop, retargeted by notification clicks. `forumId` (known on the
  // notification path) holds the target back until the RIGHT forum's
  // detail is on screen — without it, a cross-forum jump briefly hands
  // the old forum a board it doesn't have and the "topic isn't
  // available" notice flashes during the switch.
  const [navTopic, setNavTopic] = useState<{ boardId: string; topicId: string; postId?: string; forumId?: string; nonce?: number } | null>(initialTopic ?? null);
  // Monotonic click counter riding navTopic. The consumer effects key on
  // primitive ids, and navTopic is never cleared after consumption — so
  // without the nonce, clicking a SECOND notification about the SAME topic
  // (five replies to your topic = five rows with one topicId) set state to
  // identical dep values and nothing re-fired: the click was silently dead.
  const navNonceRef = useRef(0);
  const [notifOpen, setNotifOpen] = useState(false);
  // Mobile: the forum list lives in a slide-out drawer (the rail is desktop-
  // only) toggled from the toolbar. Closed by default, like the chat tools.
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The viewer's default forum (account-wide, synced via /me/profile). Seeds
  // the landing selection and is toggled from the toolbar star.
  const defaultForumId = useChat((s) => s.defaultForumId);
  // The topic currently open in the board view — mirrored into the URL.
  const [urlTopicId, setUrlTopicId] = useState<string | null>(null);
  const forumNotifUnread = useChat((s) => s.forumNotifUnread);
  const canApply = !!me?.permissions?.includes("apply_create_forum");
  // Tools → Forums → Create a Forum (or `/forums create`) lands straight on
  // the application form. Gated by canApply; runs once the permission is
  // known so a slow `me` load doesn't drop the intent.
  useEffect(() => {
    if (initialCreate && canApply) setCreateOpen(true);
  }, [initialCreate, canApply]);

  // Star the currently-viewed forum as your default (or unstar it). Optimistic
  // store update + a synced /me/profile write; revert if the save fails.
  const currentForumId = detail?.id ?? selected;
  const isDefaultForum = !!currentForumId && defaultForumId === currentForumId;
  function toggleDefaultForum() {
    if (!currentForumId) return;
    const prev = defaultForumId;
    const next = isDefaultForum ? null : currentForumId;
    useChat.getState().setDefaultForumId(next);
    void setDefaultForum(next).catch(() => useChat.getState().setDefaultForumId(prev));
  }

  /** Notification click: land on its topic (switching forums if needed). */
  function openNotification(n: ForumNotificationWire) {
    setNotifOpen(false);
    // postId = the exact post that triggered the notice — flashes it.
    setNavTopic({ boardId: n.boardRoomId, topicId: n.topicId, postId: n.messageId, forumId: n.forumId, nonce: ++navNonceRef.current });
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
        // Default selection: explicit initialKey, else the viewer's chosen
        // default forum, else the system forum, else the first row. Stored as
        // the forum ID so isReady compares one canonical key regardless of
        // whether a slug was passed.
        if (!selected) {
          const init = initialKey
            ? f.find((x) => x.slug === initialKey || x.id === initialKey)
            : undefined;
          const fav = defaultForumId ? f.find((x) => x.id === defaultForumId) : undefined;
          const target = init ?? fav ?? f.find((x) => x.isSystem) ?? f[0];
          if (target) setSelected(target.id);
        }
      })
      .catch((e) => { if (alive) setListErr(e instanceof Error ? e.message : t("shared.loadFailed")); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc closes the mobile forum drawer (mirrors the chat tools drawer).
  useEffect(() => {
    if (!drawerOpen) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setDrawerOpen(false); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  // detailTick lets the owner console force a refetch after a save
  // without re-running the selection logic.
  const [detailTick, setDetailTick] = useState(0);
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setDetailErr(null);
    fetchForumDetail(selected)
      .then((d) => { if (alive) setDetail(d); })
      .catch((e) => { if (alive) setDetailErr(e instanceof Error ? e.message : t("shared.loadFailed")); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // Always open on the forum view so the Forums Catalog loads the default forum
  // (or the deep-linked one). The first-run browse tour used to FORCE Discover
  // here to give itself a surface, but that hid the forum behind an awkward,
  // mostly-empty Discover list; the browse tour now runs on the forum view and
  // spotlights the Discover compass instead (see the ContextualTours below).
  const [view, setView] = useState<CatalogView>({ kind: "forum" });

  /** All in-modal hops (forum switch, board open, topic open, back) run
   *  through the same equipped-transition path as chat room switches. */
  function transitionTo(swap: () => void, isReady: () => boolean) {
    const permitted = !!me?.permissions?.includes("use_room_transitions");
    const key = permitted ? myActiveTransitionKey : null;
    void playRoomTransition(key, { wrapperEl: bodyRef.current, swap, isReady });
  }

  // Replay chaining: the rail's Help icon replays the BROWSE tour, but the
  // owner's mental model is "replay THE forums tour" — browse then posting.
  // Contextual tours are one-shot (tour_seen), so once the posting tour has
  // been consumed it never re-fires on its own and a browse replay ends
  // after three tips with nothing following — which reads as the tour being
  // broken. When a FORCED browse replay is dismissed while a forum is still
  // on screen, queue the posting tour next. Organic first-runs sequence
  // themselves via the toursToShow gate on the posting tour's `active` and
  // never enter this path (forcedTourId stays null for them).
  const prevForcedTourRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevForcedTourRef.current;
    prevForcedTourRef.current = forcedTourId;
    if (prev === "forums-browse" && forcedTourId === null && view.kind === "forum" && detail && detail.boards.length > 0) {
      setForcedTourId("forum-posting");
    }
  }, [forcedTourId, view.kind, detail, setForcedTourId]);

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
    <FloatingWindow
      onClose={onClose}
      title={t("chrome.forums")}
      // Forums opens near-fullscreen BY USER REQUEST (the old card filled
      // the viewport over the chat) — still a window, so it can be dragged
      // or resized down from there.
      initialWidth={window.innerWidth - 32}
      initialHeight={window.innerHeight - 32}
      // text-keep-text on the window shell re-anchors the inherited text
      // color to the forum's scoped palette. Without it, plain text inside
      // inherits the color computed at the APP shell (the viewer's
      // theme) — white text washing out over a parchment forum.
      className="keep-frame border border-keep-rule bg-keep-bg text-keep-text"
      {...(forumTheme ? { style: themeStyle(forumTheme) } : {})}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* No big title bar inside: the forum's own banner IS the header.
            The app chrome lives in a slim bar at the top of the CONTENT
            pane (see below) — breadcrumbs left, actions right — so it
            never floats over the rail column. */}

        {/* Body = content + rail; the transition wrapper covers BOTH.
            Layout splits use CONTAINER queries (the FloatingWindow content
            box is an inline-size container): the rail shows when the
            WINDOW is wide, not the screen — a window resized narrow swaps
            to the drawer layout instead of clipping. `min-w-0` on the
            content pane is load-bearing: without it wide topic rows set
            the row's min-content width past the window edge and the rail
            gets clipped off the right side. */}
        <div ref={bodyRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden [@container(min-width:1024px)]:flex-row">
          {/* Content pane */}
          <div className="order-2 flex min-h-0 min-w-0 flex-1 flex-col [@container(min-width:1024px)]:order-1">
            {/* Chrome bar: breadcrumbs on the left, actions (settings ·
                notifications · close) aligned right. One predictable
                home for the controls on every view — nothing floats
                over the banner or the rail. The notification panel
                anchors under this bar.

                `z-30` makes this bar its OWN stacking context above the
                content below it, so the absolutely-positioned notification
                dropdown (which drops down OVER the content) paints on top.
                Without it the topic-card content — which forms its own
                stacking context via the room-transition transforms —
                rendered over the dropdown. */}
            <div className="relative z-30 shrink-0 border-b border-keep-rule bg-keep-banner/30">
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
                      <span className="min-w-0 truncate text-keep-text">{t("chrome.settingsCrumb")}</span>
                    </>
                  ) : view.kind === "discover" ? (
                    <>
                      {detail ? (
                        <button
                          type="button"
                          onClick={() => navigateView({ kind: "forum" })}
                          className="flex items-center gap-1 rounded text-keep-muted hover:text-keep-action"
                        >
                          <ArrowLeft className="h-3 w-3" aria-hidden="true" />
                          <span className="max-w-[12rem] truncate">{detail.name}</span>
                        </button>
                      ) : null}
                      {detail ? <span className="text-keep-rule">›</span> : null}
                      <span className="min-w-0 truncate font-action text-sm text-keep-text">{t("chrome.discover")}</span>
                    </>
                  ) : (
                    <span className="min-w-0 truncate font-action text-sm text-keep-text">
                      {detail?.name ?? t("chrome.forums")}
                    </span>
                  )}
                </nav>
                <div className="flex shrink-0 items-center gap-1.5">
                  {/* Narrow window / mobile: open the forum-list drawer
                      (the rail shows itself once the WINDOW is wide). */}
                  <button
                    type="button"
                    onClick={() => setDrawerOpen(true)}
                    title={t("chrome.browseForums")}
                    aria-label={t("chrome.browseForums")}
                    className="rounded border border-keep-rule bg-keep-bg/70 p-1.5 text-keep-muted hover:border-keep-action hover:text-keep-action [@container(min-width:1024px)]:hidden"
                  >
                    <MessagesSquare className="h-4 w-4" aria-hidden="true" />
                  </button>
                  {/* Discover: search the catalog by name or tag, browse the
                      Popular / New rails. Toggles back to the open forum.
                      Anchored for the browse tour — this chrome button is the
                      one Discover affordance visible on BOTH mobile and desktop
                      (the rail is hidden under lg, the drawer starts closed),
                      so it wears the accent + a text label at all times: with
                      a default forum set, users land INSIDE a forum and this
                      is their only obvious way out to the rest of the catalog. */}
                  <button
                    type="button"
                    data-tour="forums-chrome-discover-btn"
                    onClick={() => navigateView(view.kind === "discover" ? { kind: "forum" } : { kind: "discover" })}
                    title={t("chrome.discoverTitle")}
                    aria-label={t("chrome.discoverAria")}
                    aria-pressed={view.kind === "discover"}
                    className={`flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-xs font-semibold uppercase tracking-widest ${
                      view.kind === "discover"
                        ? "border-keep-action bg-keep-action/25 text-keep-action"
                        : "border-keep-action/60 bg-keep-action/10 text-keep-action hover:border-keep-action hover:bg-keep-action/20"
                    }`}
                  >
                    <Compass className="h-4 w-4" aria-hidden="true" />
                    <span className="hidden sm:inline">{t("chrome.discover")}</span>
                  </button>
                  {/* Set / unset this forum as your default landing spot. */}
                  {view.kind === "forum" && detail ? (
                    <button
                      type="button"
                      onClick={toggleDefaultForum}
                      title={isDefaultForum ? t("chrome.defaultSetTitle") : t("chrome.defaultUnsetTitle")}
                      aria-label={isDefaultForum ? t("chrome.defaultUnsetAria") : t("chrome.defaultSetAria")}
                      aria-pressed={isDefaultForum}
                      className={`rounded border p-1.5 ${isDefaultForum ? "border-keep-action/60 bg-keep-action/10 text-keep-action" : "border-keep-rule bg-keep-bg/70 text-keep-muted hover:border-keep-action hover:text-keep-action"}`}
                    >
                      <Star className="h-4 w-4" aria-hidden="true" fill={isDefaultForum ? "currentColor" : "none"} />
                    </button>
                  ) : null}
                  {view.kind === "forum" && detail && (detail.viewer?.canManage || detail.viewer?.role === "mod") ? (
                    <button
                      type="button"
                      onClick={() => navigateView({ kind: "settings" })}
                      title={t("chrome.settingsTitle")}
                      aria-label={t("chrome.settingsAria")}
                      className="rounded border border-keep-rule bg-keep-bg/70 p-1.5 text-keep-muted hover:border-keep-action hover:text-keep-action"
                    >
                      <SettingsIcon className="h-4 w-4" aria-hidden="true" />
                    </button>
                  ) : null}
                  {view.kind === "forum" && detail ? (
                    <button
                      type="button"
                      onClick={() => setForcedTourId("forum-posting")}
                      title={t("chrome.postingTourTitle")}
                      aria-label={t("chrome.postingTourAria")}
                      className="rounded border border-keep-rule bg-keep-bg/70 p-1.5 text-keep-muted hover:border-keep-action hover:text-keep-action"
                    >
                      <HelpCircle className="h-4 w-4" aria-hidden="true" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setNotifOpen((o) => !o)}
                    title={t("chrome.notifTitle")}
                    aria-label={forumNotifUnread > 0 ? t("chrome.notifAriaUnread", { count: forumNotifUnread }) : t("chrome.notifAria")}
                    className="flex items-center gap-1 rounded border border-keep-rule bg-keep-bg/70 p-1.5 text-keep-muted hover:border-keep-action hover:text-keep-action"
                  >
                    <Bell className="h-4 w-4" aria-hidden="true" />
                    {forumNotifUnread > 0 ? (
                      <span className="rounded-full bg-keep-accent px-1.5 text-[10px] font-bold leading-4 text-keep-bg">
                        {forumNotifUnread > 99 ? "99+" : forumNotifUnread}
                      </span>
                    ) : null}
                  </button>
                </div>
              </div>
              {notifOpen ? (
                <ForumNotifPanel onOpen={openNotification} onClose={() => setNotifOpen(false)} />
              ) : null}
            </div>
            {/* The forum view is a flex column (MessageList owns its own
                scroll region); the settings + discover views scroll as a page. */}
            {view.kind === "forum" ? (
              <div className="flex min-h-0 flex-1 flex-col">
                {detailErr ? (
                  <p className="px-4 py-6 text-sm text-keep-accent">{detailErr}</p>
                ) : !detail ? (
                  <p className="px-4 py-6 text-sm italic text-keep-muted">{t("chrome.openingBoards")}</p>
                ) : (
                  <ForumContent
                    detail={detail}
                    asCharacterId={activeCharacterId}
                    chrome={chrome}
                    // Hold a cross-forum jump target back until ITS forum is
                    // the one rendered (see the navTopic comment above).
                    initialTopic={navTopic && (!navTopic.forumId || navTopic.forumId === detail.id) ? navTopic : null}
                    onChanged={() => setDetailTick((t) => t + 1)}
                    {...(onOpenWorld ? { onOpenWorld } : {})}
                    onActiveTopicChange={setUrlTopicId}
                  />
                )}
              </div>
            ) : view.kind === "discover" ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <ForumDiscoverView
                  activeId={detail?.id ?? selected}
                  onOpenForum={(id) => navigateToForum(id)}
                />
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
                  <p className="px-4 py-6 text-sm italic text-keep-muted">{t("common:loading")}</p>
                )}
              </div>
            )}
          </div>

          {/* Forums rail — wide-window only (right side, mirrors the chat
              userlist). In narrow windows (and on phones) it lives in the
              slide-out drawer below. */}
          <aside className="hidden shrink-0 [@container(min-width:1024px)]:order-2 [@container(min-width:1024px)]:flex [@container(min-width:1024px)]:min-h-0 [@container(min-width:1024px)]:w-64 [@container(min-width:1024px)]:flex-col [@container(min-width:1024px)]:border-l [@container(min-width:1024px)]:border-keep-rule [@container(min-width:1024px)]:bg-keep-banner/20">
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-xs uppercase tracking-widest text-keep-muted">
                {t("chrome.forums")} <span className="text-keep-rule">({list?.length ?? "…"})</span>
              </span>
              <button
                type="button"
                onClick={() => { navigateView({ kind: "forum" }); setForcedTourId("forums-browse"); }}
                title={t("chrome.browseTourTitle")}
                aria-label={t("chrome.browseTourTitle")}
                className="rounded p-1 text-keep-muted hover:bg-keep-panel hover:text-keep-action"
              >
                <HelpCircle className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <ForumRailList
              list={list}
              listErr={listErr}
              activeId={detail?.id ?? selected}
              defaultForumId={defaultForumId}
              canApply={canApply}
              discoverActive={view.kind === "discover"}
              onDiscover={() => navigateView({ kind: "discover" })}
              onCreate={() => setCreateOpen(true)}
              onSelect={(id) => navigateToForum(id)}
            />
          </aside>
        </div>

        {/* Narrow-window forum-list drawer — slides in from the right
            (mirrors the chat userlist); hides itself once the WINDOW is
            wide enough for the always-visible rail. */}
        {drawerOpen ? (
          <div className="absolute inset-0 z-40 flex [@container(min-width:1024px)]:hidden">
            <button
              type="button"
              aria-label={t("chrome.closeForumList")}
              onClick={() => setDrawerOpen(false)}
              className="absolute inset-0 bg-black/40"
            />
            <aside className="relative ml-auto flex h-full w-72 max-w-[85%] flex-col border-l border-keep-rule bg-keep-bg shadow-2xl">
              <div className="flex items-center justify-between border-b border-keep-rule bg-keep-banner/30 px-3 py-2">
                <span className="text-xs uppercase tracking-widest text-keep-muted">
                  {t("chrome.forums")} <span className="text-keep-rule">({list?.length ?? "…"})</span>
                </span>
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  aria-label={t("chrome.closeForumList")}
                  className="rounded border border-keep-rule bg-keep-bg/70 p-1 text-keep-muted hover:border-keep-action hover:text-keep-action"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              <ForumRailList
                list={list}
                listErr={listErr}
                activeId={detail?.id ?? selected}
                defaultForumId={defaultForumId}
                canApply={canApply}
                discoverActive={view.kind === "discover"}
                onDiscover={() => { navigateView({ kind: "discover" }); setDrawerOpen(false); }}
                onCreate={() => { setCreateOpen(true); setDrawerOpen(false); }}
                onSelect={(id) => { navigateToForum(id); setDrawerOpen(false); }}
              />
            </aside>
          </div>
        ) : null}
      </div>
      {/* Contextual first-run tours. Each mounts unconditionally and self-fires
          only when its own surface is on screen (and the tour is unseen or
          being replayed). Empty step lists render nothing. */}
      <ContextualTour tourId="forums-browse" active={view.kind === "forum" && !!detail && !createOpen} />
      <ContextualTour
        tourId="forum-posting"
        active={
          view.kind === "forum" && !!detail && !createOpen &&
          // A boardless forum has no New Topic button, no composer, nothing —
          // narrating the posting flow into that void reads as a broken tour.
          // The boot backfill furnishes bare forums, so this mostly guards the
          // window before a restart (and keepers who deleted every board).
          detail.boards.length > 0 &&
          // Let the browse (overview) tour finish first; both share the forum
          // surface, so gating here keeps them from stacking two overlays.
          !(toursToShow.includes("forums-browse") || forcedTourId === "forums-browse")
        }
      />
      <ContextualTour tourId="forum-admin" active={view.kind === "settings" && !!detail && !createOpen} />
      {createOpen ? <CreateForumModal onClose={() => setCreateOpen(false)} /> : null}
    </FloatingWindow>
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
  const { t } = useTranslation("forums");
  const setForcedTourId = useChat((s) => s.setForcedTourId);
  const [mine, setMine] = useState<ForumCreationApplicationWire[] | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugCheck, setSlugCheck] = useState<SlugCheck | null>(null);
  const [purpose, setPurpose] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  // Site-set forum registration rules (sanitized HTML). Empty string = none,
  // so the form skips the agreement block and behaves as before.
  const [rulesHtml, setRulesHtml] = useState<string>("");
  const [agreed, setAgreed] = useState(false);
  const hasRules = !!rulesHtml.trim();

  useEffect(() => {
    let alive = true;
    fetchMyForumApplications()
      .then((a) => { if (alive) setMine(a); })
      .catch(() => { if (alive) setMine([]); });
    fetchForumRegistrationRules()
      .then((html) => { if (alive) setRulesHtml(html); })
      .catch(() => { if (alive) setRulesHtml(""); });
    return () => { alive = false; };
  }, []);

  // Sanitize the rules HTML once for render (defense in depth — the server
  // already sanitizes on save).
  const sanitizedRules = useMemo(
    () => (rulesHtml.trim() ? DOMPurify.sanitize(rulesHtml) : ""),
    [rulesHtml],
  );

  // Auto-suggest the slug from the name until the user edits it directly.
  useEffect(() => {
    if (slugTouched) return;
    const suggested = deriveSlug(name, { sep: "_", max: 40 });
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
      await submitForumApplication({
        name: name.trim(),
        slug,
        purpose: purpose.trim(),
        // Only assert agreement when rules are actually set (server requires
        // it true in that case); omitted otherwise so behavior is unchanged.
        ...(hasRules ? { agreedToRules: true } : {}),
      });
      setSubmitted(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("create.submitFailed"));
    } finally {
      setBusy(false);
    }
  }

  const slugNote = !slugCheck || slug.length < 3
    ? null
    : slugCheck.ok
      ? { text: t("create.slugAvailable"), tone: "text-keep-action" }
      : {
          text: slugCheck.reason === "taken" ? t("create.slugTaken")
            : slugCheck.reason === "pending" ? t("create.slugPending")
            : slugCheck.reason === "reserved" ? t("create.slugReserved")
            : t("create.slugInvalid"),
          tone: "text-keep-accent",
        };
  const purposeLen = purpose.trim().length;
  const canSubmit = !busy
    && name.trim().length >= FORUM_NAME_MIN && name.trim().length <= FORUM_NAME_MAX
    && slugCheck?.ok === true
    && purposeLen >= FORUM_PURPOSE_MIN && purposeLen <= FORUM_PURPOSE_MAX
    // When the site has posted registration rules, the applicant must accept
    // them before the Submit button unlocks.
    && (!hasRules || agreed);

  return (
    <Modal onClose={onClose} zIndex={50}>
      <div
        className="keep-frame w-full max-w-lg rounded border border-keep-rule bg-keep-bg p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-action text-lg text-keep-text">{t("create.title")}</h3>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setForcedTourId("forum-create")}
              title={t("create.tourTitle")}
              aria-label={t("create.tourTitle")}
              className="rounded p-1 text-keep-muted hover:bg-keep-panel hover:text-keep-action"
            >
              <HelpCircle className="h-4 w-4" aria-hidden="true" />
            </button>
            <CloseButton onClick={onClose} />
          </div>
        </div>
        {/* The create-forum form only exists while this modal is mounted, so
            the tour is always eligible here (it self-gates on unseen/replay). */}
        <ContextualTour tourId="forum-create" active />


        {mine === null ? (
          <p className="text-sm italic text-keep-muted">{t("create.checking")}</p>
        ) : submitted ? (
          <div className="space-y-2 text-sm text-keep-text">
            <p><Trans t={t} i18nKey="create.sent" components={{ b: <strong /> }} /></p>
            <button type="button" onClick={onClose} className="rounded border border-keep-rule px-3 py-1 text-xs hover:bg-keep-panel">{t("common:close")}</button>
          </div>
        ) : pending ? (
          <div className="space-y-2 text-sm text-keep-text">
            <p>
              <Trans
                t={t}
                i18nKey="create.pendingLine"
                values={{ name: pending.requestedName, slug: pending.requestedSlug }}
                components={{ b: <strong />, muted: <span className="text-keep-muted" />, action: <span className="text-keep-action" /> }}
              />
            </p>
            <p className="text-xs text-keep-muted">{t("create.oneAtATime")}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {lastRejected?.reviewNote ? (
              <p className="rounded border border-keep-rule bg-keep-panel/40 px-2 py-1.5 text-xs text-keep-muted">
                {t("create.declinedNote", { note: lastRejected.reviewNote })}
              </p>
            ) : null}
            <label className="block text-sm">
              <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">{t("create.nameLabel")}</span>
              <input
                data-tour="forum-create-name-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={FORUM_NAME_MAX}
                placeholder={t("create.namePlaceholder")}
                className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">
                {t("create.addressLabel")} <span className="normal-case text-keep-rule">/f/</span>
                {slugNote ? <span className={`ml-2 normal-case ${slugNote.tone}`}>{slugNote.text}</span> : null}
              </span>
              <input
                data-tour="forum-create-slug-input"
                value={slug}
                onChange={(e) => { setSlugTouched(true); setSlug(e.target.value.toLowerCase()); }}
                maxLength={40}
                placeholder={t("create.slugPlaceholder")}
                className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 font-mono text-sm outline-none focus:border-keep-action"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">
                {t("create.purposeLabel")}
                <span className={`ml-2 normal-case tabular-nums ${purposeLen > 0 && purposeLen < FORUM_PURPOSE_MIN ? "text-keep-accent" : "text-keep-rule"}`}>
                  {purposeLen}/{FORUM_PURPOSE_MAX}{purposeLen < FORUM_PURPOSE_MIN ? t("create.minSuffix", { min: FORUM_PURPOSE_MIN }) : ""}
                </span>
              </span>
              <textarea
                data-tour="forum-create-purpose-input"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                maxLength={FORUM_PURPOSE_MAX}
                rows={4}
                placeholder={t("create.purposePlaceholder")}
                className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
              />
            </label>
            {/* Site-set registration rules: the applicant must read and accept
                them before applying. Only shown when rules are posted. */}
            {hasRules ? (
              <div className="space-y-2">
                <span className="block text-xs uppercase tracking-widest text-keep-muted">{t("create.rulesLabel")}</span>
                <div
                  className="prose prose-sm max-h-48 max-w-none overflow-y-auto rounded border border-keep-rule bg-keep-panel/30 p-2.5 text-keep-text"
                  dangerouslySetInnerHTML={{ __html: sanitizedRules }}
                />
                <label className="flex items-start gap-2 text-sm text-keep-text">
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>{t("create.agree")}</span>
                </label>
              </div>
            ) : null}
            {err ? <p className="text-xs text-keep-accent">{err}</p> : null}
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-keep-muted">{t("create.reviewNote")}</p>
              <button
                type="button"
                data-tour="forum-create-submit"
                onClick={() => void submit()}
                disabled={!canSubmit}
                className="shrink-0 rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
              >
                {busy ? "…" : t("create.apply")}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** The forum rail's body: a Create button, then your joined/owned forums (+
 *  the system forum) up top, then everything else folded under a collapsible
 *  "Explore" section. Shared by the desktop rail and the mobile drawer so both
 *  read identically; the list always scrolls vertically. */
function ForumRailList({ list, listErr, activeId, defaultForumId, canApply, discoverActive, onDiscover, onCreate, onSelect }: {
  list: ForumSummary[] | null;
  listErr: string | null;
  activeId: string | null;
  defaultForumId: string | null;
  canApply: boolean;
  /** The discover view is currently open — highlights the rail's Discover entry. */
  discoverActive: boolean;
  /** Open the discover view (search + Popular/New rails) in the content pane. */
  onDiscover: () => void;
  onCreate: () => void;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation("forums");
  // null = follow the default: Explore is collapsed once you have forums of
  // your own, and auto-open when "mine" is empty so a newcomer sees something.
  const [exploreOpen, setExploreOpen] = useState<boolean | null>(null);
  const mine = list ? list.filter((f) => f.viewerRole != null || f.isSystem) : [];
  const explore = list ? list.filter((f) => f.viewerRole == null && !f.isSystem) : [];
  const exploreShown = exploreOpen ?? mine.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-2 pt-2">
        <button
          type="button"
          data-tour="forums-discover-button"
          onClick={onDiscover}
          title={t("rail.discoverRailTitle")}
          aria-pressed={discoverActive}
          className={`flex w-full items-center justify-center gap-1.5 rounded border px-2 py-1.5 text-xs font-semibold uppercase tracking-widest transition-colors ${
            discoverActive
              ? "border-keep-action/60 bg-keep-action/10 text-keep-action"
              : "border-keep-rule bg-keep-bg/70 text-keep-muted hover:border-keep-action hover:text-keep-action"
          }`}
        >
          <Compass className="h-3.5 w-3.5" aria-hidden="true" />
          {t("chrome.discover")}
        </button>
      </div>
      {canApply ? (
        <div className="shrink-0 px-2 pt-2">
          <button
            type="button"
            data-tour="forums-create-button"
            onClick={onCreate}
            title={t("rail.createForumTitle")}
            className="flex w-full items-center justify-center gap-1.5 rounded border border-keep-action/60 bg-keep-action/10 px-2 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-action transition-colors hover:bg-keep-action/20"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t("create.title")}
          </button>
        </div>
      ) : null}
      {listErr ? (
        <p className="px-3 py-2 text-xs text-keep-accent">{listErr}</p>
      ) : !list ? (
        <p className="px-3 py-2 text-xs italic text-keep-muted">{t("common:loading")}</p>
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 py-2">
          {mine.length > 0 ? (
            <ul className="space-y-1">
              {mine.map((f) => (
                <ForumRailRow key={f.id} forum={f} active={activeId === f.id} isDefault={defaultForumId === f.id} onClick={() => onSelect(f.id)} />
              ))}
            </ul>
          ) : null}
          {explore.length > 0 ? (
            <div>
              <button
                type="button"
                onClick={() => setExploreOpen(!exploreShown)}
                aria-expanded={exploreShown}
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-muted hover:text-keep-text"
                title={t("rail.exploreTitle")}
              >
                <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="flex-1 text-left">{t("rail.explore")}</span>
                <span className="text-keep-rule">{explore.length}</span>
                <span aria-hidden>{exploreShown ? "▾" : "▸"}</span>
              </button>
              {exploreShown ? (
                <ul className="mt-1 space-y-1">
                  {explore.map((f) => (
                    <ForumRailRow key={f.id} forum={f} active={activeId === f.id} isDefault={defaultForumId === f.id} onClick={() => onSelect(f.id)} />
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {mine.length === 0 && explore.length === 0 ? (
            <p className="px-1 py-2 text-xs italic text-keep-muted">{t("rail.noForums")}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ForumRailRow({ forum, active, isDefault = false, onClick }: {
  forum: ForumSummary;
  active: boolean;
  /** This is the viewer's default forum — gets a small filled-star marker. */
  isDefault?: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation("forums");
  const pulse = relTime(forum.lastActivityAt);
  return (
    <li className="shrink-0">
      <button
        type="button"
        data-tour="forums-rail-row"
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
            {/* 18+ forum marker (age plan Phase 3). Rows with the flag only
                ever reach viewers who can see NSFW (the server excludes them
                for everyone else), so no muted SFW twin here — all-ages
                forums are the unmarked default. */}
            {forum.isNsfw ? <RatingChip nsfw className="self-center" /> : null}
            {forum.unseen ? (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-keep-action"
                title={t("rail.newActivityTitle")}
                aria-label={t("rail.newActivityAria")}
              />
            ) : null}
            {isDefault ? (
              <Star className="h-3 w-3 shrink-0 text-keep-action" fill="currentColor" aria-label={t("rail.defaultForumAria")} />
            ) : null}
          </span>
          <span className="block truncate text-[10px] text-keep-muted">
            {t("rail.boardCount", { count: forum.boardCount })}
            {pulse ? ` · ${pulse}` : ""}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * Discover view (Discovery + tags feature — the forum-side mirror of the
 * server discover surface). A search bar with a tag-chip cloud beneath it
 * sits at the top; below it either the default browse (two side-by-side
 * Popular / New rails) or — once there's a query or an active tag — a single
 * Results list. Cards reuse the rail's ForumRailRow markup verbatim so a
 * discovered forum reads exactly like one in the rail; clicking a card opens
 * that forum in the content pane.
 */
function ForumDiscoverView({ activeId, onOpenForum }: {
  activeId: string | null;
  onOpenForum: (id: string) => void;
}) {
  const { t } = useTranslation("forums");
  const [discover, setDiscover] = useState<{ popular: ForumSummary[]; new: ForumSummary[] } | null>(null);
  const [discoverErr, setDiscoverErr] = useState<string | null>(null);
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);

  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  // Debounced text used for the actual search request (~250ms after typing).
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [results, setResults] = useState<ForumSummary[] | null>(null);
  const [searchErr, setSearchErr] = useState<string | null>(null);

  const searching = debouncedQuery.trim().length > 0 || activeTag != null;

  // Default browse + tag cloud — fetched once on open. Empty catalogs come
  // back as empty arrays, so every branch below has a graceful empty state.
  useEffect(() => {
    let alive = true;
    fetchForumDiscover()
      .then((d) => { if (alive) setDiscover(d); })
      .catch((e) => { if (alive) setDiscoverErr(e instanceof Error ? e.message : t("discoverView.loadFailed")); });
    fetchForumTags()
      .then((rows) => { if (alive) setTags(rows); })
      .catch(() => { if (alive) setTags([]); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounce the typed query (~250ms) so each keystroke doesn't fire a search.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  // Run the search whenever the debounced text or the active tag changes.
  // When neither is set we drop back to the default browse (results = null).
  useEffect(() => {
    if (!searching) { setResults(null); setSearchErr(null); return; }
    let alive = true;
    setSearchErr(null);
    searchForums(debouncedQuery, activeTag)
      .then((items) => { if (alive) setResults(items); })
      .catch((e) => { if (alive) { setResults([]); setSearchErr(e instanceof Error ? e.message : t("discoverView.searchFailed")); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, activeTag, searching]);

  function clearSearch() {
    setQuery("");
    setDebouncedQuery("");
    setActiveTag(null);
  }

  // Top ~12 tags for the chip cloud.
  const chipTags = tags.slice(0, 12);

  return (
    <div className="mx-auto max-w-3xl px-4 py-4">
      {/* Search bar */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-keep-muted" aria-hidden="true" />
        <input
          data-tour="forums-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("discoverView.searchPlaceholder")}
          aria-label={t("discoverView.searchAria")}
          className="w-full rounded border border-keep-rule bg-keep-bg py-2 pl-9 pr-3 text-sm outline-none focus:border-keep-action"
        />
      </div>

      {/* Tag chip cloud — clicking a chip activates a tag filter. */}
      {chipTags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {chipTags.map(({ tag, count }) => {
            const on = activeTag === tag;
            return (
              <button
                key={tag}
                type="button"
                onClick={() => setActiveTag(on ? null : tag)}
                aria-pressed={on}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
                  on
                    ? "border-keep-action/60 bg-keep-action/10 text-keep-action"
                    : "border-keep-rule bg-keep-bg/70 text-keep-muted hover:border-keep-action hover:text-keep-action"
                }`}
              >
                {tag}
                <span className="ml-1 text-keep-rule">{count}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Active-tag pill + clear affordance (search mode). */}
      {searching ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {activeTag ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-keep-action/60 bg-keep-action/10 px-2.5 py-0.5 text-[11px] text-keep-action">
              {activeTag}
              <button
                type="button"
                onClick={() => setActiveTag(null)}
                aria-label={t("discoverView.removeTagFilterAria", { tag: activeTag })}
                className="rounded-full hover:text-keep-text"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </span>
          ) : null}
          <button
            type="button"
            onClick={clearSearch}
            className="inline-flex items-center gap-1 rounded border border-keep-rule px-2 py-0.5 text-[11px] uppercase tracking-widest text-keep-muted hover:border-keep-action hover:text-keep-action"
          >
            <ArrowLeft className="h-3 w-3" aria-hidden="true" />
            {t("discoverView.backToBrowse")}
          </button>
        </div>
      ) : null}

      {/* Anchored for the browse tour's "pick a forum" step: this list of
          forum cards (Popular / New, or search results) lives ONLY in the
          Discover content, so it's visible on mobile and desktop alike — unlike
          the rail rows, which are display:none under lg. */}
      <div className="mt-4" data-tour="forums-discover-list">
        {searching ? (
          /* ── Search results ── */
          <section>
            <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-keep-muted">
              <Search className="h-3.5 w-3.5" aria-hidden="true" />
              {t("discoverView.results")}
              {results ? <span className="text-keep-rule">({results.length})</span> : null}
            </p>
            {searchErr ? (
              <p className="rounded border border-keep-rule bg-keep-panel/40 px-3 py-2 text-sm text-keep-accent">{searchErr}</p>
            ) : !results ? (
              <p className="py-6 text-center text-sm italic text-keep-muted">{t("discoverView.searching")}</p>
            ) : results.length === 0 ? (
              <p className="rounded border border-dashed border-keep-rule px-3 py-4 text-center text-sm italic text-keep-muted">
                {t("discoverView.noMatches")}
              </p>
            ) : (
              <ul className="space-y-1">
                {results.map((f) => (
                  <ForumRailRow key={f.id} forum={f} active={activeId === f.id} onClick={() => onOpenForum(f.id)} />
                ))}
              </ul>
            )}
          </section>
        ) : discoverErr ? (
          <p className="rounded border border-keep-rule bg-keep-panel/40 px-3 py-2 text-sm text-keep-accent">{discoverErr}</p>
        ) : !discover ? (
          <p className="py-6 text-center text-sm italic text-keep-muted">{t("discoverView.gathering")}</p>
        ) : (
          /* ── Default browse: Popular / New, side-by-side on desktop ── */
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <ForumDiscoverColumn
              icon={<Star className="h-3.5 w-3.5" aria-hidden="true" />}
              title={t("discoverView.popular")}
              forums={discover.popular}
              activeId={activeId}
              onOpenForum={onOpenForum}
              emptyText={t("discoverView.noPopular")}
            />
            <ForumDiscoverColumn
              icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
              title={t("discoverView.new")}
              forums={discover.new}
              activeId={activeId}
              onOpenForum={onOpenForum}
              emptyText={t("discoverView.noNew")}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** One labelled column of discover cards (Popular / New), reusing the rail's
 *  ForumRailRow card. Renders its own empty state. */
function ForumDiscoverColumn({ icon, title, forums, activeId, onOpenForum, emptyText }: {
  icon: ReactNode;
  title: string;
  forums: ForumSummary[];
  activeId: string | null;
  onOpenForum: (id: string) => void;
  emptyText: string;
}) {
  return (
    <section>
      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-keep-muted">
        {icon}
        {title}
        <span className="text-keep-rule">({forums.length})</span>
      </p>
      {forums.length === 0 ? (
        <p className="rounded border border-dashed border-keep-rule px-3 py-4 text-center text-sm italic text-keep-muted">
          {emptyText}
        </p>
      ) : (
        <ul className="space-y-1">
          {forums.map((f) => (
            <ForumRailRow key={f.id} forum={f} active={activeId === f.id} onClick={() => onOpenForum(f.id)} />
          ))}
        </ul>
      )}
    </section>
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
   *  active (and optionally one post flashed). `nonce` distinguishes
   *  repeat clicks on the same target (see navNonceRef). */
  initialTopic?: { boardId: string; topicId: string; postId?: string; nonce?: number } | null;
  /** Refetch the detail after apply/withdraw/leave so the viewer state
   *  (pending chip, member count) stays honest. */
  onChanged: () => void;
  onOpenWorld?: (worldId: string) => void;
  /** URL mirroring: reports the active topic id (null = none open). */
  onActiveTopicChange?: (topicId: string | null) => void;
}) {
  const { t } = useTranslation("forums");
  // 18+ forum, under-18 account (age plan, Phase 3): the server already
  // hands this viewer only the teaser detail (no boards, no description),
  // and it keeps `isNsfw` on the payload precisely so we can SAY the forum
  // is adults-only instead of leaving a dead entrance — no Apply button
  // for a forum this account can never read (the server 403s it anyway).
  const viewerIsAdult = useChat((s) => s.viewerAge.isAdult);
  const adultsOnly = detail.isNsfw && !viewerIsAdult;
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

  // Banner legibility WITHOUT darkening the art: the banner is shown as-is
  // (no scrim overlay). We SAMPLE its average color and lift the forum's
  // OWN palette ink to a legible luminosity against it (legibleAgainstBg
  // preserves hue), with a SUBTLE shadow that adapts to the resolved ink.
  // Applied INLINE so it beats the design's
  // `[data-theme-style] h1/h2/h3 { color: rgb(var(--keep-text)) }` rule —
  // the original dark-on-dark cause. CORS-tainted sample → white fallback.
  const hasBanner = !!detail.bannerImageUrl;
  const bannerColor = useImageAverageColor(hasBanner ? detail.bannerImageUrl! : null);
  const bannerInk = hasBanner ? forumBannerInk(headerPalette, bannerColor) : null;

  const ban = detail.viewer?.ban;
  const banStrip = ban ? (
    <div className="border-b border-keep-rule bg-keep-system/10 px-4 py-2 text-sm text-keep-system">
      {ban.until
        ? ban.reason
          ? t("content.bannedUntilReason", { date: formatDate(ban.until), reason: ban.reason })
          : t("content.bannedUntil", { date: formatDate(ban.until) })
        : ban.reason
          ? t("content.bannedReason", { reason: ban.reason })
          : t("content.bannedPlain")}
    </div>
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header band: banner image (when set) behind logo + name + meta. */}
      <header
        className="relative shrink-0 border-b border-keep-rule bg-keep-banner/30 px-4 py-3 md:px-8 md:py-12"
        style={detail.bannerImageUrl ? {
          backgroundImage: `url(${detail.bannerImageUrl})`,
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
            {/* Ink follows the SURFACE: over a banner image we sample its
                luminance and force LIGHT ink via inline style (which wins
                over the forum design's heading-color rule — the dark-on-dark
                culprit). With no banner, the palette's luminance decides via
                inkClass. The viewer can't recolor someone else's banner, so
                the renderer must get it right. */}
            <h3
              className={`truncate font-action text-2xl md:text-4xl ${bannerInk ? "" : inkClass.title(headerDark)}`}
              style={bannerInk?.title}
            >{detail.name}</h3>
            {detail.tagline ? (
              <p
                className={`truncate text-sm md:text-base ${bannerInk ? "" : inkClass.sub(headerDark)}`}
                style={bannerInk?.sub}
              >{detail.tagline}</p>
            ) : null}
            <p
              className={`mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] md:text-xs ${bannerInk ? "" : inkClass.meta(headerDark)}`}
              style={bannerInk?.meta}
            >
              <span><Trans t={t} i18nKey="shared.keptBy" values={{ name: detail.ownerUsername }} components={{ v: <span className={bannerInk ? "" : inkClass.strong(headerDark)} style={bannerInk?.strong} /> }} /></span>
              {/* 18+ forum chip (age plan Phase 3): adults see which side of
                  the partition they're in; minors never receive the forum. */}
              {detail.isNsfw ? <RatingChip nsfw /> : null}
              {detail.viewer?.role === "mod" ? (
                <span
                  title={t("content.forumModTitle")}
                  className="rounded border border-keep-system/60 bg-keep-system/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-keep-system"
                >
                  {t("content.forumModChip")}
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1">
                <Users className="h-3 w-3" aria-hidden="true" />
                {detail.memberCount > 0 ? t("shared.memberCount", { count: detail.memberCount }) : t("shared.openToAll")}
              </span>
              {detail.linkedWorld ? <span>{t("content.worldMeta", { name: detail.linkedWorld.name })}</span> : null}
              <span>{t("shared.foundedDate", { date: formatDate(detail.createdAt, { year: "numeric", month: "long", day: "numeric" }) })}</span>
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
            <span className="ml-2 text-[11px] text-keep-muted">{t("content.worldBy", { name: detail.linkedWorld.ownerUsername })}</span>
            {detail.linkedWorld.description ? (
              <span className="block truncate text-xs text-keep-muted">{detail.linkedWorld.description}</span>
            ) : null}
          </div>
          {onOpenWorld ? (
            <button
              type="button"
              onClick={() => onOpenWorld(detail.linkedWorld!.id)}
              title={t("content.viewWorldTitle")}
              className="shrink-0 rounded border border-keep-accent/60 bg-keep-accent/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-accent hover:bg-keep-accent/20"
            >
              {t("content.viewWorld")}
            </button>
          ) : null}
        </div>
      ) : null}
      {banStrip}
      {adultsOnly ? (
        <div className="border-b border-keep-rule bg-keep-system/10 px-4 py-2 text-sm text-keep-system">
          {t("content.adultsOnly")}
        </div>
      ) : (
        <MembershipStrip detail={detail} onChanged={onChanged} />
      )}

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
        adultsOnly ? null : (
          <p className="px-4 py-3 text-sm italic text-keep-muted">{t("content.noBoards")}</p>
        )
      ) : (
        <ForumBoards
          detail={detail}
          asCharacterId={asCharacterId}
          chrome={chrome}
          initialTopic={initialTopic ?? null}
          onForumChanged={onChanged}
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
  const { t } = useTranslation("forums");
  const siteName = useChat((st) => st.branding.siteName) || t("common:appName");
  const s = detail.stats;
  if (!s) return null;
  const onlineTotal = s.online.publicNames.length + s.online.hiddenCount;
  return (
    <footer className="shrink-0 border-t border-keep-rule bg-keep-banner/30 px-4 py-2 text-[11px] text-keep-muted">
      {/* On phones the footer collapses to just the stats line — the "who's
          online" and vitals bands are hidden to reclaim vertical space (the
          user's "footer takes too much room on mobile" report); the stats row
          already carries the online count. Everything returns at `md`. */}
      <div className="hidden truncate border-b border-keep-rule/50 pb-1.5 md:block">
        <span className="font-semibold uppercase tracking-widest">{t("footer.whosOnline")}</span>{" "}
        {onlineTotal === 0 ? (
          <span className="italic">{t("footer.quiet")}</span>
        ) : (
          <>
            {s.online.publicNames.length > 0 ? (
              <span className="text-keep-text">{s.online.publicNames.join(", ")}</span>
            ) : null}
            {s.online.hiddenCount > 0
              ? t(s.online.publicNames.length > 0 ? "footer.hiddenAfterNames" : "footer.hidden", { count: s.online.hiddenCount })
              : ""}
            {s.online.browsingRecently > 0
              ? t("footer.browsing", { count: s.online.browsingRecently })
              : ""}
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 border-keep-rule/50 py-1.5 md:border-b">
        <span className="font-semibold uppercase tracking-widest">{t("footer.boardStatistics")}</span>
        <span><Trans t={t} i18nKey="footer.statTopics" values={{ value: formatNumber(s.topics) }} components={{ n: <b className="tabular-nums text-keep-text" /> }} /></span>
        <span><Trans t={t} i18nKey="footer.statReplies" values={{ value: formatNumber(s.replies) }} components={{ n: <b className="tabular-nums text-keep-text" /> }} /></span>
        <span><Trans t={t} i18nKey="footer.statWriters" values={{ value: formatNumber(s.writers) }} components={{ n: <b className="tabular-nums text-keep-text" /> }} /></span>
        <span>
          <Trans
            t={t}
            i18nKey={detail.memberCount > 0 ? "footer.statMembers" : "footer.statOpenToAll"}
            values={{ value: detail.memberCount > 0 ? formatNumber(detail.memberCount) : "-" }}
            components={{ n: <b className="tabular-nums text-keep-text" /> }}
          />
        </span>
        <span><Trans t={t} i18nKey="footer.statOnline" values={{ value: formatNumber(onlineTotal) }} components={{ n: <b className="tabular-nums text-keep-text" /> }} /></span>
      </div>
      <div className="hidden flex-wrap items-center gap-x-4 gap-y-0.5 pt-1.5 md:flex">
        <span>{t("footer.posting")} <span className="text-keep-text">{detail.postingMode === "application" ? t("footer.byApplication") : t("shared.openToAll")}</span></span>
        <span>{t("footer.keeperLabel")} <span className="text-keep-text">{detail.ownerUsername}</span></span>
        {detail.linkedWorld ? (
          <span>{t("footer.worldLabel")} <span className="text-keep-text">{detail.linkedWorld.name}</span></span>
        ) : null}
        <span>{t("footer.foundedLabel")} <span className="text-keep-text">{formatDate(detail.createdAt)}</span></span>
        <span className="ml-auto"><Trans t={t} i18nKey="footer.hostedBy" values={{ siteName }} components={{ v: <span className="text-keep-text" /> }} /></span>
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
function ForumBoards({ detail, asCharacterId, chrome, initialTopic, onForumChanged, onActiveTopicChange }: {
  detail: ForumDetail;
  asCharacterId: string | null;
  chrome: ForumChrome;
  initialTopic: { boardId: string; topicId: string; postId?: string; nonce?: number } | null;
  /** Refetch the forum detail (e.g. after a prefix is created inline) so the
   *  prefix catalog the chips resolve against stays current. */
  onForumChanged: () => void;
  onActiveTopicChange?: (topicId: string | null) => void;
}) {
  const { t } = useTranslation("forums");
  const [boardId, setBoardId] = useState<string>(
    initialTopic?.boardId && detail.boards.some((b) => b.roomId === initialTopic.boardId)
      ? initialTopic.boardId
      : detail.boards[0]!.roomId,
  );
  // Notification / deep-link retarget: when the requested topic changes
  // after mount, follow its board too. `nonce` rides the deps so a repeat
  // click on a notification for the SAME topic still re-navigates (the
  // ids alone would compare equal and drop the click).
  useEffect(() => {
    if (initialTopic?.boardId && detail.boards.some((b) => b.roomId === initialTopic.boardId)) {
      setBoardId(initialTopic.boardId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTopic?.boardId, initialTopic?.topicId, initialTopic?.nonce]);
  const active = detail.boards.find((b) => b.roomId === boardId) ?? detail.boards[0]!;

  // Cross-board move / merge. Provided to topic cards via context only when
  // the viewer can move topics; the picker modal state lives here (where the
  // board list is known). The server re-checks every move/merge.
  const canMoveTopics = !!detail.viewer && (detail.viewer.canManage || detail.viewer.permissions.includes("move_topics"));
  // The topic toolbar's Move button opens a unified picker (recategorize /
  // move-to-board / merge) that lives down in MessageList; here we just hand it
  // the forum's boards + a refresh callback, gated on move_topics.
  const topicAdminValue = useMemo(
    () => canMoveTopics ? {
      boards: detail.boards.map((b) => ({ roomId: b.roomId, name: b.name, topicCount: b.topicCount })),
      onChanged: () => useChat.getState().bumpForumActionTick(),
    } : null,
    [canMoveTopics, detail.boards],
  );

  // Topic prefix catalog + assign picker. The context (chip lookup) is shown
  // to everyone; the assign affordance gates per-card on author/manage_prefixes.
  const canManagePrefixes = !!detail.viewer && (detail.viewer.canManage || detail.viewer.permissions.includes("manage_prefixes"));
  const canCreateCustom = detail.allowCustomTags && !!detail.viewer && (detail.viewer.canManage || detail.viewer.permissions.includes("create_tags"));
  const [prefixAssign, setPrefixAssign] = useState<{
    topicId: string; currentPrefixId: string | null; topicCategoryId: string | null;
    /** NSFW re-tag section state (age plan Phase 3): the topic's current
     *  tag + author, so the picker can mirror the server's write gate. */
    nsfwCurrent: boolean; authorUserId: string;
  } | null>(null);
  const prefixValue = useMemo(
    () => ({
      byId: new Map(detail.prefixes.map((p) => [p.id, p])),
      all: detail.prefixes,
      canManagePrefixes,
      canCreateCustom,
      onAssign: (topicId: string, currentPrefixId: string | null, topicCategoryId: string | null, nsfw: { current: boolean; authorUserId: string }) =>
        setPrefixAssign({ topicId, currentPrefixId, topicCategoryId, nsfwCurrent: nsfw.current, authorUserId: nsfw.authorUserId }),
    }),
    [detail.prefixes, canManagePrefixes, canCreateCustom],
  );
  // Deep link / notification pointing at a board this viewer doesn't have
  // (an 18+ board hidden from the account, or one since archived): we fall
  // back to the first board, so say why the promised topic isn't on screen
  // instead of leaving a silent nothing. Dismiss is remembered per target.
  const [boardGoneDismissed, setBoardGoneDismissed] = useState<string | null>(null);
  const targetBoardMissing = !!initialTopic && !detail.boards.some((b) => b.roomId === initialTopic.boardId);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {targetBoardMissing && boardGoneDismissed !== initialTopic!.topicId ? (
        <TopicUnavailableNotice onDismiss={() => setBoardGoneDismissed(initialTopic!.topicId)} />
      ) : null}
      {detail.boards.length > 1 ? (
        <div className="flex flex-wrap gap-1 border-b border-keep-rule bg-keep-banner/20 px-3 py-1.5">
          {detail.boards.map((b) => (
            <button
              key={b.roomId}
              type="button"
              onClick={() => setBoardId(b.roomId)}
              title={b.locked ? t("shared.boardMembersOnlyTitle", { name: b.name }) : (b.topic ?? b.name)}
              className={`inline-flex items-center gap-1 rounded border px-2.5 py-1 text-xs ${
                b.roomId === active.roomId
                  ? "border-keep-action text-keep-action"
                  : "border-keep-rule text-keep-muted hover:text-keep-text"
              }`}
            >
              {b.locked ? <Lock className="h-3 w-3 shrink-0" aria-label={t("shared.membersOnly")} /> : null}
              {b.name}
              <span className="ml-0.5 text-[10px] text-keep-rule">{b.topicCount}</span>
            </button>
          ))}
        </div>
      ) : null}
      {active.locked ? (
        <LockedSection
          kind="board"
          canApply={!!detail.viewer && !detail.viewer.role && detail.postingMode === "application" && !detail.viewer.membershipPending}
          signedIn={!!detail.viewer}
        />
      ) : (
        <ForumPrefixContext.Provider value={prefixValue}>
        <ForumTopicAdminContext.Provider value={topicAdminValue}>
        <ForumReportContext.Provider value={
          // Reporting needs a signed-in, non-banned viewer; otherwise null
          // so the post toolbar's forum-report button hides itself.
          detail.viewer && !detail.viewer.ban
            ? (messageId, authorName) => {
                const reason = window.prompt(t("boards.reportPrompt", { author: authorName, forum: detail.name }));
                if (!reason || !reason.trim()) return;
                void reportForumPost(detail.id, messageId, reason.trim())
                  .then(() => window.alert(t("boards.reported")))
                  .catch((e) => window.alert(e instanceof Error ? e.message : t("boards.reportFailed")));
              }
            : null
        }>
        <BoardHost
          key={active.roomId}
          boardId={active.roomId}
          forumSlug={detail.slug}
          canParticipate={detail.viewer?.canParticipate ?? false}
          // Granular: each control gates on the matching forum permission
          // (owner/staff hold all). canModerate shows the lock/delete/move
          // toolbar for a mod holding ANY of those; the server enforces the
          // specific action, so a button they can't use 403s with a notice.
          canModerate={!!detail.viewer && (detail.viewer.canManage || detail.viewer.permissions.some((p) => p === "lock_topics" || p === "delete_posts" || p === "move_topics"))}
          canPin={!!detail.viewer && (detail.viewer.canManage || detail.viewer.permissions.includes("pin_topics"))}
          canAdminEdit={!!detail.viewer && (detail.viewer.canManage || detail.viewer.permissions.includes("edit_posts"))}
          canUseNpc={!!detail.viewer && (detail.viewer.canManage || detail.viewer.permissions.includes("use_npc"))}
          asCharacterId={asCharacterId}
          chrome={chrome}
          initialTopicId={initialTopic?.boardId === active.roomId ? initialTopic.topicId : null}
          initialPostId={initialTopic?.boardId === active.roomId ? initialTopic.postId ?? null : null}
          initialNonce={initialTopic?.boardId === active.roomId ? initialTopic.nonce ?? null : null}
          {...(onActiveTopicChange ? { onActiveTopicChange } : {})}
        />
        </ForumReportContext.Provider>
        </ForumTopicAdminContext.Provider>
        {prefixAssign ? (
          <PrefixAssignModal
            detail={detail}
            topicId={prefixAssign.topicId}
            current={prefixAssign.currentPrefixId}
            topicCategoryId={prefixAssign.topicCategoryId}
            nsfwCurrent={prefixAssign.nsfwCurrent}
            authorUserId={prefixAssign.authorUserId}
            onForumChanged={onForumChanged}
            onClose={() => setPrefixAssign(null)}
            onDone={() => { setPrefixAssign(null); useChat.getState().bumpForumActionTick(); }}
          />
        ) : null}
        </ForumPrefixContext.Provider>
      )}
    </div>
  );
}

/** Picker to assign (or clear) a topic's tag. Only tags offered in the topic's
 *  category are shown (global tags + category-scoped matches). When the forum
 *  allows custom tags, a viewer holding create_tags (or owner/staff) can also
 *  mint a new global tag inline; otherwise an empty list points managers at
 *  the settings tab and tells members the keeper curates the list. */
function PrefixAssignModal({ detail, topicId, current, topicCategoryId, nsfwCurrent, authorUserId, onForumChanged, onClose, onDone }: {
  detail: ForumDetail;
  topicId: string;
  current: string | null;
  topicCategoryId: string | null;
  /** The topic's current NSFW tag (seeds the re-tag toggle's state). */
  nsfwCurrent: boolean;
  /** The topic's author — the author may re-tag their own topic (adults). */
  authorUserId: string;
  onForumChanged: () => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation("forums");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [newColor, setNewColor] = useState("#8a66cc");
  const themeBg = useActiveTheme().bg;
  const me = useChat((s) => s.me);
  const viewerIsAdult = useChat((s) => s.viewerAge.isAdult);
  const canManagePrefixes = !!detail.viewer && (detail.viewer.canManage || detail.viewer.permissions.includes("manage_prefixes"));
  const canCreateCustom = detail.allowCustomTags && !!detail.viewer && (detail.viewer.canManage || detail.viewer.permissions.includes("create_tags"));
  // Prefix rights mirror TopicPrefix's gate: managers always; the author
  // unless the current tag is staff-only (manager-controlled). A viewer here
  // on NSFW rights alone sees no prefix picker at all — no dead buttons.
  const currentIsStaffOnly = !!(current && detail.prefixes.find((p) => p.id === current)?.staffOnly);
  const isAuthor = !!me && me.id === authorUserId;
  const canAssignPrefix = canManagePrefixes || (isAuthor && !currentIsStaffOnly);
  // NSFW re-tag (age plan Phase 3): adult author / owner / manage_prefixes.
  // Cosmetic mirror — the PATCH route re-checks all of it.
  const canTagNsfw = viewerIsAdult && (canManagePrefixes || isAuthor);
  // Applied immediately on toggle (like the prefix picks); the modal stays
  // open and the card behind it refreshes via the action tick, so the flip
  // is visible the moment it lands. State only advances on server success.
  const [nsfw, setNsfw] = useState(nsfwCurrent);
  function toggleNsfw(next: boolean) {
    setBusy(true); setError(null);
    setTopicNsfw(topicId, next)
      .then(() => { setNsfw(next); setBusy(false); useChat.getState().bumpForumActionTick(); })
      .catch((e) => { setError(e instanceof Error ? e.message : t("shared.failedDot")); setBusy(false); });
  }
  // Only tags this category can be given. The currently-assigned tag is kept
  // visible even if it's now out of scope (so you can see + clear it).
  // Staff-only tags are hidden from non-managers — they can't apply them, and
  // a topic can only carry one a manager already set (which a non-manager won't
  // reach this picker to change, per TopicPrefix's gate).
  const applicable = detail.prefixes.filter((p) => (prefixAppliesToCategory(p, topicCategoryId) || p.id === current) && (canManagePrefixes || !p.staffOnly));

  function assign(prefixId: string | null) {
    setBusy(true); setError(null);
    setTopicPrefix(topicId, prefixId).then(onDone).catch((e) => { setError(e instanceof Error ? e.message : t("shared.failedDot")); setBusy(false); });
  }
  // Mint a new (global) tag AND apply it in one step, then refetch the forum
  // detail so the new chip resolves against the catalog.
  async function createAndApply() {
    const label = newLabel.trim();
    if (!label) return;
    setBusy(true); setError(null);
    try {
      const id = await createForumPrefix(detail.id, { label, color: newColor });
      await setTopicPrefix(topicId, id);
      onForumChanged();
      onDone();
    } catch (e) { setError(e instanceof Error ? e.message : t("shared.failedDot")); setBusy(false); }
  }

  return (
    <Modal onClose={onClose} zIndex={60}>
      <div onClick={(e) => e.stopPropagation()} data-tour="forum-topic-prefix-selector" className="keep-frame w-full rounded bg-keep-bg p-5 text-keep-text md:w-[min(440px,84vw)]">
        <h2 className="font-action text-lg">{t("prefixPicker.title")}</h2>
        {canAssignPrefix ? (
          <>
            {applicable.length === 0 ? (
              <p className="mt-2 text-xs italic text-keep-muted">
                {canCreateCustom
                  ? t("prefixPicker.emptyCustom")
                  : canManagePrefixes
                    ? t("prefixPicker.emptyManager")
                    : t("prefixPicker.emptyMember")}
              </p>
            ) : (
              <ul className="mt-3 flex flex-wrap gap-2">
                <li>
                  <button type="button" disabled={busy} onClick={() => assign(null)}
                    className={`rounded border px-2 py-1 text-xs ${current === null ? "border-keep-action text-keep-action" : "border-keep-rule text-keep-muted hover:text-keep-text"}`}>{t("shared.none")}</button>
                </li>
                {applicable.map((p) => (
                  <li key={p.id}>
                    <button type="button" disabled={busy} onClick={() => assign(p.id)} title={p.staffOnly ? (p.tooltip ? t("prefixPicker.staffOnlyWithTooltip", { tooltip: p.tooltip }) : t("shared.staffOnly")) : (p.tooltip ?? undefined)}
                      className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-bold uppercase tracking-wide"
                      style={{ backgroundColor: `${p.color}22`, color: resolveMessageColor(p.color, themeBg) ?? p.color, border: `1px solid ${current === p.id ? p.color : `${p.color}66`}` }}>
                      {p.staffOnly ? <Lock className="h-3 w-3" aria-hidden /> : null}{p.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* Inline custom-tag mint — only when the forum allows it AND the
                viewer holds create_tags (owner/staff included). New tag is global. */}
            {canCreateCustom ? (
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-keep-rule/60 pt-3">
                <input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)} className="h-7 w-9 shrink-0 cursor-pointer rounded border border-keep-rule bg-transparent" title={t("shared.chipColor")} />
                <input value={newLabel} maxLength={24} onChange={(e) => setNewLabel(e.target.value)} placeholder={t("prefixPicker.newTagPlaceholder")} className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action" />
                <button type="button" disabled={busy || !newLabel.trim()} onClick={() => void createAndApply()}
                  className="rounded border border-keep-action bg-keep-action/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-action disabled:opacity-50">{t("prefixPicker.addAndApply")}</button>
              </div>
            ) : null}
          </>
        ) : null}

        {/* NSFW re-tag (age plan Phase 3): the built-in system tag, beside
            the owner-prefix picker. Applies immediately on toggle; hidden
            from anyone the server would refuse (minors, non-authors without
            manage_prefixes) so nobody meets a dead control. */}
        {canTagNsfw ? (
          <div className={`mt-3 ${canAssignPrefix ? "border-t border-keep-rule/60 pt-3" : ""}`}>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={nsfw} disabled={busy} onChange={(e) => toggleNsfw(e.target.checked)} className="mt-0.5" />
              <span>
                <span className="font-semibold text-keep-text">{t("nsfw.markLabel")}</span>
                <span className="block text-xs text-keep-muted">
                  {t("nsfw.markDesc")}
                </span>
              </span>
            </label>
          </div>
        ) : null}

        {error ? <div className="mt-2 rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">{error}</div> : null}
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="rounded border border-keep-rule px-3 py-1 text-sm hover:bg-keep-banner">{t("common:close")}</button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * A deep link (permalink, notification, bookmark) promised a topic the
 * server won't hand this account — removed, or held behind a gate the
 * viewer doesn't pass (an NSFW topic for an under-18 account, a members-
 * only board). The board still renders normally underneath; this strip
 * says plainly why the promised topic isn't on screen, with no teaser
 * (no title, no snippet) and no dead spinner. Copy stays generic on
 * purpose: "removed or can't view" covers every case without labeling
 * the content for someone who can't open it anyway.
 */
function TopicUnavailableNotice({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useTranslation("forums");
  return (
    <div className="flex items-start gap-2 border-b border-keep-rule bg-keep-panel/40 px-3 py-2">
      <p className="min-w-0 flex-1 text-xs text-keep-muted">
        <Trans t={t} i18nKey="boards.unavailable" components={{ b: <span className="font-semibold text-keep-text" /> }} />
      </p>
      <button
        type="button"
        onClick={onDismiss}
        title={t("boards.dismissTitle")}
        aria-label={t("boards.dismissAria")}
        className="shrink-0 rounded p-0.5 text-keep-muted hover:text-keep-text"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Shown-but-locked placeholder for a private board (or category) the viewer
 * can't read (migration 0239). The section still appears in the strip; this
 * panel stands in for its contents with a short reason and the right next
 * step (sign in, or apply to join an application-mode forum).
 */
function LockedSection({ kind, canApply, signedIn }: {
  kind: "board" | "category";
  /** Viewer is signed in, not yet a member, and the forum takes applications. */
  canApply: boolean;
  signedIn: boolean;
}) {
  const { t } = useTranslation("forums");
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div
        aria-hidden
        className="flex h-14 w-14 items-center justify-center rounded-full border border-keep-accent/40 bg-keep-accent/10"
      >
        <Lock className="h-6 w-6 text-keep-accent" aria-hidden="true" />
      </div>
      <p className="text-sm font-semibold text-keep-text">
        {kind === "board" ? t("boards.lockedBoard") : t("boards.lockedCategory")}
      </p>
      <p className="max-w-sm text-xs text-keep-muted">
        {signedIn
          ? canApply
            ? t("boards.lockedApplyHint")
            : t("boards.lockedMemberHint")
          : t("boards.lockedSignInHint")}
      </p>
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
function BoardHost({ boardId, forumSlug, canParticipate, canModerate, canPin, canAdminEdit, canUseNpc, asCharacterId, chrome, initialTopicId, initialPostId, initialNonce, onActiveTopicChange }: {
  boardId: string;
  /** For permalink building: /f/<slug>/t/<topicId>#p-<postId>. */
  forumSlug: string;
  canParticipate: boolean;
  canModerate: boolean;
  /** Viewer may pin/sticky (pin_topics grant or owner/admin). */
  canPin: boolean;
  canAdminEdit: boolean;
  /** Viewer may voice NPCs here (use_npc grant or owner/admin). */
  canUseNpc: boolean;
  asCharacterId: string | null;
  chrome: ForumChrome;
  initialTopicId: string | null;
  /** Optional: one post inside the initial topic to flash after opening. */
  initialPostId: string | null;
  /** Bumps on every notification click so a repeat click on the SAME
   *  topic still re-opens it (ids alone compare equal in the deps). */
  initialNonce: number | null;
  /** Reports the active topic so the modal can mirror it into the URL. */
  onActiveTopicChange?: (topicId: string | null) => void;
}) {
  const { t } = useTranslation("forums");
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
   *  edit/lock from the toolbar reflects after the action-tick refetch.
   *  Resolves false when the server won't hand us the thread (deleted,
   *  or gated away from this account) so deep links can say so. */
  const hydrateThread = useCallback(async (topicId: string): Promise<boolean> => {
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
      return true;
    } catch { /* topic may have been deleted; refetch paths handle it */ return false; }
  }, [boardId, setMessages]);

  // Deep link promised a topic the server withheld (removed, or an NSFW
  // topic this account can't view). Cleared on the next deep-link attempt
  // or by its dismiss button; the board renders normally underneath.
  const [unavailableTopicId, setUnavailableTopicId] = useState<string | null>(null);

  // Deep-link / notification navigation: respond to initialTopicId
  // CHANGES too (the notification panel retargets an already-mounted
  // board), not just the mount value. When a specific post is named,
  // flash it once the thread has hydrated.
  useEffect(() => {
    if (!initialTopicId) return;
    setUnavailableTopicId(null);
    setComposerCat(undefined);
    setActiveTopicId(initialTopicId);
    markTopicRead(initialTopicId);
    setUnreadTopics((prev) => { const n = new Set(prev); n.delete(initialTopicId); return n; });
    void hydrateThread(initialTopicId).then((ok) => {
      if (!ok) {
        // No spinner, no silent nothing: tell the viewer the link's
        // target isn't reachable from their account (sane-path rule).
        setActiveTopicId(null);
        setUnavailableTopicId(initialTopicId);
        return;
      }
      if (!initialPostId) return;
      requestAnimationFrame(() => requestAnimationFrame(() => setHighlightId(initialPostId)));
    });
    // `initialNonce` rides the deps so a REPEAT notification click on the
    // same topic re-opens it (same-id clicks were silently dropped).
  }, [initialTopicId, initialPostId, initialNonce, hydrateThread]);

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
  async function submitReply(topicId: string, text: string, opts?: { format?: "say" | "action" | "npc"; npcId?: string }) {
    await postToBoard({ roomId: boardId, text, asCharacterId, replyToId: topicId, ...(opts ?? {}) });
    await markTopicRead(topicId); // before the refetch, so server truth includes it
    setUnreadTopics((prev) => { const n = new Set(prev); n.delete(topicId); return n; });
    await hydrateThread(topicId);
    const loaded = Object.entries(useChat.getState().forumTopicsByRoom[boardId] ?? {});
    for (const [key, b] of loaded) void loadBucketPage(key, b.currentPage || 1);
  }

  /** Ghost topic submit: persists, refreshes the section's first page,
   *  and opens the freshly-raised topic. */
  async function submitTopic(title: string, text: string, poll?: PollDraft, nsfw?: boolean) {
    const categoryId = composerCat ?? null;
    // Compose-time NSFW tag rides the forum:post payload itself so the
    // topic row is stamped at insert (age plan Phase 3: tagging is atomic
    // at compose — no untagged window for minors' lists/notifications).
    const messageId = await postToBoard({
      roomId: boardId,
      text,
      asCharacterId,
      threadTitle: title,
      ...(categoryId ? { threadCategoryId: categoryId } : {}),
      ...(poll ? { poll } : {}),
      ...(nsfw ? { nsfw: true } : {}),
    });
    setComposerCat(undefined);
    await loadBucketPage(categoryId ?? "_uncat", 1);
    if (messageId) activateTopic(messageId);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {unavailableTopicId ? (
        <TopicUnavailableNotice onDismiss={() => setUnavailableTopicId(null)} />
      ) : null}
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
        canPin={canPin}
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
        // The forum-posting tour runs inside THIS modal; only this render
        // site stamps its New Topic anchor (chat's MessageList stays
        // mounted behind the modal and would win the querySelector).
        forumTourAnchors
        postPermalink={postPermalink}
        highlightMessageId={highlightId}
        onHighlightDone={() => setHighlightId(null)}
        renderTopicComposer={(topic) => {
          if (topic.lockedAt) return null; // the lock notice is the card's own chip
          if (!canParticipate) {
            return (
              <p className="rounded border border-keep-rule bg-keep-panel/20 px-3 py-1.5 text-xs italic text-keep-muted">
                {t("boards.needsApproval")}
              </p>
            );
          }
          return (
            <GhostReplyComposer
              topicId={topic.id}
              quoteSeed={quoteSeed}
              canUseNpc={canUseNpc}
              onSubmit={(text, opts) => submitReply(topic.id, text, opts)}
            />
          );
        }}
        renderNewTopicForm={(categoryKey) => {
          if (composerCat === undefined) return null;
          if ((composerCat ?? "_uncat") !== categoryKey) return null;
          if (!canParticipate) {
            return (
              <p className="rounded border border-keep-rule bg-keep-panel/20 px-3 py-1.5 text-xs italic text-keep-muted">
                {t("boards.needsApproval")}
              </p>
            );
          }
          return (
            <GhostTopicComposer
              onSubmit={(title, text, poll, nsfw) => submitTopic(title, text, poll, nsfw)}
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
type ReplyFormat = "say" | "action" | "npc";

function GhostReplyComposer({ topicId, quoteSeed, canUseNpc, onSubmit }: {
  topicId: string;
  quoteSeed: { text: string; nonce: number } | null;
  canUseNpc: boolean;
  onSubmit: (text: string, opts?: { format?: ReplyFormat; npcId?: string }) => Promise<void>;
}) {
  const { t } = useTranslation("forums");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [format, setFormat] = useState<ReplyFormat>("say");
  const [npcs, setNpcs] = useState<UserNpcWire[] | null>(null);
  const [npcId, setNpcId] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Quote button payload: append the blockquote to the draft and focus.
  const seenNonce = useRef(0);
  useEffect(() => {
    if (!quoteSeed || quoteSeed.nonce === seenNonce.current) return;
    seenNonce.current = quoteSeed.nonce;
    setDraft((d) => (d ? `${d}\n${quoteSeed.text}` : quoteSeed.text));
    requestAnimationFrame(() => ref.current?.focus());
  }, [quoteSeed]);

  // Fresh composer per topic.
  useEffect(() => { setDraft(""); setErr(null); setFormat("say"); setNpcId(null); }, [topicId]);

  // Load the viewer's NPCs the first time they switch to NPC format.
  const refreshNpcs = useCallback(() => {
    fetchMyNpcs().then((list) => { setNpcs(list); setNpcId((cur) => cur ?? list[0]?.id ?? null); }).catch(() => setNpcs([]));
  }, []);
  useEffect(() => { if (format === "npc" && npcs === null) refreshNpcs(); }, [format, npcs, refreshNpcs]);

  async function go() {
    if (format === "npc" && !npcId) { setErr(t("composer.pickNpc")); return; }
    setBusy(true); setErr(null);
    try {
      await onSubmit(draft, format === "say" ? undefined : { format, ...(format === "npc" && npcId ? { npcId } : {}) });
      setDraft("");
    } catch (e) { setErr(e instanceof Error ? e.message : t("shared.postFailed")); }
    finally { setBusy(false); }
  }

  const FMT: Array<{ k: ReplyFormat; label: string }> = [
    { k: "say", label: t("composer.say") },
    { k: "action", label: t("composer.action") },
    ...(canUseNpc ? ([{ k: "npc" as const, label: t("composer.npc") }]) : []),
  ];
  const placeholder = format === "action" ? t("composer.actionPlaceholder") : format === "npc" ? t("composer.npcPlaceholder") : t("composer.replyPlaceholder");

  return (
    <div className="rounded border border-dashed border-keep-action/40 bg-keep-bg/40 p-2">
      <div className="mb-1 flex flex-wrap items-center gap-1">
        <p className="mr-1 text-[10px] font-semibold uppercase tracking-widest text-keep-muted">{t("composer.replyAs")}</p>
        {FMT.map((f) => (
          <button
            key={f.k} type="button" onClick={() => setFormat(f.k)}
            {...(f.k === "action" ? { "data-tour": "forum-compose-action-toggle" } : f.k === "npc" ? { "data-tour": "forum-compose-npc-toggle" } : {})}
            className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${format === f.k ? "border-keep-action bg-keep-action/10 text-keep-action" : "border-keep-rule text-keep-muted hover:text-keep-text"}`}
          >{f.label}</button>
        ))}
        {format === "npc" ? (
          <span className="ml-auto flex items-center gap-1">
            <select
              value={npcId ?? ""}
              onChange={(e) => setNpcId(e.target.value || null)}
              className="rounded border border-keep-rule bg-keep-bg px-1.5 py-0.5 text-xs outline-none focus:border-keep-action"
            >
              {npcs === null ? <option>{t("common:loading")}</option> : npcs.length === 0 ? <option value="">{t("composer.noNpcsOption")}</option> : npcs.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
            <button type="button" onClick={() => setManagerOpen(true)} className="rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text">{t("composer.manage")}</button>
          </span>
        ) : null}
      </div>
      <FormattingToolbar inputRef={ref} value={draft} onChange={setDraft} disabled={busy} />
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={3}
        placeholder={placeholder}
        className="mt-1 w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
      />
      {err ? <p className="mt-1 text-xs text-keep-accent">{err}</p> : null}
      <div className="mt-1.5 flex justify-end">
        <button
          type="button"
          data-tour="forum-compose-send"
          disabled={busy || !draft.trim()}
          onClick={() => void go()}
          className="rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
        >
          {busy ? "…" : format === "npc" ? t("composer.postAsNpc") : format === "action" ? t("composer.postAction") : t("composer.reply")}
        </button>
      </div>
      {managerOpen ? (
        <NpcManagerModal
          onClose={() => setManagerOpen(false)}
          onChanged={() => refreshNpcs()}
        />
      ) : null}
    </div>
  );
}

/**
 * Manage-my-NPCs modal: list, create, edit (name + stat lines), delete. NPCs
 * are per-account and reusable in any forum. Stats are simple label/value
 * lines (HP: 30, AC: 15…). Changes call back so the composer's picker refreshes.
 */
function NpcManagerModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation("forums");
  const [npcs, setNpcs] = useState<UserNpcWire[] | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; name: string; stats: NpcStat[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => { fetchMyNpcs().then(setNpcs).catch(() => setNpcs([])); }, []);
  useEffect(() => { load(); }, [load]);

  async function save() {
    if (!editing || !editing.name.trim()) { setErr(t("npc.nameRequired")); return; }
    setBusy(true); setErr(null);
    const cleanStats = editing.stats.filter((s) => s.label.trim());
    try {
      if (editing.id) await updateNpc(editing.id, { name: editing.name.trim(), stats: cleanStats });
      else await createNpc({ name: editing.name.trim(), stats: cleanStats });
      setEditing(null); load(); onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : t("shared.saveFailed")); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    if (!window.confirm(t("npc.deleteConfirm"))) return;
    setBusy(true); setErr(null);
    try { await deleteNpc(id); load(); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : t("npc.deleteFailed")); }
    finally { setBusy(false); }
  }

  return (
    <Modal onClose={onClose} zIndex={70}>
      <div onClick={(e) => e.stopPropagation()} className="keep-frame w-full rounded bg-keep-bg p-5 text-keep-text md:w-[min(480px,86vw)]">
        <h2 className="font-action text-lg">{t("npc.title")}</h2>
        <p className="mt-1 text-xs text-keep-muted">{t("npc.intro")}</p>

        {editing ? (
          <div className="mt-3 space-y-2 rounded border border-keep-rule p-2">
            <input value={editing.name} maxLength={40} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder={t("npc.namePlaceholder")} className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action" />
            <p className="text-[10px] uppercase tracking-widest text-keep-muted">{t("npc.statsLabel")}</p>
            {editing.stats.map((s, i) => (
              <div key={i} className="flex gap-1">
                <input value={s.label} maxLength={24} onChange={(e) => { const next = [...editing.stats]; next[i] = { ...s, label: e.target.value }; setEditing({ ...editing, stats: next }); }} placeholder={t("npc.statLabelPlaceholder")} className="w-1/3 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs outline-none focus:border-keep-action" />
                <input value={s.value} maxLength={40} onChange={(e) => { const next = [...editing.stats]; next[i] = { ...s, value: e.target.value }; setEditing({ ...editing, stats: next }); }} placeholder={t("npc.statValuePlaceholder")} className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs outline-none focus:border-keep-action" />
                <button type="button" onClick={() => setEditing({ ...editing, stats: editing.stats.filter((_, j) => j !== i) })} className="shrink-0 rounded border border-keep-rule px-1.5 text-[10px] text-keep-muted hover:text-keep-text">✕</button>
              </div>
            ))}
            {editing.stats.length < 12 ? (
              <button type="button" onClick={() => setEditing({ ...editing, stats: [...editing.stats, { label: "", value: "" }] })} className="rounded border border-keep-rule px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text">{t("npc.addStat")}</button>
            ) : null}
            {err ? <p className="text-xs text-keep-accent">{err}</p> : null}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => { setEditing(null); setErr(null); }} className="rounded border border-keep-rule px-3 py-1 text-sm hover:bg-keep-banner">{t("common:cancel")}</button>
              <button type="button" disabled={busy} onClick={() => void save()} className="rounded border border-keep-action bg-keep-action/10 px-3 py-1 text-sm font-semibold text-keep-action disabled:opacity-50">{t("common:save")}</button>
            </div>
          </div>
        ) : (
          <>
            {!npcs ? (
              <p className="mt-3 text-sm italic text-keep-muted">{t("common:loading")}</p>
            ) : npcs.length === 0 ? (
              <p className="mt-3 text-xs italic text-keep-muted">{t("npc.none")}</p>
            ) : (
              <ul className="mt-3 space-y-1">
                {npcs.map((n) => (
                  <li key={n.id} className="flex items-center gap-2 rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-keep-text">{n.name}</span>
                      {n.stats.length > 0 ? <span className="block truncate text-[10px] text-keep-muted">{n.stats.map((s) => `${s.label} ${s.value}`).join(" · ")}</span> : null}
                    </span>
                    <button type="button" onClick={() => setEditing({ id: n.id, name: n.name, stats: n.stats })} className="shrink-0 rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text">{t("shared.edit")}</button>
                    <button type="button" disabled={busy} onClick={() => void remove(n.id)} className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10">{t("common:delete")}</button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex justify-between">
              <button type="button" onClick={() => setEditing({ id: null, name: "", stats: [] })} className="rounded border border-keep-action bg-keep-action/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-action">{t("npc.new")}</button>
              <button type="button" onClick={onClose} className="rounded border border-keep-rule px-3 py-1 text-sm hover:bg-keep-banner">{t("common:close")}</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * Ghost topic card (Forums Catalog): rendered at the top of the category
 * section the user clicked "+ New Topic" in — title + opening post,
 * styled like the card it's about to become. Category comes from the
 * section itself, so there's no category picker.
 */
/** Poll definition the forum composer sends to postToBoard. */
type PollDraft = { optionTexts: string[]; allowMultiple: boolean; showVoters: boolean; closesAt: number | null };

function GhostTopicComposer({ onSubmit, onCancel }: {
  onSubmit: (title: string, text: string, poll?: PollDraft, nsfw?: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation("forums");
  const [title, setTitle] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  // NSFW tag at compose time (age plan Phase 3). The checkbox renders for
  // adult accounts only — under-18 accounts can never set the tag, so they
  // get no dead control (the server refuses the write regardless).
  const isAdultViewer = useChat((s) => s.viewerAge.isAdult);
  const [markNsfw, setMarkNsfw] = useState(false);

  // Poll mode: the title becomes the question and the body is an optional
  // intro, so the body requirement is relaxed while polling.
  const [isPoll, setIsPoll] = useState(false);
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [showVoters, setShowVoters] = useState(true);
  const [deadlineHours, setDeadlineHours] = useState<string>("");

  useEffect(() => { titleRef.current?.focus(); }, []);

  const cleanOptions = options.map((o) => o.trim()).filter((o) => o.length > 0);
  const pollReady = !isPoll || (cleanOptions.length >= POLL_MIN_OPTIONS && cleanOptions.length <= POLL_MAX_OPTIONS);

  function setOption(i: number, v: string) {
    setOptions((cur) => cur.map((o, idx) => (idx === i ? v : o)));
  }
  function addOption() {
    setOptions((cur) => (cur.length >= POLL_MAX_OPTIONS ? cur : [...cur, ""]));
  }
  function removeOption(i: number) {
    setOptions((cur) => (cur.length <= 2 ? cur : cur.filter((_, idx) => idx !== i)));
  }

  async function go() {
    setBusy(true); setErr(null);
    try {
      let poll: PollDraft | undefined;
      if (isPoll) {
        if (cleanOptions.length < POLL_MIN_OPTIONS) { setErr(t("composer.minOptions", { count: POLL_MIN_OPTIONS })); setBusy(false); return; }
        const hrs = deadlineHours.trim() ? parseFloat(deadlineHours) : NaN;
        const closesAt = Number.isFinite(hrs) && hrs > 0 ? Date.now() + hrs * 3_600_000 : null;
        poll = { optionTexts: cleanOptions, allowMultiple, showVoters, closesAt };
      }
      await onSubmit(title.trim(), draft, poll, isAdultViewer && markNsfw);
    } catch (e) { setErr(e instanceof Error ? e.message : t("shared.postFailed")); setBusy(false); }
  }

  return (
    <div className="keep-frame rounded border border-dashed border-keep-action/50 bg-keep-banner/40 p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-keep-muted">
          {isPoll ? t("composer.newPoll") : t("composer.newTopic")}
        </p>
        <button
          type="button"
          onClick={() => setIsPoll((v) => !v)}
          aria-pressed={isPoll}
          className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] uppercase tracking-widest ${
            isPoll ? "border-keep-accent text-keep-accent" : "border-keep-rule text-keep-muted hover:text-keep-text"
          }`}
        >
          <BarChart3 className="h-3 w-3" aria-hidden="true" /> {t("composer.poll")}
        </button>
      </div>
      <input
        ref={titleRef}
        data-tour="forum-topic-title-input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={isPoll ? POLL_QUESTION_MAX : 120}
        placeholder={isPoll ? t("composer.askQuestion") : t("composer.topicTitle")}
        className="mb-1.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm font-semibold outline-none focus:border-keep-action"
      />

      {isPoll ? (
        <div className="mb-1.5 space-y-1.5 rounded border border-keep-rule/60 bg-keep-bg/40 p-2">
          {options.map((o, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                value={o}
                onChange={(e) => setOption(i, e.target.value)}
                maxLength={POLL_OPTION_MAX}
                placeholder={t("composer.optionPlaceholder", { number: i + 1 })}
                className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action"
              />
              <button
                type="button"
                onClick={() => removeOption(i)}
                disabled={options.length <= 2}
                title={t("composer.removeOption")}
                aria-label={t("composer.removeOptionAria", { number: i + 1 })}
                className="rounded border border-keep-rule p-1 text-keep-muted hover:text-keep-text disabled:opacity-30"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          ))}
          {options.length < POLL_MAX_OPTIONS ? (
            <button
              type="button"
              onClick={addOption}
              className="inline-flex items-center gap-1 rounded border border-keep-rule px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
            >
              <Plus className="h-3 w-3" aria-hidden="true" /> {t("composer.addOption")}
            </button>
          ) : null}
          <div className="flex flex-wrap gap-3 pt-1 text-xs text-keep-text">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={allowMultiple} onChange={(e) => setAllowMultiple(e.target.checked)} />
              {t("composer.allowMultiple")}
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={showVoters} onChange={(e) => setShowVoters(e.target.checked)} />
              {t("composer.showVoters")}
            </label>
            <label className="flex items-center gap-1.5">
              {t("composer.closeAfter")}
              <input
                value={deadlineHours}
                onChange={(e) => setDeadlineHours(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="∞"
                inputMode="decimal"
                className="w-12 rounded border border-keep-rule bg-keep-bg px-1.5 py-0.5 text-center outline-none focus:border-keep-action"
              />
              {t("composer.hrs")}
            </label>
          </div>
        </div>
      ) : null}

      <FormattingToolbar inputRef={ref} value={draft} onChange={setDraft} disabled={busy} />
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={isPoll ? 2 : 4}
        placeholder={isPoll ? t("composer.introPlaceholder") : t("composer.openingPost")}
        className="mt-1 w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
      />
      {/* NSFW tag (age plan Phase 3) — adult accounts only; under-18
          accounts never see the control at all. */}
      {isAdultViewer ? (
        <label data-tour="forum-composer-tag" className="mt-1.5 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={markNsfw}
            disabled={busy}
            onChange={(e) => setMarkNsfw(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-semibold text-keep-text">{t("nsfw.markLabel")}</span>
            <span className="block text-xs text-keep-muted">
              {t("nsfw.markDesc")}
            </span>
          </span>
        </label>
      ) : null}
      {err ? <p className="mt-1 text-xs text-keep-accent">{err}</p> : null}
      <div className="mt-1.5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-keep-rule px-3 py-1 text-[11px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
        >
          {t("common:cancel")}
        </button>
        <button
          type="button"
          data-tour="forum-composer-post"
          disabled={busy || !title.trim() || !pollReady || (!isPoll && !draft.trim())}
          onClick={() => void go()}
          className="rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
        >
          {busy ? "…" : isPoll ? t("composer.postPoll") : t("composer.postTopic")}
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
  const { t } = useTranslation("forums");
  const setForumNotifUnread = useChat((s) => s.setForumNotifUnread);
  const [rows, setRows] = useState<ForumNotificationWire[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Calm-mode ease: the panel opens BELOW its trigger (top-full), pure CSS
  // positioned, so it slides down gently. Reduce Motion only.
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    let alive = true;
    fetchForumNotifications(40)
      .then((r) => {
        if (!alive) return;
        setRows(r.notifications);
        setForumNotifUnread(r.unread);
      })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : t("shared.loadFailed")); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setForumNotifUnread]);

  function lineKey(kind: ForumNotificationWire["kind"]): string {
    if (kind === "reply") return "notif.replyLine";
    if (kind === "quote") return "notif.quoteLine";
    return "notif.postLine";
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
      <div className={`absolute right-2 top-full z-50 mt-1 w-[22rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-keep-rule bg-keep-bg shadow-2xl${reduceMotion ? " tk-slide-down-in" : ""}`}>
        <div className="flex items-center justify-between border-b border-keep-rule bg-keep-banner/40 px-3 py-1.5">
          <span className="text-xs uppercase tracking-widest text-keep-muted">{t("notif.title")}</span>
          <button
            type="button"
            onClick={() => void markAll()}
            className="rounded border border-keep-rule px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
          >
            {t("notif.markAllRead")}
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {err ? (
            <p className="px-3 py-4 text-xs text-keep-accent">{err}</p>
          ) : !rows ? (
            <p className="px-3 py-4 text-xs italic text-keep-muted">{t("notif.checking")}</p>
          ) : rows.length === 0 ? (
            <p className="px-3 py-4 text-xs italic text-keep-muted">
              {t("notif.empty")}
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
                        <Trans
                          t={t}
                          i18nKey={lineKey(n.kind)}
                          values={{ actor: n.actorName, title: n.topicTitle }}
                          components={{ actor: <b />, topic: <b className="break-words" /> }}
                        />
                      </span>
                      {n.snippet ? (
                        <span className="block truncate text-[11px] text-keep-muted">{n.snippet}</span>
                      ) : null}
                      <span className="block text-[10px] text-keep-muted">
                        {relTime(n.createdAt)}
                        {/* Live forum · board context so the reader knows WHERE
                            the notice lives before clicking; absent when the
                            board was since deleted (snapshot title remains). */}
                        {n.forumName && n.boardName
                          ? <> · {t("notif.context", { forum: n.forumName, board: n.boardName })}</>
                          : null}
                      </span>
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
  const { t } = useTranslation("forums");
  const v = detail.viewer;
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!v || v.ban) return null;

  async function act(fn: () => Promise<void>) {
    setBusy(true); setErr(null);
    try { await fn(); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : t("shared.failed")); }
    finally { setBusy(false); }
  }

  // Members (not the owner) get the leave affordance; owner/staff get nothing.
  if (v.role && !v.canManage) {
    return (
      <div className="flex items-center justify-between gap-2 border-b border-keep-rule bg-keep-panel/20 px-4 py-1.5 text-xs text-keep-muted">
        <span>
          {v.role === "mod" ? t("membership.youAreModerator") : t("membership.youAreMember")}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const parts = [t("membership.leaveConfirm", { name: detail.name })];
            if (v.role === "mod") parts.push(t("membership.leaveModNote"));
            if (detail.postingMode === "application") parts.push(t("membership.leaveReapplyNote"));
            if (!window.confirm(parts.join(" "))) return;
            void act(() => leaveForum(detail.id));
          }}
          className="rounded border border-keep-rule px-2 py-0.5 text-[10px] uppercase tracking-widest hover:text-keep-text"
        >
          {t("membership.leave")}
        </button>
      </div>
    );
  }

  // Open forum, signed-in non-member: offer a one-click Join. Open forums need
  // no membership to read/post PUBLIC sections, but a members-only category or
  // board inside one is members-only to read AND post, and the apply flow
  // rejects open forums — so this is the only way in. Gate on `isMember` (NOT
  // `role`): the default/system forum makes every signed-in user an IMPLICIT
  // member with a null role, so a `!role` check would nag them to join the
  // forum they already belong to. Owner/mods/staff are members too and skip this.
  if (detail.postingMode !== "application" && !v.isMember) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-keep-rule bg-keep-panel/20 px-4 py-1.5 text-xs">
        <span className="text-keep-muted">
          {t("membership.joinPrompt", { name: detail.name })}
        </span>
        <div className="flex items-center gap-2">
          {err ? <span className="text-keep-accent">{err}</span> : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => joinForum(detail.id))}
            className="rounded border border-keep-action bg-keep-action/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/20"
          >
            {t("membership.join")}
          </button>
        </div>
      </div>
    );
  }

  if (detail.postingMode !== "application" || v.canManage || v.canParticipate) return null;

  if (v.membershipPending) {
    return (
      <div className="flex items-center justify-between gap-2 border-b border-keep-rule bg-keep-action/5 px-4 py-1.5 text-xs">
        <span className="text-keep-action">{t("membership.pendingReview")}</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(() => withdrawForumMembership(detail.id))}
          className="rounded border border-keep-rule px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
        >
          {t("membership.withdraw")}
        </button>
      </div>
    );
  }

  return (
    <div className="border-b border-keep-rule bg-keep-panel/20 px-4 py-2">
      {!open ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-keep-muted">
            {t("membership.applyIntro")}
          </p>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded border border-keep-action bg-keep-action/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/20"
          >
            {t("membership.applyToJoin")}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-keep-muted">
            {detail.applicationPrompt?.trim() || t("membership.defaultPrompt")}
          </p>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder={t("membership.answerPlaceholder")}
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
              {busy ? "…" : t("membership.submit")}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded border border-keep-rule px-3 py-1 text-[11px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
            >
              {t("common:cancel")}
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
  // Owners (and managing staff) see the structural tabs (overview/boards/
  // appearance); the moderation tabs surface to a Forum Mod holding the
  // matching granular grant — roles←manage_members, applications←
  // review_applications, bans←ban_users. The server re-checks each action.
  const { t } = useTranslation("forums");
  const setForcedTourId = useChat((s) => s.setForcedTourId);
  const canManage = !!detail.viewer?.canManage;
  const isMod = canManage || detail.viewer?.role === "mod";
  const perms = new Set(detail.viewer?.permissions ?? []);
  type ForumSettingsTab = "overview" | "boards" | "members" | "roles" | "usergroups" | "applications" | "reports" | "prefixes" | "bans" | "modlog" | "appearance";
  const tabs: ForumSettingsTab[] = [
    ...(canManage ? (["overview", "boards"] as const) : []),
    ...(canManage || perms.has("manage_members") ? (["members", "roles"] as const) : []),
    ...(canManage || perms.has("manage_usergroups") ? (["usergroups"] as const) : []),
    ...(canManage || perms.has("review_applications") ? (["applications"] as const) : []),
    ...(canManage || perms.has("handle_reports") ? (["reports"] as const) : []),
    ...(canManage || perms.has("manage_prefixes") ? (["prefixes"] as const) : []),
    ...(canManage || perms.has("ban_users") ? (["bans"] as const) : []),
    ...(isMod ? (["modlog"] as const) : []),
    ...(canManage ? (["appearance"] as const) : []),
  ];
  const [tab, setTab] = useState<ForumSettingsTab>(tabs[0] ?? "modlog");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Calm mode: ease the active settings sub-tab's body in on each tab change.
  // Key + class applied ONLY when Reduce Motion is on; off-path is unchanged.
  const reduceMotion = useReducedMotion();

  async function run(fn: () => Promise<void>) {
    setBusy(true); setErr(null);
    try { await fn(); }
    catch (e) { setErr(e instanceof Error ? e.message : t("shared.saveFailed")); }
    finally { setBusy(false); }
  }

  return (
    <div className="px-4 py-3">
      <div className="mb-3 flex flex-wrap items-center gap-1" data-tour="forum-settings-tab-strip">
        {tabs.map((tabKey) => (
          <button
            key={tabKey}
            type="button"
            data-tour={`forum-settings-tab-${tabKey}`}
            onClick={() => setTab(tabKey)}
            className={`rounded border px-2.5 py-1 text-xs uppercase tracking-widest ${
              tab === tabKey ? "border-keep-action text-keep-action" : "border-keep-rule text-keep-muted hover:text-keep-text"
            }`}
          >
            {t(`settings.tabs.${tabKey}`)}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setForcedTourId("forum-admin")}
          title={t("settings.replayTour")}
          aria-label={t("settings.replayTour")}
          className="ml-auto rounded p-1 text-keep-muted hover:bg-keep-panel hover:text-keep-action"
        >
          <HelpCircle className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {err ? <p className="mb-2 text-xs text-keep-accent">{err}</p> : null}
      {(() => {
        const body = tab === "overview" ? (
          <OverviewSettings detail={detail} busy={busy} run={run} onSaved={onSaved} />
        ) : tab === "boards" ? (
          <BoardsSettings detail={detail} busy={busy} run={run} onSaved={onSaved} onBoardArchived={onBoardArchived} />
        ) : tab === "members" ? (
          <MembersSettings detail={detail} busy={busy} run={run} />
        ) : tab === "roles" ? (
          <RolesSettings detail={detail} busy={busy} run={run} />
        ) : tab === "usergroups" ? (
          <UsergroupsSettings detail={detail} busy={busy} run={run} />
        ) : tab === "applications" ? (
          <ApplicationsSettings detail={detail} busy={busy} run={run} />
        ) : tab === "reports" ? (
          <ReportsSettings detail={detail} busy={busy} run={run} />
        ) : tab === "prefixes" ? (
          <PrefixesSettings detail={detail} busy={busy} run={run} onSaved={onSaved} />
        ) : tab === "modlog" ? (
          <ModLogSettings detail={detail} />
        ) : tab === "appearance" ? (
          <AppearanceSettings detail={detail} busy={busy} run={run} onSaved={onSaved} />
        ) : (
          <BansSettings detail={detail} busy={busy} run={run} />
        );
        // Calm mode only: wrap the sub-tab body in a remount-on-tab-change
        // (key) div carrying `tk-fade-in` so the new tab eases in. When Reduce
        // Motion is off we render the body bare — no extra wrapper, no class —
        // so the DOM is byte-identical to before. (The primary view swap
        // forum/settings/discover keeps its existing room-transition; we
        // don't double up a fade on top of it.)
        return reduceMotion ? <div key={tab} className="tk-fade-in">{body}</div> : body;
      })()}
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
  const { t } = useTranslation("forums");
  const initialTheme = useMemo<Theme | null>(() => {
    if (!detail.themeJson) return null;
    try { return normalizeTheme(JSON.parse(detail.themeJson)); } catch { return null; }
  }, [detail.themeJson]);
  const [theme, setTheme] = useState<Theme | null>(initialTheme);
  const [styleKey, setStyleKey] = useState<string | null>(detail.themeStyleKey);
  const [bannerFocus, setBannerFocus] = useState<number>(detail.bannerFocusY ?? 50);
  const [worlds, setWorlds] = useState<Array<{ id: string; name: string; visibility: string }> | null>(null);
  const [worldId, setWorldId] = useState<string>(detail.linkedWorld?.id ?? "");
  // Servers Lift: the owner's own/manageable chat servers, for the
  // "affiliate this forum" picker. Affiliation scopes topic-card author
  // flair to that server's earned cosmetics; "None" clears it.
  const [servers, setServers] = useState<ServerSummary[] | null>(null);
  const [serverId, setServerId] = useState<string>(detail.affiliatedServer?.id ?? "");

  useEffect(() => {
    let alive = true;
    fetchMyWorlds()
      .then((w) => { if (alive) setWorlds(w.filter((x) => x.visibility !== "private")); })
      .catch(() => { if (alive) setWorlds([]); });
    listServers()
      // Only servers the forum owner owns or admins — the same authority the
      // server-side PATCH re-validates. The currently-affiliated server is
      // kept in the list even if it somehow falls outside that filter so the
      // dropdown never shows a blank current value.
      .then((all) => {
        if (!alive) return;
        const manageable = all.filter(
          (s) => s.viewerRole === "owner" || s.viewerRole === "admin" || s.id === detail.affiliatedServer?.id,
        );
        setServers(manageable);
      })
      .catch(() => { if (alive) setServers([]); });
    return () => { alive = false; };
  }, [detail.affiliatedServer?.id]);

  async function pickImage(kind: "logo" | "banner" | "sfw-banner", file: File) {
    const maxBytes = kind === "logo" ? 512 * 1024 : 2 * 1024 * 1024;
    await run(async () => {
      const dataUrl = await readImageFile(file, maxBytes);
      await setForumImage(detail.id, kind, dataUrl);
      onSaved();
    });
  }
  // The public-safe banner slot only matters for an 18+ forum (a SFW forum's
  // regular banner must already be safe for everyone), and under-18 viewers
  // never see 18+ controls. Cosmetic mirror; the route re-checks.
  const isAdultViewer = useChat((s) => s.viewerAge.isAdult);

  const themeDirty = JSON.stringify(theme) !== JSON.stringify(initialTheme);
  const styleDirty = styleKey !== detail.themeStyleKey;
  const focusDirty = bannerFocus !== (detail.bannerFocusY ?? 50);
  const worldDirty = worldId !== (detail.linkedWorld?.id ?? "");
  const serverDirty = serverId !== (detail.affiliatedServer?.id ?? "");

  return (
    <div className="max-w-xl space-y-4">
      <section>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("appearance.images")}</p>
        <div className="space-y-2 rounded border border-keep-rule bg-keep-panel/20 p-2.5">
          {(["logo", "banner"] as const).map((kind) => {
            const current = kind === "logo" ? detail.logoUrl : detail.bannerImageUrl;
            return (
              <div key={kind} className="flex flex-wrap items-center gap-2">
                <span className="w-16 text-xs uppercase tracking-widest text-keep-muted">{t(`appearance.imageKind.${kind}`)}</span>
                {current ? (
                  <img src={current} alt="" className={kind === "logo" ? "h-8 w-8 rounded border border-keep-rule object-cover" : "h-8 w-20 rounded border border-keep-rule object-cover"} />
                ) : (
                  <span className="text-xs italic text-keep-muted">{t("shared.noneLower")}</span>
                )}
                <label className="cursor-pointer rounded border border-keep-rule px-2 py-1 text-[11px] uppercase tracking-widest text-keep-muted hover:text-keep-text">
                  {t("shared.upload")}
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
                  >{t("common:clear")}</button>
                ) : null}
                <span className="text-[10px] text-keep-muted">{kind === "logo" ? t("appearance.logoSize") : t("appearance.bannerSize")}</span>
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
                <span className="text-[10px] uppercase tracking-widest text-keep-muted">{t("appearance.focus")}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={bannerFocus}
                  onChange={(e) => setBannerFocus(Number(e.target.value))}
                  disabled={busy}
                  className="min-w-0 flex-1 accent-[rgb(var(--keep-action))]"
                  aria-label={t("appearance.focusAria")}
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
                    {t("common:save")}
                  </button>
                ) : null}
              </div>
              <p className="text-[10px] text-keep-muted">
                {t("appearance.focusHint")}
              </p>
            </div>
          ) : null}
        </div>
      </section>

      {/* Public-safe banner (age plan Phase 3, decision #10): only offered
          on an 18+ forum — a SFW forum's regular banner must already be safe
          for everyone — and never shown to under-18 viewers. Same slot the
          18+ servers carry, riding the forum image upload pipeline. */}
      {isAdultViewer && (detail.isNsfw ?? false) ? (
        <section>
          <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("appearance.publicBanner")}</p>
          <div className="space-y-2 rounded border border-keep-rule bg-keep-panel/20 p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              {detail.sfwBannerUrl ? (
                <img src={detail.sfwBannerUrl} alt="" className="h-8 w-20 rounded border border-keep-rule object-cover" />
              ) : (
                <span className="text-xs italic text-keep-muted">{t("shared.noneLower")}</span>
              )}
              <label className="cursor-pointer rounded border border-keep-rule px-2 py-1 text-[11px] uppercase tracking-widest text-keep-muted hover:text-keep-text">
                {t("shared.upload")}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden"
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void pickImage("sfw-banner", f);
                  }}
                />
              </label>
              {detail.sfwBannerUrl ? (
                <button
                  type="button" disabled={busy}
                  onClick={() => void run(async () => { await setForumImage(detail.id, "sfw-banner", null); onSaved(); })}
                  className="rounded border border-keep-accent/60 px-2 py-1 text-[11px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10"
                >{t("common:clear")}</button>
              ) : null}
              <span className="text-[10px] text-keep-muted">{t("appearance.bannerSize")}</span>
            </div>
            <p className="text-[10px] text-keep-muted">
              {t("appearance.publicBannerHint")}
            </p>
          </div>
        </section>
      ) : null}

      <section>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("appearance.theme")}</p>
        <p className="mb-2 text-[11px] text-keep-muted">
          {t("appearance.themeHint")}
        </p>
        {theme === null ? (
          <button
            type="button"
            onClick={() => setTheme(DEFAULT_THEME)}
            className="rounded border border-keep-rule bg-keep-banner px-2 py-1 text-xs hover:bg-keep-banner/80"
          >
            {t("appearance.addTheme")}
          </button>
        ) : (
          <>
            <ThemePicker theme={theme} onChange={(next) => setTheme(next)} onReset={() => setTheme(DEFAULT_THEME)} />
            <button
              type="button"
              onClick={() => setTheme(null)}
              className="mt-2 rounded border border-keep-accent/40 bg-keep-bg px-2 py-1 text-[11px] text-keep-accent hover:bg-keep-accent/10"
            >
              {t("appearance.removeTheme")}
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
            {t("appearance.saveTheme")}
          </button>
        ) : null}
      </section>

      <section>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("appearance.designStyle")}</p>
        <p className="mb-2 text-[11px] text-keep-muted">
          {t("appearance.designStyleHint")}
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
            {t("appearance.saveStyle")}
          </button>
        ) : null}
      </section>

      <section>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("appearance.linkedWorld")}</p>
        <p className="mb-2 text-[11px] text-keep-muted">
          {t("appearance.linkedWorldHint")}
        </p>
        <div className="flex gap-2">
          <select
            value={worldId}
            onChange={(e) => setWorldId(e.target.value)}
            disabled={!worlds}
            className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
          >
            <option value="">{t("appearance.noWorld")}</option>
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
            {t("common:save")}
          </button>
        </div>
      </section>

      <section>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("appearance.affiliatedServer")}</p>
        <p className="mb-2 text-[11px] text-keep-muted">
          {t("appearance.affiliatedServerHint")}
        </p>
        <div className="flex gap-2">
          <select
            value={serverId}
            onChange={(e) => setServerId(e.target.value)}
            disabled={!servers}
            className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
          >
            <option value="">{t("shared.none")}</option>
            {(servers ?? []).map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || !serverDirty}
            onClick={() => void run(async () => {
              await updateForum(detail.id, { serverId: serverId || null });
              onSaved();
            })}
            className="rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
          >
            {t("common:save")}
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
  const { t } = useTranslation("forums");
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
          {t("applications.openNote")}
        </p>
      ) : null}
      <div>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">
          {t("applications.pending")} {pending ? `(${pending.length})` : ""}
        </p>
        {!pending ? (
          <p className="text-sm italic text-keep-muted">{t("common:loading")}</p>
        ) : pending.length === 0 ? (
          <p className="text-xs italic text-keep-muted">{t("applications.noneWaiting")}</p>
        ) : (
          <ul className="space-y-1.5">
            {pending.map((a) => (
              <li key={a.id} className="rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-keep-text">{a.applicantUsername}</span>
                  <span className="text-[10px] text-keep-muted">{formatDateTime(a.submittedAt)}</span>
                </div>
                {a.answer ? (
                  <p className="mt-1 whitespace-pre-wrap text-xs text-keep-text/90">{a.answer}</p>
                ) : (
                  <p className="mt-1 text-xs italic text-keep-muted">{t("applications.noAnswer")}</p>
                )}
                <div className="mt-1.5 flex gap-2">
                  <button
                    type="button" disabled={busy}
                    onClick={() => void run(async () => {
                      await reviewForumMembershipApplication(detail.id, a.id, "approve");
                      setTick((t) => t + 1);
                    })}
                    className="rounded border border-keep-action bg-keep-action/15 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-keep-action disabled:opacity-50"
                  >{t("applications.approve")}</button>
                  <button
                    type="button" disabled={busy}
                    onClick={() => {
                      const v = window.prompt(t("applications.declinePrompt", { name: a.applicantUsername }), "");
                      if (v === null) return;
                      void run(async () => {
                        await reviewForumMembershipApplication(detail.id, a.id, "reject", v.trim() || undefined);
                        setTick((n) => n + 1);
                      });
                    }}
                    className="rounded border border-keep-accent/60 bg-keep-accent/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-keep-accent disabled:opacity-50"
                  >{t("applications.decline")}</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {recent.length > 0 ? (
        <div>
          <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("applications.recentDecisions")}</p>
          <ul className="space-y-0.5">
            {recent.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 rounded border border-keep-rule/50 px-2 py-0.5 text-[11px] text-keep-muted">
                <span className={a.status === "approved" ? "font-semibold uppercase text-keep-action" : "font-semibold uppercase text-keep-accent"}>{a.status}</span>
                <span className="text-keep-text">{a.applicantUsername}</span>
                {a.reviewedByUsername ? <span>{t("shared.byName", { name: a.reviewedByUsername })}</span> : null}
                {a.reviewedAt ? <span>· {formatDate(a.reviewedAt)}</span> : null}
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
/** Checkbox grid for the granular forum-mod permissions. Keys the acting
 *  manager doesn't hold are disabled (a non-owner manager can't grant what
 *  they lack — mirrors the server's anti-escalation clamp). */
function PermissionCheckboxes({ value, onChange, grantable, disabled }: {
  value: ForumModPermission[];
  onChange: (next: ForumModPermission[]) => void;
  /** The set this manager is allowed to grant (owner = every key). */
  grantable: Set<ForumModPermission>;
  disabled?: boolean;
}) {
  const { t } = useTranslation("forums");
  const has = new Set(value);
  return (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
      {FORUM_MOD_PERMISSIONS.map((key) => {
        const meta = FORUM_MOD_PERMISSION_META[key];
        const canGrant = grantable.has(key);
        return (
          <label
            key={key}
            title={canGrant ? meta.description : t("permGrid.cantGrant")}
            className={`flex items-start gap-2 rounded border border-keep-rule/60 px-2 py-1 text-xs ${canGrant ? "" : "opacity-50"}`}
          >
            <input
              type="checkbox"
              className="mt-0.5"
              checked={has.has(key)}
              disabled={disabled || !canGrant}
              onChange={(e) => {
                const next = new Set(value);
                if (e.target.checked) next.add(key); else next.delete(key);
                onChange([...next]);
              }}
            />
            <span className="min-w-0">
              <span className="block text-keep-text">{meta.label}</span>
              <span className="block text-[10px] text-keep-muted">{meta.description}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** Full-registry permission grid (moderation + member features), grouped, for
 *  usergroups. Keys the manager doesn't hold are greyed out. */
function ForumPermissionCheckboxes({ value, onChange, grantable, disabled }: {
  value: ForumPermission[];
  onChange: (next: ForumPermission[]) => void;
  grantable: Set<ForumPermission>;
  disabled?: boolean;
}) {
  const { t } = useTranslation("forums");
  const has = new Set(value);
  const sections: { title: string; keys: ForumPermission[] }[] = [
    { title: t("permGrid.memberFeatures"), keys: FORUM_PERMISSIONS.filter((k) => forumPermissionCategory(k) === "feature") },
    { title: t("permGrid.moderation"), keys: FORUM_PERMISSIONS.filter((k) => forumPermissionCategory(k) === "moderation") },
  ];
  function toggle(key: ForumPermission, on: boolean) {
    const next = new Set(value);
    if (on) next.add(key); else next.delete(key);
    onChange([...next]);
  }
  return (
    <div className="space-y-2">
      {sections.map((sec) => (
        <div key={sec.title}>
          <p className="mb-0.5 text-[10px] uppercase tracking-widest text-keep-muted">{sec.title}</p>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {sec.keys.map((key) => {
              const meta = FORUM_PERMISSION_META[key];
              const canGrant = grantable.has(key);
              return (
                <label
                  key={key}
                  title={canGrant ? meta.description : t("permGrid.cantGrant")}
                  className={`flex items-start gap-2 rounded border border-keep-rule/60 px-2 py-1 text-xs ${canGrant ? "" : "opacity-50"}`}
                >
                  <input type="checkbox" className="mt-0.5" checked={has.has(key)} disabled={disabled || !canGrant}
                    onChange={(e) => toggle(key, e.target.checked)} />
                  <span className="min-w-0">
                    <span className="block text-keep-text">{meta.label}</span>
                    <span className="block text-[10px] text-keep-muted">{meta.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Editor for a group's auto-join rules (members who meet EVERY rule join). */
function AutoRulesEditor({ detail, rules, onChange, disabled }: {
  detail: ForumDetail;
  rules: ForumAutoRule[];
  onChange: (next: ForumAutoRule[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("forums");
  const kinds: ForumAutoRuleKind[] = ["post_count", "topic_count", "posted_in_category", "account_age_days", "member_age_days"];
  function update(i: number, rule: ForumAutoRule) { const next = rules.slice(); next[i] = rule; onChange(next); }
  function changeKind(i: number, kind: ForumAutoRuleKind, prev: ForumAutoRule) {
    if (kind === "posted_in_category") update(i, { kind, categoryId: detail.categories[0]?.id ?? "" });
    else update(i, { kind, min: "min" in prev ? prev.min : 1 });
  }
  return (
    <div className="space-y-1.5">
      {rules.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1.5 rounded border border-keep-rule/60 px-2 py-1">
          <select value={r.kind} disabled={disabled} onChange={(e) => changeKind(i, e.target.value as ForumAutoRuleKind, r)}
            className="rounded border border-keep-rule bg-keep-bg px-1.5 py-1 text-xs outline-none focus:border-keep-action">
            {kinds.map((k) => <option key={k} value={k}>{FORUM_AUTO_RULE_META[k].label}</option>)}
          </select>
          {r.kind === "posted_in_category" ? (
            <select value={r.categoryId} disabled={disabled} onChange={(e) => update(i, { kind: "posted_in_category", categoryId: e.target.value })}
              className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-1.5 py-1 text-xs outline-none focus:border-keep-action">
              {detail.categories.length === 0 ? <option value="">{t("autoRules.noCategories")}</option> :
                detail.categories.map((c) => <option key={c.id} value={c.id}>{detail.boards.length > 1 ? `${c.boardName} / ` : ""}{c.name}</option>)}
            </select>
          ) : (
            <>
              <input type="number" min={1} value={r.min} disabled={disabled}
                onChange={(e) => update(i, { kind: r.kind, min: Math.max(1, parseInt(e.target.value || "1", 10) || 1) })}
                className="w-20 rounded border border-keep-rule bg-keep-bg px-1.5 py-1 text-xs outline-none focus:border-keep-action" />
              <span className="text-[10px] text-keep-muted">{FORUM_AUTO_RULE_META[r.kind].unit}</span>
            </>
          )}
          <button type="button" disabled={disabled} onClick={() => onChange(rules.filter((_, j) => j !== i))}
            className="ml-auto shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10">{t("shared.remove")}</button>
        </div>
      ))}
      <button type="button" disabled={disabled || rules.length >= FORUM_MAX_AUTO_RULES}
        onClick={() => onChange([...rules, { kind: "post_count", min: 10 }])}
        className="rounded border border-keep-rule px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:border-keep-action hover:text-keep-action disabled:opacity-50">{t("autoRules.addRule")}</button>
    </div>
  );
}

/** Manual roster for one (non-default) usergroup: add via picker, remove. */
function UsergroupMembers({ detail, group, busy, run }: {
  detail: ForumDetail;
  group: ForumUsergroupWire;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { t } = useTranslation("forums");
  const [members, setMembers] = useState<ForumUsergroupMemberWire[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    fetchForumUsergroupMembers(detail.id, group.id).then((m) => { if (alive) setMembers(m); }).catch(() => { if (alive) setMembers([]); });
    return () => { alive = false; };
  }, [detail.id, group.id, tick]);
  return (
    <div className="border-t border-keep-rule/60 pt-3">
      <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("usergroups.membersHeading")} ({members?.length ?? "…"})</p>
      <p className="mb-2 text-[10px] text-keep-muted">{t("usergroups.addByHand")}</p>
      <div className="mb-2">
        <UserLookupPicker
          forumId={detail.id}
          placeholder={t("usergroups.addMemberPlaceholder")}
          onSelect={(hit) => void run(async () => { await addForumUsergroupMember(detail.id, group.id, `@id:${hit.userId}`); setTick((t) => t + 1); })}
        />
      </div>
      {members && members.length > 0 ? (
        <ul className="space-y-1">
          {members.map((m) => (
            <li key={m.userId} className="flex items-center gap-2 rounded border border-keep-rule/60 px-2 py-1 text-xs">
              <span className="min-w-0 flex-1 truncate text-keep-text">{m.username}</span>
              {m.isAuto ? <span className="shrink-0 rounded border border-keep-rule px-1 text-[9px] uppercase tracking-widest text-keep-muted">{t("usergroups.autoChip")}</span> : null}
              <button type="button" disabled={busy}
                onClick={() => void run(async () => { await removeForumUsergroupMember(detail.id, group.id, m.userId); setTick((n) => n + 1); })}
                className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10">{t("shared.remove")}</button>
            </li>
          ))}
        </ul>
      ) : members ? <p className="text-[11px] italic text-keep-muted">{t("usergroups.noMembers")}</p> : null}
    </div>
  );
}

/** Create / edit one usergroup: name + color, the permission grid, auto-rules
 *  (non-default), and the manual roster (existing non-default groups). */
function UsergroupEditor({ detail, group, grantable, busy, run, onClose, onSaved }: {
  detail: ForumDetail;
  group: ForumUsergroupWire | null;
  grantable: Set<ForumPermission>;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation("forums");
  const isDefault = !!group?.isDefault;
  const [name, setName] = useState(group?.name ?? "");
  const [color, setColor] = useState(group?.color ?? "");
  const [perms, setPerms] = useState<ForumPermission[]>(group?.permissions ?? [...FORUM_FEATURE_PERMISSIONS]);
  const [rules, setRules] = useState<ForumAutoRule[]>(group?.autoRules ?? []);

  function save() {
    void run(async () => {
      const payload = { name: name.trim(), color: color.trim() || null, permissions: perms, ...(isDefault ? {} : { autoRules: rules }) };
      if (group) await updateForumUsergroup(detail.id, group.id, payload);
      else await createForumUsergroup(detail.id, payload);
      onSaved();
    });
  }

  return (
    <div className="max-w-2xl space-y-3">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onClose} className="rounded border border-keep-rule px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text">{t("usergroups.back")}</button>
        <h3 className="text-sm font-semibold text-keep-text">{group ? (isDefault ? t("usergroups.defaultGroup") : t("usergroups.editGroup", { name: group.name })) : t("usergroups.newGroup")}</h3>
      </div>

      {isDefault ? (
        <p className="text-[11px] text-keep-muted">{t("usergroups.defaultHint")}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input type="color" value={color || "#8a66cc"} onChange={(e) => setColor(e.target.value)} title={t("usergroups.groupColor")} className="h-7 w-9 shrink-0 cursor-pointer rounded border border-keep-rule bg-transparent" />
          <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder={t("usergroups.groupNamePlaceholder")} className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
        </div>
      )}

      <div>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("usergroups.permissions")}</p>
        <ForumPermissionCheckboxes value={perms} grantable={grantable} disabled={busy} onChange={setPerms} />
      </div>

      {!isDefault ? (
        <div>
          <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("usergroups.autoJoinRules")}</p>
          <p className="mb-1 text-[10px] text-keep-muted">{t("usergroups.autoJoinHint")}</p>
          <AutoRulesEditor detail={detail} rules={rules} disabled={busy} onChange={setRules} />
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded border border-keep-rule px-3 py-1 text-xs hover:bg-keep-banner">{t("common:cancel")}</button>
        <button type="button" disabled={busy || (!isDefault && !name.trim())} onClick={save}
          className="rounded border border-keep-action bg-keep-action px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">{group ? t("common:save") : t("shared.create")}</button>
      </div>

      {group && !isDefault ? <UsergroupMembers detail={detail} group={group} busy={busy} run={run} /> : null}
    </div>
  );
}

function UsergroupsSettings({ detail, busy, run }: {
  detail: ForumDetail;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { t } = useTranslation("forums");
  const [data, setData] = useState<ForumUsergroupsResponse | null>(null);
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState<ForumUsergroupWire | "new" | null>(null);

  useEffect(() => {
    let alive = true;
    fetchForumUsergroups(detail.id).then((d) => { if (alive) setData(d); }).catch(() => { if (alive) setData(null); });
    return () => { alive = false; };
  }, [detail.id, tick]);

  const grantable = useMemo(() => new Set(data?.managerPermissions ?? []), [data?.managerPermissions]);

  if (!data) return <p className="text-sm italic text-keep-muted">{t("common:loading")}</p>;

  if (editing) {
    return (
      <UsergroupEditor
        detail={detail}
        group={editing === "new" ? null : editing}
        grantable={grantable}
        busy={busy}
        run={run}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); setTick((t) => t + 1); }}
      />
    );
  }

  return (
    <div className="max-w-2xl space-y-3">
      <p className="text-[11px] text-keep-muted">
        {t("usergroups.intro")}
      </p>
      <ul className="space-y-1.5">
        {data.groups.map((g) => (
          <li key={g.id} className="rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5">
            <div className="flex items-center gap-2">
              <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
                {g.color ? <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: g.color }} /> : null}
                <span className="truncate text-sm font-semibold text-keep-text">{g.name}</span>
                {g.isDefault ? <span className="shrink-0 rounded border border-keep-rule px-1 text-[9px] uppercase tracking-widest text-keep-muted">{t("usergroups.defaultChip")}</span> : null}
              </span>
              <span className="shrink-0 text-[10px] text-keep-muted">
                {t("usergroups.permCount", { count: g.permissions.length })}
                {g.isDefault
                  ? ` · ${t("usergroups.everyone")}`
                  : ` · ${t("shared.memberCount", { count: g.memberCount })}${g.autoRules.length ? ` · ${t("usergroups.ruleCount", { count: g.autoRules.length })}` : ""}`}
              </span>
              <button type="button" disabled={busy} onClick={() => setEditing(g)}
                className="shrink-0 rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:border-keep-action hover:text-keep-action">{t("shared.edit")}</button>
              {!g.isDefault ? (
                <button type="button" disabled={busy}
                  onClick={() => { if (window.confirm(t("usergroups.deleteConfirm", { name: g.name }))) void run(async () => { await deleteForumUsergroup(detail.id, g.id); setTick((n) => n + 1); }); }}
                  className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10">{t("common:delete")}</button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <button type="button" disabled={busy} onClick={() => setEditing("new")}
        className="rounded border border-keep-action bg-keep-action/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-action disabled:opacity-50">{t("usergroups.newGroupButton")}</button>
    </div>
  );
}

function RolesSettings({ detail, busy, run }: {
  detail: ForumDetail;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { t } = useTranslation("forums");
  const [roles, setRoles] = useState<ForumRoles | null>(null);
  const [tick, setTick] = useState(0);
  // Selected user from the picker, awaiting permission choices + Appoint.
  const [pendingHit, setPendingHit] = useState<ForumUserSearchHit | null>(null);
  const [pendingPerms, setPendingPerms] = useState<ForumModPermission[]>(FORUM_MOD_DEFAULT_PERMISSIONS);
  // Which existing mod's permission editor is expanded.
  const [editingUserId, setEditingUserId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchForumRoles(detail.id).then((r) => { if (alive) setRoles(r); }).catch(() => { if (alive) setRoles(null); });
    return () => { alive = false; };
  }, [detail.id, tick]);

  const grantable = useMemo(
    () => new Set(roles?.managerPermissions ?? []),
    [roles?.managerPermissions],
  );

  return (
    <div className="max-w-2xl space-y-4">
      {!roles ? (
        <p className="text-sm italic text-keep-muted">{t("common:loading")}</p>
      ) : (
        <>
          <p className="text-sm text-keep-text">
            <span className="text-xs uppercase tracking-widest text-keep-muted">{t("shared.keeper")}</span>{" "}
            <span className="font-semibold">{roles.owner.username}</span>
            <span className="ml-1 text-[10px] text-keep-muted">{t("roles.everyPower")}</span>
          </p>

          <div>
            <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">
              {t("roles.forumModerators")} ({roles.mods.length})
            </p>
            {roles.mods.length === 0 ? (
              <p className="text-xs italic text-keep-muted">
                {t("roles.noneYet")}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {roles.mods.map((m: ForumModEntry) => (
                  <li key={m.userId} className="rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm text-keep-text">{m.username}</span>
                      <span className="shrink-0 text-[10px] text-keep-muted">
                        {t("roles.powerCount", { count: m.permissions.length })} · {t("roles.sinceDate", { date: formatDate(m.since) })}
                      </span>
                      <button
                        type="button" disabled={busy}
                        onClick={() => setEditingUserId((id) => (id === m.userId ? null : m.userId))}
                        className="shrink-0 rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:border-keep-action hover:text-keep-action"
                      >{editingUserId === m.userId ? t("roles.done") : t("shared.edit")}</button>
                      <button
                        type="button" disabled={busy}
                        onClick={() => {
                          if (!window.confirm(t("roles.removeModConfirm", { name: m.username }))) return;
                          void run(async () => { await revokeForumMod(detail.id, m.userId); setTick((n) => n + 1); });
                        }}
                        className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10"
                      >{t("shared.remove")}</button>
                    </div>
                    {editingUserId === m.userId ? (
                      <div className="mt-2 border-t border-keep-rule/60 pt-2">
                        <PermissionCheckboxes
                          value={m.permissions}
                          grantable={grantable}
                          disabled={busy}
                          onChange={(next) => void run(async () => {
                            await setForumModPermissions(detail.id, m.userId, next);
                            setTick((t) => t + 1);
                          })}
                        />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Appoint flow: pick a user, choose powers, confirm. */}
          <div className="rounded border border-keep-rule p-3">
            <p className="mb-2 text-xs uppercase tracking-widest text-keep-muted">{t("roles.appointHeading")}</p>
            {!pendingHit ? (
              <UserLookupPicker
                forumId={detail.id}
                placeholder={t("roles.searchPlaceholder")}
                disabledReason={(hit) =>
                  hit.forumRole === "owner" ? t("shared.theKeeper")
                    : hit.forumRole === "mod" ? t("roles.reasonAlreadyMod")
                    : hit.banned ? t("roles.reasonBanned")
                    : null}
                onSelect={(hit) => {
                  setPendingHit(hit);
                  // Default grant, clamped to what this manager may give.
                  setPendingPerms(FORUM_MOD_DEFAULT_PERMISSIONS.filter((p) => grantable.has(p)));
                }}
              />
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-keep-text">
                  <Trans t={t} i18nKey="roles.appointName" values={{ name: pendingHit.username }} components={{ b: <span className="font-semibold" /> }} />
                  {pendingHit.characterNames.length > 0 ? (
                    <span className="text-[10px] text-keep-muted"> ({pendingHit.characterNames.join(", ")})</span>
                  ) : null}
                </p>
                <PermissionCheckboxes value={pendingPerms} grantable={grantable} disabled={busy} onChange={setPendingPerms} />
                <div className="flex justify-end gap-2">
                  <button
                    type="button" disabled={busy}
                    onClick={() => setPendingHit(null)}
                    className="rounded border border-keep-rule px-3 py-1 text-xs hover:bg-keep-banner"
                  >{t("common:cancel")}</button>
                  <button
                    type="button" disabled={busy}
                    onClick={() => void run(async () => {
                      await grantForumMod(detail.id, `@id:${pendingHit.userId}`, pendingPerms);
                      setPendingHit(null);
                      setTick((n) => n + 1);
                    })}
                    className="rounded border border-keep-action bg-keep-action px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
                  >{t("roles.appoint")}</button>
                </div>
              </div>
            )}
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
  const { t } = useTranslation("forums");
  const [bans, setBans] = useState<ForumBanRow[] | null>(null);
  const [targetHit, setTargetHit] = useState<ForumUserSearchHit | null>(null);
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
        {t("bans.intro")}
      </p>
      {!bans ? (
        <p className="text-sm italic text-keep-muted">{t("common:loading")}</p>
      ) : bans.length === 0 ? (
        <p className="text-xs italic text-keep-muted">{t("bans.noBans")}</p>
      ) : (
        <ul className="space-y-1">
          {bans.map((b) => (
            <li key={b.userId} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1 text-sm">
              <span className="font-semibold text-keep-text">{b.username}</span>
              <span className={`text-[11px] ${b.expired ? "text-keep-muted line-through" : "text-keep-muted"}`}>
                {b.until ? t("bans.untilDate", { date: formatDate(b.until) }) : t("bans.permanentLower")}
                {b.expired ? t("bans.expiredSuffix") : ""}
              </span>
              {b.reason ? <span className="min-w-0 flex-1 truncate text-[11px] italic text-keep-muted">"{b.reason}"</span> : <span className="flex-1" />}
              <button
                type="button" disabled={busy}
                onClick={() => void run(async () => { await liftForumBan(detail.id, b.userId); setTick((n) => n + 1); })}
                className="rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
              >{t("shared.lift")}</button>
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-2 rounded border border-keep-rule bg-keep-panel/20 p-2.5">
        {!targetHit ? (
          <UserLookupPicker
            forumId={detail.id}
            placeholder={t("bans.searchPlaceholder")}
            disabledReason={(hit) =>
              hit.forumRole === "owner" ? t("shared.theKeeper")
                : hit.banned ? t("bans.reasonAlreadyBanned")
                : null}
            onSelect={setTargetHit}
          />
        ) : (
          <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm">
            <span className="min-w-0 flex-1 truncate text-keep-text">
              {targetHit.username}
              {targetHit.characterNames.length > 0 ? (
                <span className="text-[10px] text-keep-muted"> ({targetHit.characterNames.join(", ")})</span>
              ) : null}
            </span>
            <button
              type="button"
              onClick={() => setTargetHit(null)}
              className="shrink-0 rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
            >{t("shared.change")}</button>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <select
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
          >
            <option value="24">{t("duration.day1")}</option>
            <option value="168">{t("duration.days7")}</option>
            <option value="720">{t("duration.days30")}</option>
            <option value="perm">{t("duration.permanent")}</option>
          </select>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={300}
            placeholder={t("shared.reasonPlaceholder")}
            className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
          />
          <button
            type="button"
            disabled={busy || !targetHit}
            onClick={() => {
              if (!targetHit) return;
              const confirmText = hours === "perm"
                ? t("bans.confirmPermanent", { name: targetHit.username, forum: detail.name })
                : t("bans.confirmTimed", {
                    name: targetHit.username,
                    forum: detail.name,
                    duration: hours === "24" ? t("duration.day1") : hours === "168" ? t("duration.days7") : t("duration.days30"),
                  });
              if (!window.confirm(confirmText)) return;
              void run(async () => {
                await banFromForum(detail.id, {
                  target: `@id:${targetHit.userId}`,
                  hours: hours === "perm" ? null : parseInt(hours, 10),
                  ...(reason.trim() ? { reason: reason.trim() } : {}),
                });
                setTargetHit(null); setReason("");
                setTick((n) => n + 1);
              });
            }}
            className="rounded border border-keep-system/70 bg-keep-system/15 px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-system disabled:opacity-50"
          >
            {t("shared.ban")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Members directory: every member of the forum (owner + mods + members)
 * with inline manage actions — promote a member to mod, remove a member.
 * Mods are demoted from the Roles tab; the owner can't be removed.
 */
function MembersSettings({ detail, busy, run }: {
  detail: ForumDetail;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { t } = useTranslation("forums");
  const [members, setMembers] = useState<ForumMemberEntry[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    fetchForumMembers(detail.id).then((m) => { if (alive) setMembers(m); }).catch(() => { if (alive) setMembers([]); });
    return () => { alive = false; };
  }, [detail.id, tick]);

  const roleLabel = (m: ForumMemberEntry) =>
    m.role === "owner" ? t("shared.keeper")
      : m.role === "mod" ? t("roles.moderatorPowers", { count: m.permissions.length })
      : t("shared.member");

  return (
    <div className="max-w-2xl space-y-3">
      {!members ? (
        <p className="text-sm italic text-keep-muted">{t("common:loading")}</p>
      ) : (
        <>
          <p className="text-xs uppercase tracking-widest text-keep-muted">{t("usergroups.membersHeading")} ({members.length})</p>
          <ul className="space-y-1">
            {members.map((m) => (
              <li key={m.userId} className="flex items-center gap-2 rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5">
                {m.avatarUrl ? (
                  <img src={m.avatarUrl} alt="" className="h-7 w-7 shrink-0 rounded-full border border-keep-rule object-cover" referrerPolicy="no-referrer" />
                ) : (
                  <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-keep-rule bg-keep-banner text-[9px] uppercase text-keep-muted">{m.username.slice(0, 2)}</span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-keep-text">{m.username}</span>
                  <span className="block text-[10px] text-keep-muted">{roleLabel(m)} · {t("members.joinedDate", { date: formatDate(m.joinedAt) })}</span>
                </span>
                {m.role === "member" ? (
                  <>
                    <button
                      type="button" disabled={busy}
                      onClick={() => void run(async () => {
                        await grantForumMod(detail.id, `@id:${m.userId}`);
                        setTick((n) => n + 1);
                      })}
                      title={t("members.makeModTitle")}
                      className="shrink-0 rounded border border-keep-action/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-action hover:bg-keep-action/10"
                    >{t("members.makeMod")}</button>
                    <button
                      type="button" disabled={busy}
                      onClick={() => {
                        if (!window.confirm(t("members.removeConfirm", { name: m.username, forum: detail.name }))) return;
                        void run(async () => { await removeForumMember(detail.id, m.userId); setTick((n) => n + 1); });
                      }}
                      className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10"
                    >{t("shared.remove")}</button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
          {members.length === 1 ? (
            <p className="text-xs italic text-keep-muted">
              {t("members.emptyBeyondYou")}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Human label + tint for a Mod Log action. */
function modLogLabel(action: string, meta: Record<string, unknown> | null, t: (key: string) => string): { text: string; tone: string } {
  const m = meta ?? {};
  switch (action) {
    case "forum_topic_lock": return { text: m.locked ? t("modlog.lockedTopic") : t("modlog.unlockedTopic"), tone: "text-keep-system" };
    case "forum_topic_sticky": return { text: m.sticky ? t("modlog.pinnedTopic") : t("modlog.unpinnedTopic"), tone: "text-keep-accent" };
    case "forum_topic_move": return { text: t("modlog.movedTopic"), tone: "text-keep-muted" };
    case "forum_post_delete": return { text: m.isTopic ? t("modlog.deletedTopic") : t("modlog.deletedPost"), tone: "text-keep-accent" };
    case "forum_ban": return { text: t("modlog.bannedUser"), tone: "text-keep-system" };
    case "forum_unban": return { text: t("modlog.liftedBan"), tone: "text-keep-muted" };
    case "forum_mod_grant": return { text: t("modlog.appointedMod"), tone: "text-keep-action" };
    case "forum_mod_revoke": return { text: t("modlog.removedMod"), tone: "text-keep-muted" };
    case "forum_mod_perms": return { text: t("modlog.changedModPowers"), tone: "text-keep-muted" };
    case "forum_member_remove": return { text: t("modlog.removedMember"), tone: "text-keep-muted" };
    case "forum_board_create": return { text: t("modlog.createdBoard"), tone: "text-keep-action" };
    case "forum_board_archive": return { text: t("modlog.archivedBoard"), tone: "text-keep-muted" };
    default: return { text: action.replace(/^forum_/, "").replace(/_/g, " "), tone: "text-keep-muted" };
  }
}

/** Read-only moderation history for the forum (owner + any mod). */
function ModLogSettings({ detail }: { detail: ForumDetail }) {
  const { t } = useTranslation("forums");
  const [entries, setEntries] = useState<ForumModLogEntry[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetchForumModLog(detail.id).then((e) => { if (alive) setEntries(e); }).catch(() => { if (alive) setEntries([]); });
    return () => { alive = false; };
  }, [detail.id]);

  return (
    <div className="max-w-2xl space-y-2">
      <p className="text-[11px] text-keep-muted">
        {t("modlog.intro")}
      </p>
      {!entries ? (
        <p className="text-sm italic text-keep-muted">{t("common:loading")}</p>
      ) : entries.length === 0 ? (
        <p className="text-xs italic text-keep-muted">{t("modlog.empty")}</p>
      ) : (
        <ul className="space-y-1">
          {entries.map((e) => {
            const { text, tone } = modLogLabel(e.action, e.metadata, t);
            const title = typeof e.metadata?.title === "string" ? e.metadata.title : null;
            return (
              <li key={e.id} className="rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5 text-xs">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className={`font-semibold ${tone}`}>{text}</span>
                  {e.targetUsername ? <span className="text-keep-muted">→ {e.targetUsername}</span> : null}
                  <span className="ml-auto text-[10px] text-keep-muted">{formatDateTime(e.createdAt)}</span>
                </div>
                <div className="text-[10px] text-keep-muted">
                  {t("shared.byName", { name: e.actorUsername })}
                  {title ? <span> · "{title}"</span> : null}
                  {e.reason ? <span> · {e.reason}</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Reports tab: the forum's report queue. Members flag posts (the report
 * button on a forum post); owner/mods with handle_reports triage them here
 * — resolve (acted on it) or dismiss (no action). Toggle open vs handled.
 */
function ReportsSettings({ detail, busy, run }: {
  detail: ForumDetail;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { t } = useTranslation("forums");
  const [status, setStatus] = useState<"open" | "resolved" | "dismissed">("open");
  const [reports, setReports] = useState<ForumReportWire[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setReports(null);
    fetchForumReports(detail.id, status).then((r) => { if (alive) setReports(r); }).catch(() => { if (alive) setReports([]); });
    return () => { alive = false; };
  }, [detail.id, status, tick]);

  return (
    <div className="max-w-2xl space-y-3">
      <div className="flex gap-1">
        {(["open", "resolved", "dismissed"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-widest ${status === s ? "border-keep-action bg-keep-action/10 text-keep-action" : "border-keep-rule text-keep-muted hover:text-keep-text"}`}
          >{t(`reports.status.${s}`)}</button>
        ))}
      </div>
      {!reports ? (
        <p className="text-sm italic text-keep-muted">{t("common:loading")}</p>
      ) : reports.length === 0 ? (
        <p className="text-xs italic text-keep-muted">{status === "open" ? t("reports.noneOpen") : status === "resolved" ? t("reports.noneResolved") : t("reports.noneDismissed")}</p>
      ) : (
        <ul className="space-y-2">
          {reports.map((r) => (
            <li key={r.id} className="rounded border border-keep-rule bg-keep-panel/30 p-2.5 text-xs">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-semibold text-keep-text">{t("reports.authorsPost", { name: r.reportedAuthorName })}</span>
                {r.topicTitle ? <span className="text-keep-muted">{t("reports.inTopic", { title: r.topicTitle })}</span> : null}
                <span className="ml-auto text-[10px] text-keep-muted">{formatDateTime(r.createdAt)}</span>
              </div>
              <p className="mt-1 line-clamp-2 rounded bg-keep-bg/50 px-2 py-1 text-[11px] italic text-keep-muted">{r.reportedSnippet}</p>
              <p className="mt-1 text-[11px] text-keep-text">
                <span className="text-keep-muted">{t("reports.reportedBy", { name: r.reporterUsername })}</span> {r.reason}
              </p>
              {r.status === "open" ? (
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button" disabled={busy}
                    onClick={() => void run(async () => { await resolveForumReport(detail.id, r.id, "dismiss"); setTick((n) => n + 1); })}
                    className="rounded border border-keep-rule px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
                  >{t("reports.dismiss")}</button>
                  <button
                    type="button" disabled={busy}
                    onClick={() => void run(async () => { await resolveForumReport(detail.id, r.id, "resolve"); setTick((n) => n + 1); })}
                    className="rounded border border-keep-action bg-keep-action/10 px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-action hover:bg-keep-action/20"
                  >{t("reports.resolve")}</button>
                </div>
              ) : (
                <p className="mt-1 text-[10px] text-keep-muted">
                  {t("reports.statusBy", { status: r.status, name: r.resolvedByUsername ?? "-" })}{r.resolvedAt ? ` · ${formatDate(r.resolvedAt)}` : ""}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Prefixes tab: curate the topic-prefix catalog (label + chip color). Adds,
 * edits, and deletes ride the prefix CRUD; each change refetches the forum so
 * the chips update everywhere. Gated on manage_prefixes.
 */
function PrefixesSettings({ detail, busy, run, onSaved }: {
  detail: ForumDetail;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onSaved: () => void;
}) {
  const { t } = useTranslation("forums");
  const [label, setLabel] = useState("");
  const [color, setColor] = useState("#8a66cc");
  const [tooltip, setTooltip] = useState("");
  const [staffOnly, setStaffOnly] = useState(false);
  return (
    <div className="max-w-xl space-y-3">
      <p className="text-[11px] text-keep-muted">
        {t("prefixes.intro")}
      </p>

      {/* Master switch: custom tags on the fly. */}
      <label className="flex items-start gap-2 rounded border border-keep-rule bg-keep-panel/20 p-2.5 text-sm">
        <input
          type="checkbox" checked={detail.allowCustomTags} disabled={busy}
          onChange={(e) => void run(async () => { await updateForum(detail.id, { allowCustomTags: e.target.checked }); onSaved(); })}
          className="mt-0.5"
        />
        <span>
          <span className="font-semibold text-keep-text">{t("prefixes.allowCustom")}</span>
          <span className="block text-xs text-keep-muted">
            {t("prefixes.allowCustomHint")}
          </span>
        </span>
      </label>

      {detail.prefixes.length === 0 ? (
        <p className="text-xs italic text-keep-muted">{t("prefixes.noTags")}</p>
      ) : (
        <ul className="space-y-1">
          {detail.prefixes.map((p) => (
            <PrefixRow key={p.id} detail={detail} prefix={p} busy={busy} run={run} onSaved={onSaved} />
          ))}
        </ul>
      )}
      <div className="rounded border border-keep-rule bg-keep-panel/20 p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-7 w-9 shrink-0 cursor-pointer rounded border border-keep-rule bg-transparent" title={t("shared.chipColor")} />
          <input value={label} onChange={(e) => setLabel(e.target.value.slice(0, 24))} placeholder={t("prefixes.labelPlaceholder")} className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
          <button
            type="button"
            disabled={busy || !label.trim()}
            onClick={() => void run(async () => { await createForumPrefix(detail.id, { label: label.trim(), color, tooltip: tooltip.trim() || null, staffOnly }); setLabel(""); setTooltip(""); setStaffOnly(false); onSaved(); })}
            className="rounded border border-keep-action bg-keep-action/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-action disabled:opacity-50"
          >{t("prefixes.add")}</button>
        </div>
        <input
          value={tooltip} maxLength={FORUM_PREFIX_TOOLTIP_MAX} onChange={(e) => setTooltip(e.target.value)}
          placeholder={t("shared.tooltipPlaceholder")}
          className="mt-2 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs outline-none focus:border-keep-action"
        />
        <label className="mt-2 flex items-center gap-2 text-xs text-keep-muted">
          <input type="checkbox" checked={staffOnly} disabled={busy} onChange={(e) => setStaffOnly(e.target.checked)} />
          <span><Trans t={t} i18nKey="prefixes.staffOnlyExplainer" components={{ b: <span className="font-semibold text-keep-text" /> }} /></span>
        </label>
      </div>
    </div>
  );
}

/** One row in the tag catalog: color + label + delete, plus an expandable
 *  category-scope picker (when the forum has categories). No categories chosen
 *  = the tag is global; otherwise it's only offered in the picked categories. */
function PrefixRow({ detail, prefix: p, busy, run, onSaved }: {
  detail: ForumDetail;
  prefix: ForumDetail["prefixes"][number];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onSaved: () => void;
}) {
  const { t } = useTranslation("forums");
  const [open, setOpen] = useState(false);
  const [tip, setTip] = useState(p.tooltip ?? "");
  const themeBg = useActiveTheme().bg;
  const hasCategories = detail.categories.length > 0;
  const multiBoard = detail.boards.length > 1;
  // Save the tooltip on blur, only when it actually changed.
  function saveTip() {
    const next = tip.trim();
    if (next === (p.tooltip ?? "")) return;
    void run(async () => { await updateForumPrefix(detail.id, p.id, { tooltip: next || null }); onSaved(); });
  }
  const scopeLabel = p.categoryIds.length === 0
    ? t("prefixes.allCategories")
    : t("prefixes.categoryCount", { count: p.categoryIds.length });
  // Group the forum's categories by board for the picker.
  const byBoard = new Map<string, ForumDetail["categories"]>();
  for (const c of detail.categories) {
    const arr = byBoard.get(c.boardName) ?? [];
    arr.push(c);
    byBoard.set(c.boardName, arr);
  }
  function toggleCat(catId: string) {
    const next = p.categoryIds.includes(catId) ? p.categoryIds.filter((c) => c !== catId) : [...p.categoryIds, catId];
    void run(async () => { await updateForumPrefix(detail.id, p.id, { categoryIds: next }); onSaved(); });
  }
  return (
    <li className="rounded border border-keep-rule bg-keep-panel/30">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <input
          type="color" value={p.color} disabled={busy}
          onChange={(e) => void run(async () => { await updateForumPrefix(detail.id, p.id, { color: e.target.value }); onSaved(); })}
          className="h-6 w-8 shrink-0 cursor-pointer rounded border border-keep-rule bg-transparent"
          title={t("shared.chipColor")}
        />
        <span className="rounded px-1.5 py-0 text-[10px] font-bold uppercase tracking-wide" style={{ backgroundColor: `${p.color}22`, color: resolveMessageColor(p.color, themeBg) ?? p.color, border: `1px solid ${p.color}66` }} title={p.tooltip ?? undefined}>{p.label}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-keep-text">
          {p.label}
          {p.staffOnly ? <span className="ml-1.5 inline-flex items-center gap-0.5 align-middle text-[10px] uppercase tracking-widest text-keep-muted" title={t("prefixes.staffChipTitle")}><Lock className="h-2.5 w-2.5" aria-hidden /> {t("prefixes.staffWord")}</span> : null}
        </span>
        <button
          type="button" disabled={busy} onClick={() => void run(async () => { await updateForumPrefix(detail.id, p.id, { staffOnly: !p.staffOnly }); onSaved(); })}
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${p.staffOnly ? "border-keep-action text-keep-action" : "border-keep-rule text-keep-muted hover:text-keep-text"}`}
          title={p.staffOnly ? t("prefixes.staffOnlyOnTitle") : t("prefixes.staffOnlyOffTitle")}
        >{t("shared.staffOnly")}</button>
        {hasCategories ? (
          <button
            type="button" disabled={busy} onClick={() => setOpen((o) => !o)}
            className="shrink-0 rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
            title={t("prefixes.scopeTitle")}
          >{scopeLabel}</button>
        ) : null}
        <button
          type="button" disabled={busy}
          onClick={() => { if (window.confirm(t("prefixes.deleteConfirm", { label: p.label }))) void run(async () => { await deleteForumPrefix(detail.id, p.id); onSaved(); }); }}
          className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10"
        >{t("common:delete")}</button>
      </div>
      <div className="px-2.5 pb-1.5">
        <input
          value={tip} maxLength={FORUM_PREFIX_TOOLTIP_MAX} disabled={busy}
          onChange={(e) => setTip(e.target.value)} onBlur={saveTip}
          placeholder={t("shared.tooltipPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs outline-none focus:border-keep-action"
        />
      </div>
      {open && hasCategories ? (
        <div className="space-y-2 border-t border-keep-rule/60 px-2.5 py-2">
          <p className="text-[11px] text-keep-muted">{t("prefixes.scopeHint")}</p>
          {[...byBoard.entries()].map(([boardName, cats]) => (
            <div key={boardName}>
              {multiBoard ? <div className="mb-0.5 text-[10px] uppercase tracking-widest text-keep-muted">{boardName}</div> : null}
              <div className="flex flex-wrap gap-1.5">
                {cats.map((c) => (
                  <button
                    key={c.id} type="button" disabled={busy} onClick={() => toggleCat(c.id)}
                    className={`rounded border px-2 py-0.5 text-[11px] ${p.categoryIds.includes(c.id) ? "border-keep-action text-keep-action" : "border-keep-rule text-keep-muted hover:text-keep-text"}`}
                  >{c.name}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function OverviewSettings({ detail, busy, run, onSaved }: {
  detail: ForumDetail;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onSaved: () => void;
}) {
  const { t } = useTranslation("forums");
  const [name, setName] = useState(detail.name);
  const [tagline, setTagline] = useState(detail.tagline ?? "");
  const [description, setDescription] = useState(detail.descriptionHtml ?? "");
  const [postingMode, setPostingMode] = useState<"open" | "application">(detail.postingMode);
  const [prompt, setPrompt] = useState(detail.applicationPrompt ?? "");
  const [publicBrowsing, setPublicBrowsing] = useState(detail.publicBrowsing);
  // Whole-forum 18+ flag (age plan Phase 3). Under-18 accounts never see
  // the toggle at all (no dead control); the route re-checks adult + owner
  // and rejects regardless. Cosmetic mirror of the server gate.
  const [isNsfw, setIsNsfw] = useState(detail.isNsfw ?? false);
  const isAdultViewer = useChat((s) => s.viewerAge.isAdult);
  const nsfwDirty = isNsfw !== (detail.isNsfw ?? false);
  // Discovery genre tags — seeded from the forum's current tags, edited as
  // chips, saved with the rest of the overview via the forum-update PATCH.
  const [tags, setTags] = useState<string[]>(detail.tags);
  const [tagDraft, setTagDraft] = useState("");

  /** Add the typed draft as one or more chips: split on commas, clean each via
   *  normalizeTag, drop empties/dupes, cap at MAX_TAGS_PER_ENTITY. */
  function commitTagDraft() {
    const incoming = tagDraft.split(",").map(normalizeTag).filter(Boolean);
    if (incoming.length === 0) { setTagDraft(""); return; }
    setTags((cur) => {
      const next = [...cur];
      for (const t of incoming) {
        if (next.length >= MAX_TAGS_PER_ENTITY) break;
        if (!next.includes(t)) next.push(t);
      }
      return next;
    });
    setTagDraft("");
  }
  function removeTag(tag: string) {
    setTags((cur) => cur.filter((t) => t !== tag));
  }

  const tagsDirty = JSON.stringify(tags) !== JSON.stringify(detail.tags);
  const dirty = name !== detail.name
    || tagline !== (detail.tagline ?? "")
    || description !== (detail.descriptionHtml ?? "")
    || postingMode !== detail.postingMode
    || prompt !== (detail.applicationPrompt ?? "")
    || publicBrowsing !== detail.publicBrowsing
    || nsfwDirty
    || tagsDirty;
  return (
    <div className="max-w-xl space-y-3">
      <label className="block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">{t("overview.name")}</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={FORUM_NAME_MAX}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">{t("overview.tagline")}</span>
        <input
          value={tagline}
          onChange={(e) => setTagline(e.target.value)}
          maxLength={200}
          placeholder={t("overview.taglinePlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">{t("overview.description")}</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={6}
          maxLength={5000}
          placeholder={t("overview.descriptionPlaceholder")}
          className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
        />
      </label>
      <div className="block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">
          {t("overview.tags")} <span className="normal-case text-keep-rule">({tags.length}/{MAX_TAGS_PER_ENTITY})</span>
        </span>
        <div className="flex flex-wrap items-center gap-1.5 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 focus-within:border-keep-action">
          {tags.map((tag) => (
            <span key={tag} className="inline-flex items-center gap-1 rounded-full border border-keep-action/40 bg-keep-action/10 px-2 py-0.5 text-[11px] text-keep-action">
              {tag}
              <button
                type="button"
                onClick={() => removeTag(tag)}
                aria-label={t("overview.removeTagAria", { tag })}
                className="rounded-full hover:text-keep-text"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </span>
          ))}
          {tags.length < MAX_TAGS_PER_ENTITY ? (
            <input
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commitTagDraft(); }
                else if (e.key === "Backspace" && tagDraft === "" && tags.length > 0) {
                  // Backspace on an empty input pops the last chip.
                  removeTag(tags[tags.length - 1]!);
                }
              }}
              onBlur={commitTagDraft}
              placeholder={tags.length === 0 ? t("overview.tagExamplesPlaceholder") : t("overview.addTagPlaceholder")}
              className="min-w-[8rem] flex-1 bg-transparent text-sm outline-none"
            />
          ) : null}
        </div>
        <p className="mt-1 text-[11px] text-keep-muted">
          {t("overview.tagsHint")}
        </p>
      </div>
      <div className="rounded border border-keep-rule bg-keep-panel/20 p-2.5">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">{t("overview.whoMayPost")}</span>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="postingMode"
            checked={postingMode === "open"}
            onChange={() => setPostingMode("open")}
            className="mt-0.5"
          />
          <span><span className="font-semibold text-keep-text">{t("overview.open")}</span>
            <span className="block text-xs text-keep-muted">{t("overview.openHint")}</span></span>
        </label>
        <label className="mt-1.5 flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="postingMode"
            checked={postingMode === "application"}
            onChange={() => setPostingMode("application")}
            className="mt-0.5"
          />
          <span><span className="font-semibold text-keep-text">{t("overview.application")}</span>
            <span className="block text-xs text-keep-muted">{t("overview.applicationHint")}</span></span>
        </label>
        {postingMode === "application" ? (
          <label className="mt-2 block text-sm">
            <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">{t("overview.applicationPrompt")}</span>
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={300}
              placeholder={t("membership.defaultPrompt")}
              className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
            />
          </label>
        ) : null}
      </div>
      <div className="rounded border border-keep-rule bg-keep-panel/20 p-2.5">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">{t("overview.publicBrowsing")}</span>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={publicBrowsing}
            onChange={(e) => setPublicBrowsing(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-semibold text-keep-text">{t("overview.publicBrowsingLabel")}</span>
            <span className="block text-xs text-keep-muted">
              {t("overview.publicBrowsingHint", { slug: detail.slug })}
            </span>
          </span>
        </label>
      </div>
      {/* 18+ forum (age plan Phase 3) — the forum-side mirror of the server
          "18+ community" toggle. Hidden entirely from under-18 viewers
          (never a dead toggle); the route re-checks adult + owner. */}
      {isAdultViewer ? (
        <div className="rounded border border-keep-rule bg-keep-panel/20 p-2.5">
          <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">{t("overview.ageRating")}</span>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={isNsfw}
              onChange={(e) => setIsNsfw(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="font-semibold text-keep-text">{t("overview.nsfwForum")}</span>
              <span className="block text-xs text-keep-muted">
                {t("overview.nsfwForumHint")}
              </span>
            </span>
          </label>
          {isNsfw ? (
            <p className="mt-1.5 text-[10px] text-keep-muted">
              {t("overview.nsfwTip")}
            </p>
          ) : null}
        </div>
      ) : null}
      <p className="text-[11px] text-keep-muted">
        {t("overview.addressPermanent", { slug: detail.slug })}
      </p>
      <button
        type="button"
        disabled={!dirty || busy || name.trim().length < FORUM_NAME_MIN}
        onClick={() => {
          // Flipping a forum 18+ hides it from every under-18 member on the
          // spot (server-side), so make the owner say it out loud first.
          if (nsfwDirty && isNsfw && !window.confirm(
            t("overview.nsfwConfirm", { name: detail.name }),
          )) return;
          void run(async () => {
          // Fold any half-typed tag in the input into the saved set (clicking
          // Save blurs the chip input, but that state update may not have
          // landed yet) — clean + dedupe + cap, same rules as commitTagDraft.
          const pending = tagDraft.split(",").map(normalizeTag).filter(Boolean);
          const finalTags = [...tags];
          for (const t of pending) {
            if (finalTags.length >= MAX_TAGS_PER_ENTITY) break;
            if (!finalTags.includes(t)) finalTags.push(t);
          }
          await updateForum(detail.id, {
            name: name.trim(),
            tagline: tagline.trim() ? tagline.trim() : null,
            descriptionHtml: description.trim() ? description : null,
            postingMode,
            applicationPrompt: prompt.trim() ? prompt.trim() : null,
            publicBrowsing,
            tags: finalTags,
            // Only on change (and the toggle only renders for adults), so an
            // untouched save can never trip the route's adult-only rejection.
            ...(nsfwDirty ? { isNsfw } : {}),
          });
          onSaved();
          });
        }}
        className="rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
      >
        {busy ? "…" : t("common:save")}
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
  const { t } = useTranslation("forums");
  const [newName, setNewName] = useState("");
  const [newTopic, setNewTopic] = useState("");
  // Category editors open by DEFAULT — every board shows its category
  // designer the moment the Boards tab loads, so adding categories isn't a
  // hidden affordance. Owners can collapse individual boards to tidy the
  // list. Categories belong to a board, so they're managed HERE, inline —
  // not on a separate tab with a board dropdown.
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(() => new Set());
  const catsOpen = (roomId: string) => !collapsedCats.has(roomId);
  const toggleCats = (roomId: string) =>
    setCollapsedCats((cur) => {
      const next = new Set(cur);
      if (next.has(roomId)) next.delete(roomId);
      else next.add(roomId);
      return next;
    });
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
                <span className="flex items-center gap-1.5 text-sm font-semibold text-keep-text">
                  {b.membersOnly ? <Lock className="h-3 w-3 shrink-0 text-keep-accent" aria-label={t("shared.membersOnly")} /> : null}
                  <span className="truncate">{b.name}</span>
                </span>
                <span className="block truncate text-xs text-keep-muted">{b.topic ?? t("boardsAdmin.noTopicLine")}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <button
                  type="button" disabled={busy || i === 0} onClick={() => move(b.roomId, -1)}
                  title={t("shared.moveUp")} aria-label={t("shared.moveNameUp", { name: b.name })}
                  className="rounded border border-keep-rule p-1 text-keep-muted hover:text-keep-text disabled:opacity-30"
                ><ArrowUp className="h-3 w-3" aria-hidden="true" /></button>
                <button
                  type="button" disabled={busy || i === detail.boards.length - 1} onClick={() => move(b.roomId, 1)}
                  title={t("shared.moveDown")} aria-label={t("shared.moveNameDown", { name: b.name })}
                  className="rounded border border-keep-rule p-1 text-keep-muted hover:text-keep-text disabled:opacity-30"
                ><ArrowDown className="h-3 w-3" aria-hidden="true" /></button>
                <button
                  type="button" disabled={busy}
                  onClick={() => {
                    const v = window.prompt(t("boardsAdmin.renamePrompt", { name: b.name }), b.name);
                    if (v === null || !v.trim() || v.trim() === b.name) return;
                    void run(async () => { await updateBoard(detail.id, b.roomId, { name: v.trim() }); onSaved(); });
                  }}
                  className="rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
                >{t("boardsAdmin.rename")}</button>
                <button
                  type="button" disabled={busy}
                  onClick={() => {
                    const v = window.prompt(t("boardsAdmin.topicPrompt", { name: b.name }), b.topic ?? "");
                    if (v === null) return;
                    void run(async () => { await updateBoard(detail.id, b.roomId, { topic: v.trim() ? v.trim() : null }); onSaved(); });
                  }}
                  className="rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
                >{t("boardsAdmin.topicButton")}</button>
                <button
                  type="button" disabled={busy}
                  onClick={() => void run(async () => { await updateBoard(detail.id, b.roomId, { membersOnly: !b.membersOnly }); onSaved(); })}
                  title={b.membersOnly ? t("boardsAdmin.privateOnTitle") : t("boardsAdmin.privateOffTitle")}
                  aria-pressed={b.membersOnly}
                  className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${
                    b.membersOnly
                      ? "border-keep-accent text-keep-accent"
                      : "border-keep-rule text-keep-muted hover:text-keep-text"
                  }`}
                >{t("boardsAdmin.privateButton")}</button>
                <button
                  type="button"
                  onClick={() => toggleCats(b.roomId)}
                  aria-expanded={catsOpen(b.roomId)}
                  className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${
                    catsOpen(b.roomId)
                      ? "border-keep-action text-keep-action"
                      : "border-keep-rule text-keep-muted hover:text-keep-text"
                  }`}
                >{t("boardsAdmin.categoriesButton")}</button>
                <button
                  type="button" disabled={busy}
                  onClick={() => {
                    if (!window.confirm(t("boardsAdmin.archiveConfirm", { name: b.name, count: b.topicCount }))) return;
                    void run(async () => { await archiveBoard(detail.id, b.roomId); onBoardArchived(b.roomId); });
                  }}
                  className="rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10"
                >{t("boardsAdmin.archive")}</button>
              </span>
            </div>
            {catsOpen(b.roomId) ? (
              <div className="mt-2 border-t border-keep-rule/50 pt-2">
                <BoardCategoriesEditor detail={detail} boardId={b.roomId} busy={busy} run={run} />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="rounded border border-keep-rule bg-keep-panel/20 p-2.5">
        <p className="mb-1.5 text-xs uppercase tracking-widest text-keep-muted">
          {t("boardsAdmin.raiseBoard")} {atCap ? <span className="text-keep-accent">{t("boardsAdmin.atCap")}</span> : `(${detail.boards.length}/10)`}
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={40}
            placeholder={t("boardsAdmin.boardNamePlaceholder")}
            className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
          />
          <input
            value={newTopic}
            onChange={(e) => setNewTopic(e.target.value)}
            maxLength={200}
            placeholder={t("boardsAdmin.topicLinePlaceholder")}
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
            {t("boardsAdmin.raise")}
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
  const { t } = useTranslation("forums");
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

  if (!cats) return <p className="text-sm italic text-keep-muted">{t("categories.loading")}</p>;

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
            <span className="shrink-0 text-[10px] tabular-nums text-keep-muted">{t("categories.subCount", { count: subsOf(c.id).length })}</span>
          ) : null}
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button" disabled={busy || si <= 0} onClick={() => moveSibling(c, -1)}
              title={t("shared.moveUp")} aria-label={t("shared.moveNameUp", { name: c.name })}
              className="rounded border border-keep-rule p-1 text-keep-muted hover:text-keep-text disabled:opacity-30"
            ><ArrowUp className="h-3 w-3" aria-hidden="true" /></button>
            <button
              type="button" disabled={busy || si === siblings.length - 1} onClick={() => moveSibling(c, 1)}
              title={t("shared.moveDown")} aria-label={t("shared.moveNameDown", { name: c.name })}
              className="rounded border border-keep-rule p-1 text-keep-muted hover:text-keep-text disabled:opacity-30"
            ><ArrowDown className="h-3 w-3" aria-hidden="true" /></button>
            {!isSub ? (
              <button
                type="button" disabled={busy}
                onClick={() => setPanel({ kind: "add", parentId: c.id })}
                title={t("categories.addSubTitle", { name: c.name })}
                className="rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
              >{t("categories.addSub")}</button>
            ) : null}
            <button
              type="button"
              onClick={() => setPanel(editingHere ? null : { kind: "edit", id: c.id })}
              aria-expanded={editingHere}
              className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-widest ${
                editingHere ? "border-keep-action text-keep-action" : "border-keep-rule text-keep-muted hover:text-keep-text"
              }`}
            >{t("shared.edit")}</button>
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
          {t("categories.empty")}
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
          {t("categories.addCategory")}
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
  const { t } = useTranslation("forums");
  const [name, setName] = useState(existing?.name ?? "");
  const [subtitle, setSubtitle] = useState(existing?.subtitle ?? "");
  const [parentId, setParentId] = useState<string>(existing?.parentId ?? defaultParentId ?? "");
  const [membersOnly, setMembersOnly] = useState(!!existing?.membersOnly);
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
          membersOnly,
          ...(canReparent ? { parentId: parentId || null } : {}),
        });
      } else {
        await createRoomCategory(boardId, trimmed, 9999, sub, parentId || null, membersOnly);
      }
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("shared.saveFailed"));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded border border-dashed border-keep-action/50 bg-keep-bg/60 p-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-keep-muted">
        {existing ? t("categories.editCategory") : defaultParentId ? t("categories.newSubcategory") : t("categories.newCategory")}
      </p>
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("overview.name")}</span>
        <input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          placeholder={t("categories.namePlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
        />
      </label>
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("categories.subtitle")} <span className="normal-case text-keep-rule">{t("categories.subtitleHint")}</span></span>
        <input
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
          maxLength={140}
          placeholder={t("categories.subtitlePlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
        />
      </label>
      {canReparent ? (
        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("categories.section")}</span>
          <select
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
          >
            <option value="">{t("categories.topLevel")}</option>
            {parentOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>{t("categories.underName", { name: opt.name })}</option>
            ))}
          </select>
        </label>
      ) : null}

      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          checked={membersOnly}
          onChange={(e) => setMembersOnly(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-semibold text-keep-text">{t("shared.membersOnly")}</span>
          <span className="block text-[11px] text-keep-muted">
            {t("categories.membersOnlyHint")}
          </span>
        </span>
      </label>

      {/* Icon + delete only make sense for an existing category. */}
      {existing ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-keep-rule/50 pt-2">
          <span className="text-[10px] uppercase tracking-widest text-keep-muted">{t("categories.icon")}</span>
          {existing.iconUrl ? (
            <img src={existing.iconUrl} alt="" className="h-5 w-5 rounded-sm object-contain" />
          ) : (
            <FolderOpen className="h-4 w-4 text-keep-accent/70" aria-hidden="true" />
          )}
          <label className={`cursor-pointer rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text ${busy ? "opacity-50" : ""}`}>
            {t("shared.upload")}
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
            >{t("common:clear")}</button>
          ) : null}
          <span className="text-[10px] text-keep-rule">{t("categories.iconSize")}</span>
          <button
            type="button" disabled={busy}
            onClick={() => {
              if (!window.confirm(t("categories.deleteConfirm", { name: existing.name }))) return;
              void run(async () => { await deleteRoomCategory(boardId, existing.id); onDone(); });
            }}
            className="ml-auto rounded border border-keep-accent/60 px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10"
          >{t("common:delete")}</button>
        </div>
      ) : null}

      {err ? <p className="text-xs text-keep-accent">{err}</p> : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-keep-rule px-3 py-1 text-[11px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
        >{t("common:cancel")}</button>
        <button
          type="button"
          disabled={busy || !name.trim()}
          onClick={() => void save()}
          className="rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
        >{busy ? "…" : existing ? t("common:save") : t("shared.create")}</button>
      </div>
    </div>
  );
}

