import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { BarChart3, Flag, FolderInput, Lock } from "lucide-react";
import { resolveMessageColor, type ChatMessage, type ForumTopicCard, type RoomOccupant, type ThreadCategory } from "@thekeep/shared";
import { extractMentions , prefixAppliesToCategory } from "@thekeep/shared";
import { BorderedAvatar, type BorderedAvatarSize } from "../cosmetics/BorderedAvatar.js";
import { RankSigil } from "../earning/RankSigil.js";
import { StyledName } from "../cosmetics/StyledName.js";
import type { Gender } from "../../lib/gender.js";
import { parseInline, renderForumBody } from "../../lib/markdown.js";
import { handlePlainTextCopy } from "../../lib/chatCopy.js";
import { useActiveTheme } from "../../lib/theme.js";
import { ForumPrefixContext } from "../../lib/forumPrefixContext.js";
import { ForumTopicAdminContext } from "../../lib/forumTopicAdminContext.js";
import { useCopyToClipboard } from "../../lib/useCopyToClipboard.js";
import { ForumReportContext } from "../../lib/forumReportContext.js";
import { useChat } from "../../state/store.js";
import { identityKey } from "../../lib/identity.js";
import { LinkPreviewCard } from "../LinkPreviewCard.js";
import { useMentionsCache, requestMentionResolve } from "../../state/mentions.js";
import { readError } from "../../lib/http.js";
import { i18n } from "../../lib/i18n.js";
import { formatNumber, formatTime } from "../../lib/intlFormat.js";
import { useReducedMotion } from "../../lib/reducedMotion.js";
import { fmtForumTime, fmtFullTimestamp } from "../messageTime.js";
import { TopicManageModal } from "../forums/forumTopicAdmin.js";
import { PollCard } from "./PollCard.js";
import { buildOccupantMaps } from "./occupantSelectors.js";
import { MessageVisibilityGate } from "./MessageVisibilityGate.js";
import { ReactionAddButton, ReactionBar } from "./ReactionBar.js";
import { Line, REPLYABLE_KINDS, REPORTABLE_KINDS } from "./messageRow.js";

/**
 * Per-server topic-card author flair (Servers Lift). The flair fields ride
 * the shared `ForumTopicCard` (`author*`), resolved server-side from the
 * cosmetics the author earned on the server the forum is affiliated to. A
 * topic object only carries them when its source route emitted them (i.e.
 * the forum HAS a `serverId` affiliation); absent ⇒ the forum is
 * unaffiliated and the card renders BARE.
 *
 * This reads them off whatever topic object the render site holds (the
 * store buckets are `ChatMessage`, which doesn't declare these optional
 * fields) and returns `null` when none are present, so the gate "did the
 * server send flair at all" is preserved on the client too.
 */
function topicCardFlair(topic: unknown): {
  authorRankKey?: string | null;
  authorTier?: number | null;
  authorSelectedBorderRankKey?: string | null;
  authorSelectedFreeformBorderKey?: string | null;
  authorFreeformBorderConfig?: Record<string, string> | null;
  authorNameStyleKey?: string | null;
  authorNameStyleConfig?: Record<string, unknown> | null;
} | null {
  if (!topic || typeof topic !== "object") return null;
  const t = topic as Partial<ForumTopicCard>;
  // The whole flair set is sent together or omitted together (server
  // contract). Presence of ANY author* flair key ⇒ the forum is affiliated.
  const hasFlair =
    "authorRankKey" in t ||
    "authorSelectedBorderRankKey" in t ||
    "authorSelectedFreeformBorderKey" in t ||
    "authorNameStyleKey" in t;
  if (!hasFlair) return null;
  return {
    authorRankKey: t.authorRankKey ?? null,
    authorTier: t.authorTier ?? null,
    authorSelectedBorderRankKey: t.authorSelectedBorderRankKey ?? null,
    authorSelectedFreeformBorderKey: t.authorSelectedFreeformBorderKey ?? null,
    authorFreeformBorderConfig: t.authorFreeformBorderConfig ?? null,
    authorNameStyleKey: t.authorNameStyleKey ?? null,
    authorNameStyleConfig: t.authorNameStyleConfig ?? null,
  };
}

/**
 * NSFW topic tag (age-restriction plan Phase 3). Like the flair above, the
 * flag rides the topics-route payload on the shared `ForumTopicCard` shape
 * while the store buckets are typed `ChatMessage`, so read it off whatever
 * topic object the render site holds. Absent = untagged. The server never
 * sends tagged topics to viewers who can't see NSFW, so a `true` here only
 * ever reaches viewers allowed to open the topic.
 */
function topicIsNsfw(topic: unknown): boolean {
  if (!topic || typeof topic !== "object") return false;
  return (topic as Partial<ForumTopicCard>).isNsfw === true;
}

interface Props {
  messages: ChatMessage[];
  /** Used to look up gender for each message author. */
  occupants: RoomOccupant[];
  /** Current viewer's user id - so the renderer can decide which messages get edit/delete grace controls. Null when not yet authenticated. */
  selfUserId: string | null;
  /**
   * Names that identify the viewer to the mention parser, master
   * username plus any active character name, in any case (lower-cased
   * downstream for the lookup). Mentions matching one of these get a
   * "you got tagged" highlight using the theme's `system` slot. Optional
   *, when omitted no self-detection runs and every mention renders in
   * the default keep-action style.
   */
  selfNames?: ReadonlyArray<string>;
  /** Current room's type. Reporting is a public-room-only feature. */
  roomType?: "public" | "private" | null;
  /**
   * "flat" (default) - chronological timeline. "nested" - replies group
   * under their parent in a thread container with the latest 5 visible
   * by default. Owner/mod sets via /replymode.
   */
  replyMode?: "flat" | "nested";
  /** `characterId` lets the handler emit `@cid:` tokens for the
   *  resulting whisper / profile fetch so a same-named character on
   *  another account can't intercept the click. Optional, callers
   *  without an id (mention clicks) still work via the name-only path. */
  onIconClick: (userId: string, displayName: string, characterId?: string | null) => void;
  onNameClick: (userId: string, displayName: string, characterId?: string | null) => void;
  /** Click handler for @mentions parsed out of the message body. */
  onMentionClick: (name: string) => void;
  /** Click handler for @world:slug mentions parsed out of the message body. */
  onWorldClick: (slug: string) => void;
  /** Click on the timestamp - pre-fill the composer with /reply <msgid>. Only enabled for chat kinds (say/me/ooc). */
  onTimeClick: (msgId: string) => void;
  /**
   * Click on a reply's quote preview, jumps the chat to the parent
   * message (the one being replied to) and flashes it. Same flow used
   * by bookmarks; the App wires this to `jumpToMessage(currentRoomId,
   * id)`. When omitted, the quote stays as plain non-clickable text.
   */
  onJumpToReply?: (messageId: string) => void;
  fontStep: 0 | 1 | 2 | 3;
  /**
   * When set, scroll the matching row into view and flash it briefly so a
   * user arriving via search/bookmark/mention can find their target.
   * Cleared via `onHighlightDone` after the flash animation completes.
   */
  highlightMessageId?: string | null;
  onHighlightDone?: () => void;
  /** Current room id; used as the localStorage key prefix for category collapse state. */
  roomId?: string | null;
  /**
   * Thread categories for the current room. Only consumed when
   * `replyMode === "nested"` and the list is non-empty, in that case
   * the forum renderer groups topics under collapsible category
   * sections. Replies stay nested under their parent regardless.
   */
  threadCategories?: ThreadCategory[];
  /**
   * Forum-mode active topic. Only meaningful when `replyMode === "nested"`.
   * The matching topic card renders expanded (body + reply chain visible)
   * and visually highlighted; everything else collapses to a header.
   */
  activeTopicId?: string | null;
  /**
   * Set or clear the active topic. The card's header is a click target
   * that calls this; clicking the currently-active topic clears it (so
   * the user can collapse). Only invoked from the forum renderer.
   */
  onSetActiveTopic?: (id: string | null) => void;
  /**
   * Open a topic in the focused-view modal. Triggered by the ⤢ button
   * on each topic card. The modal renders the same topic + replies
   * (read live from the parent's message buffer) with its own reply
   * composer; this prop just tells App.tsx which topic to focus.
   * Independent of `activeTopicId`, popping out doesn't disturb the
   * inline-expanded state in the list view.
   */
  onPopoutTopic?: (id: string) => void;
  /**
   * Viewer has moderator privileges (role mod or admin). Forum-mode
   * toolbars expose Lock/Unlock on any topic + Delete on any post
   * when this is true. Authors retain their own Lock/Delete rights
   * regardless. Defaults to false.
   */
  canModerate?: boolean;
  /**
   * Viewer can pin topics (admin only). Stricter than `canModerate`
   *, mods can lock and delete but not pin, since stickies are
   * persistent room-furniture. When true, the per-topic toolbar
   * surfaces a Pin/Unpin button. Defaults to false.
   */
  canPin?: boolean;
  /**
   * Viewer can rewrite other users' posts (admin tier only). Mods can
   * Delete (hide) a post but not edit its text; admins get cross-author
   * Edit so authors can request a touch-up after the normal edit window
   * has closed. The server enforces the same gate via `isAdminRole` on
   * PATCH /messages/:id. Defaults to false.
   */
  canAdminEdit?: boolean;
  /**
   * Optional handler for the Quote button on each forum post. When
   * present, each post in a forum room shows a "Quote" pill in its
   * toolbar; clicking it emits the pre-formatted blockquote text
   * (with attribution) so the parent can populate the appropriate
   * composer, main composer for the inline list view, modal
   * composer for the focused thread modal.
   */
  onQuotePost?: (quoteText: string) => void;
  /**
   * Paginated topic buckets for forum-mode rooms. Keyed by category
   * id, or `"_uncat"` for the uncategorized bucket. When this prop
   * is absent (or empty) for a forum room, the forum view shows a
   * loading state until the parent fetches the first page.
   *
   * `topics` is sorted DESC by `lastActivityAt`. `hasMore` drives the
   * "Load older topics" button. `pending` holds new-from-others
   * topics waiting behind the "X new topics" pill. `loading` is the
   * in-flight flag for page fetches.
   */
  forumBuckets?: Record<string, {
    topics: ChatMessage[];
    hasMore: boolean;
    loading: boolean;
    pending: ChatMessage[];
    currentPage: number;
    totalPages: number;
    totalCount: number;
    perPage: number;
  }>;
  /** Navigate the given category's bucket to the target page. Called
   *  by the per-section pagination strip (Prev / 1 2 … N / Next). */
  onGoToForumPage?: (categoryKey: string, page: number) => void;
  /** Flush queued topics (those behind the "X new topics" pill) into the visible list. */
  onFlushPendingTopics?: (categoryKey: string) => void;
  /**
   * Fired when the user clicks a category section header, signals that
   * the next "+ New topic" should pre-select this category. `null` for
   * the Uncategorized bucket. Acts in addition to (not instead of) the
   * section's collapse toggle.
   */
  onActivateCategory?: (categoryId: string | null) => void;
  /**
   * Fired when the user clicks the per-section "+ New Topic" button.
   * Distinct from `onActivateCategory`, this is the explicit "open the
   * composer in topic-create mode, target this category" path that also
   * cancels any active reply state in the parent. `null` = Uncategorized.
   */
  onStartTopicInCategory?: (categoryId: string | null) => void;
  /**
   * Forums Catalog: render the reply composer INSIDE the active topic
   * card, after its reply chain — a "ghost post" that becomes the real
   * post on submit. Called only for the ACTIVE topic. Chat passes
   * nothing (its composer is the chat composer below the feed).
   */
  renderTopicComposer?: (topic: ChatMessage) => React.ReactNode;
  /**
   * Forums Catalog: render the new-topic form inline at the top of a
   * category section (`"_uncat"` = the Uncategorized bucket). Return
   * null for sections that aren't composing. Chat passes nothing.
   */
  renderNewTopicForm?: (categoryKey: string) => React.ReactNode;
  /** Forums Catalog: topics with activity the viewer hasn't read —
   *  renders the unread dot on their cards. Chat passes nothing. */
  unreadTopicIds?: ReadonlySet<string>;
  /** Forums Catalog: topics the viewer watches (bell state). */
  watchedTopicIds?: ReadonlySet<string>;
  /** Forums Catalog: toggle a topic subscription from the card's bell. */
  onToggleTopicWatch?: (topicId: string, watch: boolean) => void;
  /**
   * Viewer can pin/unpin CHAT messages to the top of the room (migration
   * 0316). True when they hold the sitewide `pin_message` permission OR are
   * the room owner/mod. Surfaces a Pin/Unpin action beside the bookmark
   * button on flat-chat rows. The server re-checks the same gate. Defaults
   * to false. Distinct from `canPin` above (which gates forum TOPIC
   * stickies). */
  canPinMessage?: boolean;
  /** Ids of messages currently pinned in this room, so the row action can
   *  render Unpin (filled) vs Pin (outline). Fed from App's `room:pins`
   *  state. */
  pinnedMessageIds?: ReadonlySet<string>;
  /** Anonymous forum reader (/f/ landing): hide every action toolbar —
   *  read-only browsing, copy-link only. */
  readOnly?: boolean;
  /**
   * Stamp the forum-posting tour's `data-tour="forum-new-topic-btn"` anchor
   * on the per-section "+ New Topic" buttons. ONLY the Forums Catalog passes
   * true: the tour fires inside the catalog modal, but this component also
   * renders for legacy threaded CHAT rooms, which stay mounted BEHIND the
   * modal and precede it in document order — an unconditional stamp made
   * CoachTour's first `querySelector` match spotlight the hidden chat
   * button's rect instead of the catalog's.
   */
  forumTourAnchors?: boolean;
  /** Permalink builders (forum surfaces). When present, topic cards and
   *  post toolbars grow a copy-link button. */
  postPermalink?: (messageId: string) => string;
  /** Staff pair oversight: rows whose roomId matches this id (the pair's
   *  18+ channel) get a red row wash in the merged feed. Null for
   *  everyone who isn't staff viewing a paired room. */
  nsfwTintRoomId?: string | null;
  /** Staff pair oversight: the pair's OTHER room, so the buffer trim can
   *  cap the sibling bucket the merged feed renders from. Null when not
   *  merging. */
  pairSiblingRoomId?: string | null;
}

/** Replies per page inside an expanded topic. Chains at or under this
 *  render whole; longer chains get the classic forum pager (First /
 *  Prev / Page x of y / Next / Last), defaulting to the newest page. */
const REPLIES_PER_PAGE = 20;

/** Tiny copy-permalink button (topic cards + post toolbars). Flashes a
 *  check for a beat after copying. */
function CopyLinkButton({ url, compact = false }: { url: string; compact?: boolean }) {
  const { t } = useTranslation("chat");
  const { copied, copy } = useCopyToClipboard({ resetMs: 1200 });
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        /* clipboard unavailable; nothing to show */
        void copy(url);
      }}
      title={copied ? t("forum.linkCopied") : t("forum.copyLink")}
      aria-label={t("forum.copyLinkAria")}
      className={compact
        ? "shrink-0 rounded border border-keep-rule/60 bg-keep-bg/60 px-1.5 py-0.5 text-xs text-keep-muted hover:border-keep-action hover:text-keep-action"
        : "keep-button rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-0.5 text-keep-muted hover:bg-keep-banner hover:text-keep-text"}
    >
      <span aria-hidden>{copied ? "✓" : "🔗"}</span>
      {compact ? null : (
        <span className="ml-1 text-[10px]">{copied ? t("common:copied") : t("forum.link")}</span>
      )}
    </button>
  );
}


// Author edit/delete grace window is admin-configurable via
// `siteSettings.editGraceMs`, surfaced through the public /site
// endpoint into the branding store. The Line component reads it via
// `useChat` at render time so a runtime tweak in the admin panel
// takes effect without a reload. This client-side gate is just the
// soft "hide controls past the window" check; the server route
// re-validates and is authoritative.


// Stable empty fallback for the optional `selfNames` prop. Using a
// literal `[]` in the fallback expression would allocate a fresh array
// each render and churn the downstream `useMemo(renderForumBody, ...)`
// dependency, defeating the memo. App.tsx always passes a stable
// memoized array in practice, so this only triggers for older callers.
const NO_SELF_NAMES: ReadonlyArray<string> = [];

// Font-size cycle for the local Size button. Values are em-units so they
// compose with the user's profile-level UI font size: a user on "Large"
// (18px html base) sees the bottom step as 18 × 1.15 = ~21px, the top
// step as 18 × 1.75 = ~31px. A user on the default 16px base sees the
// "natural" 16px chat unmodified only by going lower than the cycle's
// floor (i.e. profile fontScale = Small). Storing this as px (the
// previous shape) would override the profile preference and leave
// accessibility users stuck at whatever the renderer baked in.
//
// The whole ladder was shifted up, step 0 is now what step 2 used to
// be, step 1 what step 3 used to be, because the old smallest steps
// (0.8em / 1em) read as cramped on the modern chat surface and almost
// no one was selecting them. Keep MessageList.FONT_EM and
// [RoomsTree.tsx](./RoomsTree.tsx)'s RAIL_FONT_EM in lockstep so the
// chat surface and the rail scale together when the Tools-menu cycle
// flips.
const FONT_EM = ["1.15em", "1.3em", "1.5em", "1.75em"] as const;


/**
 * Distance from the bottom (px) within which a NEW message (an append)
 * is allowed to scroll the reader down to follow it. Now scoped to the
 * reader's OWN send: your own new line jumps you to it even a few lines
 * up, while SOMEONE ELSE's arrival follows only when you're parked at the
 * bottom (STICK_BOTTOM_PX) — casually scrolling up to re-read no longer
 * snaps you back to the newest message.
 */
const NEAR_BOTTOM_PX = 120;

/**
 * Tighter "is the reader actually pinned to the bottom?" threshold, used
 * ONLY for the async-growth re-pin (ResizeObserver: reaction chips
 * landing, inline images decoding, link-preview cards mounting). That
 * growth is incidental — the reader didn't ask for it — so it must only
 * follow when they're TRULY at the bottom, never when they've manually
 * scrolled up to read. At the true bottom `dist` is ~0 (the feed's `pb-7`
 * gutter is inside scrollHeight, so it doesn't inflate the at-bottom
 * distance); a real scroll-up (a wheel notch is ~100px) clears this
 * easily, so the stick releases the instant the reader moves up while
 * sub-pixel / scrollbar rounding at the bottom stays comfortably under it.
 *
 * Keeping this SEPARATE from (and much tighter than) NEAR_BOTTOM_PX is
 * the fix for the "chat bounces when I react to a post or post an image"
 * report: a reaction chip or a decoding image used to re-pin anyone
 * within 120px of the bottom, yanking readers who'd deliberately scrolled
 * up a few lines back down to the latest line.
 */
const STICK_BOTTOM_PX = 24;

/**
 * Flat-buffer windowing bounds. While the reader is parked at the
 * bottom, the in-memory message buffer is trimmed back to the newest
 * `SOFT_CAP` once it grows past `HARD_CAP`. The gap between the two is
 * deliberate hysteresis, trimming on every single live append (back to
 * exactly the cap) would thrash re-renders; instead we let the buffer
 * drift up to HARD_CAP, then drop in one batch. Dropped older rows
 * stay on the server and re-hydrate through the normal scroll-up
 * load-older fetch, so windowing is lossless to the reader.
 *
 * This complements MessageVisibilityGate (which skips paint/layout for
 * off-screen rows via content-visibility, reserving their height): the gate
 * bounds paint/decode cost, this bounds the row COUNT so a long live session
 * or repeated load-older doesn't accumulate thousands of placeholders.
 * SOFT_CAP keeps several scroll-up pages of context resident.
 */
const FLAT_BUFFER_SOFT_CAP = 200;
const FLAT_BUFFER_HARD_CAP = 300;

/**
 * Window (ms) after a framework-initiated scrollTop write during which the
 * resulting scroll event is treated as that write's own echo rather than user
 * intent. A programmatic scroll's echo dispatches within a frame or two; 100ms
 * absorbs main-thread jank while staying short enough that a genuine user
 * scroll afterwards is still classified correctly. Misreading a framework
 * write as a user scroll is what deferred the async-growth re-pin ~250ms and
 * left the newest line stranded off-bottom (the "occasional bounce").
 */
const PROGRAMMATIC_ECHO_MS = 100;

export function MessageList({ messages, occupants, selfUserId, selfNames, roomType, replyMode = "flat", onIconClick, onNameClick, onMentionClick, onWorldClick, onTimeClick, onJumpToReply, fontStep, highlightMessageId, onHighlightDone, roomId, threadCategories, activeTopicId, onSetActiveTopic, onPopoutTopic, canModerate = false, canPin = false, canPinMessage = false, pinnedMessageIds, canAdminEdit = false, onQuotePost, forumBuckets, onGoToForumPage, onFlushPendingTopics, onActivateCategory, onStartTopicInCategory, renderTopicComposer, renderNewTopicForm, unreadTopicIds, watchedTopicIds, onToggleTopicWatch, readOnly = false, forumTourAnchors = false, postPermalink, nsfwTintRoomId = null, pairSiblingRoomId = null }: Props) {
  const { t } = useTranslation("chat");
  const ref = useRef<HTMLDivElement | null>(null);
  /**
   * The flat feed's content box (wraps the loader + every message row).
   * Observed by the async-growth re-pin effect below; null in nested
   * (forum) mode, which reads top-down and never end-pins.
   */
  const contentRef = useRef<HTMLDivElement | null>(null);
  /**
   * Whether the reader is parked at the bottom. Updated on every scroll
   * event (and after a programmatic end-pin). The ResizeObserver re-pin
   * consults this so it follows late height growth only while the user
   * is actually at the latest message, and never yanks a history-reader.
   * Determined from user scroll intent, NOT from a post-growth
   * measurement, the growth itself would otherwise push the position
   * past the near-bottom threshold and read as "scrolled away."
   */
  const stickRef = useRef(true);
  // Current user id, so the append-follow can tell the reader's OWN send
  // (always jump to it) apart from someone else's live message (which must
  // NOT yank a reader who has scrolled up to read).
  const myUserId = useChat((s) => s.me?.id ?? null);
  /**
   * Scroll-bookkeeping for flat-mode auto-scroll-vs-preserve. We
   * capture the scroll geometry from BEFORE the upcoming commit and
   * compare it to the new buffer in the layout effect below. This
   * lets us tell apart three transitions:
   *   1. Appended (last id changed, first id unchanged) → scroll to
   *      bottom if the user was already near the bottom; otherwise
   *      leave the position alone so reading older history isn't
   *      interrupted by every live arrival.
   *   2. Prepended (first id changed, last id unchanged) → keep the
   *      same content visible: scrollTop += (newScrollHeight -
   *      prevScrollHeight). Without this the scroll-to-load loader
   *      would jump the user back up to the boundary of every page.
   *   3. Buffer wholesale replacement (room switch, jump-to-message
   *      window swap) → fall through to the default end-pin so the
   *      user lands at the newest content.
   */
  const scrollState = useRef<{ height: number; top: number; firstId: string | null; lastId: string | null } | null>(null);
  // Bottom re-pin bookkeeping (see the ResizeObserver further below). The
  // pin is coalesced into a single pending handle (rAF or timeout id), and
  // it cooperates with the scroll listener: any programmatic scroll (the
  // re-pin AND every framework end-pin / prepend adjust) emits a scroll event
  // we must NOT read as user intent, and a recent USER scroll defers the pin
  // so it never fights an in-progress drag.
  const pinHandleRef = useRef<number | null>(null);
  // performance.now() of our last framework-initiated scrollTop write. A
  // scroll event within PROGRAMMATIC_ECHO_MS of it is that write's echo, not
  // user intent. A timestamp (vs a one-shot boolean) can't wedge true when a
  // write lands as a no-op — no echo fires to clear the flag — and then
  // swallow a later real user scroll; it simply expires.
  const programmaticScrollAtRef = useRef(0);
  const lastUserScrollTsRef = useRef(0);
  // Scroll DIRECTION bookkeeping. A forced re-pin (container resize) uses these
  // to tell a mobile address-bar reveal DURING a scroll-up (don't yank the
  // reader back to the newest line) from composer auto-grow (which never moves
  // the feed up, so it should still re-pin instantly). Without it, every mobile
  // scroll-up got grabbed back to the bottom in its first pixels — the "scroll
  // up is resistive" report.
  const lastScrollTopRef = useRef(0);
  const lastUpScrollAtRef = useRef(0);
  // Mirror `messages` into a ref so the live scroll listener below can
  // read the current array without re-binding on every change (cheap,
  // but binds dozens of times per second in active rooms). The
  // listener closes over `messagesRef` once at attach time; reading
  // `.current` gives it the up-to-date buffer.
  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  // Mirror replyMode too, so the (once-attached) scroll listener can tell flat
  // chat from the nested forum view without re-binding. Forums read top-down and
  // keep native anchoring off (as before); only flat chat toggles it.
  const replyModeRef = useRef(replyMode);
  useEffect(() => { replyModeRef.current = replyMode; }, [replyMode]);
  // Capture pre-commit geometry every render. Runs after paint, AFTER
  // any layout-effect adjustments fire, so this is the baseline the
  // NEXT render's prepend / append decision compares against.
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      scrollState.current = null;
      return;
    }
    scrollState.current = {
      height: el.scrollHeight,
      top: el.scrollTop,
      firstId: messages[0]?.id ?? null,
      lastId: messages[messages.length - 1]?.id ?? null,
    };
  });
  // ALSO capture geometry on every live scroll event, without this,
  // a user who scrolls UP without triggering a re-render leaves
  // `scrollState.top` at the stale post-render position (e.g.
  // pinned-to-bottom). When the scroll-to-load-older fetch then
  // prepends and re-renders, the layout effect computes
  // `el.scrollTop = prev.top + delta` against the STALE prev.top,
  // landing the user past the new scrollHeight, which clamps to the
  // bottom. That's the "scrolls back to the bottom every time more
  // history loads" symptom. Live-event capture keeps prev.top
  // accurate to wherever the user actually was when the fetch fired.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const capture = () => {
      const msgs = messagesRef.current;
      scrollState.current = {
        height: el.scrollHeight,
        top: el.scrollTop,
        firstId: msgs[0]?.id ?? null,
        lastId: msgs[msgs.length - 1]?.id ?? null,
      };
      // Track parked-at-bottom from the user's own scrolling so the
      // async-growth re-pin below knows whether to follow new content.
      // Uses the TIGHT threshold: the re-pin (reactions, decoding images,
      // late media) should only follow when the reader is genuinely at the
      // bottom, so manually scrolling up even a little releases the stick
      // and stops the "bounce." The looser NEAR_BOTTOM_PX now governs only
      // whether the reader's OWN new message (append, below) scrolls to follow.
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_BOTTOM_PX;
      // Native scroll-anchoring, toggled by where the reader is:
      //   - at the bottom (stick) → OFF: the manual re-pin owns the position
      //     there, and browser anchoring would fight it into a wobble.
      //   - reading history (not stick) → ON: let the browser hold the visible
      //     line steady as gates toggle visibility and late media load ABOVE
      //     the viewport. Without this, every such height change shifts content
      //     with nothing to compensate — the jerky scroll-up. The manual
      //     prepend anchor targets the same position anchoring would, so they
      //     agree rather than fight. (Safari lacks overflow-anchor and simply
      //     ignores this, keeping its current behaviour.)
      el.style.overflowAnchor =
        replyModeRef.current !== "nested" && !stickRef.current ? "auto" : "none";
      // Our own programmatic scrolls — the ResizeObserver re-pin AND the
      // layout effect's end-pin / prepend adjust below — also emit a scroll
      // event; swallow that echo (any scroll within PROGRAMMATIC_ECHO_MS of
      // the write) so it isn't mistaken for user intent. Every OTHER scroll is
      // the reader's, and stamps their last interaction so the re-pin can hold
      // off and never yank a live drag.
      if (performance.now() - programmaticScrollAtRef.current >= PROGRAMMATIC_ECHO_MS) {
        lastUserScrollTsRef.current = performance.now();
      }
      // Track scroll DIRECTION (down-clamped for a couple px of noise) so the
      // forced re-pin can stand down during an active scroll-up (a mobile
      // address-bar reveal) instead of grabbing the reader back to the bottom.
      const prevTop = lastScrollTopRef.current;
      lastScrollTopRef.current = el.scrollTop;
      if (el.scrollTop < prevTop - 2) lastUpScrollAtRef.current = performance.now();
    };
    el.addEventListener("scroll", capture, { passive: true });
    return () => el.removeEventListener("scroll", capture);
  }, []);

  // Apply scroll adjustment for the new buffer. useLayoutEffect (not
  // useEffect) so the position fix happens BEFORE the browser paints,
  // an effect-based fix would let the user see the layout jump for one
  // frame on every prepend.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Forums read TOP-DOWN: never end-pin or auto-scroll the nested
    // view. The chat heuristics below (end-pin on append/replace) were
    // yanking the forum list downward whenever the buffer changed —
    // e.g. the Forums Catalog hydrating a topic's replies — jerking the
    // reader away from the topic they just expanded.
    if (replyMode === "nested") return;
    if (highlightMessageId) return; // jump-to-message owns scroll
    const prev = scrollState.current;
    const newFirstId = messages[0]?.id ?? null;
    const newLastId = messages[messages.length - 1]?.id ?? null;
    if (!prev || !prev.firstId || !prev.lastId) {
      // Initial mount or empty → end-pin.
      programmaticScrollAtRef.current = performance.now(); // our write; swallow its echo
      el.scrollTop = el.scrollHeight;
      stickRef.current = true;
      el.style.overflowAnchor = "none"; // parked at bottom → manual pin owns it
      return;
    }
    const firstChanged = newFirstId !== prev.firstId;
    const lastChanged = newLastId !== prev.lastId;
    if (firstChanged && !lastChanged) {
      // Prepend: anchor the existing content under the user's eyes. Reading
      // history → let native anchoring stay on to absorb the prepended (and
      // still-settling) rows' height churn; it targets the same position.
      const delta = el.scrollHeight - prev.height;
      programmaticScrollAtRef.current = performance.now(); // our write; swallow its echo
      el.scrollTop = prev.top + delta;
      el.style.overflowAnchor = stickRef.current ? "none" : "auto";
      return;
    }
    if (lastChanged) {
      // Follow the newest line only when the reader is genuinely parked at
      // the bottom (tight stickRef band) OR the newest line is the reader's
      // OWN send (jump them to it even a few lines up). A live message from
      // SOMEONE ELSE no longer yanks a reader who has scrolled up: the old
      // loose 120px "near bottom" follow fired for anyone's arrival, which
      // was the "scroll up and it jumps right back to the end" report.
      const dist = prev.height - prev.top - el.clientHeight;
      const newestIsMine = myUserId != null && messages[messages.length - 1]?.userId === myUserId;
      // Full-replacement: BOTH endpoints changed (room switch, jump-window
      // swap). End-pin so the user lands at the newest.
      const replaced = firstChanged && lastChanged;
      if (replaced || dist <= STICK_BOTTOM_PX || (newestIsMine && dist < NEAR_BOTTOM_PX)) {
        // Mark our write so its (async) scroll echo isn't read as a user
        // scroll: unmarked, the echo stamped lastUserScrollTsRef and tripped
        // the re-pin's "user just scrolled" deferral, delaying the follow-up
        // late-media re-pin ~250ms and stranding the newest line off-bottom
        // until the timer snapped it back.
        programmaticScrollAtRef.current = performance.now();
        el.scrollTop = el.scrollHeight;
        // Re-arm the stick so the async-growth re-pin keeps following this
        // append's late-loading media (capture() swallows this write's echo,
        // so it won't re-arm stick on its own).
        stickRef.current = true;
        el.style.overflowAnchor = "none"; // back at bottom → manual pin owns it
      }
    }
    // first AND last unchanged → no buffer changes that affect layout
    // (an in-place message edit, for example). Leave scroll alone.
  }, [messages, highlightMessageId, replyMode, myUserId]);

  // A font-size step (the Tools "Size" cycle changes FONT_EM on the scroll
  // container) re-wraps every visible row taller/shorter at once. That growth
  // changes neither the first nor last message id, so the buffer-diff layout
  // effect above leaves scroll alone; the async re-pin below would then paint
  // one bounced frame (newest line shoved off-screen) before catching up.
  // Re-pin synchronously here — a layout effect runs before paint — while
  // parked at the bottom, so the resize is seamless. Forums (nested) opt out.
  useLayoutEffect(() => {
    if (replyMode === "nested") return;
    if (highlightMessageId) return; // jump-to-message owns scroll
    if (!stickRef.current) return; // reading history → don't yank to bottom
    const el = ref.current;
    if (!el) return;
    programmaticScrollAtRef.current = performance.now(); // our write; swallow its echo
    el.scrollTop = el.scrollHeight;
  }, [fontStep, replyMode, highlightMessageId]);

  // Keep the flat feed pinned to the newest line after LATE height
  // growth the buffer-diff effect above can't see: avatars / inline
  // images finishing load, link-preview cards mounting via
  // message:update, emoji sheets swapping in. Each grows the feed
  // WITHOUT changing the first/last message id, so the layout effect
  // leaves scroll alone and the newest post drifts below the fold; then
  // the next arrival's near-bottom test fails (the drift already pushed
  // the position past the threshold) and the reader is stranded a few
  // posts up, the "won't stay at the bottom / pops up several posts"
  // report. A ResizeObserver on the content box re-pins on height changes
  // while the user is parked at the bottom (stickRef), and no-ops the
  // instant they scroll away. Forums (nested) read top-down and opt out.
  //
  // HISTORY: setting scrollTop moves the viewport, which flips
  // MessageVisibilityGate intersection states. The gate USED to mount/unmount
  // message bodies, so a flip changed the feed height and re-fired this
  // observer; writing scrollTop unconditionally turned that into a runaway
  // observe→pin→gate-flip→observe loop (the "seizure" shake) that also stole
  // manual scrolling. The gate now toggles content-visibility with a reserved
  // intrinsic-size instead, so a flip is height-neutral and that loop is
  // broken at the source. The three hardenings below are kept as
  // defense-in-depth and to tame the OTHER height-change sources (late media,
  // container resize):
  //   (a) coalesced to ONE write per frame (rAF), never re-entrant;
  //   (b) skipped once we're already within a pixel of the bottom, so a
  //       settled feed stops writing;
  //   (c) deferred for a beat after any USER scroll, so it never hijacks
  //       an in-progress drag (mobile momentum especially) — then fires
  //       once when the reader settles so late media still lands at bottom.
  useLayoutEffect(() => {
    if (replyMode === "nested") return;
    const el = ref.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    const REPIN_AFTER_USER_MS = 250;
    // A forced re-pin stands down if the reader scrolled UP within this window —
    // enough to cover a mobile address-bar reveal that fires a beat after the
    // scroll gesture. (Composer auto-grow never scrolls the feed up, so typing
    // still re-pins instantly.)
    const RECENT_UP_SCROLL_MS = 400;
    // Set true when a CONTAINER resize (composer auto-grow as you type, or a
    // window resize) schedules the pin. A layout resize is NOT a user drag,
    // so the pin must re-stick immediately and BYPASS the "reader just
    // scrolled, let them settle" deferral below. Without this, the container
    // resize is mistaken for a user scroll (it nudges scrollTop), the pin
    // defers the whole time you're typing, the feed sits a line or two off
    // the bottom, and it only snaps back ~250ms after you stop typing.
    let forceNextPin = false;
    const pin = () => {
      pinHandleRef.current = null;
      if (!stickRef.current || highlightMessageId) { forceNextPin = false; return; } // jump owns scroll
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (dist <= 2) { forceNextPin = false; return; } // (b) already pinned — don't re-trigger the gates
      // A FORCED pin (container resize) stands down if the reader just scrolled
      // UP: that's a mobile address-bar reveal during a scroll-up, not composer
      // auto-grow (which never moves the feed up). Stops the re-pin from grabbing
      // the reader back to the bottom as they try to leave it.
      if (forceNextPin && performance.now() - lastUpScrollAtRef.current < RECENT_UP_SCROLL_MS) {
        forceNextPin = false;
        return;
      }
      const sinceUser = performance.now() - lastUserScrollTsRef.current;
      if (!forceNextPin && sinceUser < REPIN_AFTER_USER_MS) {
        // (c) reader just scrolled (a real drag): let them settle, then pin once.
        pinHandleRef.current = window.setTimeout(
          () => { pinHandleRef.current = null; pin(); },
          REPIN_AFTER_USER_MS - sinceUser + 16,
        );
        return;
      }
      forceNextPin = false;
      programmaticScrollAtRef.current = performance.now(); // mark the scroll-echo as ours
      el.scrollTop = el.scrollHeight;
    };
    // Track the container's last height (to ignore sub-line wobble) and width.
    // A pure WIDTH change re-wraps rows taller without touching clientHeight —
    // desktop horizontal resize, browser zoom, device rotation, or the
    // vertical scrollbar first appearing — so height alone can't detect it.
    let lastContainerH = el.clientHeight;
    let lastContainerW = el.clientWidth;
    // Pixels the CONTAINER must change by before we re-pin. The composer
    // auto-grow re-measures on every keystroke and can jitter by a few px
    // (min-height vs scrollHeight rounding, the overflowY scrollbar
    // toggling near max-lines); re-pinning on that micro-wobble made the
    // feed "bounce" while typing. A real line grow/shrink is ~a line tall,
    // well over this, so it still pins; content-box growth (late media) is
    // never gated this way.
    const CONTAINER_REPIN_MIN_DELTA = 10;
    const ro = new ResizeObserver((entries) => {
      if (pinHandleRef.current != null) return; // (a) one pending pin at a time
      let shouldPin = false;
      for (const e of entries) {
        if (e.target === el) {
          // Container (scroll viewport): react to a meaningful HEIGHT resize
          // OR any WIDTH change (width re-wraps rows → grows content height),
          // and force an IMMEDIATE re-stick (a resize is a layout change, not
          // a user drag — don't let the user-scroll deferral hold it off).
          const h = el.clientHeight;
          const w = el.clientWidth;
          if (Math.abs(h - lastContainerH) >= CONTAINER_REPIN_MIN_DELTA || w !== lastContainerW) {
            shouldPin = true;
            forceNextPin = true;
          }
          lastContainerH = h;
          lastContainerW = w;
        } else {
          // Content box: late media / gate mounts. Only schedule a pin while
          // parked at the BOTTOM (stickRef) — while reading history the pin
          // would no-op anyway, so scheduling it on every gate visibility flip
          // during a scroll-up just thrashes rAF + layout reads and stutters
          // the scroll (the "resistive scroll-up", desktop especially, where
          // there's no address bar in play). Container resizes above still
          // force a re-check regardless of stick.
          if (stickRef.current) shouldPin = true;
        }
      }
      if (!shouldPin) return;
      pinHandleRef.current = requestAnimationFrame(pin);
    });
    // Observe the CONTENT box (late media grows the stream)
    // AND the scroll CONTAINER itself (composer auto-grow / window resize
    // shrink it; with `overflow-anchor: none` the browser won't re-pin for
    // us). Setting scrollTop never resizes the container, so no loop.
    ro.observe(content);
    ro.observe(el);
    return () => {
      ro.disconnect();
      // The handle is a rAF id or a timeout id; both cancelers ignore an
      // id minted by the other, so calling both is safe.
      if (pinHandleRef.current != null) {
        cancelAnimationFrame(pinHandleRef.current);
        clearTimeout(pinHandleRef.current);
        pinHandleRef.current = null;
      }
    };
  }, [replyMode, highlightMessageId]);

  // Window the in-memory buffer back down once it grows past HARD_CAP,
  // but ONLY while the reader is parked at the bottom. Dropping the
  // oldest rows is invisible there (they're far above the fold), keeps
  // the row count + per-message observers bounded over a long live
  // session, and is lossless: the rows re-hydrate via the scroll-up
  // load-older fetch. Gated on stickRef so a history-reader's
  // just-loaded older page is never yanked out from under them, and so
  // the trim → load-older → trim thrash can't start. The front-trim
  // re-renders as a "prepend in reverse" the layout effect anchors,
  // and the bottom stays pinned via the same end-pin path as an append.
  const trimRoomToRecent = useChat((s) => s.trimRoomToRecent);
  useEffect(() => {
    if (replyMode === "nested") return;
    if (!roomId) return;
    if (!stickRef.current) return;
    if (messages.length <= FLAT_BUFFER_HARD_CAP) return;
    trimRoomToRecent(roomId, FLAT_BUFFER_SOFT_CAP);
    // Staff pair oversight: the rendered feed is TWO buckets merged, and
    // mirrored live rows keep appending to the sibling's. Trim it too, or
    // a staffer parked in one side of a busy pair grows the sibling
    // bucket without bound (and the cap check above, driven by the merged
    // length, would keep no-op trimming just the joined room).
    if (pairSiblingRoomId) trimRoomToRecent(pairSiblingRoomId, FLAT_BUFFER_SOFT_CAP);
  }, [messages, roomId, replyMode, trimRoomToRecent, pairSiblingRoomId]);

  // Jump-to-message flash. When `highlightMessageId` flips to a value
  // present in the current buffer, find the row's DOM node, scroll it to
  // center, and paint a brief accent tint. The transition-colors classes
  // on the row itself (see Line) handle the fade-out; we only toggle the
  // background class. Cleared via onHighlightDone after the flash window.
  useEffect(() => {
    if (!highlightMessageId) return;
    // A jump anchors the view on a specific message, so the viewer is NOT
    // following the live bottom. Clear the end-pin: a cross-room jump (e.g. a
    // mention notification) end-pins during the room switch, so without this
    // the late-growth re-pin effect would yank the view back to the newest line
    // the moment avatars/images in the jumped-to window finish loading (and
    // once the flash clears `highlightMessageId` stops suppressing it) — making
    // the jump look like it "didn't scroll to the message".
    stickRef.current = false;
    const container = ref.current;
    if (!container) return;
    const node = container.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(highlightMessageId)}"]`,
    );
    if (!node) {
      // Target not rendered YET. The forum view may be expanding a
      // capped reply window for this exact highlight (TopicCard's
      // auto-expand keys on highlightMessageId in the same commit), so
      // give the DOM one frame before giving up — without the retry,
      // quote-reference jumps into "view earlier replies" territory
      // cleared the flag before the row existed.
      const raf = requestAnimationFrame(() => {
        const late = container.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(highlightMessageId)}"]`,
        );
        if (!late) { onHighlightDone?.(); return; }
        late.scrollIntoView({ behavior: "smooth", block: "center" });
        late.classList.add("bg-keep-action/30");
        window.setTimeout(() => {
          late.classList.remove("bg-keep-action/30");
          onHighlightDone?.();
        }, 1800);
      });
      return () => cancelAnimationFrame(raf);
    }
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.classList.add("bg-keep-action/30");
    const t = window.setTimeout(() => {
      node.classList.remove("bg-keep-action/30");
      onHighlightDone?.();
    }, 1800);
    return () => {
      window.clearTimeout(t);
      node.classList.remove("bg-keep-action/30");
    };
  }, [highlightMessageId, onHighlightDone, messages]);

  // Whisper attention flash. Pulses any inbound whisper (`toUserId ===
  // selfUserId`) the first time it appears in the buffer for this
  // session. Ref-tracked Set ensures we never flash the same message
  // twice, a buffer swap (jump-to-message, history reload, room
  // re-join) re-renders the same id and would otherwise re-flash. We
  // also seed the Set on first sight with anything older than the
  // freshness window so backlog whispers loaded on join don't all
  // flash at once. The CSS animation is one-shot; we remove the class
  // after it completes so the resting `bg-keep-action/15` (applied
  // statically on the row) takes back over cleanly.
  const flashedWhispersRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!selfUserId) return;
    const container = ref.current;
    if (!container) return;
    const now = Date.now();
    const FRESH_WINDOW_MS = 5_000;
    const ANIM_MS = 1_600;
    const pendingCleanups: Array<() => void> = [];
    for (const m of messages) {
      if (m.kind !== "whisper") continue;
      if (m.toUserId !== selfUserId) continue;
      if (flashedWhispersRef.current.has(m.id)) continue;
      // Mark every whisper-to-me we encounter (fresh or backlog) so
      // future renders never reconsider it. Skip the visual flash
      // when it's outside the freshness window, that's backlog
      // (loaded via message:bulk after a room join), not a live
      // arrival worth flagging.
      flashedWhispersRef.current.add(m.id);
      if (now - m.createdAt > FRESH_WINDOW_MS) continue;
      const node = container.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(m.id)}"]`,
      );
      if (!node) continue;
      node.classList.add("animate-whisper-flash");
      const t = window.setTimeout(() => {
        node.classList.remove("animate-whisper-flash");
      }, ANIM_MS);
      pendingCleanups.push(() => window.clearTimeout(t));
    }
    return () => {
      for (const c of pendingCleanups) c();
    };
  }, [messages, selfUserId]);

  const { genderByUser, adminUserIds, styleByIdentity, cosmeticsByIdentity, genderByIdentity } = buildOccupantMaps(occupants);
  // Fall back to an empty list when the caller doesn't supply selfNames
  // (e.g. pre-auth or older callers), every mention then renders in the
  // default keep-action style.
  const effectiveSelfNames: ReadonlyArray<string> = selfNames ?? NO_SELF_NAMES;

  // Shared per-line prop bundle so the flat and nested branches can both
  // hand the same callbacks down without repeating themselves.
  function lineFor(m: ChatMessage) {
    // Look the style / cosmetics up by the message's full identity
    // tuple. Messages carry both userId and characterId snapshotted
    // at send time (characterId is null when the user posted OOC).
    // A miss here means the identity isn't in the current occupant
    // list, falls through to plain rendering, same as gender.
    const idKey = identityKey(m.userId, m.characterId);
    // Staff pair oversight: rows merged in from the 18+ channel carry a
    // red wash (the RatingChip red at hover-row opacity) so a staffer
    // scanning the combined feed can tell the channels apart at a glance.
    // Whispers are excluded: the wire RE-KEYS every whisper the viewer is
    // party to onto the loaded room, so a private exchange from a SFW
    // lobby would otherwise wear the 18+ wash while the staffer stands
    // in the annex — mislabeling where it actually happened.
    const nsfwChannelRow = nsfwTintRoomId != null && m.roomId === nsfwTintRoomId && m.kind !== "whisper";
    const line = (
      <Line
        msg={m}
        gender={genderByIdentity.get(idKey) ?? genderByUser.get(m.userId) ?? "undisclosed"}
        nameStyle={styleByIdentity.get(idKey) ?? null}
        senderCosmetics={cosmeticsByIdentity.get(idKey) ?? null}
        // Staff italic only when speaking AS the master (characterId
        // === null). Italicizing a character voice would leak the
        // OOC ↔ character link, same partition rule applied to the
        // RoomsTree staff crown.
        isSenderAdmin={m.characterId === null && adminUserIds.has(m.userId)}
        isRecipientAdmin={!!m.toUserId && adminUserIds.has(m.toUserId)}
        isOwn={!!selfUserId && m.userId === selfUserId}
        // True iff the viewer is the addressed recipient on a whisper.
        // Used to tint the row so the conversation thread visually
        // groups the viewer's own incoming whispers among the noise.
        isRecipient={!!selfUserId && m.toUserId === selfUserId}
        canReport={roomType === "public"}
        canModerate={canModerate}
        canAdminEdit={canAdminEdit}
        canPinMessage={canPinMessage}
        isPinned={!!pinnedMessageIds?.has(m.id)}
        onIconClick={onIconClick}
        onNameClick={onNameClick}
        onMentionClick={onMentionClick}
        onWorldClick={onWorldClick}
        onTimeClick={onTimeClick}
        {...(onJumpToReply ? { onJumpToReply } : {})}
        selfNames={effectiveSelfNames}
      />
    );
    return nsfwChannelRow ? (
      <div className="rounded bg-[#e06070]/10" title={t("feed.nsfwChannelRow")}>
        {line}
      </div>
    ) : line;
  }

  // Nested-mode rooms render as a forum. The TOPIC list comes from
  // `forumBuckets` (paginated by `lastActivityAt DESC` via the
  // `/rooms/:id/topics` endpoint, fed by the App-level fetch effect).
  // REPLIES still come from the chat-message backlog (`messages`) so
  // live replies from socket events appear in expanded topics without
  // a refetch.
  //
  // Defense-in-depth filters on REPLIES (the topic stream is already
  // filtered server-side):
  //   1. Drop `kind: "system"`, belt-and-suspenders alongside the
  //      server-side suppression for forum rooms.
  //   2. Drop replies whose parent topic is in the deleted set
  //      (a topic can be soft-deleted while its reply rows are still
  //      in the chat buffer; we shouldn't render those replies under
  //      any topic since the topic itself is hidden).
  if (replyMode === "nested") {
    // Build a set of deleted-topic ids from the chat backlog too,
    // the topics endpoint excludes deletes, but the chat buffer may
    // still carry the deleted topic row from when it was first sent.
    const deletedTopicIds = new Set(
      messages.filter((m) => !m.replyToId && m.deletedAt).map((m) => m.id),
    );
    const forumReplies = messages.filter((m) => {
      if (m.kind === "system") return false;
      if (!m.replyToId) return false; // topics come from forumBuckets, not here
      if (deletedTopicIds.has(m.replyToId)) return false;
      return true;
    });
    return (
      <ForumView
        scrollRef={ref}
        replies={forumReplies}
        buckets={forumBuckets ?? {}}
        categories={threadCategories ?? []}
        roomId={roomId ?? null}
        fontStep={fontStep}
        activeTopicId={activeTopicId ?? null}
        onSetActiveTopic={onSetActiveTopic ?? (() => {})}
        onPopoutTopic={onPopoutTopic ?? (() => {})}
        onGoToForumPage={onGoToForumPage ?? (() => {})}
        onFlushPendingTopics={onFlushPendingTopics ?? (() => {})}
        onActivateCategory={onActivateCategory ?? (() => {})}
        onStartTopicInCategory={onStartTopicInCategory ?? (() => {})}
        canModerate={canModerate}
        canPin={canPin}
        canAdminEdit={canAdminEdit}
        {...(onQuotePost ? { onQuotePost } : {})}
        {...(onJumpToReply ? { onJumpToReply } : {})}
        {...(renderTopicComposer ? { renderTopicComposer } : {})}
        {...(renderNewTopicForm ? { renderNewTopicForm } : {})}
        {...(unreadTopicIds ? { unreadTopicIds } : {})}
        {...(watchedTopicIds ? { watchedTopicIds } : {})}
        {...(onToggleTopicWatch ? { onToggleTopicWatch } : {})}
        readOnly={readOnly}
        forumTourAnchors={forumTourAnchors}
        {...(postPermalink ? { postPermalink } : {})}
        highlightMessageId={highlightMessageId ?? null}
        genderByUser={genderByUser}
        adminUserIds={adminUserIds}
        selfUserId={selfUserId}
        selfNames={effectiveSelfNames}
        roomType={roomType ?? null}
        onIconClick={onIconClick}
        onNameClick={onNameClick}
        onMentionClick={onMentionClick}
        onWorldClick={onWorldClick}
        onTimeClick={onTimeClick}
      />
    );
  }

  // Flat mode: existing chronological rendering with scroll-to-top
  // history pagination. The /rooms/:id/messages?before= endpoint serves
  // older pages; we trigger a fetch when the user scrolls within
  // SCROLL_TRIGGER_PX of the top edge, prepend the page via
  // store.prependMessages, and the layout effect above preserves their
  // scroll position so the new content slides in above without yanking
  // their eyes.
  return (
    <FlatMessageView
      scrollRef={ref}
      contentRef={contentRef}
      messages={messages}
      roomId={roomId ?? null}
      fontStep={fontStep}
      lineFor={lineFor}
    />
  );
}

/** Overflow slack for the auto-fill check (does the buffer scroll at all). */
const FLAT_LOAD_OLDER_THRESHOLD_PX = 200;
/** Prefetch the next older page while still this far from the top, so history
 *  streams in continuously as the reader scrolls up instead of stalling at the
 *  very top and then jumping. ~1 screen; pairs with the gate's 1500px mount
 *  padding so the rows are mounted before they scroll into view. */
const FLAT_PREFETCH_AHEAD_PX = 1000;

/**
 * Flat-mode renderer extracted so it can own the scroll-to-load-older
 * state (loading flag, error string) without polluting MessageList's
 * shared body. The shared scroll-position math lives on MessageList
 * (it applies to BOTH flat and nested-reply modes), so we forward the
 * scroll ref instead of holding our own.
 */
function FlatMessageView({
  scrollRef,
  contentRef,
  messages,
  roomId,
  fontStep,
  lineFor,
}: {
  scrollRef: React.MutableRefObject<HTMLDivElement | null>;
  /** Content-box ref the parent observes to re-pin to bottom on late
   *  height growth (image loads, link cards). See MessageList. */
  contentRef: React.MutableRefObject<HTMLDivElement | null>;
  messages: ChatMessage[];
  roomId: string | null;
  fontStep: 0 | 1 | 2 | 3;
  lineFor: (m: ChatMessage) => ReactNode;
}) {
  const { t } = useTranslation("chat");
  const hasMore = useChat((s) => (roomId ? (s.roomHistoryHasMore[roomId] ?? false) : false));
  const prependMessages = useChat((s) => s.prependMessages);
  const setRoomHistoryHasMore = useChat((s) => s.setRoomHistoryHasMore);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  // Latch in a ref so the onScroll handler can early-out without
  // re-rendering. setState alone would race: scroll events fire faster
  // than React can commit a flag.
  const inflightRef = useRef(false);

  const loadOlder = useCallback(async () => {
    if (!roomId) return;
    if (inflightRef.current) return;
    if (!hasMore) return;
    // Cursor from the RENDERED feed (the `messages` prop), not the raw
    // room bucket: under staff pair oversight the feed is the pair's two
    // buckets merged, and the true "oldest visible" row may live in the
    // sibling bucket.
    const oldest = messages[0];
    if (!oldest) return;
    inflightRef.current = true;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const r = await fetch(`/rooms/${roomId}/messages?before=${oldest.createdAt}&limit=100`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { messages: ChatMessage[]; hasMore: boolean };
      // Bucket by each row's OWN roomId: a staff pair-oversight page mixes
      // both channels' rows. Ordinary pages are single-room, so this is
      // the same single prepend as before.
      const byRoom = new Map<string, ChatMessage[]>();
      for (const m of j.messages) {
        const list = byRoom.get(m.roomId);
        if (list) list.push(m);
        else byRoom.set(m.roomId, [m]);
      }
      for (const [rid, rows] of byRoom) prependMessages(rid, rows);
      setRoomHistoryHasMore(roomId, j.hasMore);
    } catch (e) {
      setOlderError(e instanceof Error ? e.message : t("feed.loadFailed"));
    } finally {
      inflightRef.current = false;
      setLoadingOlder(false);
    }
  }, [roomId, hasMore, messages, prependMessages, setRoomHistoryHasMore, t]);

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    if (!hasMore || inflightRef.current) return;
    // Prefetch ~1 screen BEFORE the top so the next batch is already resident
    // as the reader scrolls into it — no stall-at-top-then-jump.
    if (e.currentTarget.scrollTop <= FLAT_PREFETCH_AHEAD_PX) {
      void loadOlder();
    }
  }

  // Auto-fill the viewport: if the current message buffer doesn't
  // overflow the scroll container (a fresh room with fewer visible
  // messages than the screen can hold, common on mobile after
  // server-side ignore/whisper filtering trims the post-50-row
  // backlog), the user CAN'T scroll, so the scrollTop-based trigger
  // above never fires. Auto-load older pages here until either the
  // content overflows OR the server says there's nothing older.
  //
  // Guards: only trigger after the buffer has been populated (`hasMore`
  // becomes true), one load at a time (the loadOlder() guard handles
  // that), and only after the layout has settled (rAF lets the DOM
  // measure the freshly-prepended page before we re-check).
  useEffect(() => {
    if (!hasMore || loadingOlder || messages.length === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      const e2 = scrollRef.current;
      if (!e2) return;
      if (e2.scrollHeight <= e2.clientHeight + FLAT_LOAD_OLDER_THRESHOLD_PX) {
        void loadOlder();
      }
    });
    return () => cancelAnimationFrame(id);
  }, [hasMore, loadingOlder, messages.length, loadOlder, scrollRef]);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      // `pb-7` (~28px) reserves clearance at the bottom of the feed so
      // the absolutely-positioned TypingIndicator (anchored to the
      // relative wrapper in App.tsx) overlays empty space instead of
      // the last message. Discord-style: the strip is always-floating,
      // chat always reserves a small bottom gutter; no jitter when the
      // typing strip toggles, and the last message stays visible even
      // when the strip is active.
      className="flex-1 overflow-y-auto px-4 pb-7 pt-2 leading-relaxed"
      // `overflow-anchor` is managed IMPERATIVELY (not set here) so React
      // re-renders don't clobber the live value: it's toggled OFF while parked
      // at the bottom (the manual re-pin owns the position, and anchoring would
      // fight it into a wobble) and ON while reading history (so the browser
      // keeps the visible line steady as gates toggle visibility and late media
      // load above the viewport, instead of jerking the reader). See the scroll
      // capture + layout effect in MessageList. Default is the browser's `auto`
      // until the first pin flips it to `none`.
      style={{ fontSize: FONT_EM[fontStep] }}
    >
      {/* Content box the parent's ResizeObserver watches to keep the
          feed pinned to the newest line as late-loading media grows the
          height. A plain wrapper, no layout effect of its own (the
          scroll container keeps the padding + scroll). */}
      <div ref={contentRef}>
      {hasMore || loadingOlder ? (
        <div className="mb-1 flex items-center justify-center gap-2 text-[10px] uppercase tracking-widest text-keep-muted">
          {loadingOlder ? (
            <span>{t("feed.loadingEarlier")}</span>
          ) : olderError ? (
            <button
              type="button"
              onClick={() => { void loadOlder(); }}
              className="rounded border border-keep-accent/40 px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10"
              title={olderError}
            >
              {t("feed.retryEarlier")}
            </button>
          ) : (
            // Clickable so a touch user whose viewport can't scroll
            // (no overflow) still has a manual trigger. The
            // auto-fill effect above usually handles this for them,
            // but the button is a no-cost safety net.
            <button
              type="button"
              onClick={() => { void loadOlder(); }}
              className="rounded px-2 py-0.5 hover:text-keep-text"
            >
              {t("feed.tapForEarlier")}
            </button>
          )}
        </div>
      ) : messages.length > 0 ? (
        <div className="mb-1 flex items-center justify-center text-[10px] uppercase tracking-widest text-keep-muted/60">
          {t("feed.startOfHistory")}
        </div>
      ) : null}
      {messages.map((m) => (
        // Each message rides through a viewport-aware gate that
        // skips paint/layout for the line's heavy DOM (embeds, sprite
        // images, bordered avatars, name-style decorations) when
        // scrolled far away, Discord-style. The gate reserves the row's
        // measured height while skipped so scroll position never jumps.
        <MessageVisibilityGate key={m.id}>{lineFor(m)}</MessageVisibilityGate>
      ))}
      </div>
    </div>
  );
}

/**
 * Display label for a topic. Falls back to a body excerpt when the
 * message has no title (legacy rows from before the forum schema, or
 * any topic created via slash command without a /topic title arg).
 */
export function topicHeading(m: ChatMessage): string {
  const t = m.title?.trim();
  if (t) return t;
  const body = m.body.trim();
  // i18n instance (not a hook): this helper is exported to non-chat
  // callers (ThreadModal) whose signature must stay `(m) => string`.
  if (!body) return i18n.t("chat:forum.untitled");
  return body.length <= 80 ? body : `${body.slice(0, 80)}…`;
}

/**
 * Forum-mode renderer. Top-level messages with a title (or any chat-
 * kind top-level row in a forum room, we treat title-less legacy rows
 * as untitled topics) render as forum cards grouped by category.
 * Clicking a card's header sets it as the active topic, which expands
 * to show the body + reply chain underneath. The active topic gets a
 * visual highlight so the user always knows which thread they're
 * reading. Replies to other topics stay tucked inside their (collapsed)
 * parent, you only see one expanded topic at a time.
 *
 * Collapse state for the *category sections* persists per `(roomId,
 * categoryId)` in localStorage; topic expanded-state is driven by
 * `activeTopicId` (single source of truth lives in App.tsx).
 */
interface ForumBucket {
  topics: ChatMessage[];
  hasMore: boolean;
  loading: boolean;
  pending: ChatMessage[];
  currentPage: number;
  totalPages: number;
  totalCount: number;
  perPage: number;
}

/**
 * Numbered pagination strip for a forum category. Reads like:
 *
 *   ‹ Prev   1  2  3  …  17   Next ›       Page 3 of 17 · 340 topics
 *
 * For small totals every page button shows; once totalPages crosses
 * the visible-window threshold we collapse the middle stretch with
 * `…` markers. The page-list builder below picks a 1-2-…-(cur-1)-cur-
 * (cur+1)-…-N shape that always anchors the first and last page.
 *
 * Disabling rules:
 *   - Prev is disabled on page 1.
 *   - Next is disabled on the last page.
 *   - The currently-active page button is non-interactive.
 *   - All controls disable when the bucket is mid-fetch so a quick
 *     double-click can't race two requests.
 */
function ForumPaginationStrip({
  sectionKey,
  currentPage,
  totalPages,
  totalCount,
  isLoading,
  onGoToPage,
}: {
  sectionKey: string;
  currentPage: number;
  totalPages: number;
  totalCount: number;
  isLoading: boolean;
  onGoToPage: (page: number) => void;
}) {
  const { t } = useTranslation("chat");
  const pageList = buildForumPageList(currentPage, totalPages);
  return (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-keep-rule/30 pt-2">
      <nav
        aria-label={sectionKey === "_uncat" ? t("forum.pageNavUncategorized") : t("forum.pageNavCategory")}
        className="flex flex-wrap items-center gap-1"
      >
        <button
          type="button"
          onClick={() => onGoToPage(currentPage - 1)}
          disabled={isLoading || currentPage <= 1}
          className="rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-0.5 text-[11px] uppercase tracking-widest text-keep-muted hover:bg-keep-banner hover:text-keep-text disabled:cursor-not-allowed disabled:opacity-40"
          title={t("forum.prevPageTitle")}
        >
          {t("forum.prev")}
        </button>
        {pageList.map((entry, i) =>
          entry === "ellipsis" ? (
            <span
              key={`ellipsis-${i}`}
              aria-hidden
              className="px-1 text-[11px] text-keep-muted"
            >
              …
            </span>
          ) : (
            <button
              key={entry}
              type="button"
              onClick={() => onGoToPage(entry)}
              disabled={isLoading || entry === currentPage}
              aria-current={entry === currentPage ? "page" : undefined}
              className={
                entry === currentPage
                  ? "rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-keep-action"
                  : "rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-0.5 text-[11px] tabular-nums text-keep-muted hover:bg-keep-banner hover:text-keep-text disabled:cursor-not-allowed disabled:opacity-50"
              }
              title={t("forum.goToPage", { page: entry })}
            >
              {entry}
            </button>
          ),
        )}
        <button
          type="button"
          onClick={() => onGoToPage(currentPage + 1)}
          disabled={isLoading || currentPage >= totalPages}
          className="rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-0.5 text-[11px] uppercase tracking-widest text-keep-muted hover:bg-keep-banner hover:text-keep-text disabled:cursor-not-allowed disabled:opacity-40"
          title={t("forum.nextPageTitle")}
        >
          {t("forum.next")}
        </button>
      </nav>
      <span className="text-[10px] uppercase tracking-widest text-keep-muted tabular-nums">
        {t("forum.pageOfTopics", { page: currentPage, pages: totalPages, total: formatNumber(totalCount), count: totalCount })}
      </span>
    </div>
  );
}

/**
 * Returns the visible page-button list. Always anchors page 1 and
 * `totalPages`; shows two neighbors of `currentPage` in the middle;
 * collapses everything in between with `"ellipsis"` markers. With
 * `totalPages` of 7 or fewer every page is listed without collapse.
 *
 * Examples (current = 5, totalPages varies):
 *   totalPages = 5:  [1, 2, 3, 4, 5]
 *   totalPages = 7:  [1, 2, 3, 4, 5, 6, 7]
 *   totalPages = 17: [1, "ellipsis", 4, 5, 6, "ellipsis", 17]
 *   totalPages = 17, current = 2: [1, 2, 3, 4, "ellipsis", 17]
 */
function buildForumPageList(currentPage: number, totalPages: number): Array<number | "ellipsis"> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const out: Array<number | "ellipsis"> = [1];
  const left = Math.max(2, currentPage - 1);
  const right = Math.min(totalPages - 1, currentPage + 1);
  if (left > 2) out.push("ellipsis");
  for (let p = left; p <= right; p++) out.push(p);
  if (right < totalPages - 1) out.push("ellipsis");
  out.push(totalPages);
  return out;
}

function ForumView({
  // `scrollRef` is intentionally NOT named `ref`, React treats `ref` as
  // a special prop on function components and won't forward it. Renaming
  // dodges the "ref is not a prop" warning without needing forwardRef.
  scrollRef,
  replies,
  buckets,
  categories,
  roomId,
  fontStep,
  activeTopicId,
  onSetActiveTopic,
  onPopoutTopic,
  onGoToForumPage,
  onFlushPendingTopics,
  onActivateCategory,
  onStartTopicInCategory,
  canModerate,
  canPin,
  canAdminEdit,
  onQuotePost,
  onJumpToReply,
  genderByUser,
  adminUserIds,
  selfUserId,
  selfNames,
  roomType,
  onIconClick,
  onNameClick,
  onMentionClick,
  onWorldClick,
  onTimeClick,
  renderTopicComposer,
  renderNewTopicForm,
  unreadTopicIds,
  watchedTopicIds,
  onToggleTopicWatch,
  readOnly = false,
  forumTourAnchors = false,
  postPermalink,
  highlightMessageId,
}: {
  scrollRef: React.MutableRefObject<HTMLDivElement | null>;
  /** Reply messages from the chat backlog. Topics come from `buckets`, not from this list. */
  replies: ChatMessage[];
  /** Paginated topic buckets keyed by category id (or `"_uncat"`). */
  buckets: Record<string, ForumBucket>;
  /** Sibling categories in this board, for the per-category headings + counts. */
  categories: ThreadCategory[];
  roomId: string | null;
  fontStep: 0 | 1 | 2 | 3;
  activeTopicId: string | null;
  onSetActiveTopic: (id: string | null) => void;
  /** Open the given topic in the focused-view modal. The modal carries its own reply composer; this is independent of `activeTopicId`. */
  onPopoutTopic: (id: string) => void;
  /** Navigate the given category's pagination to the target page.
   *  Replaces the old "Load older topics" cursor flow, the
   *  pagination strip rendered under each category section calls
   *  this for Prev / Next and for each numbered page button. */
  onGoToForumPage: (categoryKey: string, page: number) => void;
  /** Flush pending → visible (user clicked the "X new topics" pill). */
  onFlushPendingTopics: (categoryKey: string) => void;
  /** Fire when the user clicks a category section header, the parent should remember this as the target for the next "+ New topic". `null` = Uncategorized bucket. */
  onActivateCategory: (categoryId: string | null) => void;
  /** Fire when the user clicks the per-section "+ New Topic" button, parent cancels reply mode + opens topic-create form targeted at this category. */
  onStartTopicInCategory: (categoryId: string | null) => void;
  /** Viewer is a moderator (role mod or admin), exposes Lock/Unlock + cross-author Delete in PostToolbar. */
  canModerate: boolean;
  /** Viewer is an admin, exposes Pin/Unpin on topics. */
  canPin: boolean;
  /** Viewer is an admin, exposes cross-author Edit in PostToolbar. */
  canAdminEdit: boolean;
  /** Pre-fill the right composer with a markdown blockquote of the post. Optional. */
  onQuotePost?: (quoteText: string) => void;
  /** Optional: click a reply post's `↪ <author>` chip to jump to the parent. */
  onJumpToReply?: (messageId: string) => void;
  genderByUser: Map<string, Gender>;
  adminUserIds: Set<string>;
  selfUserId: string | null;
  /** Lower-cased viewer identities for self-mention highlighting. */
  selfNames: ReadonlyArray<string>;
  roomType: "public" | "private" | null;
  onIconClick: (userId: string, displayName: string, characterId?: string | null) => void;
  onNameClick: (userId: string, displayName: string, characterId?: string | null) => void;
  onMentionClick: (name: string) => void;
  onWorldClick: (slug: string) => void;
  onTimeClick: (msgId: string) => void;
  /** See MessageList Props — inline composers for the Forums Catalog. */
  renderTopicComposer?: (topic: ChatMessage) => React.ReactNode;
  renderNewTopicForm?: (categoryKey: string) => React.ReactNode;
  /** See MessageList Props — unread dots + watch bells (catalog only). */
  unreadTopicIds?: ReadonlySet<string>;
  watchedTopicIds?: ReadonlySet<string>;
  onToggleTopicWatch?: (topicId: string, watch: boolean) => void;
  /** See MessageList Props — anonymous read-only mode + permalinks. */
  readOnly?: boolean;
  /** See MessageList Props — Forums Catalog stamps the posting-tour anchor. */
  forumTourAnchors?: boolean;
  postPermalink?: (messageId: string) => string;
  /** Jump-highlight target (quote references); TopicCards expand their
   *  reply cap when it's one of their hidden replies. */
  highlightMessageId?: string | null;
}) {
  const { t } = useTranslation("chat");
  // Index replies by parent topic id. Replies that don't match any
  // currently-loaded topic just don't render (they'll appear when the
  // user loads the topic page that contains their parent). Sorted
  // chronologically within a parent so the conversation reads
  // top-to-bottom.
  const repliesByParent = useMemo(() => {
    const map = new Map<string, ChatMessage[]>();
    for (const r of replies) {
      if (!r.replyToId) continue;
      const arr = map.get(r.replyToId) ?? [];
      arr.push(r);
      map.set(r.replyToId, arr);
    }
    return map;
  }, [replies]);

  // Section ordering: known categories first (by sortOrder, already
  // applied server-side), then a synthetic Uncategorized bucket. We
  // always render Uncategorized last when it has content, OR when
  // the room has no categories defined (so the room still has a
  // visible topic list).
  // Category tree (one level): top-level categories render as sections;
  // their children render as SUB-sections inside. A subcategory whose
  // parent is missing or is itself a child (shouldn't happen — the
  // server enforces one level) promotes to top level instead of
  // disappearing.
  type SubSection = { key: string; label: string; subtitle: string | null; iconUrl: string | null; membersOnly: boolean; locked: boolean };
  const sections = useMemo(() => {
    const validParentIds = new Set(categories.filter((c) => !c.parentId).map((c) => c.id));
    const isSub = (c: ThreadCategory) => !!c.parentId && validParentIds.has(c.parentId);
    const subsByParent = new Map<string, SubSection[]>();
    for (const c of categories) {
      if (!isSub(c)) continue;
      const list = subsByParent.get(c.parentId!) ?? [];
      list.push({ key: c.id, label: c.name, subtitle: c.subtitle ?? null, iconUrl: c.iconUrl ?? null, membersOnly: !!c.membersOnly, locked: !!c.locked });
      subsByParent.set(c.parentId!, list);
    }
    const out: Array<{ key: string; label: string | null; subtitle: string | null; iconUrl: string | null; membersOnly: boolean; locked: boolean; children: SubSection[] }> = [];
    for (const c of categories) {
      if (isSub(c)) continue;
      out.push({
        key: c.id,
        label: c.name,
        subtitle: c.subtitle ?? null,
        iconUrl: c.iconUrl ?? null,
        membersOnly: !!c.membersOnly,
        locked: !!c.locked,
        children: subsByParent.get(c.id) ?? [],
      });
    }
    const uncatBucket = buckets["_uncat"];
    const uncatVisible = uncatBucket && (uncatBucket.topics.length > 0 || uncatBucket.pending.length > 0 || uncatBucket.hasMore);
    if (uncatVisible || categories.length === 0) {
      out.push({ key: "_uncat", label: categories.length > 0 ? t("forum.uncategorized") : null, subtitle: null, iconUrl: null, membersOnly: false, locked: false, children: [] });
    }
    return out;
  }, [categories, buckets, t]);

  // Section collapse state, persisted per room.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    if (!roomId) return new Set();
    try {
      const raw = window.localStorage.getItem(`thespire.thread-cat-collapse.${roomId}`);
      if (!raw) return new Set();
      return new Set(JSON.parse(raw) as string[]);
    } catch { return new Set(); }
  });
  useEffect(() => {
    if (!roomId) return;
    try {
      window.localStorage.setItem(
        `thespire.thread-cat-collapse.${roomId}`,
        JSON.stringify([...collapsed]),
      );
    } catch { /* ignore */ }
  }, [collapsed, roomId]);

  function toggleSection(sectionKey: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(sectionKey)) next.delete(sectionKey);
      else next.add(sectionKey);
      return next;
    });
  }

  /** One bucket's body: pending pill, inline new-topic slot, topic
   *  cards, pagination. Shared by top-level sections and their
   *  subcategory sub-sections (each category id has its own bucket). */
  function renderBucket(key: string) {
    const bucket = buckets[key];
    const items = bucket?.topics ?? [];
    const pendingCount = bucket?.pending.length ?? 0;
    const isLoading = bucket?.loading ?? false;
    const currentPage = bucket?.currentPage ?? 1;
    const totalPages = bucket?.totalPages ?? 1;
    const totalCount = bucket?.totalCount ?? items.length;
    return (
      <div className="flex flex-col gap-1.5">
        {/* "X new topics" pill, visible only when at least one topic
            from another user arrived since the last flush. */}
        {pendingCount > 0 ? (
          <button
            type="button"
            onClick={() => onFlushPendingTopics(key)}
            className="self-start rounded-full border border-keep-action/60 bg-keep-action/10 px-3 py-0.5 text-[11px] font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/20"
            title={t("forum.newTopicsTitle")}
          >
            {t("forum.newTopics", { count: pendingCount })}
          </button>
        ) : null}

        {/* Inline new-topic form (Forums Catalog). Renders as a ghost
            topic card in the category the user clicked "+ New Topic"
            in; null everywhere else. */}
        {renderNewTopicForm?.(key) ?? null}

        {/* The actual list. While the bucket is still loading its first
            page, show a skeleton hint instead of "No topics yet". */}
        {items.length === 0 ? (
          isLoading ? (
            <div className="px-1 py-2 text-xs italic text-keep-muted">{t("forum.loadingTopics")}</div>
          ) : (
            <div className="px-1 py-2 text-xs italic text-keep-muted">{t("forum.noTopics")}</div>
          )
        ) : (
          items.map((topic) => (
            <TopicCard
              key={topic.id}
              topic={topic}
              flair={topicCardFlair(topic)}
              replies={repliesByParent.get(topic.id) ?? []}
              isActive={topic.id === activeTopicId}
              onToggle={() => onSetActiveTopic(topic.id === activeTopicId ? null : topic.id)}
              onPopout={() => onPopoutTopic(topic.id)}
              canModerate={canModerate}
              canPin={canPin}
              canAdminEdit={canAdminEdit}
              {...(onQuotePost ? { onQuotePost } : {})}
              {...(onJumpToReply ? { onJumpToReply } : {})}
              // Reply pill activates the topic unconditionally (the
              // toggle semantic would deactivate when already active,
              // wrong for "I'm about to reply to this").
              onActivateForReply={(id) => onSetActiveTopic(id)}
              {...(renderTopicComposer ? { renderTopicComposer } : {})}
              isUnread={unreadTopicIds?.has(topic.id) ?? false}
              {...(onToggleTopicWatch
                ? {
                    isWatched: watchedTopicIds?.has(topic.id) ?? false,
                    onToggleWatch: () => onToggleTopicWatch(topic.id, !(watchedTopicIds?.has(topic.id) ?? false)),
                  }
                : {})}
              highlightMessageId={highlightMessageId ?? null}
              readOnly={readOnly}
              {...(postPermalink ? { postPermalink } : {})}
              genderByUser={genderByUser}
              adminUserIds={adminUserIds}
              selfUserId={selfUserId}
              selfNames={selfNames}
              roomType={roomType}
              onIconClick={onIconClick}
              onNameClick={onNameClick}
              onMentionClick={onMentionClick}
              onWorldClick={onWorldClick}
              onTimeClick={onTimeClick}
            />
          ))
        )}

        {/* Per-category pagination strip. Stickies stay on page 1 and
            don't count against pagination (server behavior). */}
        {totalPages > 1 ? (
          <ForumPaginationStrip
            sectionKey={key}
            currentPage={currentPage}
            totalPages={totalPages}
            totalCount={totalCount}
            isLoading={isLoading}
            onGoToPage={(p) => onGoToForumPage(key, p)}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef as React.RefObject<HTMLDivElement>}
      // No horizontal padding on mobile so topic cards reach the viewport
      // edges, every pixel of side gutter is one or two characters of
      // reading width that otherwise gets eaten by chrome. lg+ restores
      // the gutter since desktop has plenty of horizontal room and the
      // visual breathing room reads as intentional, not cramped. The
      // breakpoint is `lg` to match the rest of the chat shell, the
      // rail stays in drawer mode until `lg` so the chat needs the
      // full viewport gutter-free at every `< lg` width.
      // pb only: top padding made the FIRST category header float below
      // an awkward empty strip (the header's own border-y + the section
      // chrome already separate it from whatever sits above).
      className="keep-chat-feed min-h-0 flex-1 overflow-y-auto pb-2 leading-relaxed lg:px-4"
      style={{ fontSize: FONT_EM[fontStep] }}
      // Flatten any selection copied out of the chat feed to plain
      // text, no avatar markup, no name-style CSS, no bold /
      // italic / link decoration. See lib/chatCopy.ts for the
      // rationale; covers chat AND forum rendering since this scroll
      // container hosts both.
      onCopy={handlePlainTextCopy}
    >
      {sections.map((s) => {
        const ownBucket = buckets[s.key];
        const headerCount = ownBucket?.totalCount ?? ownBucket?.topics.length ?? 0;
        const isCollapsed = s.label !== null && collapsed.has(s.key);
        return (
          // The scroll container intentionally has no top padding so the
          // first CATEGORY HEADER sits flush (its own chrome separates it).
          // But a header-less section (`label === null` — the Uncategorized
          // bucket when the forum has no categories at all) has nothing above
          // its first topic, so it'd ride the container's top edge. Give that
          // case its own top padding so the lone post isn't cramped against
          // the frame. Only the no-categories uncat bucket is ever label-less,
          // so this never adds a stray gap mid-list.
          <section key={s.key} className={`mb-3 ${s.label === null ? "pt-3" : ""}`}>
            {s.label !== null ? (
              // Switched from <button> to <div role="button"> so the
              // nested "+ New Topic" action button below is valid HTML
              // (button-in-button isn't). The toggle/activate behavior
              // on the row itself is preserved via click + keyDown.
              <div
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  // Single click on the row does two jobs intentionally:
                  // toggle the section's collapse state AND nominate it
                  // as the "post here" target for the next + New topic.
                  // The closest-button guard makes the nested action
                  // button (and any future ones) "punch through" the
                  // row click without double-firing.
                  if ((e.target as HTMLElement).closest("button") !== null) return;
                  toggleSection(s.key);
                  onActivateCategory(s.key === "_uncat" ? null : s.key);
                }}
                onKeyDown={(e) => {
                  // Only respond when the row itself has focus, let
                  // Enter/Space on a nested button fire its own handler.
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleSection(s.key);
                    onActivateCategory(s.key === "_uncat" ? null : s.key);
                  }
                }}
                // NOT sticky at any width. A previous version pinned the
                // header (`lg:sticky lg:top-0`) on desktop, but at every
                // size that read as a bug: as the user scrolled, the
                // header floated over the topics below it instead of
                // staying in its original spot ("headers scrolling over
                // topics"). Normal block flow is correct here, each
                // section's header sits naturally above its own topics and
                // scrolls away with them; the count badge + uppercase
                // styling keep enough hierarchy that the category boundary
                // stays obvious without a persistent floating header.
                //
                // Inline backgroundColor uses the CSS var directly so
                // Tailwind's `<alpha-value>` substitution can't sneak any
                // transparency in (a translucent header would let topics
                // ghost through it).
                style={{ backgroundColor: "rgb(var(--keep-panel))" }}
                // Full-bleed math (-mx-4 + w-[calc(100%+2rem)]) only applies
                // on lg+ where the chat scroll root re-adds its px-4 gutter
                // (see [MessageList.tsx](./MessageList.tsx)'s `lg:px-4`).
                // On mobile / mid-width the root is edge-to-edge, so the
                // header is already full-bleed at plain `w-full`. Pinning
                // the breakpoint to lg keeps the negative-margin trick in
                // lockstep with the gutter it's compensating for, earlier
                // the two diverged (md vs lg) and headers overflowed the
                // chat container at 768–1023px widths.
                className="keep-section-header mb-2 flex w-full cursor-pointer items-center justify-between gap-3 border-y border-keep-rule px-4 py-2 text-left text-[1.1rem] font-semibold uppercase tracking-widest text-keep-text shadow-sm hover:brightness-95 lg:-mx-4 lg:w-[calc(100%+2rem)]"
                title={isCollapsed ? t("forum.expandCategory") : t("forum.collapseCategory")}
              >
                {/* Left span: name + chevron. min-w-0 + truncate so a
                    long section name (or a small viewport) shrinks the
                    label with ellipsis instead of forcing the action
                    button on the right off the edge. */}
                <span className="flex min-w-0 items-baseline">
                  <span aria-hidden className="mr-2 inline-block w-3 shrink-0 text-keep-muted">{isCollapsed ? "▶" : "▼"}</span>
                  {/* Owner-uploaded category icon (borderless, contain —
                      alpha icons render as themselves). */}
                  {s.iconUrl ? (
                    <img src={s.iconUrl} alt="" className="mr-2 h-5 w-5 shrink-0 self-center object-contain" />
                  ) : null}
                  {/* `min-w-0` on the truncate target itself, without
                      it, Tailwind's `.truncate` (which sets overflow:
                      hidden) can't shrink below the text's intrinsic
                      width because the default flex min-width is auto. */}
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center gap-1.5 truncate">
                      {s.membersOnly ? (
                        <Lock className="h-3.5 w-3.5 shrink-0 text-keep-accent" aria-label={t("forum.membersOnly")} />
                      ) : null}
                      <span className="truncate">{s.label}</span>
                    </span>
                    {/* Owner-set "what belongs in here" line. Overrides
                        the header's uppercase/tracking so it reads as
                        prose, not as a second shouting label. */}
                    {s.subtitle ? (
                      <span className="block truncate text-[11px] font-normal normal-case tracking-normal text-keep-muted">
                        {s.subtitle}
                      </span>
                    ) : null}
                  </span>
                </span>
                <span className="flex shrink-0 items-baseline gap-3">
                  <span className="text-xs tabular-nums text-keep-muted">{headerCount}</span>
                  {/* Members-only category the viewer can't post in → no
                      compose action (you can't post where you can't read);
                      a quiet "Members only" chip stands in for the button. */}
                  {s.locked ? (
                    <span
                      className="rounded border border-keep-rule/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-keep-muted"
                      title={t("forum.membersOnlyTitle")}
                    >
                      {t("forum.membersOnly")}
                    </span>
                  ) : (
                  <button
                    type="button"
                    onClick={(e) => {
                      // Don't propagate to the row, clicking this button
                      // should *only* open the composer for a new topic,
                      // not toggle the section's collapse state.
                      e.stopPropagation();
                      // Force the section EXPANDED (never collapse it). The
                      // inline new-topic composer — and, after an in-room
                      // post, the freshly-created topic — render inside the
                      // bucket body, which is skipped while the section is
                      // collapsed. Without this, clicking "+ New Topic" on a
                      // collapsed (often empty) category set the target but
                      // showed nothing: the "nothing happens" report.
                      setCollapsed((prev) => {
                        if (!prev.has(s.key)) return prev;
                        const n = new Set(prev);
                        n.delete(s.key);
                        return n;
                      });
                      onStartTopicInCategory(s.key === "_uncat" ? null : s.key);
                    }}
                    data-tour={forumTourAnchors ? "forum-new-topic-btn" : undefined}
                    className="keep-button rounded border border-keep-action/50 bg-keep-action/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/20"
                    title={t("forum.startTopicIn", { name: s.label })}
                  >
                    {t("forum.newTopic")}
                  </button>
                  )}
                </span>
              </div>
            ) : null}
            {isCollapsed ? null : (
              // No indent at this level: a top-level category's OWN topics
              // are first-level content and read best flush under the
              // header. Only a SUBCATEGORY's content gets indented (below),
              // so the one visible step of depth always means "nested in a
              // subcategory" rather than "nested in a category."
              <div>
                {/* Subcategories first, like a normal forum: a category's
                    sub-boards sit above its own loose topics. Each keeps
                    its own collapse, "+ New Topic", and bucket. */}
                {s.children.map((sub) => {
                  const subCollapsed = collapsed.has(sub.key);
                  const subBucket = buckets[sub.key];
                  const subCount = subBucket?.totalCount ?? subBucket?.topics.length ?? 0;
                  return (
                    <div key={sub.key} className="mt-2">
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          if ((e.target as HTMLElement).closest("button") !== null) return;
                          toggleSection(sub.key);
                          onActivateCategory(sub.key);
                        }}
                        onKeyDown={(e) => {
                          if (e.target !== e.currentTarget) return;
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            toggleSection(sub.key);
                            onActivateCategory(sub.key);
                          }
                        }}
                        className="mb-1.5 flex w-full cursor-pointer items-center justify-between gap-3 rounded border border-keep-rule bg-keep-panel/70 px-3 py-1.5 text-left text-[0.92rem] font-semibold uppercase tracking-widest text-keep-text hover:brightness-95"
                        title={subCollapsed ? t("forum.expandSubcategory") : t("forum.collapseSubcategory")}
                      >
                        <span className="flex min-w-0 items-baseline">
                          <span aria-hidden className="mr-2 inline-block w-3 shrink-0 text-keep-muted">{subCollapsed ? "▶" : "▼"}</span>
                          {sub.iconUrl ? (
                            <img src={sub.iconUrl} alt="" className="mr-2 h-4 w-4 shrink-0 self-center object-contain" />
                          ) : null}
                          <span className="min-w-0">
                            <span className="flex min-w-0 items-center gap-1.5 truncate">
                              {sub.membersOnly ? (
                                <Lock className="h-3 w-3 shrink-0 text-keep-accent" aria-label={t("forum.membersOnly")} />
                              ) : null}
                              <span className="truncate">{sub.label}</span>
                            </span>
                            {sub.subtitle ? (
                              <span className="block truncate text-[11px] font-normal normal-case tracking-normal text-keep-muted">
                                {sub.subtitle}
                              </span>
                            ) : null}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-baseline gap-3">
                          <span className="text-xs tabular-nums text-keep-muted">{subCount}</span>
                          {sub.locked ? (
                            <span
                              className="rounded border border-keep-rule/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-keep-muted"
                              title={t("forum.membersOnlyTitle")}
                            >
                              {t("forum.membersOnly")}
                            </span>
                          ) : (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              // Expand the subcategory so its inline composer /
                              // new topic is visible (see the category button).
                              setCollapsed((prev) => {
                                if (!prev.has(sub.key)) return prev;
                                const n = new Set(prev);
                                n.delete(sub.key);
                                return n;
                              });
                              onStartTopicInCategory(sub.key);
                            }}
                            data-tour={forumTourAnchors ? "forum-new-topic-btn" : undefined}
                            className="keep-button rounded border border-keep-action/50 bg-keep-action/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/20"
                            title={t("forum.startTopicIn", { name: sub.label })}
                          >
                            {t("forum.newTopic")}
                          </button>
                          )}
                        </span>
                      </div>
                      {/* Indent ONLY a subcategory's content, so its topics
                          read as nested under it; the parent category's own
                          topics stay flush at first level. */}
                      {subCollapsed ? null : <div className="pl-2 lg:pl-5">{renderBucket(sub.key)}</div>}
                    </div>
                  );
                })}
                {/* The category's own loose topics, below its subcategories. */}
                <div className={s.children.length > 0 ? "mt-2" : undefined}>
                  {renderBucket(s.key)}
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/**
 * One forum topic. The header is always visible (avatar + author +
 * title + timestamp + reply count). Clicking it makes this the
 * active topic, body + reply chain expand, the card gets an accent
 * border, and the composer up top switches to "reply to this topic"
 * mode. Replies render as compact forum-post cards.
 *
 * Chains longer than REPLIES_PER_PAGE paginate with the classic forum
 * strip (First / Prev / Page x of y / Next / Last), opening on the
 * newest page; short threads (the overwhelming common case) render
 * whole with no pager.
 */

/** Prefix chip for a forum topic + (for the author / manage_prefixes) a
 *  click target to (re)assign it. Resolves the chip from the forum's prefix
 *  catalog provided via context; renders nothing outside a prefix-enabled
 *  forum or when the topic has no prefix and the viewer can't assign one. */
function TopicPrefix({ topic, selfUserId }: { topic: ChatMessage; selfUserId: string | null }) {
  const { t } = useTranslation("chat");
  // Nudge the tag's ink toward legibility against the viewer's theme bg (same
  // pass the chat author colors use) so a pale tag survives a light theme and
  // a dark tag survives a dark one. The faint bg/border tints keep the raw hue.
  const themeBg = useActiveTheme().bg;
  const ctx = useContext(ForumPrefixContext);
  // Cosmetic mirror of the NSFW re-tag write gate (adults only); the picker
  // and the server re-check. Hook runs before the early return (hook order).
  const viewerIsAdult = useChat((s) => s.viewerAge.isAdult);
  if (!ctx || topic.replyToId) return null;
  const prefix = topic.prefixId ? ctx.byId.get(topic.prefixId) : null;
  // A staff-only tag is manager-controlled: only manage_prefixes may set it,
  // and once set, only they may change/clear it — the author can't (mirrors
  // the server gate). So the author's self-tag right is suspended whenever the
  // current tag is staff-only.
  const isManager = ctx.canManagePrefixes;
  const currentIsStaffOnly = !!prefix?.staffOnly;
  const isAuthor = !!selfUserId && topic.userId === selfUserId;
  const canAssign = isManager || (isAuthor && !currentIsStaffOnly);
  // NSFW re-tag (age plan Phase 3) rides the same picker: adult author /
  // owner / manage_prefixes. Independent of the staff-only prefix rule —
  // the NSFW tag is a separate system from the owner's prefix catalog.
  const canTagNsfw = viewerIsAdult && (isManager || isAuthor);
  // Tags this topic's category can actually be given (global + matching-scope).
  // Members don't count staff-only tags toward "is there anything to assign".
  const categoryId = topic.threadCategoryId ?? null;
  const hasApplicable = ctx.all.some((p) => prefixAppliesToCategory(p, categoryId) && (isManager || !p.staffOnly));
  // Hide the whole affordance when there's nothing to assign and no way to
  // mint one — "no tags + custom off ⇒ don't show the tag system" — unless
  // the viewer can NSFW-tag, which needs a path into the picker even in a
  // forum with no prefix catalog at all.
  if (!prefix && !canTagNsfw && (!canAssign || (!hasApplicable && !ctx.canCreateCustom))) return null;
  const chip = prefix ? (
    <span
      className="shrink-0 rounded px-1.5 py-0 text-[10px] font-bold uppercase tracking-wide"
      style={{ backgroundColor: `${prefix.color}22`, color: resolveMessageColor(prefix.color, themeBg) ?? prefix.color, border: `1px solid ${prefix.color}66` }}
      title={prefix.tooltip ?? undefined}
    >
      {prefix.label}
    </span>
  ) : (
    <span className="shrink-0 rounded border border-dashed border-keep-rule px-1.5 py-0 text-[10px] uppercase tracking-wide text-keep-muted">{t("forum.addTag")}</span>
  );
  if (!canAssign && !canTagNsfw) return chip;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        ctx.onAssign(topic.id, topic.prefixId ?? null, topic.threadCategoryId ?? null, {
          current: topicIsNsfw(topic),
          authorUserId: topic.userId,
        });
      }}
      title={t("forum.setTags")}
      className="shrink-0"
    >
      {chip}
    </button>
  );
}

function TopicCard({
  topic,
  replies,
  isActive,
  onToggle,
  onPopout,
  canModerate,
  canPin,
  onQuotePost,
  onJumpToReply,
  onActivateForReply,
  renderTopicComposer,
  isUnread = false,
  isWatched = false,
  onToggleWatch,
  highlightMessageId = null,
  readOnly = false,
  postPermalink,
  genderByUser,
  adminUserIds,
  selfUserId,
  selfNames,
  roomType,
  onIconClick,
  onNameClick,
  onMentionClick,
  onWorldClick,
  onTimeClick,
  canAdminEdit,
  flair = null,
}: {
  topic: ChatMessage;
  replies: ChatMessage[];
  isActive: boolean;
  onToggle: () => void;
  /** Open this topic in the focused-view modal. Always available; rendered as a small icon to the left of the expand chevron. */
  onPopout: () => void;
  /** Viewer is a moderator, passed through to PostToolbar so cross-author Delete + Lock/Unlock buttons appear. */
  canModerate: boolean;
  /** Viewer is an admin, Pin/Unpin button appears in the topic-post toolbar. */
  canPin: boolean;
  /** Viewer is an admin, Edit button appears on other users' posts. */
  canAdminEdit: boolean;
  /** Optional Quote-button callback. When present, ForumPostBody shows a Quote pill. */
  onQuotePost?: (quoteText: string) => void;
  /** Optional: click the `↪ <author>` chip on a reply to jump to its parent. */
  onJumpToReply?: (messageId: string) => void;
  /**
   * Activate the given topic id as the composer's reply target. The Reply
   * pill on each ForumPostBody calls this with the topic's id (replies
   * always attach to the parent topic, replies-to-replies aren't a
   * thing server-side). Always activates, never deactivates, distinct
   * from `onToggle`, which toggles the topic open/closed.
   */
  onActivateForReply: (topicId: string) => void;
  /** Forums Catalog: inline reply composer rendered after the reply
   *  chain while this topic is active (see MessageList Props). */
  renderTopicComposer?: (topic: ChatMessage) => React.ReactNode;
  /** Forums Catalog: unread-activity dot on the card header. */
  isUnread?: boolean;
  /** Forums Catalog: watch-bell state + toggle (absent in chat). */
  isWatched?: boolean;
  onToggleWatch?: () => void;
  /** Active jump-highlight target; expands the reply cap when it's one
   *  of this topic's hidden replies. */
  highlightMessageId?: string | null;
  /** Anonymous read-only browsing + permalink builders (see MessageList). */
  readOnly?: boolean;
  postPermalink?: (messageId: string) => string;
  genderByUser: Map<string, Gender>;
  adminUserIds: Set<string>;
  selfUserId: string | null;
  /** Viewer identities for self-mention highlighting inside topic/reply bodies. */
  selfNames: ReadonlyArray<string>;
  roomType: "public" | "private" | null;
  onIconClick: (userId: string, displayName: string, characterId?: string | null) => void;
  onNameClick: (userId: string, displayName: string, characterId?: string | null) => void;
  onMentionClick: (name: string) => void;
  onWorldClick: (slug: string) => void;
  onTimeClick: (msgId: string) => void;
  /**
   * Per-server author flair for the topic card (Servers Lift). Resolved
   * SERVER-SIDE from the cosmetics the topic author earned on the server
   * the forum is affiliated to (`forums.serverId`). `null` (the default)
   * means the forum is UNAFFILIATED — the card renders BARE: no rank
   * sigil, no avatar-border frame, no name style. A non-null object means
   * the forum IS affiliated; its individual fields may still be null when
   * the author hasn't earned/equipped that cosmetic on that server.
   *
   * Shape mirrors the `author*` fields on the shared `ForumTopicCard`.
   */
  flair?: {
    authorRankKey?: string | null;
    authorTier?: number | null;
    authorSelectedBorderRankKey?: string | null;
    authorSelectedFreeformBorderKey?: string | null;
    authorFreeformBorderConfig?: Record<string, string> | null;
    authorNameStyleKey?: string | null;
    authorNameStyleConfig?: Record<string, unknown> | null;
  } | null;
}) {
  const { t } = useTranslation("chat");
  // Reply pagination (classic forum navigation): short chains render
  // whole; past REPLIES_PER_PAGE the chain pages, defaulting to the LAST
  // page (the live end of the conversation, matching the old tail-cap
  // behavior). `replyPage` is null until the user (or a jump) picks one.
  const [replyPage, setReplyPage] = useState<number | null>(null);
  const totalReplyPages = Math.max(1, Math.ceil(replies.length / REPLIES_PER_PAGE));
  const paged = replies.length > REPLIES_PER_PAGE;
  const currentReplyPage = Math.min(replyPage ?? totalReplyPages, totalReplyPages);
  // Quote-reference jump landing on a reply outside the visible page:
  // navigate to its page so the highlight effect can find the row (it
  // retries one frame later).
  useEffect(() => {
    if (!highlightMessageId) return;
    const idx = replies.findIndex((r) => r.id === highlightMessageId);
    if (idx >= 0) setReplyPage(Math.floor(idx / REPLIES_PER_PAGE) + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightMessageId]);
  const headingText = topicHeading(topic);
  const visibleReplies = paged
    ? replies.slice((currentReplyPage - 1) * REPLIES_PER_PAGE, currentReplyPage * REPLIES_PER_PAGE)
    : replies;
  const themeBg = useActiveTheme().bg;
  const topicAuthorColor = resolveMessageColor(topic.color, themeBg);

  /** Compact pager strip for the reply chain (top + bottom when paged). */
  const replyPager = paged ? (
    <div className="flex flex-wrap items-center justify-center gap-1.5 py-1 text-[11px] text-keep-muted">
      <button
        type="button"
        disabled={currentReplyPage <= 1}
        onClick={() => setReplyPage(1)}
        className="rounded border border-keep-rule px-1.5 py-0.5 hover:text-keep-text disabled:opacity-30"
        title={t("forum.firstPageTitle")}
      >
        {t("forum.first")}
      </button>
      <button
        type="button"
        disabled={currentReplyPage <= 1}
        onClick={() => setReplyPage(currentReplyPage - 1)}
        className="rounded border border-keep-rule px-1.5 py-0.5 hover:text-keep-text disabled:opacity-30"
        title={t("forum.prevRepliesTitle")}
      >
        {t("forum.prev")}
      </button>
      <span className="px-1 tabular-nums">
        {t("forum.pageOfReplies", { page: currentReplyPage, pages: totalReplyPages, n: replies.length })}
      </span>
      <button
        type="button"
        disabled={currentReplyPage >= totalReplyPages}
        onClick={() => setReplyPage(currentReplyPage + 1)}
        className="rounded border border-keep-rule px-1.5 py-0.5 hover:text-keep-text disabled:opacity-30"
        title={t("forum.nextRepliesTitle")}
      >
        {t("forum.next")}
      </button>
      <button
        type="button"
        disabled={currentReplyPage >= totalReplyPages}
        onClick={() => setReplyPage(totalReplyPages)}
        className="rounded border border-keep-rule px-1.5 py-0.5 hover:text-keep-text disabled:opacity-30"
        title={t("forum.newestRepliesTitle")}
      >
        {t("forum.last")}
      </button>
    </div>
  ) : null;

  return (
    <article
      data-message-id={topic.id}
      // The `.keep-frame` theme styles bake in a per-style border-radius
      // (medieval 2px, modern 10px, scifi 0). On md+ we let that ride,
      // there's a gutter and the rounded chrome reads as deliberate.
      // On mobile the card runs edge-to-edge: a non-zero radius carves a
      // transparent notch in the corner that visually reads as a gutter
      // (the bg color shows through), defeating the full-bleed effect.
      // `max-md:!rounded-none` strips the radius below md only; the `!`
      // is needed because the theme rule wins on specificity otherwise.
      className={
        "keep-frame bg-keep-banner/40 transition-colors max-md:!rounded-none " +
        (isActive ? "ring-2 ring-keep-action/60" : "")
      }
    >
      {/* Header row. The outer is a `<div>` (not <button>) so we can
          nest real <button> elements for the avatar/author/pop-out
          without invalid HTML; click + keyboard handlers on the div
          drive the expand toggle. The chevron column at the right is
          NOT a click target itself, clicking anywhere on the row
          toggles. The pop-out icon next to the chevron IS a real
          button that stops propagation so it doesn't also toggle. */}
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => {
          // Inner buttons (avatar / author / popout) already stop
          // propagation on their own clicks. This guard catches the
          // rare case where a click bubbles up from a non-stopping
          // child (e.g. text spans), toggle only when the click
          // originated outside of an interactive descendant.
          if ((e.target as HTMLElement).closest("button") !== null) return;
          onToggle();
        }}
        onKeyDown={(e) => {
          // Only toggle when the row itself has focus. If the user
          // pressed Enter/Space while focused on a nested button
          // (popout, author name, avatar), let the button's own
          // handler run instead of double-firing the toggle.
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className="flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left hover:bg-keep-muted/10"
        title={isActive ? t("forum.collapseTopic") : t("forum.openTopic")}
      >
        <ForumAvatar
          src={topic.avatarUrl ?? null}
          name={topic.displayName}
          userId={topic.userId}
          characterId={topic.characterId ?? null}
          size={48}
          // Per-server flair (Servers Lift): when the forum is affiliated
          // (`flair` non-null) the border comes from the forum's server via
          // forceBorder — including the bare case (all null) so an
          // unaffiliated forum doesn't leak the author's live equip. When
          // `flair` is null we keep the legacy occupant-cache behavior.
          {...(flair
            ? {
                forceBorder: true,
                borderRankKey: flair.authorSelectedBorderRankKey ?? null,
                freeformBorderKey: flair.authorSelectedFreeformBorderKey ?? null,
                freeformBorderConfig: flair.authorFreeformBorderConfig ?? null,
              }
            : {})}
          onClick={(e) => {
            e.stopPropagation();
            onIconClick(topic.userId, topic.displayName, topic.characterId ?? null);
          }}
        />
        <div className="min-w-0 flex-1">
          {/* min-w-0 on the inner flex too, without it, the `truncate`
              on the title span doesn't actually shrink, because
              min-width:auto on flex children defeats overflow:hidden. */}
          {/* On mobile this wraps: the prefix tag + date sit on their own
              row ABOVE the title (both already smaller than the title),
              and the title (basis-full) drops to the next line so it gets
              the full width instead of being squeezed between tag and date.
              On >=sm it stays a single nowrap row: prefix · title (flex-1) ·
              right-aligned date (sm:order-last pushes it back to the end). */}
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 sm:flex-nowrap">
            {/* Unread marker (Forums Catalog): activity since the viewer
                last opened this topic. Cleared when the topic opens. */}
            {isUnread ? (
              <span
                aria-label={t("forum.newActivity")}
                title={t("forum.newActivityTitle")}
                className="h-2 w-2 shrink-0 self-center rounded-full bg-keep-action"
              />
            ) : null}
            {topic.isSticky ? (
              <span
                aria-label={t("forum.pinned")}
                title={t("forum.pinnedTitle")}
                className="shrink-0 text-keep-action"
              >
                📌
              </span>
            ) : null}
            {topic.lockedAt ? (
              <span
                aria-label={t("forum.locked")}
                title={t("forum.lockedTitle")}
                className="shrink-0 text-keep-muted"
              >
                🔒
              </span>
            ) : null}
            {/* Built-in NSFW tag (age-restriction plan Phase 3). Deliberately
                NOT a prefix chip: fixed warning red (the RatingChip color, a
                concrete value so it reads as a warning on every palette)
                instead of the owner's custom prefix colors. The server holds
                tagged topics back from viewers who can't see NSFW, so this
                only ever renders for viewers allowed to open the topic. */}
            {topicIsNsfw(topic) ? (
              <span
                title={t("forum.nsfwTitle")}
                className="inline-flex shrink-0 items-center self-center rounded border border-[#e06070] bg-[#e06070]/10 px-1.5 py-0 text-[10px] font-bold uppercase leading-none tracking-widest text-[#e06070]"
              >
                {t("forum.nsfw")}
              </span>
            ) : null}
            <TopicPrefix topic={topic} selfUserId={selfUserId} />
            <span
              className="shrink-0 text-[10px] uppercase tracking-widest text-keep-muted tabular-nums sm:order-last"
              title={fmtFullTimestamp(topic.createdAt)}
            >
              {fmtForumTime(topic.createdAt)}
            </span>
            <span
              className="min-w-0 basis-full truncate font-semibold text-keep-text sm:basis-auto sm:flex-1"
              title={headingText}
            >
              {topic.kind === "poll" ? (
                <span className="mr-1.5 inline-flex items-center gap-1 rounded-full border border-keep-accent/50 bg-keep-accent/10 px-1.5 py-0 align-middle text-[10px] font-semibold uppercase tracking-widest text-keep-accent">
                  <BarChart3 className="h-3 w-3" aria-hidden="true" /> {t("forum.pollChip")}
                </span>
              ) : null}
              {parseInline(headingText)}
            </span>
          </div>
          <div className="flex items-baseline gap-2 text-[11px] text-keep-muted">
            {/* Per-server rank sigil (Servers Lift). Only when the forum is
                affiliated AND this author holds a rank on that server.
                Unaffiliated forums (`flair` null) render no sigil. */}
            {flair?.authorRankKey ? (
              <RankSigil rankKey={flair.authorRankKey} tier={flair.authorTier ?? null} size="sm" variant="gem" />
            ) : null}
            <span>{t("forum.by")}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onNameClick(topic.userId, topic.displayName, topic.characterId ?? null);
              }}
              className={
                "rounded font-semibold text-keep-action hover:underline " +
                // Staff-italic only when the topic was authored OOC.
                // A character voice doesn't get italicized even if
                // the owner is staff, same partition rule as the
                // chat-line `isSenderAdmin` above.
                (topic.characterId === null && adminUserIds.has(topic.userId) ? "italic" : "")
              }
              // A name style owns the color, so suppress the author-color
              // override when one is active (matches the reply-row rule).
              style={topicAuthorColor && !flair?.authorNameStyleKey ? { color: topicAuthorColor } : undefined}
            >
              {/* Per-server name style (Servers Lift). When the forum is
                  affiliated and the author has a style equipped on that
                  server, render through StyledName; otherwise plain text. */}
              {flair?.authorNameStyleKey ? (
                <StyledName
                  displayName={topic.displayName}
                  styleKey={flair.authorNameStyleKey}
                  config={flair.authorNameStyleConfig ?? null}
                  baseColor={topicAuthorColor}
                />
              ) : (
                topic.displayName
              )}
            </button>
            <span className="tabular-nums">
              {/* Use the larger of the server-provided total (correct on a
                  collapsed card before its thread is fetched) and the loaded
                  reply buffer (grows live as replies stream in once expanded).
                  Without the server count, a collapsed topic read "0 replies"
                  until opened. */}
              {(() => {
                const n = Math.max(topic.replyCount ?? 0, replies.length);
                return t("forum.replyCount", { count: n });
              })()}
            </span>
          </div>
        </div>
        {/* Watch bell (Forums Catalog): subscribe to reply notifications
            for this topic. Authors and repliers are auto-subscribed. */}
        {onToggleWatch ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleWatch();
            }}
            aria-label={isWatched ? t("forum.stopWatching") : t("forum.watchTopic")}
            title={isWatched ? t("forum.watchingTitle") : t("forum.watchTitle")}
            className={
              "shrink-0 rounded border px-1.5 py-0.5 text-xs " +
              (isWatched
                ? "border-keep-action/60 bg-keep-action/10 text-keep-action"
                : "border-keep-rule/60 bg-keep-bg/60 text-keep-muted hover:border-keep-action hover:text-keep-action")
            }
          >
            {isWatched ? "🔔" : "🔕"}
          </button>
        ) : null}
        {!readOnly ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPopout();
            }}
            aria-label={t("forum.openFocused")}
            title={t("forum.openFocused")}
            className="shrink-0 rounded border border-keep-rule/60 bg-keep-bg/60 px-1.5 py-0.5 text-xs text-keep-muted hover:border-keep-action hover:bg-keep-action/10 hover:text-keep-action"
          >
            ⤢
          </button>
        ) : null}
        <span aria-hidden className="shrink-0 text-keep-muted">
          {isActive ? "▼" : "▶"}
        </span>
      </div>
      {isActive ? (
        <div className="border-t border-keep-rule/60 px-3 py-2">
          <ForumPostBody
            msg={topic}
            isOwn={!!selfUserId && topic.userId === selfUserId}
            isSenderAdmin={topic.characterId === null && adminUserIds.has(topic.userId)}
            canReport={roomType === "public"}
            canModerate={canModerate}
            canPin={canPin}
            canAdminEdit={canAdminEdit}
            {...(onQuotePost ? { onQuotePost } : {})}
            {...(onJumpToReply ? { onJumpToReply } : {})}
            onReply={() => onActivateForReply(topic.id)}
            onIconClick={onIconClick}
            onNameClick={onNameClick}
            onMentionClick={onMentionClick}
            onWorldClick={onWorldClick}
            onTimeClick={onTimeClick}
            showAuthorHeader={false}
            selfNames={selfNames}
            readOnly={readOnly}
            {...(postPermalink ? { postPermalink } : {})}
          />
          {topic.kind === "poll" && topic.poll ? (
            <div className="mt-2 max-w-lg">
              <PollCard
                message={topic}
                poll={topic.poll}
                isAuthor={!!selfUserId && topic.userId === selfUserId}
                canModerate={canModerate}
                readOnly={readOnly}
              />
            </div>
          ) : null}
          {replies.length > 0 ? (
            <div className="mt-2 flex flex-col gap-1.5 border-t border-keep-rule/40 pt-2">
              {replyPager}
              {visibleReplies.map((r) => (
                <ForumPostBody
                  key={r.id}
                  msg={r}
                  isOwn={!!selfUserId && r.userId === selfUserId}
                  isSenderAdmin={r.characterId === null && adminUserIds.has(r.userId)}
                  canReport={roomType === "public"}
                  canModerate={canModerate}
                  canPin={canPin}
                  canAdminEdit={canAdminEdit}
                  {...(onQuotePost ? { onQuotePost } : {})}
                  {...(onJumpToReply ? { onJumpToReply } : {})}
                  onReply={() => onActivateForReply(topic.id)}
                  onIconClick={onIconClick}
                  onNameClick={onNameClick}
                  onMentionClick={onMentionClick}
                  onWorldClick={onWorldClick}
                  onTimeClick={onTimeClick}
                  showAuthorHeader
                  selfNames={selfNames}
                  readOnly={readOnly}
                  {...(postPermalink ? { postPermalink } : {})}
                />
              ))}
              {/* Bottom pager too - after reading a page you're at the
                  bottom, the next click shouldn't require scrolling up. */}
              {replyPager}
            </div>
          ) : null}
          {/* Ghost reply post (Forums Catalog): the composer lives inside
              the topic, at the end of its chain — submitting turns it
              into the real post in place. Chat renders nothing here. */}
          {renderTopicComposer ? (
            <div className={replies.length > 0 ? "mt-1.5" : "mt-2 border-t border-keep-rule/40 pt-2"}>
              {renderTopicComposer(topic)}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/**
 * Round avatar tile for forum posts. Falls back to the author's
 * initial in a colored circle when no avatarUrl was snapshotted (very
 * common for older messages and for users who never set one). The
 * fallback bg uses keep-banner so it tones with the surrounding card
 * rather than fighting it.
 */
export function ForumAvatar({
  src,
  name,
  onClick,
  size = 32,
  userId,
  characterId,
  borderRankKey,
  freeformBorderKey,
  freeformBorderConfig,
  forceBorder = false,
}: {
  src: string | null;
  name: string;
  onClick?: (e: React.MouseEvent) => void;
  /** Numeric size for backward compat. Mapped to BorderedAvatar's
   *  size enum: anything ≥28 gets the `md` showcase slot (frame
   *  container at 1.5× the avatar); smaller is a bare circle. */
  size?: number;
  /** When provided, ForumAvatar looks up the author's currently-
   *  equipped border in the chat store's occupant cache. Used by
   *  forum topic/reply call sites so the same border the user
   *  picked in the Earning dashboard frames their forum posts. */
  userId?: string | null;
  /** Author's character id at message time (null = the post was OOC).
   *  Paired with `userId` for occupant lookup so a master who has
   *  since switched to a different character doesn't bleed their
   *  CURRENT character's avatar / crop / border onto a past post
   *  authored under a DIFFERENT character. Without this, the
   *  userId-only `.find()` below returned whichever identity the
   *  master happens to be voicing right now. */
  characterId?: string | null;
  /** Direct border override, wins over `userId` lookup. */
  borderRankKey?: string | null;
  /** Direct free-form border override + its color config (Servers Lift:
   *  per-server topic flair). When `forceBorder` is set, these REPLACE the
   *  occupant-cache lookup entirely — including the free-form slot — so an
   *  unaffiliated forum (all three null + forceBorder) renders a bare tile
   *  instead of leaking the author's live equipped border. */
  freeformBorderKey?: string | null;
  freeformBorderConfig?: Record<string, string> | null;
  /** When true, the occupant-cache border lookup is bypassed and ONLY the
   *  explicit `borderRankKey` / `freeformBorderKey` props drive the frame.
   *  Used by per-server forum surfaces where the border must come from the
   *  forum's server, not the author's current live equip. */
  forceBorder?: boolean;
}) {
  const { t } = useTranslation("chat");
  // Tuple-aware occupant matcher used by every cache lookup below.
  // (userId, characterId) pins a specific identity, the same way
  // `cosmeticsByIdentity` in the chat path does, so two characters
  // from the same master never share a resolution.
  function matchesIdentity(o: { userId: string; characterId: string | null }): boolean {
    return o.userId === userId && (o.characterId ?? null) === (characterId ?? null);
  }
  const occupantBorderRankKey = useChat((s) => {
    if (!userId) return null;
    for (const list of Object.values(s.occupants)) {
      const row = list.find(matchesIdentity);
      if (row) return row.selectedBorderRankKey;
    }
    return null;
  });
  const occupantFreeformBorderKey = useChat((s) => {
    if (!userId) return null;
    for (const list of Object.values(s.occupants)) {
      const row = list.find(matchesIdentity);
      if (row) return row.selectedFreeformBorderKey;
    }
    return null;
  });
  const occupantFreeformBorderConfig = useChat((s) => {
    if (!userId) return null;
    for (const list of Object.values(s.occupants)) {
      const row = list.find(matchesIdentity);
      if (row) return row.freeformBorderConfig;
    }
    return null;
  });
  // Live-first lookup. The author's currently-set avatar URL +
  // crop come from the occupant cache when they're online AS THIS
  // EXACT IDENTITY (master AND characterId both match) in any room
  // the viewer can see. The message snapshot is the fallback for
  // authors who have since switched identities OR logged out.
  const occupantAvatarUrl = useChat((s) => {
    if (!userId) return null;
    for (const list of Object.values(s.occupants)) {
      const row = list.find(matchesIdentity);
      if (row?.avatarUrl) return row.avatarUrl;
    }
    return null;
  });
  // Crop has no message snapshot column, only the occupant cache
  // carries it. Paired with `occupantAvatarUrl` below so we never
  // frame a snapshot URL with a live crop (which produced the
  // "old avatar, new zoom" mismatch reported on forum posts after
  // an author re-cropped their portrait). Pairing with the tuple
  // matcher above ALSO closes the "switched character" leak that
  // had a master's current-character crop framing every prior
  // post from any of their OTHER identities.
  const occupantAvatarCrop = useChat((s) => {
    if (!userId) return null;
    for (const list of Object.values(s.occupants)) {
      const row = list.find(matchesIdentity);
      if (row) return row.avatarCrop;
    }
    return null;
  });
  // forceBorder (per-server forum flair): the explicit props are the ONLY
  // source — the occupant cache is bypassed for every border slot so an
  // unaffiliated forum (all border props null) renders a bare tile rather
  // than leaking the author's live equip. Otherwise keep the legacy
  // "explicit override else occupant cache" behavior.
  const effectiveBorder = forceBorder ? (borderRankKey ?? null) : (borderRankKey ?? occupantBorderRankKey);
  const effectiveFreeformBorderKey = forceBorder ? (freeformBorderKey ?? null) : occupantFreeformBorderKey;
  const effectiveFreeformConfig = forceBorder ? (freeformBorderConfig ?? null) : occupantFreeformBorderConfig;
  // Live URL wins over the snapshot. This is the inverse of the
  // earlier `src ?? occupantAvatarUrl` order, which preferred the
  // historical snapshot, but the snapshot URL has no companion
  // snapshot crop, so the page-rendered crop (always live) had
  // nothing to match the URL it was framing. Flipping to live-first
  // restores the URL ↔ crop pairing; the snapshot URL still kicks
  // in when the author isn't around anywhere (offline backlog).
  const effectiveSrc = occupantAvatarUrl ?? src;
  // Use the live crop ONLY when the live URL was chosen. When we
  // fall back to the message-snapshot URL we have no matching crop
  // and render with the default centered cover (avatarCrop null).
  const effectiveCrop = occupantAvatarUrl ? occupantAvatarCrop : null;
  const mappedSize: BorderedAvatarSize =
    size <= 22 ? "sm" : size <= 28 ? "md" : size <= 48 ? "lg" : "xl";
  return (
    <BorderedAvatar
      avatarUrl={effectiveSrc}
      name={name}
      borderRankKey={effectiveBorder ?? null}
      freeformBorderKey={effectiveFreeformBorderKey}
      freeformConfig={effectiveFreeformConfig}
      avatarCrop={effectiveCrop}
      size={mappedSize}
      {...(onClick ? { onClick } : {})}
      title={t("actions.viewProfile", { name })}
    />
  );
}

/** Kinds that show a bookmark affordance in the forum toolbar. Same set as the floating BookmarkButton uses. */
const BOOKMARKABLE_KINDS = new Set(["say", "me", "ooc", "whisper", "npc", "roll"]);

/**
 * Body of a forum post, avatar (small), author header (optional), the
 * message body with mentions/markdown/links parsed, and an inline action
 * toolbar (Edit / Delete / Bookmark / Report) underneath. Used both for
 * the topic's first post and for each reply underneath. Topic cards pass
 * `showAuthorHeader={false}` because the card header already carries the
 * author info; replies pass true so the reader sees who wrote each one.
 *
 * Edit/delete in forum rooms is **not** gated by the 60-second grace
 * window, the server lifts the cap for nested-mode rooms, and the
 * toolbar exposes the controls indefinitely to the author. Transparency
 * comes from the `(edited)` badge + server-preserved soft-delete bodies
 * (admins can recover the original content for moderation review).
 */
export function ForumPostBody({
  msg,
  isOwn,
  isSenderAdmin,
  canReport,
  canModerate = false,
  canPin = false,
  canAdminEdit = false,
  onQuotePost,
  onReply,
  onIconClick,
  onNameClick,
  onMentionClick,
  onWorldClick,
  onTimeClick,
  onJumpToReply,
  showAuthorHeader,
  selfNames = [],
  readOnly = false,
  postPermalink,
}: {
  msg: ChatMessage;
  isOwn: boolean;
  isSenderAdmin: boolean;
  canReport: boolean;
  /** Viewer is a moderator. Adds Lock/Unlock (topics) + cross-author Delete to the toolbar. Defaults to false. */
  canModerate?: boolean;
  /** Viewer is an admin. Adds Pin/Unpin to the toolbar for topics. Defaults to false. */
  canPin?: boolean;
  /** Viewer is an admin. Adds cross-author Edit to the toolbar. Defaults to false. */
  canAdminEdit?: boolean;
  /** Pre-fill the parent's composer with a markdown blockquote of this post. */
  onQuotePost?: (quoteText: string) => void;
  /** Activate this post's parent topic in the composer for plain reply (no quote). */
  onReply?: () => void;
  onIconClick: (userId: string, displayName: string, characterId?: string | null) => void;
  onNameClick: (userId: string, displayName: string, characterId?: string | null) => void;
  onMentionClick: (name: string) => void;
  onWorldClick: (slug: string) => void;
  onTimeClick: (msgId: string) => void;
  /** Click the small `↪ <author>` chip in the post header to jump to the parent message. Optional, chip stays non-clickable when omitted. */
  onJumpToReply?: (messageId: string) => void;
  showAuthorHeader: boolean;
  /** Viewer identities for self-mention highlighting inside this post's body. Optional. */
  selfNames?: ReadonlyArray<string>;
  /** Anonymous read-only browsing: the action toolbar is replaced by a
   *  lone copy-link button (when a permalink builder is present). */
  readOnly?: boolean;
  /** Permalink builder for this post (forum surfaces). */
  postPermalink?: (messageId: string) => string;
}) {
  const { t } = useTranslation("chat");
  // Forum posts use the block-level body renderer so blockquotes
  // (`> quoted text` line prefix) render as styled <blockquote>
  // elements, needed by the Quote-reply flow. Flat-chat lines still
  // use the inline parser (see the `Line` component further down).
  const knownMentions = useMentionsCache((s) => {
    void s.version;
    return s.known;
  });
  useEffect(() => {
    const names = extractMentions(msg.body);
    if (names.length > 0) requestMentionResolve(names);
  }, [msg.body]);
  const renderedBody = useMemo(
    () => renderForumBody(msg.body, onMentionClick, onWorldClick, selfNames, knownMentions, msg.mentions ?? []),
    [msg.body, msg.mentions, onMentionClick, onWorldClick, selfNames, knownMentions],
  );
  // Theme bg drives the legibility nudge that keeps a user-picked color
  // readable when the current palette flips between light and dark.
  const themeBg = useActiveTheme().bg;
  const authorColor = resolveMessageColor(msg.color, themeBg);
  // Earning, equipped name style for this post's author, looked up
  // in the current room's occupant cache. The match keys on the
  // full identity tuple (userId + characterId) so a forum post
  // authored as a specific character doesn't bleed onto the OOC
  // master's row (or vice versa) when both identities are in the
  // occupant list. Backlog from authors no longer present renders
  // unstyled; matches the chat-line policy.
  // Split into two scalar selectors instead of returning `{ key, config }`
  //, zustand's default Object.is comparator treats a freshly-constructed
  // object as "changed" on every render, which triggers an infinite
  // re-render loop (React #185) when the user has an active name style.
  // Two scalar selectors are individually comparable (string === string,
  // and the config object is the SAME reference inside the occupant row
  // so its identity is stable across selector calls).
  const authorStyleKey = useChat((s) => {
    const room = s.occupants[msg.roomId] ?? [];
    const found = room.find((o) => o.userId === msg.userId && (o.characterId ?? null) === (msg.characterId ?? null));
    return found?.activeNameStyleKey ?? null;
  });
  const authorStyleConfig = useChat((s) => {
    const room = s.occupants[msg.roomId] ?? [];
    const found = room.find((o) => o.userId === msg.userId && (o.characterId ?? null) === (msg.characterId ?? null));
    return found?.nameStyleConfig ?? null;
  });
  const authorStyle = authorStyleKey
    ? { key: authorStyleKey, config: authorStyleConfig }
    : null;
  // Reactor identity for any reactions placed via the bar below.
  // Live subscription so a /char switch updates which identity is
  // attributed to a new reaction without remounting the post.
  const viewerActiveCharacterIdForForum = useChat((s) => s.activeCharacterId);

  // Inline editor state, when editing, the body region is replaced
  // with a textarea + Save/Cancel. Hoisted here (not in PostToolbar) so
  // the toolbar's Edit button can swap the post's main content.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.body);
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  if (msg.deletedAt) {
    // Mirror the chat-line variant's author + actor surfacing, see
    // that branch (around line 2361) for the rationale on the three
    // possible actor states.
    const isSelfDelete = !!msg.deletedByUserId && msg.deletedByUserId === msg.userId;
    const actorBlurb = msg.deletedByUserId
      ? (isSelfDelete
          ? t("row.selfDeleted")
          : t("row.deletedBy", { name: msg.deletedByDisplayName ?? t("row.unknown") }))
      : null;
    return (
      <div className="rounded border border-dashed border-keep-rule/40 px-2 py-1 text-xs italic text-keep-muted/70">
        {t("row.messageRemoved")}
        {/* Admin-only audit reveal. See the chat-line variant for the
            same rationale: server only emits `originalBody` to admin
            viewers, so this block stays inert for mods + ordinary
            users. */}
        {msg.originalBody ? (
          <blockquote className="mt-1 border-l-2 border-keep-accent/30 bg-keep-panel/20 px-2 py-0.5 text-[11px] italic text-keep-muted/60">
            <span
              className="mr-1 select-none text-[9px] uppercase not-italic tracking-widest text-keep-accent/70"
              title={t("row.adminAuditTitle")}
            >
              {t("row.adminAudit")}
              <span className="ml-1 normal-case tracking-normal">
               , {msg.displayName}
                {actorBlurb ? ` · ${actorBlurb}` : ""}
              </span>
              :
            </span>
            <span className="whitespace-pre-wrap">{msg.originalBody}</span>
          </blockquote>
        ) : null}
      </div>
    );
  }

  const showOwnControls = isOwn && REPLYABLE_KINDS.has(msg.kind);
  // Admins can rewrite anyone's post (cross-author edit). The own-edit
  // path keeps its existing tooltip; the admin path picks up a distinct
  // "Admin edit" label in PostToolbar so the actor knows they're using
  // a moderation lever, not exercising authorship.
  const showAdminEdit = !isOwn && canAdminEdit && REPLYABLE_KINDS.has(msg.kind);
  const showReport = canReport && !isOwn && REPORTABLE_KINDS.has(msg.kind);
  const showBookmark = BOOKMARKABLE_KINDS.has(msg.kind);
  const editedBadge = msg.editedAt ? (
    <span
      className="ml-1 text-[10px] italic text-keep-muted"
      title={t("row.editedAt", { time: formatTime(msg.editedAt) })}
    >
      {t("row.edited")}
    </span>
  ) : null;

  async function saveEdit() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (trimmed === msg.body) { setEditing(false); return; }
    setEditBusy(true);
    setEditError(null);
    try {
      const res = await fetch(`/messages/${msg.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: trimmed }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      // Chat repaints via the socket echo; the Forums Catalog (not in the
      // board's socket room) refetches off this tick instead.
      useChat.getState().bumpForumActionTick();
      setEditing(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : t("row.editFailed"));
    } finally {
      setEditBusy(false);
    }
  }

  return (
    <div
      data-message-id={msg.id}
      // items-start pins the avatar to the post's top line; without it
      // the avatar floated vertically centered beside tall posts and
      // short one-liners got inflated by the avatar's showcase frame,
      // which read as random gaps between replies.
      className="group flex items-start gap-2 rounded transition-colors duration-700"
    >
      {showAuthorHeader ? (
        <ForumAvatar
          src={msg.avatarUrl ?? null}
          name={msg.displayName}
          userId={msg.userId}
          characterId={msg.characterId ?? null}
          onClick={(e) => {
            e.stopPropagation();
            onIconClick(msg.userId, msg.displayName, msg.characterId ?? null);
          }}
          // < 28 = bare circle (no 1.5× showcase slot), so every reply
          // row has the SAME compact height regardless of frames.
          size={24}
        />
      ) : null}
      <div className="min-w-0 flex-1">
        {showAuthorHeader ? (
          <div className="flex items-baseline gap-2 text-[11px]">
            {/* Forum-header rank sigil. Reads from the message-row
                snapshot so a later rank-up doesn't rewrite the
                badge on a historical post. Gem variant matches the
                chat-line treatment so chronological + threaded
                surfaces share one visual language for ranks. */}
            <RankSigil rankKey={msg.rankKey ?? null} tier={msg.tier ?? null} size="md" variant="gem" />
            {/* Author name button. Suppressed for /me posts because the
                action body below renders as "DisplayName <body>" in the
                action color, repeating the name in the header would
                read as "Kaal\nKaal raises his sword". Profile access
                stays available via the avatar tile on the left. */}
            {msg.kind === "me" ? null : (
              <button
                type="button"
                onClick={() => onNameClick(msg.userId, msg.displayName, msg.characterId ?? null)}
                className={
                  "rounded font-semibold text-keep-text hover:text-keep-action " +
                  (isSenderAdmin ? "italic" : "")
                }
                // Author color only applies when no style is active,
                // a style's CSS typically owns the color directly.
                style={authorColor && !authorStyle ? { color: authorColor } : undefined}
              >
                <StyledName
                  displayName={msg.displayName}
                  styleKey={authorStyle?.key ?? null}
                  config={authorStyle?.config ?? null}
                  baseColor={authorColor}
                />
              </button>
            )}
            <button
              type="button"
              onClick={() => onTimeClick(msg.id)}
              className="rounded text-keep-muted tabular-nums hover:text-keep-action hover:underline"
              title={t("forum.replyToPostTitle", { time: fmtFullTimestamp(msg.createdAt) })}
            >
              {fmtForumTime(msg.createdAt)}
            </button>
            {msg.replyToDisplayName ? (
              onJumpToReply && msg.replyToId ? (
                <button
                  type="button"
                  onClick={() => onJumpToReply(msg.replyToId!)}
                  className="truncate rounded italic text-keep-muted hover:text-keep-action hover:underline focus:outline-none focus:ring-1 focus:ring-keep-action"
                  title={t("forum.jumpToUsersPost", { name: msg.replyToDisplayName })}
                >
                  ↪ {msg.replyToDisplayName}
                </button>
              ) : (
                <span className="truncate italic text-keep-muted">
                  ↪ {msg.replyToDisplayName}
                </span>
              )
            ) : null}
          </div>
        ) : null}
        {editing ? (
          <div className="mt-1 flex flex-col gap-1">
            <textarea
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(10, Math.max(3, draft.split("\n").length + 1))}
              className="w-full resize-y rounded border border-keep-action bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setEditing(false);
                  setDraft(msg.body);
                  setEditError(null);
                }
              }}
            />
            {editError ? <span className="text-[11px] text-keep-accent">{editError}</span> : null}
            <div className="flex justify-end gap-1">
              <button
                type="button"
                onClick={() => { setEditing(false); setDraft(msg.body); setEditError(null); }}
                className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs hover:bg-keep-banner"
              >
                {t("common:cancel")}
              </button>
              <button
                type="button"
                onClick={saveEdit}
                disabled={editBusy}
                className="rounded border border-keep-action bg-keep-action/10 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/20 disabled:opacity-50"
              >
                {editBusy ? t("common:saving") : t("common:save")}
              </button>
            </div>
          </div>
        ) : msg.kind === "me" ? (
          // Action posts read seamlessly: "<DisplayName> <body>" in
          // the action color, mirroring the chat-line /me treatment
          // (see the `case "me"` branch in [renderChatLine](./MessageList.tsx)).
          // The header's name button is suppressed above so the name
          // appears exactly once, integrated into the action sentence,
          // `/me raises his sword` → "Kaal raises his sword" rather
          // than a name header followed by an awkward bare verb body.
          // StyledName preserves any equipped name-style glamour
          // (gradients, glow) on the prefix; the rest of the body
          // takes the action color.
          <div
            className="whitespace-pre-wrap font-action"
            style={{ color: authorColor ?? "rgb(var(--keep-action))" }}
          >
            <StyledName
              displayName={msg.displayName}
              styleKey={authorStyle?.key ?? null}
              config={authorStyle?.config ?? null}
              baseColor={authorColor}
            />
            {" "}
            {renderedBody}
            {editedBadge}
          </div>
        ) : msg.kind === "npc" ? (
          // NPC post: a streamlined card — the body, an optional stat block,
          // and a quiet "voiced by" attribution. The NPC's name is the post
          // author (header above), so the line reads as the NPC speaking.
          <div className="rounded border-l-2 border-keep-system/50 bg-keep-system/5 px-2 py-1">
            <div className="whitespace-pre-wrap text-keep-text">
              {renderedBody}
              {editedBadge}
            </div>
            {msg.npcStats && msg.npcStats.length > 0 ? (
              <div className="mt-1 flex flex-wrap gap-1">
                {msg.npcStats.map((s, i) => (
                  <span key={i} className="rounded border border-keep-rule bg-keep-bg/60 px-1.5 py-0 text-[10px] text-keep-muted">
                    <b className="text-keep-text">{s.label}</b> {s.value}
                  </span>
                ))}
              </div>
            ) : null}
            {msg.npcVoicedBy ? (
              <div className="mt-1 text-[10px] italic text-keep-muted">{t("row.voicedBy", { name: msg.npcVoicedBy })}</div>
            ) : null}
          </div>
        ) : (
          <div className="whitespace-pre-wrap text-keep-text">
            {renderedBody}
            {editedBadge}
          </div>
        )}
        {/* Reaction CHIPS, same `chat_message` target kind as flat
            chat (forum posts ARE chat messages: say / me / ooc).
            Chips sit ABOVE the action toolbar (just under the message
            body) so reactions read as content rather than chrome.
            The "+ react" trigger is mounted INSIDE the action toolbar
            below via `extraActions`, keeps the toolbar row as a
            single tidy bar of post actions instead of stranding the
            add button on its own row beneath the message. */}
        {/* OpenGraph card for the post's first link. The author keeps
            the ✕ in the catalog; the anonymous reader never shows it. */}
        {msg.linkPreview && !msg.deletedAt ? (
          <LinkPreviewCard preview={msg.linkPreview} canRemove={isOwn && !readOnly} messageId={msg.id} />
        ) : null}
        {REPLYABLE_KINDS.has(msg.kind) && !msg.deletedAt ? (
          <div className="mt-1">
            <ReactionBar
              targetKind="chat_message"
              targetId={msg.id}
              {...(msg.reactions ? { initialEntries: msg.reactions } : {})}
              asCharacterId={viewerActiveCharacterIdForForum}
              hideAddButton
            />
          </div>
        ) : null}
        {/* Read-only mode renders NO per-post chrome — the address bar
            carries the topic's URL (mirrored on navigation), so guests
            copy the link from where links live. */}
        {!editing && !readOnly ? (
          <PostToolbar
            msg={msg}
            isOwn={isOwn}
            canModerate={canModerate}
            canPin={canPin}
            // Edit is shown to the author (always, in forum rooms) OR to
            // any admin via the cross-author override. Mods do NOT get
            // edit: they can hide a post with Delete but cannot rewrite
            // someone else's words.
            showEdit={showOwnControls || showAdminEdit}
            isAdminEdit={!isOwn && showAdminEdit}
            // Delete is shown to the author (within the normal rules)
            // OR to any moderator. The server re-validates the actual
            // permission, this is just the UI affordance.
            showDelete={showOwnControls || (canModerate && REPLYABLE_KINDS.has(msg.kind))}
            showBookmark={showBookmark}
            // Reporting your own post is meaningless; reporting as a
            // moderator is redundant since they can act directly.
            showReport={showReport && !showOwnControls && !canModerate}
            {...(onQuotePost ? { onQuotePost } : {})}
            {...(onReply ? { onReply } : {})}
            {...(postPermalink ? { permalinkUrl: postPermalink(msg.id) } : {})}
            onEdit={() => { setDraft(msg.body); setEditing(true); }}
            extraActions={
              REPLYABLE_KINDS.has(msg.kind) && !msg.deletedAt ? (
                <ReactionAddButton
                  targetKind="chat_message"
                  targetId={msg.id}
                  asCharacterId={viewerActiveCharacterIdForForum}
                  className="keep-button rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-0.5 normal-case hover:bg-keep-banner hover:text-keep-text"
                  title={t("reactions.add")}
                  label={<><span aria-hidden>+ 😊</span> <span className="text-[10px]">{t("forum.react")}</span></>}
                />
              ) : null
            }
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Inline action toolbar for forum posts. Sits beneath the post body and
 * carries Edit / Lock / Delete / Bookmark / Report pills. Buttons
 * render only when the relevant action is available for the viewer:
 *   - Edit      , author only (forum rooms lift the 60s grace cap).
 *   - Delete    , author OR moderator. Mod cross-author deletes are
 *                  the moderation lever for offensive replies.
 *   - Lock      , only on top-level topics; author OR moderator.
 *                  Locked topics show as 🔓 → unlock; the server-side
 *                  PATCH /messages/:id/lock toggles the state.
 *   - Bookmark  , anyone on bookmarkable kinds.
 *   - Report    , non-authors on reportable kinds in public rooms,
 *                  hidden for moderators (they can act directly).
 *
 * Edit triggers `onEdit` so the parent (ForumPostBody) can swap the
 * body region for an inline editor, keeping the editor scoped to the
 * post being edited instead of floating in a corner. Delete + Lock are
 * self-contained here: confirm, fire the appropriate REST call, and
 * the server's `message:update` broadcast flips the row state so the
 * renderer reflects the change.
 */
function PostToolbar({
  msg,
  isOwn,
  canModerate,
  canPin,
  showEdit,
  isAdminEdit,
  showDelete,
  showBookmark,
  showReport,
  onEdit,
  onQuotePost,
  onReply,
  permalinkUrl,
  extraActions,
}: {
  msg: ChatMessage;
  isOwn: boolean;
  canModerate: boolean;
  canPin: boolean;
  showEdit: boolean;
  /** True when the Edit button represents an admin cross-author edit (not the author's own edit). Drives the moderation-tinted label + confirm copy. */
  isAdminEdit: boolean;
  showDelete: boolean;
  showBookmark: boolean;
  showReport: boolean;
  onEdit: () => void;
  /** Optional Quote-button handler. When present, a Quote pill appears. */
  onQuotePost?: (quoteText: string) => void;
  /**
   * Optional Reply-button handler. When present, a "Reply" pill is
   * rendered to the LEFT of the Quote pill. Clicking it makes the
   * post's parent topic active in the composer so the user can type a
   * reply immediately. Distinct from Quote (which also pre-fills the
   * composer with a blockquote of the post), Reply is the bare
   * "start replying to this thread" affordance.
   */
  onReply?: () => void;
  /** Shareable URL for this post; renders a copy-link pill. */
  permalinkUrl?: string;
  /** Extra actions appended to the right of the standard buttons.
   *  Forum posts mount the "add reaction" trigger here so it lives
   *  inline with Reply/Quote/Bookmark instead of as a separate row
   *  below them. */
  extraActions?: React.ReactNode;
}) {
  const { t } = useTranslation("chat");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [lockBusy, setLockBusy] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Lock is only meaningful on top-level topics. Mods can lock any
  // topic; authors can lock their own. Replies don't get a Lock button
  // (the server rejects /lock on replies with 400 anyway).
  const isTopic = !msg.replyToId;
  const showLock = isTopic && (isOwn || canModerate);
  const isLocked = !!msg.lockedAt;
  // Pin is admin-only and topic-only. The server enforces both.
  const showPin = isTopic && canPin;
  const isSticky = !!msg.isSticky;
  // Quote is offered on any post the parent provides a handler for.
  // Replying to your own post via Quote is fine, sometimes users
  // quote themselves to keep a long thread organized.
  const showQuote = !!onQuotePost;
  // Reply pill ditto, only renders when the parent wires up a
  // handler, so contexts that don't make sense (e.g. inside the focused
  // thread modal where the composer is already targeted at this topic)
  // can simply not pass `onReply` and the button hides itself.
  const showReply = !!onReply;
  // Forum context: when present, "report" routes to the FORUM's queue
  // (owner + mods) instead of the site-wide report. Available on any
  // forum post that isn't the viewer's own.
  const forumReport = useContext(ForumReportContext);
  const showForumReport = !!forumReport && !isOwn && REPORTABLE_KINDS.has(msg.kind);
  // Move/merge: one toolbar button (topics only) opens the unified picker.
  // Present only when the Forums Catalog wired the admin context, i.e. the
  // viewer holds move_topics; the server re-checks every action.
  const topicAdmin = useContext(ForumTopicAdminContext);
  const [manageOpen, setManageOpen] = useState(false);
  const showMove = isTopic && !!topicAdmin;

  async function doDelete() {
    // The confirm copy differs slightly for moderators so they know
    // the body remains recoverable from the admin audit view.
    const prompt = canModerate && !isOwn
      ? t("forum.deleteOtherConfirm", { name: msg.displayName })
      : t("forum.deleteOwnConfirm");
    if (!window.confirm(prompt)) return;
    setDeleteBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`/messages/${msg.id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      useChat.getState().bumpForumActionTick();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("row.deleteFailed"));
    } finally {
      setDeleteBusy(false);
    }
  }

  async function toggleLock() {
    setLockBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`/messages/${msg.id}/lock`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locked: !isLocked }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      useChat.getState().bumpForumActionTick();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("forum.lockFailed"));
    } finally {
      setLockBusy(false);
    }
  }

  async function togglePin() {
    setPinBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`/messages/${msg.id}/sticky`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sticky: !isSticky }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      useChat.getState().bumpForumActionTick();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("row.pinFailed"));
    } finally {
      setPinBusy(false);
    }
  }

  function doQuote() {
    if (!onQuotePost) return;
    // Markdown blockquote with attribution. Each line of the original
    // body is prefixed with `> ` so multi-paragraph quotes render as a
    // single blockquote block. A trailing blank line + newline gives
    // the user a place to type their reply after the quote. The
    // "wrote:" is a msg: reference link (see lib/markdown.tsx) so
    // readers can jump back to the quoted post.
    const attribution = t("forum.quoteAttribution", { name: msg.displayName, id: msg.id });
    const bodyLines = msg.body.split("\n").map((l) => `> ${l}`).join("\n");
    const quote = `> ${attribution}\n${bodyLines}\n\n`;
    onQuotePost(quote);
  }

  if (!showEdit && !showDelete && !showBookmark && !showReport && !showForumReport && !showLock && !showPin && !showQuote && !showReply && !extraActions) return null;

  return (
    <>
    <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-keep-rule/30 pt-1 text-[10px] text-keep-muted">
      {showReply ? (
        <button
          type="button"
          onClick={onReply}
          className="keep-button rounded border border-keep-action/40 bg-keep-action/5 px-2 py-0.5 text-keep-action hover:bg-keep-action/15"
          title={t("forum.replyPillTitle")}
        >
          {t("forum.replyPill")}
        </button>
      ) : null}
      {showQuote ? (
        <button
          type="button"
          onClick={doQuote}
          className="keep-button rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-0.5 hover:bg-keep-banner hover:text-keep-text"
          title={t("forum.quoteTitle", { name: msg.displayName })}
        >
          {t("forum.quotePill")}
        </button>
      ) : null}
      {showEdit ? (
        <button
          type="button"
          onClick={() => {
            if (isAdminEdit) {
              const ok = window.confirm(
                t("forum.adminEditConfirm", { name: msg.displayName }),
              );
              if (!ok) return;
            }
            onEdit();
          }}
          className={
            isAdminEdit
              ? "keep-button rounded border border-keep-accent/40 bg-keep-bg/60 px-2 py-0.5 text-keep-accent/80 hover:bg-keep-accent/10 hover:text-keep-accent"
              : "keep-button rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-0.5 hover:bg-keep-banner hover:text-keep-text"
          }
          title={isAdminEdit ? t("forum.adminEditTitle", { name: msg.displayName }) : t("forum.editTitle")}
        >
          {t("forum.edit")}
        </button>
      ) : null}
      {showPin ? (
        <button
          type="button"
          onClick={togglePin}
          disabled={pinBusy}
          className="keep-button rounded border border-keep-action/40 bg-keep-bg/60 px-2 py-0.5 text-keep-action/80 hover:bg-keep-action/10 hover:text-keep-action disabled:opacity-50"
          title={isSticky ? t("forum.unpinTopic") : t("forum.pinTopicTitle")}
        >
          {pinBusy ? "…" : isSticky ? t("forum.unpinLabel") : t("forum.pinLabel")}
        </button>
      ) : null}
      {showLock ? (
        <button
          type="button"
          onClick={toggleLock}
          disabled={lockBusy}
          className="keep-button rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-0.5 hover:bg-keep-banner hover:text-keep-text disabled:opacity-50"
          title={isLocked ? t("forum.unlockTitle") : t("forum.lockTitle")}
        >
          {lockBusy ? "…" : isLocked ? t("forum.unlockLabel") : t("forum.lockLabel")}
        </button>
      ) : null}
      {showDelete ? (
        <button
          type="button"
          onClick={doDelete}
          disabled={deleteBusy}
          className="keep-button rounded border border-keep-accent/40 bg-keep-bg/60 text-keep-accent/80 px-2 py-0.5 hover:bg-keep-accent/10 hover:text-keep-accent disabled:opacity-50"
          title={canModerate && !isOwn ? t("forum.modHideTitle") : t("forum.hideTitle")}
        >
          {deleteBusy ? "…" : t("common:delete")}
        </button>
      ) : null}
      {showMove ? (
        <button
          type="button"
          onClick={() => setManageOpen(true)}
          className="keep-button rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-0.5 hover:bg-keep-banner hover:text-keep-text"
          title={t("forum.moveTitle")}
        >
          <FolderInput className="mr-1 inline h-3 w-3" aria-hidden="true" />{t("forum.move")}
        </button>
      ) : null}
      {showBookmark ? <InlineBookmark msg={msg} /> : null}
      {permalinkUrl ? <CopyLinkButton url={permalinkUrl} /> : null}
      {/* Forum posts report to the forum's own queue; suppress the site
          report in that case so there's exactly one Report affordance. */}
      {showForumReport ? (
        <button
          type="button"
          onClick={() => forumReport!(msg.id, msg.displayName)}
          className="keep-button flex items-center gap-1 rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-0.5 hover:bg-keep-banner hover:text-keep-text"
          title={t("forum.reportToForumTitle", { name: msg.displayName })}
        >
          <Flag className="h-3 w-3" aria-hidden="true" /> {t("forum.report")}
        </button>
      ) : null}
      {showReport && !showForumReport ? <InlineReport msg={msg} /> : null}
      {extraActions}
      {actionError ? <span className="normal-case tracking-normal text-keep-accent">{actionError}</span> : null}
    </div>
    {showMove && manageOpen && topicAdmin ? (
      <TopicManageModal
        topic={msg}
        boards={topicAdmin.boards}
        onChanged={topicAdmin.onChanged}
        onClose={() => setManageOpen(false)}
      />
    ) : null}
    </>
  );
}

/**
 * Inline bookmark trigger + popover. Mirrors `BookmarkButton`'s behavior
 * (popover with category datalist + optional note, POST /me/bookmarks)
 * but renders as a normal toolbar button without the absolute floating
 * wrapper the flat-chat variant uses.
 */


function InlineBookmark({ msg }: { msg: ChatMessage }) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [knownCategories, setKnownCategories] = useState<string[] | null>(null);
  // Calm-mode ease: this popover is a desktop dropdown (md:top-full) AND a
  // mobile bottom-sheet (fixed bottom-2), so a slide transform's direction
  // would be wrong in one layout — fade in (opacity only) is safe for both.
  const reduceMotion = useReducedMotion();

  async function openPopover() {
    setOpen(true);
    if (knownCategories === null) {
      try {
        const r = await fetch("/me/bookmarks", { credentials: "include" });
        if (r.ok) {
          const j = (await r.json()) as { bookmarks: Array<{ category: string }> };
          const seen = new Set<string>();
          for (const b of j.bookmarks) {
            const c = b.category.trim();
            if (c) seen.add(c);
          }
          setKnownCategories([...seen].sort((a, b) => a.localeCompare(b)));
        } else { setKnownCategories([]); }
      } catch { setKnownCategories([]); }
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/me/bookmarks", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageId: msg.id,
          category: category.trim(),
          note: note.trim() || null,
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({} as { error?: string })));
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setDone(true);
      setOpen(false);
      window.setTimeout(() => setDone(false), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bookmarks.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={openPopover}
        title={t("bookmarks.bookmarkPost")}
        className="keep-button rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-0.5 hover:bg-keep-action/10 hover:text-keep-action"
      >
        {done ? t("bookmarks.savedCheck") : t("bookmarks.bookmarkLabel")}
      </button>
      {open ? (
        <div
          onClick={(e) => e.stopPropagation()}
          // Mobile: bottom-anchored fixed sheet so the popover always
          // sits inside the viewport regardless of where the trigger
          // is. md+: absolute-positioned dropdown anchored to the
          // trigger's left edge, same as before. `max-h-[80vh]` +
          // `overflow-y-auto` keeps it usable on very short mobile
          // viewports (e.g. landscape phone with the keyboard open).
          className={`fixed inset-x-2 bottom-2 z-30 max-h-[80vh] overflow-y-auto rounded border border-keep-rule bg-keep-bg p-2 text-xs normal-case tracking-normal shadow-lg md:absolute md:inset-x-auto md:bottom-auto md:left-0 md:top-full md:mt-1 md:max-h-none md:min-w-[16rem]${reduceMotion ? " tk-fade-in" : ""}`}
        >
          <div className="mb-1 font-semibold text-keep-text">{t("bookmarks.header")}</div>
          <label className="mb-1 block text-[10px] uppercase tracking-widest text-keep-muted">
            {t("bookmarks.category")}
            <input
              type="text"
              list={`bookmark-cats-inline-${msg.id}`}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              maxLength={60}
              placeholder={t("bookmarks.categoryEmptyPlaceholder")}
              className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 normal-case tracking-normal text-keep-text"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />
            <datalist id={`bookmark-cats-inline-${msg.id}`}>
              {(knownCategories ?? []).map((c) => <option key={c} value={c} />)}
            </datalist>
          </label>
          {/* Existing-categories chip row. Datalist only shows
              suggestions as the user types; chips let them pick a
              previously-used category in one click. Hidden while
              loading and when the user has none yet. */}
          {knownCategories && knownCategories.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-1">
              {knownCategories.map((c) => {
                const isSelected = c === category.trim();
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategory(c)}
                    className={
                      "rounded-full border px-2 py-0.5 text-[10px] normal-case tracking-normal " +
                      (isSelected
                        ? "border-keep-action bg-keep-action/15 text-keep-action"
                        : "border-keep-rule/60 bg-keep-bg/60 text-keep-muted hover:border-keep-action/40 hover:bg-keep-action/10 hover:text-keep-action")
                    }
                    title={t("bookmarks.useCategory", { name: c })}
                  >
                    {c}
                  </button>
                );
              })}
            </div>
          ) : null}
          <label className="mb-2 block text-[10px] uppercase tracking-widest text-keep-muted">
            {t("bookmarks.noteOptional")}
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              placeholder={t("bookmarks.whySaving")}
              className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 normal-case tracking-normal text-keep-text"
            />
          </label>
          {error ? <div className="mb-1 text-[10px] text-keep-accent">{error}</div> : null}
          <div className="flex justify-end gap-1">
            <button
              type="button"
              onClick={() => { setOpen(false); setError(null); }}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-[10px] hover:bg-keep-banner"
            >
              {t("common:cancel")}
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="rounded border border-keep-action/60 bg-keep-action/10 px-2 py-0.5 text-[10px] font-semibold text-keep-action hover:bg-keep-action/20 disabled:opacity-50"
            >
              {busy ? t("bookmarks.saving") : t("common:save")}
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}


/**
 * Inline report button. Mirrors `ReportButton` (POST /reports with an
 * optional reason prompt) but as a toolbar pill instead of the
 * hover-revealed corner flag.
 */
function InlineReport({ msg }: { msg: ChatMessage }) {
  const { t } = useTranslation("chat");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function file() {
    if (done || busy) return;
    const reason = window.prompt(
      t("report.postPrompt", { name: msg.displayName }),
      "",
    );
    if (reason === null) return;
    setBusy(true);
    try {
      const res = await fetch("/reports", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: msg.id, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        window.alert(j.error ?? t("report.fileFailed", { status: res.status }));
        return;
      }
      setDone(true);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t("report.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={file}
      disabled={busy || done}
      title={done ? t("report.reportedTitle") : t("report.reportPostTitle")}
      className="keep-button rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-0.5 hover:bg-keep-accent/10 hover:text-keep-accent disabled:opacity-50"
    >
      {done ? t("report.reportedLabel") : t("report.reportLabel")}
    </button>
  );
}

