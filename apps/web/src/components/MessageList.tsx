import { Fragment, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { BarChart3, Bookmark, BookmarkCheck, Flag, FolderInput, Lock, Pencil, Reply, SmilePlus, Trash2 } from "lucide-react";
import { setTopicCategory, moveTopicToBoard, mergeTopicInto, fetchBoardTopics, fetchRoomCategories } from "../lib/forums.js";
import { ForumReportContext } from "../lib/forumReportContext.js";
import { ForumTopicAdminContext, type ForumTopicAdminBoard } from "../lib/forumTopicAdminContext.js";
import { ForumPrefixContext } from "../lib/forumPrefixContext.js";
import { Modal } from "./Modal.js";
import { PollCard } from "./PollCard.js";
import { customCmdCssToStyle, isAdminRole, resolveMessageColor, type AvatarCrop, type ChatMessage, type ForumTopicCard, type MentionRef, type RoomOccupant, type ThreadCategory } from "@thekeep/shared";
import { useActiveTheme } from "../lib/theme.js";
import { BorderedAvatar, type BorderedAvatarSize } from "./BorderedAvatar.js";
import { RankSigil } from "./RankSigil.js";
import { StyledName } from "./StyledName.js";
import { UserNameTag } from "./UserNameTag.js";
import type { Gender } from "../lib/gender.js";
import { parseInline, renderForumBody, solitaryEmoticonToken } from "../lib/markdown.js";
import { sanitizeUserHtml } from "../lib/userHtml.js";
import { renderUiRouteChipsInHtml } from "@thekeep/shared";
import { handleUiRouteClickInHtml } from "../lib/uiRouteOpen.js";
import { hydrateDynamicUiRouteChips } from "../lib/hydrateDynamicUiRouteChips.js";
import { EmoticonSprite } from "./EmoticonSprite.js";
import { useEmoticons } from "../state/emoticons.js";
import { handlePlainTextCopy } from "../lib/chatCopy.js";
import { splitMentions } from "../lib/mentions.js";
import { extractMentions } from "@thekeep/shared";
import { prefixAppliesToCategory } from "@thekeep/shared";
import { useChat } from "../state/store.js";
import { ReactionAddButton, ReactionBar } from "./ReactionBar.js";
import { LinkPreviewCard } from "./LinkPreviewCard.js";
import { MessageVisibilityGate } from "./MessageVisibilityGate.js";
import { useMentionsCache, requestMentionResolve } from "../state/mentions.js";
import { readError } from "../lib/http.js";

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
  /** Anonymous forum reader (/f/ landing): hide every action toolbar —
   *  read-only browsing, copy-link only. */
  readOnly?: boolean;
  /** Permalink builders (forum surfaces). When present, topic cards and
   *  post toolbars grow a copy-link button. */
  postPermalink?: (messageId: string) => string;
}

/** Replies per page inside an expanded topic. Chains at or under this
 *  render whole; longer chains get the classic forum pager (First /
 *  Prev / Page x of y / Next / Last), defaulting to the newest page. */
const REPLIES_PER_PAGE = 20;

/** Tiny copy-permalink button (topic cards + post toolbars). Flashes a
 *  check for a beat after copying. */
function CopyLinkButton({ url, compact = false }: { url: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(url)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          })
          .catch(() => { /* clipboard unavailable; nothing to show */ });
      }}
      title={copied ? "Link copied" : "Copy link to this"}
      aria-label="Copy link"
      className={compact
        ? "shrink-0 rounded border border-keep-rule/60 bg-keep-bg/60 px-1.5 py-0.5 text-xs text-keep-muted hover:border-keep-action hover:text-keep-action"
        : "keep-button rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-0.5 text-keep-muted hover:bg-keep-banner hover:text-keep-text"}
    >
      <span aria-hidden>{copied ? "✓" : "🔗"}</span>
      {compact ? null : (
        <span className="ml-1 text-[10px]">{copied ? "Copied" : "Link"}</span>
      )}
    </button>
  );
}

/** Kinds eligible for /reports - mirrors the server's privacy gate. */
const REPORTABLE_KINDS = new Set(["say", "me", "ooc", "announce", "npc"]);

// Author edit/delete grace window is admin-configurable via
// `siteSettings.editGraceMs`, surfaced through the public /site
// endpoint into the branding store. The Line component reads it via
// `useChat` at render time so a runtime tweak in the admin panel
// takes effect without a reload. This client-side gate is just the
// soft "hide controls past the window" check; the server route
// re-validates and is authoritative.

const REPLYABLE_KINDS = new Set(["say", "me", "ooc", "npc"]);

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

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/**
 * Date-aware timestamp for forum surfaces (topic cards + the post
 * timestamp on each ForumPostBody). Forum posts are persistent,
 * a "09:21:48" with no date is meaningless once the topic is more
 * than a few hours old, which is why the old `fmtTime` rendering
 * read as wrong on the forum even though it was fine for live chat.
 *
 * Tier ladder, picked for "fits in a chip-sized footprint, reads
 * like a human wrote it":
 *   - < 60s:        "just now"
 *   - < 60m:        "12m ago"
 *   - < 24h:        "5h ago"
 *   - < 7d:         "Mon at 9:21 PM"   (weekday + locale time)
 *   - same year:    "Jun 4, 9:21 PM"
 *   - older:        "Jun 4, 2025"      (year on its own, older posts
 *                                       care about the year, not the
 *                                       minute)
 *
 * Locale-aware via `toLocaleString`, month abbreviations + 12-/24-h
 * preference follow the viewer's browser locale, so en-US sees
 * "9:21 PM" and en-GB sees "21:21". The chat-line `fmtTime` stays
 * HH:MM:SS because tight time-of-day precision is useful in an
 * active conversation where context tells you what day it is.
 */
function fmtForumTime(ms: number): string {
  const d = new Date(ms);
  const now = Date.now();
  const delta = now - ms;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) {
    const day = d.toLocaleDateString(undefined, { weekday: "short" });
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `${day} at ${time}`;
  }
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  if (sameYear) {
    const md = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `${md}, ${time}`;
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Always-explicit "wall clock" timestamp for hover tooltips, so
 *  any tier of the date-aware label above can be cross-checked
 *  against an unambiguous full date/time. */
function fmtFullTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

/**
 * Distance from the bottom (px) within which a NEW message (an append)
 * is allowed to scroll the reader down to follow it. Generous on
 * purpose: a brand-new line — especially the reader's OWN send — should
 * follow even when they're a few lines off the bottom.
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
 * This complements MessageVisibilityGate (which unmounts off-screen
 * DOM but keeps a placeholder + observer per message): the gate bounds
 * paint/decode cost, this bounds the row COUNT so a long live session
 * or repeated load-older doesn't accumulate thousands of placeholders.
 * SOFT_CAP keeps several scroll-up pages of context resident.
 */
const FLAT_BUFFER_SOFT_CAP = 200;
const FLAT_BUFFER_HARD_CAP = 300;

export function MessageList({ messages, occupants, selfUserId, selfNames, roomType, replyMode = "flat", onIconClick, onNameClick, onMentionClick, onWorldClick, onTimeClick, onJumpToReply, fontStep, highlightMessageId, onHighlightDone, roomId, threadCategories, activeTopicId, onSetActiveTopic, onPopoutTopic, canModerate = false, canPin = false, canAdminEdit = false, onQuotePost, forumBuckets, onGoToForumPage, onFlushPendingTopics, onActivateCategory, onStartTopicInCategory, renderTopicComposer, renderNewTopicForm, unreadTopicIds, watchedTopicIds, onToggleTopicWatch, readOnly = false, postPermalink }: Props) {
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
  // it cooperates with the scroll listener: a programmatic pin emits a
  // scroll event we must NOT read as user intent, and a recent USER scroll
  // defers the pin so it never fights an in-progress drag.
  const pinHandleRef = useRef<number | null>(null);
  const programmaticScrollRef = useRef(false);
  const lastUserScrollTsRef = useRef(0);
  // Mirror `messages` into a ref so the live scroll listener below can
  // read the current array without re-binding on every change (cheap,
  // but binds dozens of times per second in active rooms). The
  // listener closes over `messagesRef` once at attach time; reading
  // `.current` gives it the up-to-date buffer.
  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
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
      // and stops the "bounce." The looser NEAR_BOTTOM_PX still governs
      // whether a brand-new message (append, below) scrolls down to follow.
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_BOTTOM_PX;
      // A programmatic pin (the ResizeObserver below) also emits a scroll
      // event; swallow that echo so it isn't mistaken for user intent.
      // Every OTHER scroll is the reader's, and stamps their last
      // interaction so the re-pin can hold off and never yank a live drag.
      if (programmaticScrollRef.current) programmaticScrollRef.current = false;
      else lastUserScrollTsRef.current = performance.now();
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
      el.scrollTop = el.scrollHeight;
      stickRef.current = true;
      return;
    }
    const firstChanged = newFirstId !== prev.firstId;
    const lastChanged = newLastId !== prev.lastId;
    if (firstChanged && !lastChanged) {
      // Prepend: anchor the existing content under the user's eyes.
      const delta = el.scrollHeight - prev.height;
      el.scrollTop = prev.top + delta;
      return;
    }
    if (lastChanged) {
      // Append (or full replacement). End-pin only when the user was
      // already near the bottom, otherwise they're reading older
      // history and we shouldn't yank them away.
      const wasNearBottom = prev.height - prev.top - el.clientHeight < NEAR_BOTTOM_PX;
      // Detect full-replacement: BOTH endpoints changed (room switch,
      // jump-window swap). End-pin so the user lands at the newest.
      const replaced = firstChanged && lastChanged;
      if (replaced || wasNearBottom) {
        el.scrollTop = el.scrollHeight;
        // Re-arm the stick so the async-growth re-pin keeps following
        // this append's late-loading media (a programmatic scrollTop set
        // doesn't fire a scroll event, so capture() won't re-arm it).
        stickRef.current = true;
      }
    }
    // first AND last unchanged → no buffer changes that affect layout
    // (an in-place message edit, for example). Leave scroll alone.
  }, [messages, highlightMessageId, replyMode]);

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
  // CRUCIAL: setting scrollTop DOES indirectly resize the content here —
  // moving the viewport flips MessageVisibilityGate intersection states,
  // which mount/unmount message bodies and change the feed height, which
  // re-fires this observer. Writing scrollTop unconditionally turned that
  // into a runaway observe→pin→gate-flip→observe loop (the "seizure" shake)
  // that also stole manual scrolling. So the pin is hardened three ways:
  //   (a) coalesced to ONE write per frame (rAF), never re-entrant;
  //   (b) skipped once we're already within a pixel of the bottom, so a
  //       settled feed stops writing and the gates stop thrashing;
  //   (c) deferred for a beat after any USER scroll, so it never hijacks
  //       an in-progress drag (mobile momentum especially) — then fires
  //       once when the reader settles so late media still lands at bottom.
  useLayoutEffect(() => {
    if (replyMode === "nested") return;
    const el = ref.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    const REPIN_AFTER_USER_MS = 250;
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
      programmaticScrollRef.current = true; // mark the scroll-echo as ours
      el.scrollTop = el.scrollHeight;
    };
    // Track the container's last height so we can ignore sub-line wobble.
    let lastContainerH = el.clientHeight;
    // Pixels the CONTAINER must change by before we re-pin. The composer
    // auto-grow re-measures on every keystroke and can jitter by a few px
    // (min-height vs scrollHeight rounding, the overflowY scrollbar
    // toggling near max-lines); re-pinning on that micro-wobble made the
    // feed "bounce" while typing. A real line grow/shrink is ~a line tall,
    // well over this, so it still pins; content-box growth (late media,
    // gate mounts) is never gated this way.
    const CONTAINER_REPIN_MIN_DELTA = 10;
    const ro = new ResizeObserver((entries) => {
      if (pinHandleRef.current != null) return; // (a) one pending pin at a time
      let shouldPin = false;
      for (const e of entries) {
        if (e.target === el) {
          // Container (scroll viewport): only react to a meaningful resize,
          // and force an IMMEDIATE re-stick (a resize is a layout change, not
          // a user drag — don't let the user-scroll deferral hold it off).
          const h = el.clientHeight;
          if (Math.abs(h - lastContainerH) >= CONTAINER_REPIN_MIN_DELTA) { shouldPin = true; forceNextPin = true; }
          lastContainerH = h;
        } else {
          // Content box: late media / gate mounts — always consider.
          shouldPin = true;
        }
      }
      if (!shouldPin) return;
      pinHandleRef.current = requestAnimationFrame(pin);
    });
    // Observe the CONTENT box (late media / gate mounts grow the stream)
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
  }, [messages, roomId, replyMode, trimRoomToRecent]);

  // Jump-to-message flash. When `highlightMessageId` flips to a value
  // present in the current buffer, find the row's DOM node, scroll it to
  // center, and paint a brief accent tint. The transition-colors classes
  // on the row itself (see Line) handle the fade-out; we only toggle the
  // background class. Cleared via onHighlightDone after the flash window.
  useEffect(() => {
    if (!highlightMessageId) return;
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

  const genderByUser = new Map<string, Gender>();
  // Account-level role lookup so the renderer can italicize site admins'
  // names. Only populated for users currently in the room - history from
  // someone who's left renders without italics, which is fine (italics is
  // decorative, not load-bearing identification).
  const adminUserIds = new Set<string>();
  // Earning, equipped name style + cosmetic state keyed by the FULL
  // identity tuple (userId, characterId). Each row in `occupants`
  // represents ONE identity, a user has one occupant row for OOC/
  // master and one per character they're currently voicing. Keying
  // these maps by userId alone collapsed the rows down to "last
  // wins", which is why a master's equipped Embers bled onto every
  // character of the same user (and vice versa). Building a
  // compound key keeps each identity's cosmetics separate, and the
  // message-level lookup below uses the same `(userId,
  // characterId)` tuple the message was authored under.
  //
  // Falls back to plain rendering for backlog from identities that
  // have left the room (matches the gender / admin-italics
  // fallbacks above, styling is decorative, not load-bearing).
  function identityKey(userId: string, characterId: string | null | undefined): string {
    return `${userId}::${characterId ?? ""}`;
  }
  const styleByIdentity = new Map<string, { key: string; config: Record<string, unknown> | null }>();
  const cosmeticsByIdentity = new Map<string, {
    avatarUrl: string | null;
    avatarCrop: AvatarCrop | null;
    selectedBorderRankKey: string | null;
    selectedFreeformBorderKey: string | null;
    freeformBorderConfig: Record<string, string> | null;
    inlineAvatarEnabled: boolean;
  }>();
  const genderByIdentity = new Map<string, Gender>();
  for (const o of occupants) {
    const k = identityKey(o.userId, o.characterId);
    genderByIdentity.set(k, o.gender);
    // Admin status IS account-wide (the user holds the role
    // regardless of which character they're voicing), so this stays
    // keyed by userId. Call sites that consume this set also need to
    // gate on the per-message `characterId === null` check to avoid
    // italicizing a staff user's CHARACTER voices, that would leak
    // the OOC ↔ character link the per-identity partition is meant
    // to keep private. See `isSenderAdmin` usage below.
    if (isAdminRole(o.accountRole)) adminUserIds.add(o.userId);
    if (o.activeNameStyleKey) {
      styleByIdentity.set(k, { key: o.activeNameStyleKey, config: o.nameStyleConfig });
    }
    cosmeticsByIdentity.set(k, {
      avatarUrl: o.avatarUrl,
      avatarCrop: o.avatarCrop,
      selectedBorderRankKey: o.selectedBorderRankKey,
      selectedFreeformBorderKey: o.selectedFreeformBorderKey,
      freeformBorderConfig: o.freeformBorderConfig,
      inlineAvatarEnabled: o.inlineAvatarEnabled,
    });
    // ALSO write the master/OOC identity (`identityKey(userId, null)`)
    // for this user, even when the occupant row represents a
    // character, the wire carries the user's master slot fields too.
    // This is what lets past OOC messages from a user currently
    // voicing a character render with the master's equipped style
    // and cosmetics instead of falling through to plain. If the
    // occupant IS the OOC row (characterId === null), this is a
    // no-op overwrite of the row we just wrote.
    const masterKey = identityKey(o.userId, null);
    if (!styleByIdentity.has(masterKey) && o.masterNameStyleKey) {
      styleByIdentity.set(masterKey, { key: o.masterNameStyleKey, config: o.masterNameStyleConfig });
    }
    if (!cosmeticsByIdentity.has(masterKey)) {
      cosmeticsByIdentity.set(masterKey, {
        avatarUrl: o.masterAvatarUrl,
        avatarCrop: o.masterAvatarCrop,
        selectedBorderRankKey: o.masterSelectedBorderRankKey,
        selectedFreeformBorderKey: o.masterSelectedFreeformBorderKey,
        freeformBorderConfig: o.masterFreeformBorderConfig,
        inlineAvatarEnabled: o.masterInlineAvatarEnabled,
      });
    }
    // Keep a fallback by userId only for the gender map so the
    // existing default-keyed lookups elsewhere still resolve to
    // something sane for chat lines that authored before the
    // occupant joined, first-write-wins via the if-guard, so a
    // character row doesn't clobber the OOC fallback.
    if (!genderByUser.has(o.userId)) genderByUser.set(o.userId, o.gender);
  }
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
    return (
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
        onIconClick={onIconClick}
        onNameClick={onNameClick}
        onMentionClick={onMentionClick}
        onWorldClick={onWorldClick}
        onTimeClick={onTimeClick}
        {...(onJumpToReply ? { onJumpToReply } : {})}
        selfNames={effectiveSelfNames}
      />
    );
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

/** Trigger an older-history fetch when scrolled within this many px of the top. */
const FLAT_LOAD_OLDER_THRESHOLD_PX = 200;

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
    const buf = useChat.getState().messagesByRoom[roomId] ?? [];
    const oldest = buf[0];
    if (!oldest) return;
    inflightRef.current = true;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const r = await fetch(`/rooms/${roomId}/messages?before=${oldest.createdAt}&limit=50`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { messages: ChatMessage[]; hasMore: boolean };
      prependMessages(roomId, j.messages);
      setRoomHistoryHasMore(roomId, j.hasMore);
    } catch (e) {
      setOlderError(e instanceof Error ? e.message : "load failed");
    } finally {
      inflightRef.current = false;
      setLoadingOlder(false);
    }
  }, [roomId, hasMore, prependMessages, setRoomHistoryHasMore]);

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    if (!hasMore || inflightRef.current) return;
    if (e.currentTarget.scrollTop <= FLAT_LOAD_OLDER_THRESHOLD_PX) {
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
      // `overflow-anchor: none` disables the browser's scroll-anchoring on
      // this container. This component manages scroll position entirely by
      // hand (the bottom re-pin, the load-older `scrollTop += delta`
      // preservation, the buffer-diff auto-scroll). Native scroll anchoring
      // ALSO nudges scrollTop whenever content above the viewport changes
      // height (a gate mounting/unmounting, late media) to keep the visible
      // anchor stable — so the two controllers fight over scrollTop and the
      // feed wobbles a few px once there's enough history above to anchor
      // against. Turning anchoring off makes our manual logic the sole
      // authority and stops the bounce.
      style={{ fontSize: FONT_EM[fontStep], overflowAnchor: "none" }}
    >
      {/* Content box the parent's ResizeObserver watches to keep the
          feed pinned to the newest line as late-loading media grows the
          height. A plain wrapper, no layout effect of its own (the
          scroll container keeps the padding + scroll). */}
      <div ref={contentRef}>
      {hasMore || loadingOlder ? (
        <div className="mb-1 flex items-center justify-center gap-2 text-[10px] uppercase tracking-widest text-keep-muted">
          {loadingOlder ? (
            <span>Loading earlier messages…</span>
          ) : olderError ? (
            <button
              type="button"
              onClick={() => { void loadOlder(); }}
              className="rounded border border-keep-accent/40 px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10"
              title={olderError}
            >
              Retry loading earlier messages
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
              Tap or scroll up for earlier messages
            </button>
          )}
        </div>
      ) : messages.length > 0 ? (
        <div className="mb-1 flex items-center justify-center text-[10px] uppercase tracking-widest text-keep-muted/60">
          start of history
        </div>
      ) : null}
      {messages.map((m) => (
        // Each message rides through a viewport-aware gate that
        // unmounts the line's heavy DOM (embeds, sprite images,
        // bordered avatars, name-style decorations) when scrolled
        // far away, Discord-style. The gate's outer div holds a
        // measured-height placeholder while unmounted so scroll
        // position never jumps.
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
  if (!body) return "(untitled)";
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
  const pageList = buildForumPageList(currentPage, totalPages);
  return (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-keep-rule/30 pt-2">
      <nav
        aria-label={`Page navigation for ${sectionKey === "_uncat" ? "Uncategorized" : "category"}`}
        className="flex flex-wrap items-center gap-1"
      >
        <button
          type="button"
          onClick={() => onGoToPage(currentPage - 1)}
          disabled={isLoading || currentPage <= 1}
          className="rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-0.5 text-[11px] uppercase tracking-widest text-keep-muted hover:bg-keep-banner hover:text-keep-text disabled:cursor-not-allowed disabled:opacity-40"
          title="Previous page"
        >
          ‹ Prev
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
              title={`Go to page ${entry}`}
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
          title="Next page"
        >
          Next ›
        </button>
      </nav>
      <span className="text-[10px] uppercase tracking-widest text-keep-muted tabular-nums">
        Page {currentPage} of {totalPages} · {totalCount.toLocaleString()} {totalCount === 1 ? "topic" : "topics"}
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
  postPermalink?: (messageId: string) => string;
  /** Jump-highlight target (quote references); TopicCards expand their
   *  reply cap when it's one of their hidden replies. */
  highlightMessageId?: string | null;
}) {
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
      out.push({ key: "_uncat", label: categories.length > 0 ? "Uncategorized" : null, subtitle: null, iconUrl: null, membersOnly: false, locked: false, children: [] });
    }
    return out;
  }, [categories, buckets]);

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
            title="Show the topics that arrived while you were reading"
          >
            ↓ {pendingCount} new {pendingCount === 1 ? "topic" : "topics"}
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
            <div className="px-1 py-2 text-xs italic text-keep-muted">Loading topics…</div>
          ) : (
            <div className="px-1 py-2 text-xs italic text-keep-muted">No topics yet.</div>
          )
        ) : (
          items.map((topic) => (
            <TopicCard
              key={topic.id}
              topic={topic}
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
                title={isCollapsed ? "Expand category" : "Collapse category"}
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
                        <Lock className="h-3.5 w-3.5 shrink-0 text-keep-accent" aria-label="Members only" />
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
                      title="Members only — join the forum to post here"
                    >
                      Members only
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
                    className="keep-button rounded border border-keep-action/50 bg-keep-action/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/20"
                    title={`Start a new topic in ${s.label}`}
                  >
                    + New Topic
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
                        title={subCollapsed ? "Expand subcategory" : "Collapse subcategory"}
                      >
                        <span className="flex min-w-0 items-baseline">
                          <span aria-hidden className="mr-2 inline-block w-3 shrink-0 text-keep-muted">{subCollapsed ? "▶" : "▼"}</span>
                          {sub.iconUrl ? (
                            <img src={sub.iconUrl} alt="" className="mr-2 h-4 w-4 shrink-0 self-center object-contain" />
                          ) : null}
                          <span className="min-w-0">
                            <span className="flex min-w-0 items-center gap-1.5 truncate">
                              {sub.membersOnly ? (
                                <Lock className="h-3 w-3 shrink-0 text-keep-accent" aria-label="Members only" />
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
                              title="Members only — join the forum to post here"
                            >
                              Members only
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
                            className="keep-button rounded border border-keep-action/50 bg-keep-action/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/20"
                            title={`Start a new topic in ${sub.label}`}
                          >
                            + New Topic
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
/**
 * Unified "Move topic" modal, opened from the topic toolbar's Move button
 * (mods holding move_topics). One place for the three placement actions:
 * recategorize within the current board, move to another board, or merge into
 * another topic. The board list arrives via ForumTopicAdminContext; the current
 * board's categories are fetched on open (so the modal is self-contained and
 * needs no category prop-drilling). The server re-checks every action. Forums
 * Catalog viewers aren't on the board socket, so on success we just ask the
 * catalog to refresh (`onChanged`) rather than relying on a `message:update`.
 */
function TopicManageModal({ topic, boards, onClose, onChanged }: {
  topic: ChatMessage;
  boards: ForumTopicAdminBoard[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [cats, setCats] = useState<ThreadCategory[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Merge is lazy: a board's topic list only loads once the section is opened.
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeBoard, setMergeBoard] = useState<string>(topic.roomId);
  const [mergeTopics, setMergeTopics] = useState<ForumTopicCard[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetchRoomCategories(topic.roomId).then((c) => { if (alive) setCats(c); }).catch(() => { if (alive) setCats([]); });
    return () => { alive = false; };
  }, [topic.roomId]);

  useEffect(() => {
    if (!mergeOpen) return;
    let alive = true;
    setMergeTopics(null);
    fetchBoardTopics(mergeBoard).then((p) => { if (alive) setMergeTopics(p.topics); }).catch(() => { if (alive) setMergeTopics([]); });
    return () => { alive = false; };
  }, [mergeOpen, mergeBoard]);

  const otherBoards = boards.filter((b) => b.roomId !== topic.roomId);
  const currentCat = topic.threadCategoryId ?? "";

  function guard(p: Promise<void>) {
    setBusy(true); setErr(null);
    p.then(() => { onChanged(); onClose(); })
     .catch((e) => { setErr(e instanceof Error ? e.message : "Action failed."); setBusy(false); });
  }
  function recategorize(next: string) {
    const categoryId = next === "" ? null : next;
    if ((topic.threadCategoryId ?? null) === categoryId) return;
    guard(setTopicCategory(topic.id, categoryId));
  }
  function toBoard(roomId: string) { guard(moveTopicToBoard(topic.id, roomId, null)); }
  function doMerge(targetId: string, targetTitle: string) {
    if (!window.confirm(`Merge "${topic.title ?? "this topic"}" into "${targetTitle}"? Its posts become replies there. This can't be auto-undone.`)) return;
    guard(mergeTopicInto(topic.id, targetId));
  }

  return (
    <Modal onClose={onClose} zIndex={60}>
      <div onClick={(e) => e.stopPropagation()} className="keep-frame w-full rounded bg-keep-bg p-5 text-keep-text md:w-[min(480px,86vw)]">
        <h2 className="font-action text-lg">Move topic</h2>
        <p className="mt-1 truncate text-sm text-keep-muted">"{topic.title ?? "this topic"}"</p>

        {/* Recategorize within the current board (only when it has categories). */}
        {cats && cats.length > 0 ? (
          <div className="mt-3">
            <div className="mb-1 text-[10px] uppercase tracking-widest text-keep-muted">Category</div>
            <select
              value={currentCat}
              disabled={busy}
              onChange={(e) => recategorize(e.target.value)}
              className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm disabled:opacity-50"
            >
              <option value="">Uncategorized</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        ) : null}

        {/* Move the whole topic to a different board. */}
        {otherBoards.length > 0 ? (
          <div className="mt-3">
            <div className="mb-1 text-[10px] uppercase tracking-widest text-keep-muted">Move to another board</div>
            <ul className="space-y-1">
              {otherBoards.map((b) => (
                <li key={b.roomId}>
                  <button
                    type="button" disabled={busy} onClick={() => toBoard(b.roomId)}
                    className="flex w-full items-center justify-between rounded border border-keep-rule px-2 py-1.5 text-left text-sm hover:border-keep-action hover:bg-keep-banner/40 disabled:opacity-50"
                  >
                    <span className="truncate">{b.name}</span>
                    <span className="ml-2 shrink-0 text-[10px] text-keep-muted">{b.topicCount} topics</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Merge this topic into another (posts become replies). Lazy-loaded. */}
        <div className="mt-3">
          <button
            type="button" disabled={busy} onClick={() => setMergeOpen((o) => !o)}
            className="text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
          >{mergeOpen ? "▾" : "▸"} Merge into another topic</button>
          {mergeOpen ? (
            <div className="mt-2 space-y-2">
              {boards.length > 1 ? (
                <select value={mergeBoard} onChange={(e) => setMergeBoard(e.target.value)} className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm">
                  {boards.map((b) => <option key={b.roomId} value={b.roomId}>{b.name}</option>)}
                </select>
              ) : null}
              {!mergeTopics ? (
                <p className="text-xs italic text-keep-muted">Loading topics…</p>
              ) : (
                <ul className="max-h-60 space-y-1 overflow-y-auto">
                  {mergeTopics.filter((t) => t.id !== topic.id).map((t) => (
                    <li key={t.id}>
                      <button
                        type="button" disabled={busy} onClick={() => doMerge(t.id, t.title)}
                        className="w-full truncate rounded border border-keep-rule px-2 py-1.5 text-left text-sm hover:border-keep-action hover:bg-keep-banner/40 disabled:opacity-50"
                      >{t.title}</button>
                    </li>
                  ))}
                  {mergeTopics.filter((t) => t.id !== topic.id).length === 0 ? (
                    <li className="text-xs italic text-keep-muted">No other topics on this board.</li>
                  ) : null}
                </ul>
              )}
            </div>
          ) : null}
        </div>

        {err ? <div className="mt-2 rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">{err}</div> : null}
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="rounded border border-keep-rule px-3 py-1 text-sm hover:bg-keep-banner">Close</button>
        </div>
      </div>
    </Modal>
  );
}

/** Prefix chip for a forum topic + (for the author / manage_prefixes) a
 *  click target to (re)assign it. Resolves the chip from the forum's prefix
 *  catalog provided via context; renders nothing outside a prefix-enabled
 *  forum or when the topic has no prefix and the viewer can't assign one. */
function TopicPrefix({ topic, selfUserId }: { topic: ChatMessage; selfUserId: string | null }) {
  // Nudge the tag's ink toward legibility against the viewer's theme bg (same
  // pass the chat author colors use) so a pale tag survives a light theme and
  // a dark tag survives a dark one. The faint bg/border tints keep the raw hue.
  const themeBg = useActiveTheme().bg;
  const ctx = useContext(ForumPrefixContext);
  if (!ctx || topic.replyToId) return null;
  const prefix = topic.prefixId ? ctx.byId.get(topic.prefixId) : null;
  // A staff-only tag is manager-controlled: only manage_prefixes may set it,
  // and once set, only they may change/clear it — the author can't (mirrors
  // the server gate). So the author's self-tag right is suspended whenever the
  // current tag is staff-only.
  const isManager = ctx.canManagePrefixes;
  const currentIsStaffOnly = !!prefix?.staffOnly;
  const canAssign = isManager || (!!selfUserId && topic.userId === selfUserId && !currentIsStaffOnly);
  // Tags this topic's category can actually be given (global + matching-scope).
  // Members don't count staff-only tags toward "is there anything to assign".
  const categoryId = topic.threadCategoryId ?? null;
  const hasApplicable = ctx.all.some((p) => prefixAppliesToCategory(p, categoryId) && (isManager || !p.staffOnly));
  // Hide the whole affordance when there's nothing to assign and no way to
  // mint one — "no tags + custom off ⇒ don't show the tag system".
  if (!prefix && (!canAssign || (!hasApplicable && !ctx.canCreateCustom))) return null;
  const chip = prefix ? (
    <span
      className="shrink-0 rounded px-1.5 py-0 text-[10px] font-bold uppercase tracking-wide"
      style={{ backgroundColor: `${prefix.color}22`, color: resolveMessageColor(prefix.color, themeBg) ?? prefix.color, border: `1px solid ${prefix.color}66` }}
      title={prefix.tooltip ?? undefined}
    >
      {prefix.label}
    </span>
  ) : (
    <span className="shrink-0 rounded border border-dashed border-keep-rule px-1.5 py-0 text-[10px] uppercase tracking-wide text-keep-muted">+ tag</span>
  );
  if (!canAssign) return chip;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); ctx.onAssign(topic.id, topic.prefixId ?? null, topic.threadCategoryId ?? null); }}
      title="Set this topic's prefix"
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
}) {
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
        title="First page of replies"
      >
        « First
      </button>
      <button
        type="button"
        disabled={currentReplyPage <= 1}
        onClick={() => setReplyPage(currentReplyPage - 1)}
        className="rounded border border-keep-rule px-1.5 py-0.5 hover:text-keep-text disabled:opacity-30"
        title="Previous page of replies"
      >
        ‹ Prev
      </button>
      <span className="px-1 tabular-nums">
        Page {currentReplyPage} of {totalReplyPages} · {replies.length} replies
      </span>
      <button
        type="button"
        disabled={currentReplyPage >= totalReplyPages}
        onClick={() => setReplyPage(currentReplyPage + 1)}
        className="rounded border border-keep-rule px-1.5 py-0.5 hover:text-keep-text disabled:opacity-30"
        title="Next page of replies"
      >
        Next ›
      </button>
      <button
        type="button"
        disabled={currentReplyPage >= totalReplyPages}
        onClick={() => setReplyPage(totalReplyPages)}
        className="rounded border border-keep-rule px-1.5 py-0.5 hover:text-keep-text disabled:opacity-30"
        title="Newest page of replies"
      >
        Last »
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
        title={isActive ? "Collapse this topic" : "Open this topic"}
      >
        <ForumAvatar
          src={topic.avatarUrl ?? null}
          name={topic.displayName}
          userId={topic.userId}
          characterId={topic.characterId ?? null}
          size={48}
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
                aria-label="New activity"
                title="New activity since you last read this topic"
                className="h-2 w-2 shrink-0 self-center rounded-full bg-keep-action"
              />
            ) : null}
            {topic.isSticky ? (
              <span
                aria-label="Pinned"
                title="Pinned by an admin, stays at the top of this category."
                className="shrink-0 text-keep-action"
              >
                📌
              </span>
            ) : null}
            {topic.lockedAt ? (
              <span
                aria-label="Locked"
                title="This topic is locked, no new replies."
                className="shrink-0 text-keep-muted"
              >
                🔒
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
                  <BarChart3 className="h-3 w-3" aria-hidden="true" /> Poll
                </span>
              ) : null}
              {parseInline(headingText)}
            </span>
          </div>
          <div className="flex items-baseline gap-2 text-[11px] text-keep-muted">
            <span>by</span>
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
              style={topicAuthorColor ? { color: topicAuthorColor } : undefined}
            >
              {topic.displayName}
            </button>
            <span className="tabular-nums">
              {/* Use the larger of the server-provided total (correct on a
                  collapsed card before its thread is fetched) and the loaded
                  reply buffer (grows live as replies stream in once expanded).
                  Without the server count, a collapsed topic read "0 replies"
                  until opened. */}
              {(() => {
                const n = Math.max(topic.replyCount ?? 0, replies.length);
                return `· ${n} ${n === 1 ? "reply" : "replies"}`;
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
            aria-label={isWatched ? "Stop watching this topic" : "Watch this topic"}
            title={isWatched ? "Watching - you're notified of new replies. Click to stop." : "Watch this topic - get notified of new replies."}
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
            aria-label="Open in focused view"
            title="Open in focused view"
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
}) {
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
  const effectiveBorder = borderRankKey ?? occupantBorderRankKey;
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
      freeformBorderKey={occupantFreeformBorderKey}
      freeformConfig={occupantFreeformBorderConfig}
      avatarCrop={effectiveCrop}
      size={mappedSize}
      {...(onClick ? { onClick } : {})}
      title={`View ${name}'s profile`}
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
          ? "self-deleted"
          : `deleted by ${msg.deletedByDisplayName ?? "unknown"}`)
      : null;
    return (
      <div className="rounded border border-dashed border-keep-rule/40 px-2 py-1 text-xs italic text-keep-muted/70">
        [message removed]
        {/* Admin-only audit reveal. See the chat-line variant for the
            same rationale: server only emits `originalBody` to admin
            viewers, so this block stays inert for mods + ordinary
            users. */}
        {msg.originalBody ? (
          <blockquote className="mt-1 border-l-2 border-keep-accent/30 bg-keep-panel/20 px-2 py-0.5 text-[11px] italic text-keep-muted/60">
            <span
              className="mr-1 select-none text-[9px] uppercase not-italic tracking-widest text-keep-accent/70"
              title="Original body, visible to site admins only for audit"
            >
              admin audit
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
      title={`edited ${new Date(msg.editedAt).toLocaleTimeString()}`}
    >
      (edited)
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
      setEditError(err instanceof Error ? err.message : "edit failed");
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
              title={`Reply to this post, posted ${fmtFullTimestamp(msg.createdAt)}`}
            >
              {fmtForumTime(msg.createdAt)}
            </button>
            {msg.replyToDisplayName ? (
              onJumpToReply && msg.replyToId ? (
                <button
                  type="button"
                  onClick={() => onJumpToReply(msg.replyToId!)}
                  className="truncate rounded italic text-keep-muted hover:text-keep-action hover:underline focus:outline-none focus:ring-1 focus:ring-keep-action"
                  title={`Jump to ${msg.replyToDisplayName}'s post`}
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
                Cancel
              </button>
              <button
                type="button"
                onClick={saveEdit}
                disabled={editBusy}
                className="rounded border border-keep-action bg-keep-action/10 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/20 disabled:opacity-50"
              >
                {editBusy ? "Saving…" : "Save"}
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
              <div className="mt-1 text-[10px] italic text-keep-muted">voiced by {msg.npcVoicedBy}</div>
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
                  title="Add reaction"
                  label={<><span aria-hidden>+ 😊</span> <span className="text-[10px]">React</span></>}
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
      ? `Delete this post by ${msg.displayName}? It will be hidden from users but the original content stays available in the admin audit view.`
      : "Delete this post? It will be hidden from other users but admins can still review it if reported.";
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
      setActionError(err instanceof Error ? err.message : "delete failed");
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
      setActionError(err instanceof Error ? err.message : "lock failed");
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
      setActionError(err instanceof Error ? err.message : "pin failed");
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
    const attribution = `**${msg.displayName}** [wrote:](msg:${msg.id})`;
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
          title={`Reply to this thread`}
        >
          ↩ Reply
        </button>
      ) : null}
      {showQuote ? (
        <button
          type="button"
          onClick={doQuote}
          className="keep-button rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-0.5 hover:bg-keep-banner hover:text-keep-text"
          title={`Quote ${msg.displayName}'s post in your reply`}
        >
          ❝ Quote
        </button>
      ) : null}
      {showEdit ? (
        <button
          type="button"
          onClick={() => {
            if (isAdminEdit) {
              const ok = window.confirm(
                `Edit this post by ${msg.displayName} as an admin? The (edited) badge will appear to all viewers; the original body is preserved server-side for audit.`,
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
          title={isAdminEdit ? `Admin: edit ${msg.displayName}'s post` : "Edit this post"}
        >
          Edit
        </button>
      ) : null}
      {showPin ? (
        <button
          type="button"
          onClick={togglePin}
          disabled={pinBusy}
          className="keep-button rounded border border-keep-action/40 bg-keep-bg/60 px-2 py-0.5 text-keep-action/80 hover:bg-keep-action/10 hover:text-keep-action disabled:opacity-50"
          title={isSticky ? "Unpin this topic" : "Pin this topic to the top of its category"}
        >
          {pinBusy ? "…" : isSticky ? "📌 Unpin" : "📌 Pin"}
        </button>
      ) : null}
      {showLock ? (
        <button
          type="button"
          onClick={toggleLock}
          disabled={lockBusy}
          className="keep-button rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-0.5 hover:bg-keep-banner hover:text-keep-text disabled:opacity-50"
          title={isLocked ? "Reopen this topic to new replies" : "Lock this topic against new replies"}
        >
          {lockBusy ? "…" : isLocked ? "🔓 Unlock" : "🔒 Lock"}
        </button>
      ) : null}
      {showDelete ? (
        <button
          type="button"
          onClick={doDelete}
          disabled={deleteBusy}
          className="keep-button rounded border border-keep-accent/40 bg-keep-bg/60 text-keep-accent/80 px-2 py-0.5 hover:bg-keep-accent/10 hover:text-keep-accent disabled:opacity-50"
          title={canModerate && !isOwn ? "Moderator: hide this post" : "Hide this post"}
        >
          {deleteBusy ? "…" : "Delete"}
        </button>
      ) : null}
      {showMove ? (
        <button
          type="button"
          onClick={() => setManageOpen(true)}
          className="keep-button rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-0.5 hover:bg-keep-banner hover:text-keep-text"
          title="Move this topic to another category or board, or merge it into another topic"
        >
          <FolderInput className="mr-1 inline h-3 w-3" aria-hidden="true" />Move
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
          title={`Report ${msg.displayName}'s post to the forum's moderators`}
        >
          <Flag className="h-3 w-3" aria-hidden="true" /> Report
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

/**
 * `/scene <title> [| <url>]` banner. Bare scenes render exactly as the
 * old inline JSX did, just a tinted strip with the theatre mask and
 * the rendered title. Scenes that snapshot an image URL render the
 * title at a larger text size with the image centered below, rounded
 * corners, capped at 20rem tall so a portrait poster doesn't blow out
 * the timeline. Clicking the banner toggles collapsed mode: the image
 * disappears and the banner reads as the title-only variant, so a
 * viewer who's scrolled back through a long scene can tap once to
 * reclaim vertical space without losing the chapter marker.
 *
 * State is local-only, the toggle is per-viewer and per-mount, not
 * shared across tabs or persisted across reloads. That matches user
 * intent: "collapse" is a personal "I've already looked at the
 * image" gesture, not a director decision.
 */
function SceneBanner({
  renderedBody,
  imageUrl,
}: {
  renderedBody: ReactNode;
  imageUrl: string | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const hasImage = !!imageUrl;
  return (
    <div
      // Click the banner to collapse/expand when there's an image.
      // Without an image the click handler is omitted so the banner
      // stays a non-interactive timeline marker (matches the
      // pre-image behavior, no "click me" cursor, no pointer
      // affordance changes on hover).
      {...(hasImage
        ? {
            onClick: () => setCollapsed((c) => !c),
            role: "button" as const,
            tabIndex: 0,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setCollapsed((c) => !c);
              }
            },
            "aria-expanded": !collapsed,
            title: collapsed ? "Click to expand the scene image" : "Click to collapse the scene image",
          }
        : {})}
      className={`my-1 rounded border-y border-keep-action/40 bg-keep-action/10 px-3 py-2 text-center font-action italic text-keep-action${
        hasImage ? " cursor-pointer transition hover:bg-keep-action/15" : ""
      }`}
    >
      {/* Title at chat-text-plus-two so the scene marker reads more
          like a chapter heading than a regular line. Larger only,
          color, italic, and the theatre-mask glyph come from the
          banner wrapper. */}
      <div className="whitespace-pre-wrap text-base leading-tight sm:text-lg">
        🎭 {renderedBody}
      </div>
      {hasImage && !collapsed ? (
        <img
          src={imageUrl}
          alt=""
          // `block mx-auto` centers the image even when shorter than
          // the banner. `max-h-80` caps a tall poster at ~320px so a
          // portrait scene image doesn't dominate the timeline.
          // `object-contain` preserves aspect; rounded corners +
          // soft shadow match the banner's chat-card feel. On image
          // load failure we hide the element so the banner falls
          // back to title-only instead of showing a broken-image
          // glyph in the middle of the chat.
          className="mx-auto mt-2 block max-h-80 max-w-full rounded-lg object-contain shadow"
          loading="lazy"
          draggable={false}
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
      ) : null}
    </div>
  );
}

function InlineBookmark({ msg }: { msg: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [knownCategories, setKnownCategories] = useState<string[] | null>(null);

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
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={openPopover}
        title="Bookmark this post"
        className="keep-button rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-0.5 hover:bg-keep-action/10 hover:text-keep-action"
      >
        {done ? "✓ Saved" : "🔖 Bookmark"}
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
          className="fixed inset-x-2 bottom-2 z-30 max-h-[80vh] overflow-y-auto rounded border border-keep-rule bg-keep-bg p-2 text-xs normal-case tracking-normal shadow-lg md:absolute md:inset-x-auto md:bottom-auto md:left-0 md:top-full md:mt-1 md:max-h-none md:min-w-[16rem]"
        >
          <div className="mb-1 font-semibold text-keep-text">Bookmark</div>
          <label className="mb-1 block text-[10px] uppercase tracking-widest text-keep-muted">
            Category
            <input
              type="text"
              list={`bookmark-cats-inline-${msg.id}`}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              maxLength={60}
              placeholder="leave empty for Uncategorized"
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
                    title={`Use category "${c}"`}
                  >
                    {c}
                  </button>
                );
              })}
            </div>
          ) : null}
          <label className="mb-2 block text-[10px] uppercase tracking-widest text-keep-muted">
            Note (optional)
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              placeholder="why you're saving this"
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
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="rounded border border-keep-action/60 bg-keep-action/10 px-2 py-0.5 text-[10px] font-semibold text-keep-action hover:bg-keep-action/20 disabled:opacity-50"
            >
              {busy ? "saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}

/* =============================================================
 *  AnnounceHtmlBody, wraps the scheduled-announce `bodyHtml`
 *  render so the dynamic UI-route chip hydrator (e.g. for the
 *  {scriptorium:latest:story} chip) can post-process the painted
 *  HTML. Without this wrapper the render loop for messages has
 *  no place to host a per-message `useEffect`, since the loop
 *  body isn't itself a component.
 *
 *  The wrapper re-runs hydration whenever the HTML changes, an
 *  admin editing a scheduled announce + the server re-pushing it
 *  flips `html` and the dynamic chip resolves against the new
 *  body. The shared cache + in-flight coalescing in `latestStory`
 *  makes the per-message cost negligible.
 * ============================================================= */
function AnnounceHtmlBody({ html }: { html: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return hydrateDynamicUiRouteChips(el);
  }, [html]);
  return (
    <span
      ref={ref}
      className="prose prose-sm inline max-w-none [&_p]:m-0 [&_p]:inline [&_a]:underline [&_a]:underline-offset-2"
      onClick={handleUiRouteClickInHtml}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Inline report button. Mirrors `ReportButton` (POST /reports with an
 * optional reason prompt) but as a toolbar pill instead of the
 * hover-revealed corner flag.
 */
function InlineReport({ msg }: { msg: ChatMessage }) {
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function file() {
    if (done || busy) return;
    const reason = window.prompt(
      `Report this post from ${msg.displayName}? Optional reason (admins see it):`,
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
        window.alert(j.error ?? `Couldn't file report (HTTP ${res.status}).`);
        return;
      }
      setDone(true);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "report failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={file}
      disabled={busy || done}
      title={done ? "Reported, admins will review." : "Report this post to admins"}
      className="keep-button rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-0.5 hover:bg-keep-accent/10 hover:text-keep-accent disabled:opacity-50"
    >
      {done ? "✓ Reported" : "🚩 Report"}
    </button>
  );
}

/**
 * Render pre-split body parts with `@username` substrings turned into
 * clickable profile-open buttons. Text segments are run through the inline
 * markdown parser (lib/markdown.tsx) so `**bold**`, `*italic*`, `` `code` ``,
 * and bare http(s) URLs / image links render with structure - but always as
 * React elements, never via `dangerouslySetInnerHTML`, so message bodies
 * remain XSS-safe.
 */
function renderParts(
  parts: ReturnType<typeof splitMentions>,
  onMentionClick: (name: string) => void,
  onWorldClick: (slug: string) => void,
  selfNames: ReadonlyArray<string> = [],
  /**
   * Lowercased Set of names that resolve to a real, clickable
   * profile (master username OR any non-deleted character name).
   * Sourced from the global mentions cache (`state/mentions.ts`),
   * which batch-resolves unknown names against `/mentions/resolve`
   * and populates this set asynchronously. Mentions not in this
   * set (and not in `selfNames`) render as plain `@text` rather
   * than as a styled chip, typos and dangling `@bobs` don't
   * dress up as broken-looking links.
   *
   * When `null` or omitted, every mention is styled, kept as
   * the fallback for surfaces that don't subscribe to the cache.
   */
  knownNames?: ReadonlySet<string> | null,
  /**
   * Snapshot of resolved `@id:`/`@cid:` mentions for this message. When a
   * mention chip matches one of these (by the displayed name), clicking it
   * opens the EXACT identity by id, never an ambiguous name, and the chip is
   * always treated as a known/clickable mention.
   */
  mentions: ReadonlyArray<MentionRef> = [],
): ReactNode[] {
  // Normalize NBSP to a regular space so a mention rendered with the "fake
  // space" matches a viewer/self name (or a snapshot ref) typed with a real
  // space. Without this, multi-word names never self-highlight or resolve.
  const norm = (s: string) => s.toLowerCase().replace(/ /g, " ");
  // Lower-cased Set so the inner check is O(1). Empty when no viewer
  // identity is known yet (pre-auth), which falls through to the
  // default action-color mention chip.
  const selfSet = new Set(selfNames.map(norm));
  const mentionMap = new Map(mentions.map((m) => [norm(m.name), m]));
  const out: ReactNode[] = [];
  parts.forEach((p, i) => {
    if (p.kind === "text") {
      out.push(<Fragment key={i}>{parseInline(p.text)}</Fragment>);
    } else if (p.kind === "world-mention") {
      // World mention chip - styled distinctly from @user mentions so the
      // two are visually separable mid-sentence. Opens the world viewer.
      out.push(
        <button
          key={i}
          type="button"
          onClick={() => onWorldClick(p.slug)}
          className="rounded border border-keep-action/40 bg-keep-action/10 px-1 text-[0.95em] font-semibold text-keep-action hover:bg-keep-action/20 focus:outline-none focus:ring-1 focus:ring-keep-action"
          title={`Open the ${p.slug} world`}
        >
          @world:{p.slug}
        </button>,
      );
    } else {
      // Snapshot ref (from an `@id:`/`@cid:` token): when present it pins the
      // exact identity, so the click opens it by id (no name ambiguity) and
      // the chip is always a known, clickable mention.
      const ref = mentionMap.get(norm(p.name));
      const isSelf = selfSet.has(norm(p.name));
      // If the caller supplied a known-names set and this name isn't
      // in it (and isn't a self identity or a snapshot ref), fall back to
      // plain text, matches the rule: only valid users get the chip
      // treatment; typos and dangling @bobs stay as literal text.
      const isKnown = isSelf || !!ref || (knownNames ? knownNames.has(p.name) : true);
      if (!isKnown) {
        out.push(<Fragment key={i}>@{p.raw}</Fragment>);
        return;
      }
      const clickTarget = ref
        ? (ref.characterId ? `@cid:${ref.characterId}` : `@id:${ref.userId}`)
        : p.name;
      const className = isSelf
        ? "rounded bg-keep-system-100 px-1 font-semibold text-keep-system-500 ring-1 ring-keep-system/40 hover:bg-keep-system-200 focus:outline-none focus:ring-2"
        : "rounded px-0.5 font-semibold text-keep-action hover:underline focus:outline-none focus:ring-1 focus:ring-keep-action";
      out.push(
        <button
          key={i}
          type="button"
          onClick={() => onMentionClick(clickTarget)}
          className={className}
          title={isSelf ? `You were mentioned (${p.raw})` : `View ${p.raw}'s profile`}
        >
          @{p.raw}
        </button>,
      );
    }
  });
  return out;
}

function Line({
  msg,
  gender,
  nameStyle,
  senderCosmetics,
  isSenderAdmin,
  isRecipientAdmin,
  isOwn,
  isRecipient,
  canReport,
  canModerate,
  canAdminEdit,
  onIconClick,
  onNameClick,
  onMentionClick,
  onWorldClick,
  onTimeClick,
  onJumpToReply,
  selfNames,
}: {
  msg: ChatMessage;
  gender: Gender;
  /** Equipped name style for the sender, from the live occupant cache. Null when nothing equipped or sender has left the room. */
  nameStyle: { key: string; config: Record<string, unknown> | null } | null;
  /** Cosmetic state for the sender (avatar + border + inline-avatar toggle). Null = sender no longer in room, inline avatar suppressed for backlog. */
  senderCosmetics: {
    avatarUrl: string | null;
    avatarCrop: AvatarCrop | null;
    selectedBorderRankKey: string | null;
    selectedFreeformBorderKey: string | null;
    inlineAvatarEnabled: boolean;
  } | null;
  isSenderAdmin: boolean;
  isRecipientAdmin: boolean;
  isOwn: boolean;
  /** True iff the viewer is the addressed recipient on a whisper. Combined with `isOwn` to decide whether the viewer is a *party* to this whisper, which drives the resting-tint highlight. */
  isRecipient: boolean;
  canReport: boolean;
  /** Viewer is mod/admin/masteradmin, surfaces a cross-author Delete button on others' lines (no grace window). */
  canModerate: boolean;
  /** Viewer is admin/masteradmin, surfaces a cross-author Edit button on others' lines. Stricter than canModerate. */
  canAdminEdit: boolean;
  /** Unbound - Line binds with the relevant userId/displayName for sender vs recipient. */
  onIconClick: (userId: string, displayName: string, characterId?: string | null) => void;
  onNameClick: (userId: string, displayName: string, characterId?: string | null) => void;
  onMentionClick: (name: string) => void;
  onWorldClick: (slug: string) => void;
  onTimeClick: (msgId: string) => void;
  /** Optional: click the inline reply quote to jump to the parent
   *  message. When omitted, the quote stays visible but non-clickable. */
  onJumpToReply?: (messageId: string) => void;
  /** Viewer identity names (master + active char). Drives self-mention highlight in body. */
  selfNames: ReadonlyArray<string>;
}) {
  const canReply = REPLYABLE_KINDS.has(msg.kind);
  const timeText = fmtTime(msg.createdAt);
  // Timestamp is the click target for "reply to this message" - turning the
  // whole line into a button is too aggressive (steals selection, conflicts
  // with name/mention buttons). The timestamp is a stable, decorative spot
  // that's already visually separate from the body.
  const time = canReply ? (
    <button
      type="button"
      onClick={() => onTimeClick(msg.id)}
      title="Reply to this message"
      // `data-copy-skip` drops the timestamp from copied chat text
      // (the copy walker reads this attribute, not `user-select: none`,
      // since `textContent` doesn't honor the CSS). The `select-none`
      // class is still here for the in-document selection highlight.
      data-copy-skip
      className="mr-2 select-none rounded text-xs text-keep-muted tabular-nums hover:text-keep-action hover:underline focus:outline-none focus:ring-1 focus:ring-keep-action"
    >
      {timeText}
    </button>
  ) : (
    <span
      data-copy-skip
      className="mr-2 select-none text-xs text-keep-muted tabular-nums"
    >
      {timeText}
    </span>
  );
  // Inline avatar, round portrait between the timestamp and the
  // styled name. The author's "should this show?" + border picks
  // come from the LIVE occupant row when the sender is still in
  // the room; otherwise from the per-message snapshot the server
  // froze at send time (migration 0120). Without the snapshot
  // fallback, backlog from senders who have since logged out
  // rendered without their inline avatar even though the message
  // already carried the avatarUrl snapshot.
  const inlineEnabled = senderCosmetics?.inlineAvatarEnabled ?? !!msg.senderInlineAvatarEnabled;
  const inlineAvatarUrl = senderCosmetics?.avatarUrl ?? msg.avatarUrl ?? null;
  const inlineBorderKey = senderCosmetics?.selectedBorderRankKey ?? msg.senderSelectedBorderRankKey ?? null;
  // Free-form border has no per-message snapshot field yet (no
  // schema column for it on `messages`); we only have the LIVE
  // occupant cache to consult. For senders who've logged out, the
  // freeform border falls away on backlog while the rank border
  // still renders from the message snapshot, matches the existing
  // graceful-degradation pattern for name-style configs.
  const inlineFreeformBorderKey = senderCosmetics?.selectedFreeformBorderKey ?? null;
  // Crop has no per-message snapshot column, pull from the live
  // occupant cache when available, fall through to BorderedAvatar's
  // null-handling (defaults to centered cover) for backlog from
  // senders who've left the room.
  const inlineAvatarCrop = senderCosmetics?.avatarCrop ?? null;
  const inlineAvatar = (inlineEnabled && inlineAvatarUrl)
    ? (
      // `data-copy-skip` drops the whole avatar subtree (img + the
      // initials-fallback text the wrapper renders when the avatar
      // URL fails) from copied chat text. Without it, a copy of a
      // chat-line with the avatar selected dragged the initials run
      // into the clipboard right before the styled name. `select-none`
      // stays on the inner element for the visible-selection highlight
      // (browsers gray out non-selectable text on click-drag).
      <span data-copy-skip className="contents">
        <BorderedAvatar
          avatarUrl={inlineAvatarUrl}
          name={msg.displayName}
          borderRankKey={inlineBorderKey}
          freeformBorderKey={inlineFreeformBorderKey}
          avatarCrop={inlineAvatarCrop}
          size="xs"
          onClick={() => onIconClick(msg.userId, msg.displayName, msg.characterId ?? null)}
          title={`view ${msg.displayName}'s profile`}
          className="mr-1 select-none align-middle"
        />
      </span>
    )
    : null;
  const isReply = !!(msg.replyToId && msg.replyToDisplayName);
  // Quote preview reads at the chat body size (`text-sm`), not the
  // smaller meta size. Previously this rendered at `text-xs` which was
  // unreadable next to the actual chat lines, users were squinting at
  // the reference they were responding to. `leading-tight` keeps the
  // single-line preview compact at the larger size; `truncate` still
  // caps the run so a long parent body stays one line.
  //
  // When `onJumpToReply` is provided AND the parent's id is known,
  // wrap the preview in a button so a click jumps to the original
  // message, same flow as bookmarks. The visual stays mostly
  // unchanged (hover adds a subtle accent so the affordance is
  // discoverable) so the quote doesn't suddenly read as a chip.
  const quoteInner = isReply ? (
    <>
      <span aria-hidden="true">↪</span>
      <span className="font-semibold">{msg.replyToDisplayName}:</span>
      {/* Parse the snippet through the inline markdown renderer so
          `[link text](url)`, **bold**, *italic*, `code`, and other
          inline markers render as proper elements instead of leaking
          their raw markdown source into the quote preview. The
          `[&_a]:pointer-events-none` + neutralized link styling
          stops the inner `<a>` from intercepting the parent button's
          jump-to-reply click (and from rendering as a competing
          interactive affordance, the quote IS the affordance). */}
      <span className="truncate italic [&_a]:pointer-events-none [&_a]:text-current [&_a]:no-underline">
        {parseInline(msg.replyToBodySnippet ?? "")}
      </span>
    </>
  ) : null;
  const quote = isReply
    ? (onJumpToReply && msg.replyToId
        ? (
            <button
              type="button"
              onClick={() => onJumpToReply(msg.replyToId!)}
              title={`Jump to ${msg.replyToDisplayName}'s message`}
              className="flex w-full items-baseline gap-1 rounded text-left text-sm leading-tight text-keep-muted hover:text-keep-action hover:underline focus:outline-none focus:ring-1 focus:ring-keep-action"
            >
              {quoteInner}
            </button>
          )
        : (
            <div className="flex items-baseline gap-1 text-sm leading-tight text-keep-muted">
              {quoteInner}
            </div>
          ))
    : null;
  const tag = (
    <UserNameTag
      displayName={msg.displayName}
      gender={gender}
      color={msg.color}
      italic={isSenderAdmin}
      mood={msg.moodSnapshot ?? null}
      // Snapshot from the message row itself, rank at send time
      // never gets rewritten by a later rank-up. Matches the
      // display-name / color / mood snapshot pattern.
      rankKey={msg.rankKey ?? null}
      tier={msg.tier ?? null}
      // Chat feed uses the abridged gem icons (one per rank, tier
      // ignored) at the md em-size so they read clearly against the
      // line of text and ride the Tools-menu font cycle along with
      // everything else in the message stream.
      rankSigilSize="md"
      rankIconVariant="gem"
      // Name style, live lookup from the current room's occupant
      // cache (no snapshot on the message row). Backlog from a
      // sender who has left the room renders unstyled, which is
      // intentional: stale styling on offline-author messages is
      // weirder than a clean fallback.
      nameStyleKey={nameStyle?.key ?? null}
      nameStyleConfig={nameStyle?.config ?? null}
      // Deliberately NOT passing `ooc` here. It'd repeat on every utterance
      // and stack with mood/away into a wall of chips. The userlist (and
      // rooms tree) carries the OOC marker - that's the canonical "who's
      // here" board; chat lines stay tight.
      onIconClick={() => onIconClick(msg.userId, msg.displayName, msg.characterId ?? null)}
      onNameClick={() => onNameClick(msg.userId, msg.displayName, msg.characterId ?? null)}
      // Chat lines stay compact - viewers open profiles from the userlist.
      hideIcon
    />
  );
  // Soft-deleted messages collapse to a placeholder regardless of kind.
  // Server strips the body server-side already; this just paints the gap so
  // the timeline doesn't shift when an in-grace delete fires.
  if (msg.deletedAt) {
    // Compute the actor blurb for the admin audit. Three cases:
    //   * Self-delete (deletedByUserId === userId): "self-deleted", the
    //     author hit delete within the grace window.
    //   * Mod/admin action (different deletedByUserId): "deleted by Y".
    //   * Pre-migration delete (no deletedByUserId snapshot): omit the
    //     actor blurb entirely; just show "admin audit" so the older
    //     deletes still surface their body without claiming an actor
    //     we don't know.
    const isSelfDelete = !!msg.deletedByUserId && msg.deletedByUserId === msg.userId;
    const actorBlurb = msg.deletedByUserId
      ? (isSelfDelete
          ? "self-deleted"
          : `deleted by ${msg.deletedByDisplayName ?? "unknown"}`)
      : null;
    return (
      <div className="text-keep-muted/70">
        <span data-copy-skip className="mr-2 select-none text-xs tabular-nums">{timeText}</span>
        <span className="italic">[message removed]</span>
        {/* Admin-only audit reveal: when the server attached the
            pre-delete body on `originalBody` (it only does so for
            isAdminRole viewers), surface it underneath as a greyed,
            indented quote so a site admin can see what got hidden.
            Mods + room-owner mods don't receive the field at all and
            this block stays inert. */}
        {msg.originalBody ? (
          <blockquote className="ml-6 mt-0.5 border-l-2 border-keep-accent/30 bg-keep-panel/20 px-2 py-0.5 text-[11px] italic text-keep-muted/60">
            <span
              className="mr-1 select-none text-[9px] uppercase not-italic tracking-widest text-keep-accent/70"
              title="Original body, visible to site admins only for audit"
            >
              admin audit
              {/* Surface the author snapshotted on the row + the actor
                  who performed the delete so admins don't have to
                  cross-reference timestamps to figure out who hid what.
                  Author is always present (snapshotted at send time);
                  actor came in with migration 0084 and falls back
                  cleanly for older rows. */}
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

  // Memoize the parsed parts on body so the splitMentions regex doesn't
  // re-run on every parent render (only when the body changes).
  const bodyParts = useMemo(() => splitMentions(msg.body), [msg.body]);
  // Subscribe to the mentions cache version + known set so the render
  // re-fires after a batch resolve lands (the resolver mutates Sets
  // in place; the version bump is what triggers React to re-evaluate).
  const knownMentions = useMentionsCache((s) => {
    void s.version;
    return s.known;
  });
  // Kick off resolution for any mention names in this body that the
  // cache hasn't seen yet. Debounced + deduped inside the cache, so
  // calling this on every Line render is cheap.
  useEffect(() => {
    const names = extractMentions(msg.body);
    if (names.length > 0) requestMentionResolve(names);
  }, [msg.body]);
  const renderedBody = renderParts(bodyParts, onMentionClick, onWorldClick, selfNames, knownMentions, msg.mentions ?? []);
  // Resolve the user's stored color once and feed both kind-shaped
  // body styles below. `themeBg` lets resolveMessageColor swap in a
  // legible variant of literal hex colors when the chosen shade would
  // disappear against the current background.
  const themeBg = useActiveTheme().bg;
  const bodyColor = resolveMessageColor(msg.color, themeBg);
  // Sticker promotion: if the whole body is a single emoticon token,
  // we render it at 84px (Messenger / Discord / Telegram lone-emoji
  // size) below in the "say" kind switch. Hook-call must live at the
  // component top level (not inside the switch), Rules of Hooks.
  // Resolved here once for ALL kinds so the lookup obeys hook order
  // even when this message renders as `me`/`ooc`/`whisper` etc. and
  // doesn't end up taking the sticker path.
  const sticker = solitaryEmoticonToken(msg.body);
  const stickerSheet = useEmoticons((s) =>
    sticker ? s.sheets.find((sh) => sh.slug === sticker.slug) : undefined,
  );
  const stickerOk = !!(sticker && stickerSheet
    && sticker.cellIndex >= 0
    && sticker.cellIndex < stickerSheet.cells.length);

  // Edit/delete controls only apply to the author's own chat-shaped
  // lines and only inside the admin-configured grace window. The
  // server re-validates both rules, this is just the affordance
  // hint, and reading the window from the store means an admin tweak
  // takes effect on the next render without a reload.
  const editGraceMs = useChat((s) => s.branding.editGraceMs);
  // Live subscription to the viewer's active character so reactions
  // placed via this line attribute to the right identity. Switching
  // characters mid-session updates this without a remount.
  const viewerActiveCharacterId = useChat((s) => s.activeCharacterId);
  const ageMs = Date.now() - msg.createdAt;
  const showOwnControls = isOwn && ageMs < editGraceMs && REPLYABLE_KINDS.has(msg.kind);
  // Moderation affordances. Mods get Delete (hide a post); admins
  // additionally get Edit (rewrite the body). Both bypass the grace
  // window, that's the whole point of the moderation lever, and the
  // server (apps/server/src/routes/messages.ts) enforces the same
  // bypass when `isAdminRole(role)` / mod is true.
  //
  // Critically: these apply to the author's OWN past-grace posts too,
  // not just cross-author. Without that, a masteradmin who let their
  // own message age past the grace window would lose the edit/delete
  // buttons entirely (the in-grace `showOwnControls` would be false
  // AND the old `!isOwn` clause locked them out of ModControls). The
  // gate is just "not currently showing OwnControls", within-grace
  // own posts keep the standard OwnControls path so the UI doesn't
  // render both row variants on top of each other.
  const showModDelete = canModerate && !msg.deletedAt && REPLYABLE_KINDS.has(msg.kind) && !showOwnControls;
  const showAdminEdit = canAdminEdit && !msg.deletedAt && REPLYABLE_KINDS.has(msg.kind) && !showOwnControls;
  const showModControls = showModDelete || showAdminEdit;
  // Inline edit lives at the ROW level, not inside the controls dock.
  // The dock is `md:absolute md:right-3` on desktop so its children
  // (Bookmark, React, OwnControls, ModControls, Report) stack neatly on
  // the right, but anything `w-full` inside the dock is "100% of the
  // dock's content width," which is a narrow strip. That's exactly
  // what made the edit textarea scrunch up against the right edge.
  // Lifting the form's open/closed state here lets us render it as a
  // sibling of `lineEl` (full row width) instead. `editMode` is the
  // discriminator so author-style and admin-style edits can pick
  // different colors / labels without two parallel state pairs.
  const [editMode, setEditMode] = useState<null | "own" | "mod">(null);
  const isEditingHere = editMode !== null;
  const editedBadge = msg.editedAt ? (
    <span
      className="ml-1 text-[10px] italic text-keep-muted"
      title={`edited ${new Date(msg.editedAt).toLocaleTimeString()}`}
    >
      (edited)
    </span>
  ) : null;

  // Reactions, same kind set as replies (say / me / ooc). System +
  // command + whisper kinds skip the bar entirely: whispers are
  // private threads where reactions don't make sense, and system /
  // cmd lines are chrome, not user content. Soft-deleted messages
  // render read-only (cached reactions still visible, no new ones).
  //
  // `hideAddButton` because the chat feed lifts the "+ react"
  // trigger out of the inline bar and into the floating right-side
  // controls row (next to Edit), see `chatReactButton` below.
  // Mirrors the forum-post pattern at line 1814 where the
  // add-reaction trigger sits in the post action toolbar.
  // OpenGraph card for the body's first link (absent until the unfurl
  // lands via message:update; gone for everyone once the author ✕'s it).
  const linkPreviewEl = msg.linkPreview && !msg.deletedAt ? (
    <div className="pl-6 pr-2 sm:pl-12">
      <LinkPreviewCard preview={msg.linkPreview} canRemove={isOwn} messageId={msg.id} />
    </div>
  ) : null;
  // When an OpenGraph card is present, indent any inline image/video
  // embed in the body so it shares the card's left edge (the card sits
  // at pl-12; a raw embed otherwise breaks out to the row's left margin
  // and the two read as disconnected blocks). Scoped to the embed
  // wrapper (`.md-inline-media`) via an arbitrary descendant variant so
  // surrounding prose keeps its normal flow. No-op without a card, a
  // lone posted image stays flush-left as before.
  const mediaAlignClass = msg.linkPreview && !msg.deletedAt
    ? "[&_.md-inline-media]:ml-6 sm:[&_.md-inline-media]:ml-12"
    : "";

  const reactionBar = REPLYABLE_KINDS.has(msg.kind) ? (
    <div className="pl-6 sm:pl-12">
      <ReactionBar
        targetKind="chat_message"
        targetId={msg.id}
        {...(msg.reactions ? { initialEntries: msg.reactions } : {})}
        asCharacterId={viewerActiveCharacterId}
        {...(msg.deletedAt ? { readOnly: true } : {})}
        hideAddButton
      />
    </div>
  ) : null;
  // Standalone "+ react" trigger that sits in the floating controls
  // row next to Edit. Suppressed on soft-deleted lines. Styled to
  // match the edit/delete/bookmark buttons rather than the round
  // reaction-chip pill so the right-side toolbar reads as one
  // cohesive set. `md:invisible md:group-hover:visible
  // md:group-focus-within:visible` matches the
  // ReportButton/ModControls/BookmarkButton reveal pattern on
  // desktop, without it, the React button would sit visible under
  // every message and clutter the feed.
  const reactAvailable = REPLYABLE_KINDS.has(msg.kind) && !msg.deletedAt;
  const chatReactButton = reactAvailable ? (
    <ReactionAddButton
      targetKind="chat_message"
      targetId={msg.id}
      asCharacterId={viewerActiveCharacterId}
      title="Add reaction"
      label={<span className="inline-flex items-center gap-1"><SmilePlus className="h-3 w-3" aria-hidden />react</span>}
      className="flex h-5 items-center rounded border border-keep-rule bg-keep-bg/80 px-1.5 text-[10px] leading-none text-keep-muted hover:border-keep-action/60 hover:bg-keep-banner hover:text-keep-action md:invisible md:group-hover:visible md:group-focus-within:visible"
    />
  ) : null;

  let lineEl: ReactNode;
  switch (msg.kind) {
    case "me":
      lineEl = (
        <div className="font-action" style={{ color: bodyColor ?? "rgb(var(--keep-action))" }}>
          {time}{inlineAvatar}{tag} <span className="whitespace-pre-wrap">{renderedBody}</span>{editedBadge}
        </div>
      );
      break;
    case "cmd": {
      // Custom-command output, the template controls placement via
      // `{sender}`, so the renderer does NOT auto-prepend the display
      // name like it does for "me"/"say". The body styles itself with
      // the snapshotted CSS (when the admin set one); fall through to
      // the sender's color otherwise. Wrapped in an inline span so the
      // CSS only paints the body, not the timestamp.
      // `themeBg` is fed in so an admin-set `color: #hex` inside the CSS
      // gets nudged for legibility against the viewer's current palette
      // (same legibility pass that runs on per-user chat colors).
      const cmdStyle = customCmdCssToStyle(msg.cmdCss ?? null, themeBg);
      const bodyStyle: CSSProperties = { ...(cmdStyle ?? {}) };
      if (bodyColor) bodyStyle.color = bodyColor;
      lineEl = (
        <div>
          {time}
          <span className="whitespace-pre-wrap" style={bodyStyle}>{renderedBody}</span>
          {editedBadge}
        </div>
      );
      break;
    }
    case "roll":
      lineEl = (
        <div className="text-keep-system">
          {time}{inlineAvatar}{tag} <span className="whitespace-pre-wrap">🎲 {renderedBody}</span>{editedBadge}
        </div>
      );
      break;
    case "poll":
      lineEl = (
        <div>
          <div>{time}{tag}</div>
          {msg.poll ? (
            <div className="mt-1 max-w-md">
              <PollCard message={msg} poll={msg.poll} isAuthor={isOwn} canModerate={canModerate} compact />
            </div>
          ) : (
            <span className="whitespace-pre-wrap text-keep-muted italic">poll unavailable</span>
          )}
        </div>
      );
      break;
    case "system": {
      // A system line whose `displayName` is the literal "system" is
      // a genuine server-authored notice (joins/parts, /describe,
      // /scene-end, etc.), rendered bare. When displayName is
      // anything else, it's a user-supplied alias the server kept on
      // the row: today that's the `/incognito <alias>` rewrite, where
      // a moderator's outgoing chat lines are stored as kind=system
      // with their alias as the author. Surface the alias as a
      // `[alias]` prefix so other participants can tell the
      // attributed system speech apart from real server output.
      const systemAlias = msg.displayName && msg.displayName !== "system"
        ? msg.displayName
        : null;
      lineEl = (
        // whitespace-pre-wrap preserves the newlines that /describe authors
        // use to format multi-paragraph world descriptions; ordinary system
        // messages are single-line so this is a no-op for them. No leading
        // `* ` decoration - the italic + system color already distinguish
        // these from chat lines, and descriptions carry their own
        // `[Description]:` prefix when delivered on join.
        <div className="italic text-keep-system">
          {time}
          {systemAlias ? (
            <span className="mr-1 font-semibold not-italic">[{systemAlias}]</span>
          ) : null}
          <span className="whitespace-pre-wrap">{renderedBody}</span>
        </div>
      );
      break;
    }
    case "announce": {
      // Two render paths for announce lines:
      //   - Manual in-chat `/announce <text>` → plain text + inline
      //     markdown via `renderedBody`, same as it's always been.
      //   - Scheduled announcement (announce-tab cronjob) →
      //     `msg.bodyHtml` carries server-sanitized HTML the admin
      //     authored as Markdown or HTML, painted via
      //     `dangerouslySetInnerHTML` after a defense-in-depth pass
      //     through `sanitizeUserHtml`. Lets admin-scheduled banners
      //     keep their links / lists / bold spans instead of
      //     degrading to escaped text on the in-chat surface.
      //
      // Color: scheduled announces can carry a `msg.color` snapshot
      // (theme token or hex) the admin picked in the editor; when
      // set we override the default action-accent text. The
      // `resolveMessageColor` nudge handles theme tokens and
      // legibility-nudges literal hex against the viewer's current
      // bg, same as it does for chat lines.
      const announceColor = bodyColor;
      const announceStyle = announceColor ? { color: announceColor } : undefined;
      // Scheduled-announce body, sanitize, then run the UI route
      // chip generator so `{rules}` / `{modal:earning}` shortcuts in
      // the saved HTML render as clickable chips. Delegated click
      // handler picks them up. Manual `/announce <text>` (no
      // bodyHtml) flows through the regular markdown pipeline which
      // already handles `{token}` natively via `parseInline`.
      const announceHtml = msg.bodyHtml
        ? renderUiRouteChipsInHtml(sanitizeUserHtml(msg.bodyHtml))
        : "";
      lineEl = msg.bodyHtml ? (
        <div className="font-bold text-keep-accent" style={announceStyle}>
          {time}
          <span aria-hidden>📣 </span>
          <AnnounceHtmlBody html={announceHtml} />
        </div>
      ) : (
        <div className="font-bold text-keep-accent" style={announceStyle}>
          {time}<span className="whitespace-pre-wrap">📣 {renderedBody}</span>
        </div>
      );
      break;
    }
    case "scene":
      lineEl = (
        // Tinted banner that visually breaks the timeline. Distinct from
        // announce (red, sitewide) and system (muted, joins/parts).
        // SceneBanner handles the optional hero image + collapse toggle
        // so this case stays declarative.
        <SceneBanner renderedBody={renderedBody} imageUrl={msg.sceneImageUrl ?? null} />
      );
      break;
    case "npc":
      // Renders the NPC name (msg.displayName has been overridden by the
      // /npc handler) followed by the body. The "voiced by" tag is small,
      // muted, and clickable - it routes to the voicing user's master profile
      // so the audience can verify who's puppeting. Body shape: a leading
      // `*...*` (italic) means /npc <Name> /me <act> ; otherwise quoted say.
      lineEl = (
        <div className="text-keep-text">
          {time}
          <span className="font-semibold italic">{msg.displayName}</span>
          {msg.npcVoicedBy ? (
            <button
              type="button"
              onClick={() => onMentionClick(msg.npcVoicedBy!)}
              className="ml-1 rounded text-[10px] uppercase tracking-wide text-keep-muted hover:text-keep-action hover:underline"
              title={`voiced by ${msg.npcVoicedBy}, click to view profile`}
            >
              (voiced by {msg.npcVoicedBy})
            </button>
          ) : null}
          <span className="ml-1 whitespace-pre-wrap">{renderedBody}</span>
        </div>
      );
      break;
    case "whisper": {
      // Render "<Sender> whispers <Receiver>: <msg>" so both ends of the
      // conversation are visible. Both names are click-targets:
      //   - icon → view that user's profile
      //   - name → pre-fill composer with /whisper <name> (continue/reply)
      const toUserId = msg.toUserId;
      const toName = msg.toDisplayName;
      // Per-identity recipient pin (migration 0189). When the original
      // whisper was addressed at a CHARACTER (`@cid:` resolution),
      // this carries the character id so the continuation `/whisper`
      // built from a click here addresses the SAME character, not
      // the master account. Older rows pre-0189 have no snapshot
      // here; the click falls back to `@id:<userId>` (legacy behavior)
      // which is correct for OOC-addressed whispers anyway.
      const toCharacterId = msg.toCharacterId ?? null;
      const recipientTag =
        toUserId && toName ? (
          <UserNameTag
            displayName={toName}
            gender="undisclosed"
            color={null}
            italic={isRecipientAdmin}
            onIconClick={() => onIconClick(toUserId, toName, toCharacterId)}
            onNameClick={() => onNameClick(toUserId, toName, toCharacterId)}
            hideIcon
          />
        ) : (
          <span className="text-keep-muted">someone</span>
        );
      // Whisper line uses the theme's "action" slot - distinct from say/me
      // (white-ish text) and from system (muted), and themes cleanly: forest
      // green on Parchment, purple on Twilight, etc.
      //
      // Layout: flex with `items-baseline` + `flex-wrap` so the body text
      // sits on the same baseline as the sender + recipient name tags
      // even when the sender's rank gem makes the line height taller.
      // (The bare inline render was leaving sender/recipient `align-middle`
      // chips centered on the line height while the body text rode the
      // text baseline below them, visibly staggered on whispers because
      // there are TWO name tags plus several text spans, and on narrow
      // viewports the body wraps and lands below the prefix where the
      // misalignment is most obvious.) `break-words` on the body span
      // lets long unbreakable runs (URLs, no-space text) wrap inside the
      // row instead of pushing the line past the right edge where the
      // hover-revealed action buttons would clip them. Tiny horizontal
      // gap on the flex container keeps the `whispers` / `:` separators
      // visually spaced now that the raw " " whitespace tokens between
      // children no longer survive flex layout.
      lineEl = (
        <div className="flex flex-wrap items-baseline gap-x-1 text-keep-action">
          {time}{inlineAvatar}{tag}
          <span className="text-keep-muted">whispers</span>
          {recipientTag}
          <span className="-ml-1 text-keep-muted">:</span>
          <span className="min-w-0 whitespace-pre-wrap break-words">{renderedBody}</span>
          {editedBadge}
        </div>
      );
      break;
    }
    case "ooc":
      lineEl = (
        <div className="text-keep-muted">
          {time}{inlineAvatar}[{tag}] <span className="whitespace-pre-wrap">{renderedBody}</span>{editedBadge}
        </div>
      );
      break;
    case "say":
    default:
      lineEl = (
        <div>
          {time}{inlineAvatar}[{tag}]{" "}
          {stickerOk && sticker ? (
            <span className="inline-emoticon-sticker">
              <EmoticonSprite sheetSlug={sticker.slug} cellIndex={sticker.cellIndex} size={84} />
            </span>
          ) : (
            <span className="whitespace-pre-wrap" style={bodyColor ? { color: bodyColor } : undefined}>{renderedBody}</span>
          )}
          {editedBadge}
        </div>
      );
      break;
  }

  // Wrap the line in a `group` so author edit/delete controls and the
  // report button can be hover-revealed (they'd be too noisy in your own
  // history otherwise). Controls are absolutely positioned so they don't
  // disturb existing layout for any kind.
  const showReport = canReport && !isOwn && REPORTABLE_KINDS.has(msg.kind);
  // Bookmarking is offered on the content-bearing kinds. System / scene /
  // announce are server-authored noise (joins, kicks, "Scene begins")
  // that don't reward saving for later. Soft-deleted messages can still
  // be bookmarked in principle but the body is empty, hide there too.
  const BOOKMARKABLE_KINDS = new Set(["say", "me", "ooc", "whisper", "npc", "roll"]);
  const showBookmark = BOOKMARKABLE_KINDS.has(msg.kind) && !msg.deletedAt;

  // Hover row-highlight. `bg-keep-muted/25` uses the theme's "secondary
  // text" tone (warm gray on light palettes, soft gray on dark ones) so
  // the hover lands a tint that's palette-consistent without the harsh
  // contrast of `--keep-text` (which is essentially black on light themes
  // and read as too dark even at low alpha). `-mx-4 px-4` extends the
  // hover edge-to-edge of the chat column (matches MessageList's px-4
  // padding) so the strip looks intentional rather than floating mid-row.
  const hoverRow = "-mx-4 px-4 transition-colors hover:bg-keep-muted/25";

  // Persistent tint on whispers the viewer is a party to (sender OR
  // recipient). Pulls the action-color slot at 15% so it picks up the
  // current palette automatically. Skipped for whispers the viewer is
  // only watching (e.g. an admin reading a channel), those are
  // technically visible in the timeline but they aren't theirs to
  // visually claim, and tinting them as such would falsely imply the
  // viewer is on one end of the conversation. The whisper-flash
  // keyframe (applied transiently by the effect above) starts and
  // ends on this same value so the resting state and the flash align
  // without a "settling" jump.
  const whisperRest =
    msg.kind === "whisper" && (isOwn || isRecipient) ? "bg-keep-action/15" : "";

  // Replies wrap the quote + the line in a single container with a continuous
  // accent-tinted left border, so the two read as one coupled block instead
  // of as two stray lines next to each other in the timeline. The hover
  // tint goes on the OUTER container so hovering anywhere over the reply
  // (including its quote preview) lights the whole block.
  // Controls bundle. Behavior diverges by viewport:
  //
  //   Mobile (default): the wrapper is `hidden` by default and flips to
  //     a right-aligned flex row when the row gains focus-within. To
  //     receive focus from a touch tap we give the outer row
  //     `tabIndex=-1` (focusable via pointer but not keyboard tab order
  //    , keyboard users get the desktop hover/focus path instead). Tap
  //     once to surface the controls, tap a different row (or the
  //     composer) to dismiss.
  //
  //   Desktop (md+): the wrapper goes `absolute right-3 top-0 flex
  //     gap-1` and lays its children out right-aligned via flex
  //     order, bookmark, react, edit/delete, mod, report. Each
  //     button keeps its own `md:invisible md:group-hover:visible
  //     md:group-focus-within:visible` so the hover/focus-reveal
  //     behavior survives per-button (BookmarkButton + ReportButton
  //     + ModControls + chatReactButton all hide until interaction;
  //     OwnControls stays always-visible for the author's own
  //     edit/delete row). Adding a new control means appending it
  //     to the JSX with the standard visibility modifiers, no
  //     pixel-offset bookkeeping.
  // Mods can act directly, surfacing a Report button next to their own
  // moderation controls would be redundant (and confusing).
  const effectiveShowReport = showReport && !showOwnControls && !showModControls;
  // `reactAvailable` (defined above) counts as a control for the
  // purposes of mounting the wrapper + the tap-to-focus affordance,
  // so other people's messages still surface the React button on
  // hover/tap even when no other control would apply.
  const hasControls = showBookmark || showOwnControls || showModControls || effectiveShowReport || reactAvailable;
  // On mobile we normally keep the controls hidden until the row gains
  // focus-within (a tap) so the timeline stays uncluttered. The author's
  // own edit/delete row is the exception: hiding it behind a tap was
  // making people think the controls didn't exist. When `showOwnControls`
  // is true, the wrapper is always-flex on mobile so edit/delete are
  // visible on the row without an extra interaction. Other people's
  // messages keep the tap-to-reveal behavior, mod actions stay
  // tap-to-reveal too so a moderator's timeline isn't a wall of buttons.
  //
  // Desktop (md+): the wrapper itself goes `absolute right-3 top-0
  // flex gap-1` so its children stack right-aligned via flex order,
  // bookmark, react, edit/delete, etc. Previously the wrapper used
  // `md:contents` and EACH child set its own `md:absolute md:right-X`
  // offset, which only worked because there were a fixed number of
  // controls at hardcoded positions. The flex wrapper makes the
  // ordering data-driven and lets new controls (like the React
  // trigger) slot in without juggling pixel offsets. Children keep
  // their `md:invisible md:group-hover:visible` modifiers to retain
  // the hover/focus-reveal behavior for buttons that should stay
  // hidden until the user shows interest in the row.
  const controlsClass = showOwnControls
    ? "flex justify-end gap-1 mt-0.5 md:absolute md:right-3 md:top-0 md:mt-0 md:flex md:items-center md:gap-1"
    : "hidden group-focus-within:flex justify-end gap-1 mt-0.5 md:flex md:absolute md:right-3 md:top-0 md:mt-0 md:items-center md:gap-1";
  const controls = hasControls ? (
    <div className={controlsClass}>
      {/* Dock order, left→right, groups actions by intent so the row
          reads as deliberate clusters rather than a random scatter:
            engagement (Reply, React) → save (Bookmark) → author/mod
            (Edit, Delete) → Report.
          Reply leads as the primary reader-facing action. It mirrors the
          timestamp click (pre-fills the composer with /reply <msgid>) but
          surfaces the affordance explicitly so it's discoverable without
          knowing the timestamp trick. Same visibility/shape contract as
          the rest of the row. */}
      {reactAvailable ? (
        <button
          type="button"
          onClick={() => onTimeClick(msg.id)}
          title="Reply to this message"
          aria-label="Reply to this message"
          className="flex h-5 items-center gap-1 rounded border border-keep-rule bg-keep-bg/80 px-1.5 text-[10px] leading-none text-keep-muted hover:border-keep-action/60 hover:bg-keep-banner hover:text-keep-action md:invisible md:group-hover:visible md:group-focus-within:visible"
        >
          <Reply className="h-3 w-3" aria-hidden />reply
        </button>
      ) : null}
      {/* React sits beside Reply so the two engagement actions read as a
          pair, then Bookmark (save) follows. */}
      {chatReactButton}
      {showBookmark ? <BookmarkButton msg={msg} /> : null}
      {/* When the inline edit form is open, the buttons collapse so
          the user isn't staring at duplicate Edit/Cancel affordances
          (the form has its own Save / Cancel). The form itself
          renders below as a row-level sibling. */}
      {showOwnControls && !isEditingHere ? (
        <OwnControls msg={msg} onStartEdit={() => setEditMode("own")} />
      ) : null}
      {showModControls && !isEditingHere ? (
        <ModControls
          msg={msg}
          canEdit={showAdminEdit}
          canDelete={showModDelete}
          onStartEdit={() => setEditMode("mod")}
        />
      ) : null}
      {effectiveShowReport ? <ReportButton msg={msg} /> : null}
    </div>
  ) : null;
  // Row-level edit form. Rendered as a sibling of `lineEl` so its
  // `w-full` resolves against the message row's full width rather
  // than the narrow absolute-positioned controls dock that scrunched
  // the previous in-dock form to a sliver on the right.
  const inlineEditForm = isEditingHere ? (
    <InlineEditForm
      msg={msg}
      variant={editMode!}
      onClose={() => setEditMode(null)}
    />
  ) : null;

  // `tabIndex=-1` makes the row focusable from a tap without putting it
  // in the keyboard tab order. `outline-none` strips the default focus
  // ring, the hover background tint already signals "this row is
  // active". Skipped when there are no controls to reveal (saves users
  // a phantom focus state with no visible effect).
  //
  // iOS Safari quirk: a tap on a div with only `tabIndex=-1` doesn't
  // reliably move focus. Explicit `currentTarget.focus()` in onClick
  // makes the focus transition deterministic across browsers. The
  // call is harmless on desktop (the element either already has
  // focus or is about to receive it from the click event anyway).
  // We also bail out when the tap originated inside a focusable
  // descendant (button, link, input), letting that native control's
  // own focus win prevents the row from snatching it back and
  // closing things like an open bookmark popover.
  function activateRow(e: React.MouseEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement;
    if (t.closest("button, a, input, textarea, select, label")) return;
    e.currentTarget.focus();
  }
  const rowFocusProps = hasControls
    ? { tabIndex: -1 as const, className: "outline-none", onClick: activateRow }
    : { className: "" };

  if (isReply) {
    // The accent left border lives in the chat panel's left gutter so
    // the reply's timestamp + body still align column-for-column with
    // surrounding non-reply messages. `hoverRow` brings `-mx-4 px-4`
    // (edge-to-edge hover); we keep its left padding intact (`pl-4`)
    // so content starts at the same column as a plain message, the
    // older `pl-2` value undershot it and pulled the whole reply
    // block ~6px to the left. The quote line gets a small extra
    // indent so it visually sits with the body rather than encroaching
    // on the timestamp column above it.
    return (
      <div
        data-message-id={msg.id}
        tabIndex={rowFocusProps.tabIndex}
        onClick={rowFocusProps.onClick}
        className={`group relative my-0.5 border-l-2 border-keep-action/50 pl-4 transition-colors duration-700 ${mediaAlignClass} ${rowFocusProps.className} ${hoverRow} ${whisperRest}`}
      >
        <div className="pl-6 sm:pl-12">{quote}</div>
        {lineEl}
        {linkPreviewEl}
        {inlineEditForm}
        {controls}
        {reactionBar}
      </div>
    );
  }
  return (
    <div
      data-message-id={msg.id}
      tabIndex={rowFocusProps.tabIndex}
      onClick={rowFocusProps.onClick}
      className={`group relative transition-colors duration-700 ${mediaAlignClass} ${rowFocusProps.className} ${hoverRow} ${whisperRest}`}
    >
      {lineEl}
      {linkPreviewEl}
      {inlineEditForm}
      {controls}
      {reactionBar}
    </div>
  );
}

/**
 * Hover-revealed 🚩 button on public-room messages from other users. Opens
 * a window.prompt for an optional reason and POSTs the report. The server
 * is authoritative on eligibility (whisper/private gates, dup-report cap);
 * any 4xx surfaces verbatim via window.alert.
 */
function ReportButton({ msg }: { msg: ChatMessage }) {
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function file() {
    if (done || busy) return;
    const reason = window.prompt(
      `Report this message from ${msg.displayName}? Optional reason (admins see it):`,
      "",
    );
    // window.prompt returns null on cancel, "" on empty submit. Treat null
    // as "abandoned" and "" as "no reason" so cancelling doesn't fire.
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
        window.alert(j.error ?? `Couldn't file report (HTTP ${res.status}).`);
        return;
      }
      setDone(true);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "report failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex md:invisible md:group-hover:visible md:group-focus-within:visible">
      <button
        type="button"
        onClick={file}
        disabled={busy || done}
        title={done ? "Reported - admins will review." : "Report this message to admins"}
        className="flex h-5 items-center gap-1 rounded border border-keep-rule bg-keep-bg/80 px-1.5 text-[10px] leading-none text-keep-muted hover:border-keep-accent/60 hover:bg-keep-accent/10 hover:text-keep-accent disabled:opacity-50"
      >
        {done ? "reported" : <><Flag className="h-3 w-3" aria-hidden />report</>}
      </button>
    </span>
  );
}

/**
 * Author-only inline controls for editing/deleting a message inside the
 * grace window. Hover-revealed to keep the timeline tidy. The server is
 * authoritative on the grace cap; clicks that land just past the window
 * surface the server's error verbatim rather than failing silently.
 */
function OwnControls({ msg, onStartEdit }: { msg: ChatMessage; onStartEdit: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Same admin-configurable grace window the visibility gate above
  // checks against. Threaded down so the button tooltip reads the
  // current cap instead of a hardcoded "60s" that drifted from the
  // server once admins bumped the value.
  const graceMs = useChat((s) => s.branding.editGraceMs);

  async function doDelete() {
    if (!window.confirm("Delete this message? You can only do this within 60 seconds of sending.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/messages/${msg.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    // Always visible (no hover gate). The caller only renders <OwnControls>
    // when `showOwnControls` is true, which already means "your own message,
    // still within the admin-configured grace window, chat-style kind."
    // Hiding the edit button behind a hover trigger turned that into a
    // discoverability black hole, people kept reporting the option was
    // missing because they didn't think to mouse over their own messages
    // to find it.
    //
    // Visual contract: edit + delete share the same base shape as the
    // BookmarkButton (h-5, rounded, thin border, 10px text) so the
    // three-button row reads as one set. Edit is neutral; delete is
    // accent-tinted as the danger-coded option so a fast click can't
    // confuse the two.
    //
    // Editing state itself lives on the parent Line, clicking Edit
    // just signals up via `onStartEdit` so the row can render the
    // form full-width as a sibling of the message body. Keeping
    // state out of this component means the absolute-positioned
    // controls dock that surrounds these buttons can never again
    // squeeze the edit textarea into the narrow strip on the right.
    //
    // `md:invisible md:group-hover:visible md:group-focus-within:visible`
    // matches every other action button on the row (Bookmark,
    // chatReact, ModControls, Report), on desktop the controls
    // appear only when the message row is hovered or keyboard-
    // focused, so they don't permanently obscure long message
    // bodies that span the full chat width. Mobile keeps the
    // controls always-on for tap-discoverability (no `invisible`
    // applied at the base breakpoint).
    <span className="inline-flex gap-1 md:invisible md:group-hover:visible md:group-focus-within:visible">
      <button
        type="button"
        onClick={onStartEdit}
        title={`Edit (within ${formatGraceWindow(graceMs)} of sending)`}
        className="flex h-5 items-center gap-1 rounded border border-keep-rule bg-keep-bg/80 px-1.5 text-[10px] leading-none text-keep-muted hover:border-keep-action/60 hover:bg-keep-banner hover:text-keep-action"
      >
        <Pencil className="h-3 w-3" aria-hidden />edit
      </button>
      <button
        type="button"
        onClick={doDelete}
        title={`Delete (within ${formatGraceWindow(graceMs)} of sending)`}
        disabled={busy}
        className="flex h-5 items-center gap-1 rounded border border-keep-accent/60 bg-keep-accent/10 px-1.5 text-[10px] font-semibold leading-none text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
      >
        <Trash2 className="h-3 w-3" aria-hidden />delete
      </button>
      {error ? <span className="text-[10px] text-keep-accent">{error}</span> : null}
    </span>
  );
}

/**
 * Shared inline edit form for both author (in-grace) and admin
 * (out-of-grace) edits. Lives at the message-row level (sibling of
 * `lineEl`) so its `w-full` resolves against the full row instead of
 * the narrow absolute-positioned controls dock. `variant` picks the
 * border / button tint and the aria-label phrasing, author edits are
 * accent-neutral (matches their own controls), admin edits are
 * accent-red to remind the actor they're using a moderation lever.
 */
function InlineEditForm({
  msg,
  variant,
  onClose,
}: {
  msg: ChatMessage;
  variant: "own" | "mod";
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(msg.body);
  const [error, setError] = useState<string | null>(null);

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (trimmed === msg.body) { onClose(); return; }
    setBusy(true);
    setError(null);
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
      // Server emits message:update; the store action picks it up and
      // the line re-renders with the new body. We just close the editor.
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "edit failed");
    } finally {
      setBusy(false);
    }
  }

  const isAdmin = variant === "mod";
  const textareaClass = isAdmin
    ? "min-w-0 flex-1 resize-y rounded border border-keep-accent bg-keep-bg px-2 py-1 text-sm outline-none"
    : "min-w-0 flex-1 resize-y rounded border border-keep-action bg-keep-bg px-2 py-1 text-sm outline-none";
  const saveButtonClass = isAdmin
    ? "shrink-0 rounded border border-keep-accent bg-keep-accent/10 px-2 py-0.5 text-xs text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
    : "shrink-0 rounded border border-keep-action bg-keep-action/10 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/20 disabled:opacity-50";

  return (
    <form
      onSubmit={submitEdit}
      // Full row width, that's the entire reason this form lives at
      // the Line level instead of inside the absolute-positioned
      // controls dock. `mt-1` keeps a small breath between the
      // original message body and the editor; `flex-col` stacks the
      // textarea above its Cancel/Save row.
      className="mt-1 flex w-full flex-col gap-1"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <textarea
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        // Auto-grow with the draft: floor at 1 row so single-line
        // edits keep the original inline feel, cap at 10 so a long
        // body doesn't blow the row's vertical budget.
        rows={Math.min(10, Math.max(1, draft.split("\n").length))}
        // Enter saves (mirrors the composer's send-on-Enter convention);
        // Shift+Enter inserts a newline. Without this override the form's
        // onSubmit would never fire because <textarea> swallows Enter.
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
        className={textareaClass}
        {...(isAdmin ? { "aria-label": `Admin edit of ${msg.displayName}'s message` } : {})}
      />
      <div className="flex items-center justify-end gap-1">
        {error ? <span className="mr-auto text-[10px] text-keep-accent">{error}</span> : null}
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs text-keep-muted hover:bg-keep-banner hover:text-keep-text"
        >
          Cancel
        </button>
        <button type="submit" disabled={busy} className={saveButtonClass}>
          {busy ? "..." : "Save"}
        </button>
      </div>
    </form>
  );
}

/**
 * Mod / admin cross-author controls on a chat line. Mirrors {@link OwnControls}'s
 * shape (inline edit input + Save/Cancel; Delete button on the right) but
 * gates the buttons on the viewer's privileges rather than authorship and
 * the grace window:
 *   - `canEdit` (admin tier) renders the Edit button + inline editor.
 *   - `canDelete` (mod tier or higher) renders the Delete button.
 * Both bypass the edit window server-side via the `isAdminRole` /
 * mod gates on PATCH and DELETE /messages/:id. Confirm copy names the
 * post's author so a moderator double-checks they're acting on the
 * right line.
 */
function ModControls({
  msg,
  canEdit,
  canDelete,
  onStartEdit,
}: {
  msg: ChatMessage;
  canEdit: boolean;
  canDelete: boolean;
  onStartEdit: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doDelete() {
    const ok = window.confirm(
      `Delete this message from ${msg.displayName}? It will be hidden from users; admins can still review the original body in the audit view.`,
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/messages/${msg.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    // Visual contract mirrors OwnControls (same h-5 pill row) but every
    // button is accent-tinted so the actor sees they're using a
    // moderation lever, not a self-edit.
    //
    // Visibility: on desktop these are HOVER-ONLY (`md:invisible
    // md:group-hover:visible md:group-focus-within:visible`), admins
    // see the whole room's worth of these buttons on every row
    // otherwise, which turned the chat into a wall of pills. Same
    // pattern ReportButton / BookmarkButton use for cross-author
    // affordances. Mobile follows the parent wrapper's
    // `hidden group-focus-within:flex`, tap a row to reveal.
    //
    // Editing itself lives on the parent Line and renders the form as
    // a row-level sibling (full width), so this component stays focused
    // on the buttons and never has to fight the absolute-positioned
    // controls dock for horizontal space.
    <span className="inline-flex gap-1 md:invisible md:group-hover:visible md:group-focus-within:visible">
      {canEdit ? (
        <button
          type="button"
          onClick={() => {
            const ok = window.confirm(
              `Edit this message from ${msg.displayName} as an admin? The (edited) badge will appear to all viewers; the original body is preserved server-side for audit.`,
            );
            if (!ok) return;
            onStartEdit();
          }}
          title={`Admin: edit ${msg.displayName}'s message`}
          className="flex h-5 items-center gap-1 rounded border border-keep-accent/40 bg-keep-bg/80 px-1.5 text-[10px] leading-none text-keep-accent/80 hover:bg-keep-accent/10 hover:text-keep-accent"
        >
          <Pencil className="h-3 w-3" aria-hidden />edit
        </button>
      ) : null}
      {canDelete ? (
        <button
          type="button"
          onClick={doDelete}
          title={`Hide ${msg.displayName}'s message`}
          disabled={busy}
          className="flex h-5 items-center gap-1 rounded border border-keep-accent/60 bg-keep-accent/10 px-1.5 text-[10px] font-semibold leading-none text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
        >
          <Trash2 className="h-3 w-3" aria-hidden />delete
        </button>
      ) : null}
      {error ? <span className="text-[10px] text-keep-accent">{error}</span> : null}
    </span>
  );
}

/**
 * Human-friendly format for the edit grace window. Picks the most
 * natural unit so a 300_000ms setting reads "5m" rather than "300s".
 */
function formatGraceWindow(ms: number): string {
  if (ms <= 0) return "no edits";
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * Hover-revealed bookmark control on each message. Sits at the top-right
 * of the line, offset to the LEFT of the existing OwnControls / Report
 * buttons so they don't overlap. Both clusters use a small right-3
 * inset (12px) to clear the scroll container's scrollbar; the
 * bookmark sits another 80px to the left of that (`right-[5.75rem]`
 * ≈ 92px total) which leaves room for either control variant
 * without crowding.
 *
 * Open the popover to choose a category and optional note, then POST to
 * `/me/bookmarks`. The server upserts on the unique (user, message)
 * index, so re-bookmarking is idempotent and updates the category.
 */
function BookmarkButton({ msg }: { msg: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Lazy-load the caller's existing categories so the dropdown can
  // suggest them. Only fetched the first time the popover opens.
  const [knownCategories, setKnownCategories] = useState<string[] | null>(null);

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
        } else {
          setKnownCategories([]);
        }
      } catch {
        setKnownCategories([]);
      }
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
      // Brief "saved" pulse on the trigger so the user sees feedback;
      // cleared after 1.2s.
      window.setTimeout(() => setDone(false), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="relative inline-flex md:invisible md:group-hover:visible md:group-focus-within:visible">
      <button
        type="button"
        onClick={openPopover}
        title={done ? "Saved" : "Bookmark this message"}
        aria-label={done ? "Saved" : "Bookmark this message"}
        // Matches the h-5 / rounded / 10px shape of the edit + delete
        // buttons in OwnControls so the row reads as one consistent set.
        className="flex h-5 items-center gap-1 rounded border border-keep-rule bg-keep-bg/80 px-1.5 text-[10px] leading-none text-keep-muted hover:border-keep-action/60 hover:bg-keep-banner hover:text-keep-action"
      >
        {done ? <BookmarkCheck className="h-3 w-3 text-keep-action" aria-hidden /> : <Bookmark className="h-3 w-3" aria-hidden />}
      </button>
      {open ? (
        <div
          // Popover sits below the trigger; absolute-positioned so it
          // overlays subsequent messages instead of pushing them. Mobile-
          // friendly width via min-w. Stops propagation so clicks inside
          // don't dismiss the underlying message row hover state.
          onClick={(e) => e.stopPropagation()}
          // Same mobile-sheet treatment as InlineBookmark, see that
          // popover for the rationale. Desktop dropdown stays anchored
          // to the trigger's right edge (the flat-chat hover icon
          // lives near the right of the message row, so right-0 is
          // the natural anchor for md+).
          className="fixed inset-x-2 bottom-2 z-30 max-h-[80vh] overflow-y-auto rounded border border-keep-rule bg-keep-bg p-2 text-xs normal-case tracking-normal shadow-lg md:absolute md:inset-x-auto md:bottom-auto md:right-0 md:top-5 md:max-h-none md:min-w-[16rem] md:normal-case md:tracking-normal"
        >
          <div className="mb-1 font-semibold text-keep-text">Bookmark</div>
          <label className="mb-1 block text-[10px] uppercase tracking-widest text-keep-muted">
            Category
            <input
              type="text"
              list={`bookmark-cats-${msg.id}`}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              maxLength={60}
              placeholder="leave empty for Uncategorized"
              className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 normal-case tracking-normal text-keep-text"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />
            <datalist id={`bookmark-cats-${msg.id}`}>
              {(knownCategories ?? []).map((c) => <option key={c} value={c} />)}
            </datalist>
          </label>
          {/* Existing-categories chip row, same UX as InlineBookmark
              so users see and reuse their categories without typing. */}
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
                    title={`Use category "${c}"`}
                  >
                    {c}
                  </button>
                );
              })}
            </div>
          ) : null}
          <label className="mb-2 block text-[10px] uppercase tracking-widest text-keep-muted">
            Note (optional)
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              placeholder="why you're saving this"
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
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="rounded border border-keep-action/60 bg-keep-action/10 px-2 py-0.5 text-[10px] font-semibold text-keep-action hover:bg-keep-action/20 disabled:opacity-50"
            >
              {busy ? "saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}
