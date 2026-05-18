import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { customCmdCssToStyle, isAdminRole, resolveMessageColor, type ChatMessage, type RoomOccupant, type ThreadCategory } from "@thekeep/shared";
import { useActiveTheme } from "../lib/theme.js";
import { BorderedAvatar, type BorderedAvatarSize } from "./BorderedAvatar.js";
import { RankSigil } from "./RankSigil.js";
import { StyledName } from "./StyledName.js";
import { UserNameTag } from "./UserNameTag.js";
import type { Gender } from "../lib/gender.js";
import { parseInline, renderForumBody } from "../lib/markdown.js";
import { splitMentions } from "../lib/mentions.js";
import { extractMentions } from "@thekeep/shared";
import { useChat } from "../state/store.js";
import { useMentionsCache, requestMentionResolve } from "../state/mentions.js";
import { readError } from "../lib/http.js";

interface Props {
  messages: ChatMessage[];
  /** Used to look up gender for each message author. */
  occupants: RoomOccupant[];
  /** Current viewer's user id - so the renderer can decide which messages get edit/delete grace controls. Null when not yet authenticated. */
  selfUserId: string | null;
  /**
   * Names that identify the viewer to the mention parser — master
   * username plus any active character name, in any case (lower-cased
   * downstream for the lookup). Mentions matching one of these get a
   * "you got tagged" highlight using the theme's `system` slot. Optional
   * — when omitted no self-detection runs and every mention renders in
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
  onIconClick: (userId: string, displayName: string) => void;
  onNameClick: (userId: string, displayName: string) => void;
  /** Click handler for @mentions parsed out of the message body. */
  onMentionClick: (name: string) => void;
  /** Click handler for @world:slug mentions parsed out of the message body. */
  onWorldClick: (slug: string) => void;
  /** Click on the timestamp - pre-fill the composer with /reply <msgid>. Only enabled for chat kinds (say/me/ooc). */
  onTimeClick: (msgId: string) => void;
  /**
   * Click on a reply's quote preview — jumps the chat to the parent
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
   * `replyMode === "nested"` and the list is non-empty — in that case
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
   * Independent of `activeTopicId` — popping out doesn't disturb the
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
   * — mods can lock and delete but not pin, since stickies are
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
   * composer — main composer for the inline list view, modal
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
  }>;
  /** Fetch the next page for a category. Called by the per-section "Load older" button. */
  onLoadOlderTopics?: (categoryKey: string) => void;
  /** Flush queued topics (those behind the "X new topics" pill) into the visible list. */
  onFlushPendingTopics?: (categoryKey: string) => void;
  /**
   * Fired when the user clicks a category section header — signals that
   * the next "+ New topic" should pre-select this category. `null` for
   * the Uncategorized bucket. Acts in addition to (not instead of) the
   * section's collapse toggle.
   */
  onActivateCategory?: (categoryId: string | null) => void;
  /**
   * Fired when the user clicks the per-section "+ New Topic" button.
   * Distinct from `onActivateCategory` — this is the explicit "open the
   * composer in topic-create mode, target this category" path that also
   * cancels any active reply state in the parent. `null` = Uncategorized.
   */
  onStartTopicInCategory?: (categoryId: string | null) => void;
}

/** Replies past this count get hidden behind a "View More" expander in nested mode. */
const NESTED_VISIBLE_REPLIES = 5;

/** Kinds eligible for /reports - mirrors the server's privacy gate. */
const REPORTABLE_KINDS = new Set(["say", "me", "ooc", "announce", "npc"]);

// Author edit/delete grace window is admin-configurable via
// `siteSettings.editGraceMs`, surfaced through the public /site
// endpoint into the branding store. The Line component reads it via
// `useChat` at render time so a runtime tweak in the admin panel
// takes effect without a reload. This client-side gate is just the
// soft "hide controls past the window" check; the server route
// re-validates and is authoritative.

const REPLYABLE_KINDS = new Set(["say", "me", "ooc"]);

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
// The whole ladder was shifted up — step 0 is now what step 2 used to
// be, step 1 what step 3 used to be — because the old smallest steps
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

export function MessageList({ messages, occupants, selfUserId, selfNames, roomType, replyMode = "flat", onIconClick, onNameClick, onMentionClick, onWorldClick, onTimeClick, onJumpToReply, fontStep, highlightMessageId, onHighlightDone, roomId, threadCategories, activeTopicId, onSetActiveTopic, onPopoutTopic, canModerate = false, canPin = false, canAdminEdit = false, onQuotePost, forumBuckets, onLoadOlderTopics, onFlushPendingTopics, onActivateCategory, onStartTopicInCategory }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
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
  // Capture pre-commit geometry every render. Runs BEFORE the layout
  // effect that decides how to react to the new buffer.
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

  // Apply scroll adjustment for the new buffer. useLayoutEffect (not
  // useEffect) so the position fix happens BEFORE the browser paints —
  // an effect-based fix would let the user see the layout jump for one
  // frame on every prepend.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (highlightMessageId) return; // jump-to-message owns scroll
    const prev = scrollState.current;
    const newFirstId = messages[0]?.id ?? null;
    const newLastId = messages[messages.length - 1]?.id ?? null;
    if (!prev || !prev.firstId || !prev.lastId) {
      // Initial mount or empty → end-pin.
      el.scrollTop = el.scrollHeight;
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
      // already near the bottom — otherwise they're reading older
      // history and we shouldn't yank them away.
      const NEAR_BOTTOM_PX = 120;
      const wasNearBottom = prev.height - prev.top - el.clientHeight < NEAR_BOTTOM_PX;
      // Detect full-replacement: BOTH endpoints changed (room switch,
      // jump-window swap). End-pin so the user lands at the newest.
      const replaced = firstChanged && lastChanged;
      if (replaced || wasNearBottom) el.scrollTop = el.scrollHeight;
    }
    // first AND last unchanged → no buffer changes that affect layout
    // (an in-place message edit, for example). Leave scroll alone.
  }, [messages, highlightMessageId]);

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
      // Target not in the loaded buffer — caller is responsible for
      // swapping the buffer first; we just clear the flag and let them
      // retry on the next render.
      onHighlightDone?.();
      return;
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
  // twice — a buffer swap (jump-to-message, history reload, room
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
      // when it's outside the freshness window — that's backlog
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
  // Earning — equipped name style + cosmetic state keyed by the FULL
  // identity tuple (userId, characterId). Each row in `occupants`
  // represents ONE identity — a user has one occupant row for OOC/
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
  // fallbacks above — styling is decorative, not load-bearing).
  function identityKey(userId: string, characterId: string | null | undefined): string {
    return `${userId}::${characterId ?? ""}`;
  }
  const styleByIdentity = new Map<string, { key: string; config: Record<string, unknown> | null }>();
  const cosmeticsByIdentity = new Map<string, {
    avatarUrl: string | null;
    selectedBorderRankKey: string | null;
    inlineAvatarEnabled: boolean;
  }>();
  const genderByIdentity = new Map<string, Gender>();
  for (const o of occupants) {
    const k = identityKey(o.userId, o.characterId);
    genderByIdentity.set(k, o.gender);
    // Admin status IS account-wide (the user holds the role
    // regardless of which character they're voicing), so this stays
    // keyed by userId.
    if (isAdminRole(o.accountRole)) adminUserIds.add(o.userId);
    if (o.activeNameStyleKey) {
      styleByIdentity.set(k, { key: o.activeNameStyleKey, config: o.nameStyleConfig });
    }
    cosmeticsByIdentity.set(k, {
      avatarUrl: o.avatarUrl,
      selectedBorderRankKey: o.selectedBorderRankKey,
      inlineAvatarEnabled: o.inlineAvatarEnabled,
    });
    // ALSO write the master/OOC identity (`identityKey(userId, null)`)
    // for this user — even when the occupant row represents a
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
        selectedBorderRankKey: o.masterSelectedBorderRankKey,
        inlineAvatarEnabled: o.masterInlineAvatarEnabled,
      });
    }
    // Keep a fallback by userId only for the gender map so the
    // existing default-keyed lookups elsewhere still resolve to
    // something sane for chat lines that authored before the
    // occupant joined — first-write-wins via the if-guard, so a
    // character row doesn't clobber the OOC fallback.
    if (!genderByUser.has(o.userId)) genderByUser.set(o.userId, o.gender);
  }
  // Fall back to an empty list when the caller doesn't supply selfNames
  // (e.g. pre-auth or older callers) — every mention then renders in the
  // default keep-action style.
  const effectiveSelfNames: ReadonlyArray<string> = selfNames ?? NO_SELF_NAMES;

  // Shared per-line prop bundle so the flat and nested branches can both
  // hand the same callbacks down without repeating themselves.
  function lineFor(m: ChatMessage) {
    // Look the style / cosmetics up by the message's full identity
    // tuple. Messages carry both userId and characterId snapshotted
    // at send time (characterId is null when the user posted OOC).
    // A miss here means the identity isn't in the current occupant
    // list — falls through to plain rendering, same as gender.
    const idKey = identityKey(m.userId, m.characterId);
    return (
      <Line
        msg={m}
        gender={genderByIdentity.get(idKey) ?? genderByUser.get(m.userId) ?? "undisclosed"}
        nameStyle={styleByIdentity.get(idKey) ?? null}
        senderCosmetics={cosmeticsByIdentity.get(idKey) ?? null}
        isSenderAdmin={adminUserIds.has(m.userId)}
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
  //   1. Drop `kind: "system"` — belt-and-suspenders alongside the
  //      server-side suppression for forum rooms.
  //   2. Drop replies whose parent topic is in the deleted set
  //      (a topic can be soft-deleted while its reply rows are still
  //      in the chat buffer; we shouldn't render those replies under
  //      any topic since the topic itself is hidden).
  if (replyMode === "nested") {
    // Build a set of deleted-topic ids from the chat backlog too —
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
        onLoadOlderTopics={onLoadOlderTopics ?? (() => {})}
        onFlushPendingTopics={onFlushPendingTopics ?? (() => {})}
        onActivateCategory={onActivateCategory ?? (() => {})}
        onStartTopicInCategory={onStartTopicInCategory ?? (() => {})}
        canModerate={canModerate}
        canPin={canPin}
        canAdminEdit={canAdminEdit}
        {...(onQuotePost ? { onQuotePost } : {})}
        {...(onJumpToReply ? { onJumpToReply } : {})}
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
  messages,
  roomId,
  fontStep,
  lineFor,
}: {
  scrollRef: React.MutableRefObject<HTMLDivElement | null>;
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

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto px-4 py-2 leading-relaxed"
      style={{ fontSize: FONT_EM[fontStep] }}
    >
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
            <span>Scroll up for earlier messages</span>
          )}
        </div>
      ) : messages.length > 0 ? (
        <div className="mb-1 flex items-center justify-center text-[10px] uppercase tracking-widest text-keep-muted/60">
          — start of history —
        </div>
      ) : null}
      {messages.map((m) => (
        <Fragment key={m.id}>{lineFor(m)}</Fragment>
      ))}
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
 * kind top-level row in a forum room — we treat title-less legacy rows
 * as untitled topics) render as forum cards grouped by category.
 * Clicking a card's header sets it as the active topic, which expands
 * to show the body + reply chain underneath. The active topic gets a
 * visual highlight so the user always knows which thread they're
 * reading. Replies to other topics stay tucked inside their (collapsed)
 * parent — you only see one expanded topic at a time.
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
}

function ForumView({
  // `scrollRef` is intentionally NOT named `ref` — React treats `ref` as
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
  onLoadOlderTopics,
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
}: {
  scrollRef: React.MutableRefObject<HTMLDivElement | null>;
  /** Reply messages from the chat backlog. Topics come from `buckets`, not from this list. */
  replies: ChatMessage[];
  /** Paginated topic buckets keyed by category id (or `"_uncat"`). */
  buckets: Record<string, ForumBucket>;
  categories: ThreadCategory[];
  roomId: string | null;
  fontStep: 0 | 1 | 2 | 3;
  activeTopicId: string | null;
  onSetActiveTopic: (id: string | null) => void;
  /** Open the given topic in the focused-view modal. The modal carries its own reply composer; this is independent of `activeTopicId`. */
  onPopoutTopic: (id: string) => void;
  /** Fire when the user clicks "Load older topics" in a category section. */
  onLoadOlderTopics: (categoryKey: string) => void;
  /** Flush pending → visible (user clicked the "X new topics" pill). */
  onFlushPendingTopics: (categoryKey: string) => void;
  /** Fire when the user clicks a category section header — the parent should remember this as the target for the next "+ New topic". `null` = Uncategorized bucket. */
  onActivateCategory: (categoryId: string | null) => void;
  /** Fire when the user clicks the per-section "+ New Topic" button — parent cancels reply mode + opens topic-create form targeted at this category. */
  onStartTopicInCategory: (categoryId: string | null) => void;
  /** Viewer is a moderator (role mod or admin) — exposes Lock/Unlock + cross-author Delete in PostToolbar. */
  canModerate: boolean;
  /** Viewer is an admin — exposes Pin/Unpin on topics. */
  canPin: boolean;
  /** Viewer is an admin — exposes cross-author Edit in PostToolbar. */
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
  onIconClick: (userId: string, displayName: string) => void;
  onNameClick: (userId: string, displayName: string) => void;
  onMentionClick: (name: string) => void;
  onWorldClick: (slug: string) => void;
  onTimeClick: (msgId: string) => void;
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
  const sections = useMemo(() => {
    const out: Array<{ key: string; label: string | null }> = [];
    for (const c of categories) {
      out.push({ key: c.id, label: c.name });
    }
    const uncatBucket = buckets["_uncat"];
    const uncatVisible = uncatBucket && (uncatBucket.topics.length > 0 || uncatBucket.pending.length > 0 || uncatBucket.hasMore);
    if (uncatVisible || categories.length === 0) {
      out.push({ key: "_uncat", label: categories.length > 0 ? "Uncategorized" : null });
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

  return (
    <div
      ref={scrollRef as React.RefObject<HTMLDivElement>}
      // No horizontal padding on mobile so topic cards reach the viewport
      // edges — every pixel of side gutter is one or two characters of
      // reading width that otherwise gets eaten by chrome. lg+ restores
      // the gutter since desktop has plenty of horizontal room and the
      // visual breathing room reads as intentional, not cramped. The
      // breakpoint is `lg` to match the rest of the chat shell — the
      // rail stays in drawer mode until `lg` so the chat needs the
      // full viewport gutter-free at every `< lg` width.
      className="min-h-0 flex-1 overflow-y-auto py-2 leading-relaxed lg:px-4"
      style={{ fontSize: FONT_EM[fontStep] }}
    >
      {sections.map((s) => {
        const bucket = buckets[s.key];
        const items = bucket?.topics ?? [];
        const pendingCount = bucket?.pending.length ?? 0;
        const isCollapsed = s.label !== null && collapsed.has(s.key);
        const isLoading = bucket?.loading ?? false;
        const hasMore = bucket?.hasMore ?? false;
        return (
          <section key={s.key} className="mb-3">
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
                  // Only respond when the row itself has focus — let
                  // Enter/Space on a nested button fire its own handler.
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleSection(s.key);
                    onActivateCategory(s.key === "_uncat" ? null : s.key);
                  }
                }}
                // Sticky behavior is `lg+` only. Anything below a real
                // desktop (1024px) — phones, landscape phones, tablets,
                // small-window responsive testing — gets normal block
                // flow. On narrow viewports the sticky header was
                // overlapping the topics below it as the user scrolled,
                // both eating vertical space (already scarce on a 360×
                // 800ish viewport) and reading as a bug — the user
                // perceived it as the section "hovering" over threads.
                // In block flow, each section's header sits naturally
                // above its topics; the count badge + uppercase styling
                // keep enough visual hierarchy that the category
                // boundary stays obvious without needing the persistent
                // header.
                //
                // Inline backgroundColor uses the CSS var directly so
                // Tailwind's `<alpha-value>` substitution can't sneak
                // any transparency in (kept as a defense in depth even
                // though we're no longer sticky on mobile/tablet).
                style={{ backgroundColor: "rgb(var(--keep-panel))" }}
                // Full-bleed math (-mx-4 + w-[calc(100%+2rem)]) only applies
                // on lg+ where the chat scroll root re-adds its px-4 gutter
                // (see [MessageList.tsx](./MessageList.tsx)'s `lg:px-4`).
                // On mobile / mid-width the root is edge-to-edge, so the
                // header is already full-bleed at plain `w-full`. Pinning
                // the breakpoint to lg keeps the negative-margin trick in
                // lockstep with the gutter it's compensating for — earlier
                // the two diverged (md vs lg) and headers overflowed the
                // chat container at 768–1023px widths.
                className="keep-section-header mb-2 flex w-full cursor-pointer items-baseline justify-between gap-3 border-y border-keep-rule px-4 py-2 text-left text-[1.1rem] font-semibold uppercase tracking-widest text-keep-text shadow-sm hover:brightness-95 lg:-mx-4 lg:w-[calc(100%+2rem)] lg:sticky lg:top-0 lg:z-30"
                title={isCollapsed ? "Expand category" : "Collapse category"}
              >
                {/* Left span: name + chevron. min-w-0 + truncate so a
                    long section name (or a small viewport) shrinks the
                    label with ellipsis instead of forcing the action
                    button on the right off the edge. */}
                <span className="flex min-w-0 items-baseline">
                  <span aria-hidden className="mr-2 inline-block w-3 shrink-0 text-keep-muted">{isCollapsed ? "▶" : "▼"}</span>
                  {/* `min-w-0` on the truncate target itself — without
                      it, Tailwind's `.truncate` (which sets overflow:
                      hidden) can't shrink below the text's intrinsic
                      width because the default flex min-width is auto. */}
                  <span className="min-w-0 truncate">{s.label}</span>
                </span>
                <span className="flex shrink-0 items-baseline gap-3">
                  <span className="text-xs tabular-nums text-keep-muted">{items.length}{hasMore ? "+" : ""}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      // Don't propagate to the row — clicking this button
                      // should *only* open the composer for a new topic,
                      // not toggle the section's collapse state.
                      e.stopPropagation();
                      onStartTopicInCategory(s.key === "_uncat" ? null : s.key);
                    }}
                    className="keep-button rounded border border-keep-action/50 bg-keep-action/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/20"
                    title={`Start a new topic in ${s.label}`}
                  >
                    + New Topic
                  </button>
                </span>
              </div>
            ) : null}
            {isCollapsed ? null : (
              <div className="flex flex-col gap-1.5">
                {/* "X new topics" pill — visible only when at least one
                    topic from another user arrived since the last
                    flush. Click prepends them into `items`. */}
                {pendingCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => onFlushPendingTopics(s.key)}
                    className="self-start rounded-full border border-keep-action/60 bg-keep-action/10 px-3 py-0.5 text-[11px] font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/20"
                    title="Show the topics that arrived while you were reading"
                  >
                    ↓ {pendingCount} new {pendingCount === 1 ? "topic" : "topics"}
                  </button>
                ) : null}

                {/* The actual list. While the bucket is still loading
                    its first page and hasn't returned anything yet,
                    show a skeleton hint instead of "No topics yet" so
                    the user doesn't briefly see "empty" on join. */}
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
                      // toggle semantic would deactivate when already active —
                      // wrong for "I'm about to reply to this").
                      onActivateForReply={(id) => onSetActiveTopic(id)}
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

                {/* "Load older topics" — only when the server signaled
                    `hasMore: true` on the most recent page fetch. The
                    button stays disabled while a fetch is in flight to
                    prevent double-firing. */}
                {hasMore ? (
                  <button
                    type="button"
                    onClick={() => onLoadOlderTopics(s.key)}
                    disabled={isLoading}
                    className="self-center rounded border border-keep-rule/60 bg-keep-bg/60 px-3 py-1 text-[11px] uppercase tracking-widest text-keep-muted hover:bg-keep-banner hover:text-keep-text disabled:cursor-not-allowed disabled:opacity-50"
                    title="Load 20 more topics"
                  >
                    {isLoading ? "Loading…" : "Load older topics"}
                  </button>
                ) : null}
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
 * active topic — body + reply chain expand, the card gets an accent
 * border, and the composer up top switches to "reply to this topic"
 * mode. Replies render as compact forum-post cards.
 *
 * NESTED_VISIBLE_REPLIES caps very long chains at the most-recent N
 * with a "View earlier replies" toggle, same as before — for short
 * threads (the overwhelming common case) the toggle never renders.
 */
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
  /** Viewer is a moderator — passed through to PostToolbar so cross-author Delete + Lock/Unlock buttons appear. */
  canModerate: boolean;
  /** Viewer is an admin — Pin/Unpin button appears in the topic-post toolbar. */
  canPin: boolean;
  /** Viewer is an admin — Edit button appears on other users' posts. */
  canAdminEdit: boolean;
  /** Optional Quote-button callback. When present, ForumPostBody shows a Quote pill. */
  onQuotePost?: (quoteText: string) => void;
  /** Optional: click the `↪ <author>` chip on a reply to jump to its parent. */
  onJumpToReply?: (messageId: string) => void;
  /**
   * Activate the given topic id as the composer's reply target. The Reply
   * pill on each ForumPostBody calls this with the topic's id (replies
   * always attach to the parent topic — replies-to-replies aren't a
   * thing server-side). Always activates, never deactivates — distinct
   * from `onToggle`, which toggles the topic open/closed.
   */
  onActivateForReply: (topicId: string) => void;
  genderByUser: Map<string, Gender>;
  adminUserIds: Set<string>;
  selfUserId: string | null;
  /** Viewer identities for self-mention highlighting inside topic/reply bodies. */
  selfNames: ReadonlyArray<string>;
  roomType: "public" | "private" | null;
  onIconClick: (userId: string, displayName: string) => void;
  onNameClick: (userId: string, displayName: string) => void;
  onMentionClick: (name: string) => void;
  onWorldClick: (slug: string) => void;
  onTimeClick: (msgId: string) => void;
}) {
  const [expandAll, setExpandAll] = useState(false);
  const headingText = topicHeading(topic);
  const visibleReplies = expandAll
    ? replies
    : replies.slice(-NESTED_VISIBLE_REPLIES);
  const hidden = Math.max(0, replies.length - visibleReplies.length);
  const themeBg = useActiveTheme().bg;
  const topicAuthorColor = resolveMessageColor(topic.color, themeBg);

  return (
    <article
      data-message-id={topic.id}
      // The `.keep-frame` theme styles bake in a per-style border-radius
      // (medieval 2px, modern 10px, scifi 0). On md+ we let that ride —
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
          NOT a click target itself — clicking anywhere on the row
          toggles. The pop-out icon next to the chevron IS a real
          button that stops propagation so it doesn't also toggle. */}
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => {
          // Inner buttons (avatar / author / popout) already stop
          // propagation on their own clicks. This guard catches the
          // rare case where a click bubbles up from a non-stopping
          // child (e.g. text spans) — toggle only when the click
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
          size={48}
          onClick={(e) => {
            e.stopPropagation();
            onIconClick(topic.userId, topic.displayName);
          }}
        />
        <div className="min-w-0 flex-1">
          {/* min-w-0 on the inner flex too — without it, the `truncate`
              on the title span doesn't actually shrink, because
              min-width:auto on flex children defeats overflow:hidden. */}
          <div className="flex min-w-0 items-baseline gap-2">
            {topic.isSticky ? (
              <span
                aria-label="Pinned"
                title="Pinned by an admin — stays at the top of this category."
                className="shrink-0 text-keep-action"
              >
                📌
              </span>
            ) : null}
            {topic.lockedAt ? (
              <span
                aria-label="Locked"
                title="This topic is locked — no new replies."
                className="shrink-0 text-keep-muted"
              >
                🔒
              </span>
            ) : null}
            <span
              className="min-w-0 flex-1 truncate font-semibold text-keep-text"
              title={headingText}
            >
              {parseInline(headingText)}
            </span>
            <span className="shrink-0 text-[10px] uppercase tracking-widest text-keep-muted tabular-nums">
              {fmtTime(topic.createdAt)}
            </span>
          </div>
          <div className="flex items-baseline gap-2 text-[11px] text-keep-muted">
            <span>by</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onNameClick(topic.userId, topic.displayName);
              }}
              className={
                "rounded font-semibold text-keep-action hover:underline " +
                (adminUserIds.has(topic.userId) ? "italic" : "")
              }
              style={topicAuthorColor ? { color: topicAuthorColor } : undefined}
            >
              {topic.displayName}
            </button>
            <span className="tabular-nums">
              · {replies.length} {replies.length === 1 ? "reply" : "replies"}
            </span>
          </div>
        </div>
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
        <span aria-hidden className="shrink-0 text-keep-muted">
          {isActive ? "▼" : "▶"}
        </span>
      </div>
      {isActive ? (
        <div className="border-t border-keep-rule/60 px-3 py-2">
          <ForumPostBody
            msg={topic}
            isOwn={!!selfUserId && topic.userId === selfUserId}
            isSenderAdmin={adminUserIds.has(topic.userId)}
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
          />
          {replies.length > 0 ? (
            <div className="mt-2 flex flex-col gap-1.5 border-t border-keep-rule/40 pt-2">
              {hidden > 0 ? (
                <button
                  type="button"
                  onClick={() => setExpandAll(true)}
                  className="self-start rounded text-[11px] uppercase tracking-widest text-keep-muted hover:text-keep-action"
                  title={`Show ${hidden} earlier ${hidden === 1 ? "reply" : "replies"}`}
                >
                  ↑ View {hidden} earlier {hidden === 1 ? "reply" : "replies"}
                </button>
              ) : null}
              {visibleReplies.map((r) => (
                <ForumPostBody
                  key={r.id}
                  msg={r}
                  isOwn={!!selfUserId && r.userId === selfUserId}
                  isSenderAdmin={adminUserIds.has(r.userId)}
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
                />
              ))}
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
  /** Direct border override — wins over `userId` lookup. */
  borderRankKey?: string | null;
}) {
  const occupantBorderRankKey = useChat((s) => {
    if (!userId) return null;
    for (const list of Object.values(s.occupants)) {
      const row = list.find((o) => o.userId === userId);
      if (row) return row.selectedBorderRankKey;
    }
    return null;
  });
  // Fall back to live occupant avatar when the message snapshot
  // didn't carry one (older messages, system rows, etc.). Lets a
  // user who set their avatar AFTER posting still see the new
  // portrait on their existing forum posts without a backfill.
  const occupantAvatarUrl = useChat((s) => {
    if (!userId) return null;
    for (const list of Object.values(s.occupants)) {
      const row = list.find((o) => o.userId === userId);
      if (row?.avatarUrl) return row.avatarUrl;
    }
    return null;
  });
  const effectiveBorder = borderRankKey ?? occupantBorderRankKey;
  const effectiveSrc = src ?? occupantAvatarUrl;
  const mappedSize: BorderedAvatarSize =
    size <= 22 ? "sm" : size <= 28 ? "md" : size <= 48 ? "lg" : "xl";
  return (
    <BorderedAvatar
      avatarUrl={effectiveSrc}
      name={name}
      borderRankKey={effectiveBorder ?? null}
      size={mappedSize}
      {...(onClick ? { onClick } : {})}
      title={`View ${name}'s profile`}
    />
  );
}

/** Kinds that show a bookmark affordance in the forum toolbar. Same set as the floating BookmarkButton uses. */
const BOOKMARKABLE_KINDS = new Set(["say", "me", "ooc", "whisper", "npc", "roll"]);

/**
 * Body of a forum post — avatar (small), author header (optional), the
 * message body with mentions/markdown/links parsed, and an inline action
 * toolbar (Edit / Delete / Bookmark / Report) underneath. Used both for
 * the topic's first post and for each reply underneath. Topic cards pass
 * `showAuthorHeader={false}` because the card header already carries the
 * author info; replies pass true so the reader sees who wrote each one.
 *
 * Edit/delete in forum rooms is **not** gated by the 60-second grace
 * window — the server lifts the cap for nested-mode rooms, and the
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
  onIconClick: (userId: string, displayName: string) => void;
  onNameClick: (userId: string, displayName: string) => void;
  onMentionClick: (name: string) => void;
  onWorldClick: (slug: string) => void;
  onTimeClick: (msgId: string) => void;
  /** Click the small `↪ <author>` chip in the post header to jump to the parent message. Optional — chip stays non-clickable when omitted. */
  onJumpToReply?: (messageId: string) => void;
  showAuthorHeader: boolean;
  /** Viewer identities for self-mention highlighting inside this post's body. Optional. */
  selfNames?: ReadonlyArray<string>;
}) {
  // Forum posts use the block-level body renderer so blockquotes
  // (`> quoted text` line prefix) render as styled <blockquote>
  // elements — needed by the Quote-reply flow. Flat-chat lines still
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
    () => renderForumBody(msg.body, onMentionClick, onWorldClick, selfNames, knownMentions),
    [msg.body, onMentionClick, onWorldClick, selfNames, knownMentions],
  );
  // Theme bg drives the legibility nudge that keeps a user-picked color
  // readable when the current palette flips between light and dark.
  const themeBg = useActiveTheme().bg;
  const authorColor = resolveMessageColor(msg.color, themeBg);
  // Earning — equipped name style for this post's author, looked up
  // in the current room's occupant cache. The match keys on the
  // full identity tuple (userId + characterId) so a forum post
  // authored as a specific character doesn't bleed onto the OOC
  // master's row (or vice versa) when both identities are in the
  // occupant list. Backlog from authors no longer present renders
  // unstyled; matches the chat-line policy.
  const authorStyle = useChat((s) => {
    const room = s.occupants[msg.roomId] ?? [];
    const found = room.find((o) => o.userId === msg.userId && (o.characterId ?? null) === (msg.characterId ?? null));
    if (!found || !found.activeNameStyleKey) return null;
    return { key: found.activeNameStyleKey, config: found.nameStyleConfig };
  });

  // Inline editor state — when editing, the body region is replaced
  // with a textarea + Save/Cancel. Hoisted here (not in PostToolbar) so
  // the toolbar's Edit button can swap the post's main content.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.body);
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  if (msg.deletedAt) {
    // Mirror the chat-line variant's author + actor surfacing — see
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
                — {msg.displayName}
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
      className="flex gap-2 rounded transition-colors duration-700"
    >
      {showAuthorHeader ? (
        <ForumAvatar
          src={msg.avatarUrl ?? null}
          name={msg.displayName}
          userId={msg.userId}
          onClick={(e) => {
            e.stopPropagation();
            onIconClick(msg.userId, msg.displayName);
          }}
          size={32}
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
                action color — repeating the name in the header would
                read as "Kaal\nKaal raises his sword". Profile access
                stays available via the avatar tile on the left. */}
            {msg.kind === "me" ? null : (
              <button
                type="button"
                onClick={() => onNameClick(msg.userId, msg.displayName)}
                className={
                  "rounded font-semibold text-keep-text hover:text-keep-action " +
                  (isSenderAdmin ? "italic" : "")
                }
                // Author color only applies when no style is active —
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
              title="Reply to this post"
            >
              {fmtTime(msg.createdAt)}
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
          // appears exactly once, integrated into the action sentence —
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
        ) : (
          <div className="whitespace-pre-wrap text-keep-text">
            {renderedBody}
            {editedBadge}
          </div>
        )}
        {!editing ? (
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
            // permission — this is just the UI affordance.
            showDelete={showOwnControls || (canModerate && REPLYABLE_KINDS.has(msg.kind))}
            showBookmark={showBookmark}
            // Reporting your own post is meaningless; reporting as a
            // moderator is redundant since they can act directly.
            showReport={showReport && !showOwnControls && !canModerate}
            {...(onQuotePost ? { onQuotePost } : {})}
            {...(onReply ? { onReply } : {})}
            onEdit={() => { setDraft(msg.body); setEditing(true); }}
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
 *   - Edit       — author only (forum rooms lift the 60s grace cap).
 *   - Delete     — author OR moderator. Mod cross-author deletes are
 *                  the moderation lever for offensive replies.
 *   - Lock       — only on top-level topics; author OR moderator.
 *                  Locked topics show as 🔓 → unlock; the server-side
 *                  PATCH /messages/:id/lock toggles the state.
 *   - Bookmark   — anyone on bookmarkable kinds.
 *   - Report     — non-authors on reportable kinds in public rooms,
 *                  hidden for moderators (they can act directly).
 *
 * Edit triggers `onEdit` so the parent (ForumPostBody) can swap the
 * body region for an inline editor — keeping the editor scoped to the
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
   * composer with a blockquote of the post) — Reply is the bare
   * "start replying to this thread" affordance.
   */
  onReply?: () => void;
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
  // Replying to your own post via Quote is fine — sometimes users
  // quote themselves to keep a long thread organized.
  const showQuote = !!onQuotePost;
  // Reply pill ditto — only renders when the parent wires up a
  // handler, so contexts that don't make sense (e.g. inside the focused
  // thread modal where the composer is already targeted at this topic)
  // can simply not pass `onReply` and the button hides itself.
  const showReply = !!onReply;

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
    // the user a place to type their reply after the quote.
    const attribution = `**${msg.displayName}** wrote:`;
    const bodyLines = msg.body.split("\n").map((l) => `> ${l}`).join("\n");
    const quote = `> ${attribution}\n${bodyLines}\n\n`;
    onQuotePost(quote);
  }

  if (!showEdit && !showDelete && !showBookmark && !showReport && !showLock && !showPin && !showQuote && !showReply) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-keep-rule/30 pt-1 text-[10px] uppercase tracking-widest text-keep-muted">
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
      {showBookmark ? <InlineBookmark msg={msg} /> : null}
      {showReport ? <InlineReport msg={msg} /> : null}
      {actionError ? <span className="normal-case tracking-normal text-keep-accent">{actionError}</span> : null}
    </div>
  );
}

/**
 * Inline bookmark trigger + popover. Mirrors `BookmarkButton`'s behavior
 * (popover with category datalist + optional note, POST /me/bookmarks)
 * but renders as a normal toolbar button without the absolute floating
 * wrapper the flat-chat variant uses.
 */
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
      title={done ? "Reported — admins will review." : "Report this post to admins"}
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
   * than as a styled chip — typos and dangling `@bobs` don't
   * dress up as broken-looking links.
   *
   * When `null` or omitted, every mention is styled — kept as
   * the fallback for surfaces that don't subscribe to the cache.
   */
  knownNames?: ReadonlySet<string> | null,
): ReactNode[] {
  // Lower-cased Set so the inner check is O(1). Empty when no viewer
  // identity is known yet (pre-auth), which falls through to the
  // default action-color mention chip.
  const selfSet = new Set(selfNames.map((n) => n.toLowerCase()));
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
      const isSelf = selfSet.has(p.name);
      // If the caller supplied a known-names set and this name isn't
      // in it (and isn't a self identity), fall back to plain text —
      // matches the rule: only valid users get the chip treatment;
      // typos and dangling @bobs stay as literal text.
      const isKnown = isSelf || (knownNames ? knownNames.has(p.name) : true);
      if (!isKnown) {
        out.push(<Fragment key={i}>@{p.raw}</Fragment>);
        return;
      }
      const className = isSelf
        ? "rounded bg-keep-system-100 px-1 font-semibold text-keep-system-500 ring-1 ring-keep-system/40 hover:bg-keep-system-200 focus:outline-none focus:ring-2"
        : "rounded px-0.5 font-semibold text-keep-action hover:underline focus:outline-none focus:ring-1 focus:ring-keep-action";
      out.push(
        <button
          key={i}
          type="button"
          onClick={() => onMentionClick(p.name)}
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
  /** Cosmetic state for the sender (avatar + border + inline-avatar toggle). Null = sender no longer in room — inline avatar suppressed for backlog. */
  senderCosmetics: {
    avatarUrl: string | null;
    selectedBorderRankKey: string | null;
    inlineAvatarEnabled: boolean;
  } | null;
  isSenderAdmin: boolean;
  isRecipientAdmin: boolean;
  isOwn: boolean;
  /** True iff the viewer is the addressed recipient on a whisper. Combined with `isOwn` to decide whether the viewer is a *party* to this whisper, which drives the resting-tint highlight. */
  isRecipient: boolean;
  canReport: boolean;
  /** Viewer is mod/admin/masteradmin — surfaces a cross-author Delete button on others' lines (no grace window). */
  canModerate: boolean;
  /** Viewer is admin/masteradmin — surfaces a cross-author Edit button on others' lines. Stricter than canModerate. */
  canAdminEdit: boolean;
  /** Unbound - Line binds with the relevant userId/displayName for sender vs recipient. */
  onIconClick: (userId: string, displayName: string) => void;
  onNameClick: (userId: string, displayName: string) => void;
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
      className="mr-2 select-none rounded text-xs text-keep-muted tabular-nums hover:text-keep-action hover:underline focus:outline-none focus:ring-1 focus:ring-keep-action"
    >
      {timeText}
    </button>
  ) : (
    <span className="mr-2 select-none text-xs text-keep-muted tabular-nums">
      {timeText}
    </span>
  );
  // Phase 4 inline avatar — round 16px portrait that sits between
  // the timestamp and the styled name when the author has the
  // `inline_avatar` cosmetic enabled. Border ring (if any) wraps it
  // using the author's currently-selected border. Backlog from a
  // sender no longer in the room rendering without this is fine —
  // the lookup just returns null and the line collapses to the
  // standard layout.
  const inlineAvatar = (senderCosmetics?.inlineAvatarEnabled && (senderCosmetics.avatarUrl || msg.avatarUrl))
    ? (
      <BorderedAvatar
        avatarUrl={senderCosmetics.avatarUrl ?? msg.avatarUrl ?? null}
        name={msg.displayName}
        borderRankKey={senderCosmetics.selectedBorderRankKey}
        size="xs"
        onClick={() => onIconClick(msg.userId, msg.displayName)}
        title={`view ${msg.displayName}'s profile`}
        className="mr-1 align-middle"
      />
    )
    : null;
  const isReply = !!(msg.replyToId && msg.replyToDisplayName);
  // Quote preview reads at the chat body size (`text-sm`), not the
  // smaller meta size. Previously this rendered at `text-xs` which was
  // unreadable next to the actual chat lines — users were squinting at
  // the reference they were responding to. `leading-tight` keeps the
  // single-line preview compact at the larger size; `truncate` still
  // caps the run so a long parent body stays one line.
  //
  // When `onJumpToReply` is provided AND the parent's id is known,
  // wrap the preview in a button so a click jumps to the original
  // message — same flow as bookmarks. The visual stays mostly
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
          interactive affordance — the quote IS the affordance). */}
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
      // Snapshot from the message row itself — rank at send time
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
      // Name style — live lookup from the current room's occupant
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
      onIconClick={() => onIconClick(msg.userId, msg.displayName)}
      onNameClick={() => onNameClick(msg.userId, msg.displayName)}
      // Chat lines stay compact - viewers open profiles from the userlist.
      hideIcon
    />
  );
  // Soft-deleted messages collapse to a placeholder regardless of kind.
  // Server strips the body server-side already; this just paints the gap so
  // the timeline doesn't shift when an in-grace delete fires.
  if (msg.deletedAt) {
    // Compute the actor blurb for the admin audit. Three cases:
    //   * Self-delete (deletedByUserId === userId): "self-deleted" — the
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
        <span className="mr-2 select-none text-xs tabular-nums">{timeText}</span>
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
                — {msg.displayName}
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
  const renderedBody = renderParts(bodyParts, onMentionClick, onWorldClick, selfNames, knownMentions);
  // Resolve the user's stored color once and feed both kind-shaped
  // body styles below. `themeBg` lets resolveMessageColor swap in a
  // legible variant of literal hex colors when the chosen shade would
  // disappear against the current background.
  const themeBg = useActiveTheme().bg;
  const bodyColor = resolveMessageColor(msg.color, themeBg);

  // Edit/delete controls only apply to the author's own chat-shaped
  // lines and only inside the admin-configured grace window. The
  // server re-validates both rules — this is just the affordance
  // hint, and reading the window from the store means an admin tweak
  // takes effect on the next render without a reload.
  const editGraceMs = useChat((s) => s.branding.editGraceMs);
  const ageMs = Date.now() - msg.createdAt;
  const showOwnControls = isOwn && ageMs < editGraceMs && REPLYABLE_KINDS.has(msg.kind);
  // Moderation affordances. Mods get Delete (hide a post); admins
  // additionally get Edit (rewrite the body). Both bypass the grace
  // window — that's the whole point of the moderation lever, and the
  // server (apps/server/src/routes/messages.ts) enforces the same
  // bypass when `isAdminRole(role)` / mod is true.
  //
  // Critically: these apply to the author's OWN past-grace posts too,
  // not just cross-author. Without that, a masteradmin who let their
  // own message age past the grace window would lose the edit/delete
  // buttons entirely (the in-grace `showOwnControls` would be false
  // AND the old `!isOwn` clause locked them out of ModControls). The
  // gate is just "not currently showing OwnControls" — within-grace
  // own posts keep the standard OwnControls path so the UI doesn't
  // render both row variants on top of each other.
  const showModDelete = canModerate && !msg.deletedAt && REPLYABLE_KINDS.has(msg.kind) && !showOwnControls;
  const showAdminEdit = canAdminEdit && !msg.deletedAt && REPLYABLE_KINDS.has(msg.kind) && !showOwnControls;
  const showModControls = showModDelete || showAdminEdit;
  const editedBadge = msg.editedAt ? (
    <span
      className="ml-1 text-[10px] italic text-keep-muted"
      title={`edited ${new Date(msg.editedAt).toLocaleTimeString()}`}
    >
      (edited)
    </span>
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
      // Custom-command output — the template controls placement via
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
    case "system":
      lineEl = (
        // whitespace-pre-wrap preserves the newlines that /describe authors
        // use to format multi-paragraph world descriptions; ordinary system
        // messages are single-line so this is a no-op for them. No leading
        // `* ` decoration - the italic + system color already distinguish
        // these from chat lines, and descriptions carry their own
        // `[Description]:` prefix when delivered on join.
        <div className="italic text-keep-system">
          {time}<span className="whitespace-pre-wrap">{renderedBody}</span>
        </div>
      );
      break;
    case "announce":
      lineEl = (
        <div className="font-bold text-keep-accent">
          {time}<span className="whitespace-pre-wrap">📣 {renderedBody}</span>
        </div>
      );
      break;
    case "scene":
      lineEl = (
        // Tinted banner that visually breaks the timeline. Distinct from
        // announce (red, sitewide) and system (muted, joins/parts).
        <div className="my-1 rounded border-y border-keep-action/40 bg-keep-action/10 px-3 py-1 text-center font-action italic text-keep-action">
          <span className="whitespace-pre-wrap">🎭 {renderedBody}</span>
        </div>
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
              title={`voiced by ${msg.npcVoicedBy} — click to view profile`}
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
      const recipientTag =
        toUserId && toName ? (
          <UserNameTag
            displayName={toName}
            gender="undisclosed"
            color={null}
            italic={isRecipientAdmin}
            onIconClick={() => onIconClick(toUserId, toName)}
            onNameClick={() => onNameClick(toUserId, toName)}
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
      // text baseline below them — visibly staggered on whispers because
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
          {time}{inlineAvatar}[{tag}] <span className="whitespace-pre-wrap" style={bodyColor ? { color: bodyColor } : undefined}>{renderedBody}</span>{editedBadge}
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
  // be bookmarked in principle but the body is empty — hide there too.
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
  // only watching (e.g. an admin reading a channel) — those are
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
  //     — keyboard users get the desktop hover/focus path instead). Tap
  //     once to surface the controls, tap a different row (or the
  //     composer) to dismiss.
  //
  //   Desktop (md+): the wrapper collapses via `md:contents` so each
  //     button's own `md:absolute md:right-* md:top-0
  //     md:invisible md:group-hover:visible` classes restore the
  //     original hover-revealed behavior. We additionally honor
  //     `group-focus-within` on desktop so a tab-navigating user can
  //     reveal the controls without a mouse.
  // Mods can act directly — surfacing a Report button next to their own
  // moderation controls would be redundant (and confusing).
  const effectiveShowReport = showReport && !showOwnControls && !showModControls;
  const hasControls = showBookmark || showOwnControls || showModControls || effectiveShowReport;
  // On mobile we normally keep the controls hidden until the row gains
  // focus-within (a tap) so the timeline stays uncluttered. The author's
  // own edit/delete row is the exception: hiding it behind a tap was
  // making people think the controls didn't exist. When `showOwnControls`
  // is true, the wrapper is always-flex on mobile so edit/delete are
  // visible on the row without an extra interaction. Other people's
  // messages keep the tap-to-reveal behavior — mod actions stay
  // tap-to-reveal too so a moderator's timeline isn't a wall of buttons.
  const controlsClass = showOwnControls
    ? "flex justify-end gap-1 mt-0.5 md:contents"
    : "hidden group-focus-within:flex justify-end gap-1 mt-0.5 md:contents";
  const controls = hasControls ? (
    <div className={controlsClass}>
      {showBookmark ? <BookmarkButton msg={msg} /> : null}
      {showOwnControls ? <OwnControls msg={msg} /> : null}
      {showModControls ? (
        <ModControls msg={msg} canEdit={showAdminEdit} canDelete={showModDelete} />
      ) : null}
      {effectiveShowReport ? <ReportButton msg={msg} /> : null}
    </div>
  ) : null;

  // `tabIndex=-1` makes the row focusable from a tap without putting it
  // in the keyboard tab order. `outline-none` strips the default focus
  // ring — the hover background tint already signals "this row is
  // active". Skipped when there are no controls to reveal (saves users
  // a phantom focus state with no visible effect).
  //
  // iOS Safari quirk: a tap on a div with only `tabIndex=-1` doesn't
  // reliably move focus. Explicit `currentTarget.focus()` in onClick
  // makes the focus transition deterministic across browsers. The
  // call is harmless on desktop (the element either already has
  // focus or is about to receive it from the click event anyway).
  // We also bail out when the tap originated inside a focusable
  // descendant (button, link, input) — letting that native control's
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
    return (
      <div
        data-message-id={msg.id}
        tabIndex={rowFocusProps.tabIndex}
        onClick={rowFocusProps.onClick}
        className={`group relative my-0.5 border-l-2 border-keep-action/50 pl-2 transition-colors duration-700 ${rowFocusProps.className} ${hoverRow} ${whisperRest}`}
      >
        {quote}
        {lineEl}
        {controls}
      </div>
    );
  }
  return (
    <div
      data-message-id={msg.id}
      tabIndex={rowFocusProps.tabIndex}
      onClick={rowFocusProps.onClick}
      className={`group relative transition-colors duration-700 ${rowFocusProps.className} ${hoverRow} ${whisperRest}`}
    >
      {lineEl}
      {controls}
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
    <span className="inline-flex md:absolute md:right-3 md:top-0 md:invisible md:group-hover:visible">
      <button
        type="button"
        onClick={file}
        disabled={busy || done}
        title={done ? "Reported - admins will review." : "Report this message to admins"}
        className="flex h-5 items-center rounded border border-keep-rule bg-keep-bg/80 px-1.5 text-[10px] leading-none text-keep-muted hover:border-keep-accent/60 hover:bg-keep-accent/10 hover:text-keep-accent disabled:opacity-50"
      >
        {done ? "reported" : "🚩 report"}
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
function OwnControls({ msg }: { msg: ChatMessage }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.body);
  const [error, setError] = useState<string | null>(null);
  // Same admin-configurable grace window the visibility gate above
  // checks against. Threaded down so the button tooltip reads the
  // current cap instead of a hardcoded "60s" that drifted from the
  // server once admins bumped the value.
  const graceMs = useChat((s) => s.branding.editGraceMs);

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (trimmed === msg.body) { setEditing(false); return; }
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
      // Server emits message:update; the store action picks it up and the
      // line re-renders. We just close the inline editor.
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "edit failed");
    } finally {
      setBusy(false);
    }
  }

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

  if (editing) {
    return (
      // `block w-full` is load-bearing. The OwnControls wrapper above this
      // uses `md:contents` on desktop, so the form ends up as a direct
      // child of the message row. Without an explicit width the form was
      // collapsing to a narrow slot on the right of the line — looked like
      // a tiny ~200px input next to the message body. Forcing block + 100%
      // makes the editor span the full row width on every viewport.
      // `basis-full` is the flex-context fallback in case the form lands
      // inside a horizontal flex container in some future caller.
      <form
        onSubmit={submitEdit}
        className="mt-1 flex w-full basis-full flex-col gap-1"
        onKeyDown={(e) => {
          if (e.key === "Escape") { setEditing(false); setDraft(msg.body); }
        }}
      >
        <textarea
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          // Auto-grow with the draft: floor at 1 row so single-line edits
          // keep the original inline feel, cap at 10 so a long forum body
          // doesn't blow the row's vertical budget.
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
          className="min-w-0 flex-1 resize-y rounded border border-keep-action bg-keep-bg px-2 py-1 text-sm outline-none"
        />
        <div className="flex items-center justify-end gap-1">
          {error ? <span className="mr-auto text-[10px] text-keep-accent">{error}</span> : null}
          <button
            type="button"
            onClick={() => { setEditing(false); setDraft(msg.body); setError(null); }}
            className="shrink-0 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs text-keep-muted hover:bg-keep-banner hover:text-keep-text"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="shrink-0 rounded border border-keep-action bg-keep-action/10 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/20 disabled:opacity-50"
          >
            {busy ? "..." : "Save"}
          </button>
        </div>
      </form>
    );
  }

  return (
    // Always visible (no hover gate). The caller only renders <OwnControls>
    // when `showOwnControls` is true, which already means "your own message,
    // still within the admin-configured grace window, chat-style kind."
    // Hiding the edit button behind a hover trigger turned that into a
    // discoverability black hole — people kept reporting the option was
    // missing because they didn't think to mouse over their own messages
    // to find it.
    //
    // Visual contract: edit + delete share the same base shape as the
    // BookmarkButton (h-5, rounded, thin border, 10px text) so the
    // three-button row reads as one set. Edit is neutral; delete is
    // accent-tinted as the danger-coded option so a fast click can't
    // confuse the two.
    <span className="inline-flex gap-1 md:absolute md:right-3 md:top-0">
      <button
        type="button"
        onClick={() => { setDraft(msg.body); setEditing(true); }}
        title={`Edit (within ${formatGraceWindow(graceMs)} of sending)`}
        className="flex h-5 items-center rounded border border-keep-rule bg-keep-bg/80 px-1.5 text-[10px] leading-none text-keep-muted hover:border-keep-action/60 hover:bg-keep-banner hover:text-keep-action"
      >
        edit
      </button>
      <button
        type="button"
        onClick={doDelete}
        title={`Delete (within ${formatGraceWindow(graceMs)} of sending)`}
        disabled={busy}
        className="flex h-5 items-center rounded border border-keep-accent/60 bg-keep-accent/10 px-1.5 text-[10px] font-semibold leading-none text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
      >
        delete
      </button>
      {error ? <span className="text-[10px] text-keep-accent">{error}</span> : null}
    </span>
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
function ModControls({ msg, canEdit, canDelete }: { msg: ChatMessage; canEdit: boolean; canDelete: boolean }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.body);
  const [error, setError] = useState<string | null>(null);

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (trimmed === msg.body) { setEditing(false); return; }
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
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "edit failed");
    } finally {
      setBusy(false);
    }
  }

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

  if (editing) {
    return (
      <form
        onSubmit={submitEdit}
        className="mt-1 flex w-full basis-full flex-col gap-1"
        onKeyDown={(e) => {
          if (e.key === "Escape") { setEditing(false); setDraft(msg.body); }
        }}
      >
        <textarea
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.min(10, Math.max(1, draft.split("\n").length))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          className="min-w-0 flex-1 resize-y rounded border border-keep-accent bg-keep-bg px-2 py-1 text-sm outline-none"
          aria-label={`Admin edit of ${msg.displayName}'s message`}
        />
        <div className="flex items-center justify-end gap-1">
          {error ? <span className="mr-auto text-[10px] text-keep-accent">{error}</span> : null}
          <button
            type="button"
            onClick={() => { setEditing(false); setDraft(msg.body); setError(null); }}
            className="shrink-0 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs text-keep-muted hover:bg-keep-banner hover:text-keep-text"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="shrink-0 rounded border border-keep-accent bg-keep-accent/10 px-2 py-0.5 text-xs text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
          >
            {busy ? "..." : "Save"}
          </button>
        </div>
      </form>
    );
  }

  return (
    // Visual contract mirrors OwnControls (same h-5 pill row) but every
    // button is accent-tinted so the actor sees they're using a
    // moderation lever, not a self-edit.
    //
    // Visibility: on desktop these are HOVER-ONLY (`md:invisible
    // md:group-hover:visible md:group-focus-within:visible`) — admins
    // see the whole room's worth of these buttons on every row
    // otherwise, which turned the chat into a wall of pills. Same
    // pattern ReportButton / BookmarkButton use for cross-author
    // affordances. Mobile follows the parent wrapper's
    // `hidden group-focus-within:flex` — tap a row to reveal.
    <span className="inline-flex gap-1 md:absolute md:right-3 md:top-0 md:invisible md:group-hover:visible md:group-focus-within:visible">
      {canEdit ? (
        <button
          type="button"
          onClick={() => {
            const ok = window.confirm(
              `Edit this message from ${msg.displayName} as an admin? The (edited) badge will appear to all viewers; the original body is preserved server-side for audit.`,
            );
            if (!ok) return;
            setDraft(msg.body);
            setEditing(true);
          }}
          title={`Admin: edit ${msg.displayName}'s message`}
          className="flex h-5 items-center rounded border border-keep-accent/40 bg-keep-bg/80 px-1.5 text-[10px] leading-none text-keep-accent/80 hover:bg-keep-accent/10 hover:text-keep-accent"
        >
          edit
        </button>
      ) : null}
      {canDelete ? (
        <button
          type="button"
          onClick={doDelete}
          title={`Hide ${msg.displayName}'s message`}
          disabled={busy}
          className="flex h-5 items-center rounded border border-keep-accent/60 bg-keep-accent/10 px-1.5 text-[10px] font-semibold leading-none text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
        >
          delete
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
    <span className="relative inline-flex md:absolute md:right-[5.75rem] md:top-0 md:invisible md:group-hover:visible">
      <button
        type="button"
        onClick={openPopover}
        title="Bookmark this message"
        // Matches the h-5 / rounded / 10px shape of the edit + delete
        // buttons in OwnControls so the row reads as one consistent set.
        className="flex h-5 items-center rounded border border-keep-rule bg-keep-bg/80 px-1.5 text-[10px] leading-none text-keep-muted hover:border-keep-action/60 hover:bg-keep-banner hover:text-keep-action"
      >
        {done ? "✓ saved" : "🔖"}
      </button>
      {open ? (
        <div
          // Popover sits below the trigger; absolute-positioned so it
          // overlays subsequent messages instead of pushing them. Mobile-
          // friendly width via min-w. Stops propagation so clicks inside
          // don't dismiss the underlying message row hover state.
          onClick={(e) => e.stopPropagation()}
          // Same mobile-sheet treatment as InlineBookmark — see that
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
          {/* Existing-categories chip row — same UX as InlineBookmark
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
