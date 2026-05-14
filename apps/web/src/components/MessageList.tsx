import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatMessage, RoomOccupant, ThreadCategory } from "@thekeep/shared";
import { UserNameTag } from "./UserNameTag.js";
import type { Gender } from "../lib/gender.js";
import { parseInline, renderForumBody } from "../lib/markdown.js";
import { splitMentions } from "../lib/mentions.js";

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

/** Author can edit or delete their own message inside this window after sending. Mirrors the server-side cap in routes/messages.ts. */
const GRACE_MS = 60_000;

const REPLYABLE_KINDS = new Set(["say", "me", "ooc"]);

// Stable empty fallback for the optional `selfNames` prop. Using a
// literal `[]` in the fallback expression would allocate a fresh array
// each render and churn the downstream `useMemo(renderForumBody, ...)`
// dependency, defeating the memo. App.tsx always passes a stable
// memoized array in practice, so this only triggers for older callers.
const NO_SELF_NAMES: ReadonlyArray<string> = [];

// Font-size cycle for the local Size button. Values are em-units so they
// compose with the user's profile-level UI font size: a user on "Large"
// (18px html base) sees `1em` = 18px chat; bumping the local step to 3
// scales to 18 × 1.3 = ~23px. A user on the default 16px base sees the
// "natural" 16px chat at step 1, etc. Storing this as px (the previous
// shape) would override the profile preference and leave accessibility
// users stuck at whatever the renderer baked in.
const FONT_EM = ["0.8em", "1em", "1.15em", "1.3em"] as const;

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function MessageList({ messages, occupants, selfUserId, selfNames, roomType, replyMode = "flat", onIconClick, onNameClick, onMentionClick, onWorldClick, onTimeClick, fontStep, highlightMessageId, onHighlightDone, roomId, threadCategories, activeTopicId, onSetActiveTopic, onPopoutTopic, canModerate = false, canPin = false, onQuotePost, forumBuckets, onLoadOlderTopics, onFlushPendingTopics, onActivateCategory, onStartTopicInCategory }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Skip the auto-scroll-to-bottom when we're driving a jump-to-message
    // flash; the flash effect owns scroll positioning in that case and
    // pinning to the end would fight it.
    if (highlightMessageId) return;
    el.scrollTop = el.scrollHeight;
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
  for (const o of occupants) {
    genderByUser.set(o.userId, o.gender);
    if (o.accountRole === "admin") adminUserIds.add(o.userId);
  }
  // Fall back to an empty list when the caller doesn't supply selfNames
  // (e.g. pre-auth or older callers) — every mention then renders in the
  // default keep-action style.
  const effectiveSelfNames: ReadonlyArray<string> = selfNames ?? NO_SELF_NAMES;

  // Shared per-line prop bundle so the flat and nested branches can both
  // hand the same callbacks down without repeating themselves.
  function lineFor(m: ChatMessage) {
    return (
      <Line
        msg={m}
        gender={genderByUser.get(m.userId) ?? "undisclosed"}
        isSenderAdmin={adminUserIds.has(m.userId)}
        isRecipientAdmin={!!m.toUserId && adminUserIds.has(m.toUserId)}
        isOwn={!!selfUserId && m.userId === selfUserId}
        // True iff the viewer is the addressed recipient on a whisper.
        // Used to tint the row so the conversation thread visually
        // groups the viewer's own incoming whispers among the noise.
        isRecipient={!!selfUserId && m.toUserId === selfUserId}
        canReport={roomType === "public"}
        onIconClick={onIconClick}
        onNameClick={onNameClick}
        onMentionClick={onMentionClick}
        onWorldClick={onWorldClick}
        onTimeClick={onTimeClick}
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
        {...(onQuotePost ? { onQuotePost } : {})}
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

  // Flat mode: existing chronological rendering.
  return (
    <div
      ref={ref}
      className="flex-1 overflow-y-auto px-4 py-2 leading-relaxed"
      style={{ fontSize: FONT_EM[fontStep] }}
    >
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
  onQuotePost,
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
  /** Pre-fill the right composer with a markdown blockquote of the post. Optional. */
  onQuotePost?: (quoteText: string) => void;
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
      // reading width that otherwise gets eaten by chrome. md+ restores
      // the gutter since desktop has plenty of horizontal room and the
      // visual breathing room reads as intentional, not cramped.
      className="min-h-0 flex-1 overflow-y-auto py-2 leading-relaxed md:px-4"
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
                // on md+ where the ForumView root re-adds its px-4 gutter.
                // On mobile the root is edge-to-edge, so the header is
                // already full-bleed at plain `w-full`.
                className="keep-section-header mb-2 flex w-full cursor-pointer items-baseline justify-between gap-3 border-y border-keep-rule px-4 py-2 text-left text-[1.1rem] font-semibold uppercase tracking-widest text-keep-text shadow-sm hover:brightness-95 md:-mx-4 md:w-[calc(100%+2rem)] lg:sticky lg:top-0 lg:z-30"
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
                      {...(onQuotePost ? { onQuotePost } : {})}
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
  /** Optional Quote-button callback. When present, ForumPostBody shows a Quote pill. */
  onQuotePost?: (quoteText: string) => void;
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
              style={topic.color ? { color: topic.color } : undefined}
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
            {...(onQuotePost ? { onQuotePost } : {})}
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
                  {...(onQuotePost ? { onQuotePost } : {})}
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
}: {
  src: string | null;
  name: string;
  onClick?: (e: React.MouseEvent) => void;
  size?: number;
}) {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  const style = { width: `${size}px`, height: `${size}px` } as const;
  const inner = src ? (
    <img
      src={src}
      alt=""
      className="h-full w-full rounded-full object-cover"
      loading="lazy"
      onError={(e) => {
        // Drop the broken image so the fallback initial shows.
        (e.currentTarget as HTMLImageElement).style.display = "none";
      }}
    />
  ) : (
    <span className="select-none text-sm font-semibold text-keep-muted">{initial}</span>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        style={style}
        className="keep-button flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-keep-rule bg-keep-banner hover:border-keep-action"
        title={`View ${name}'s profile`}
      >
        {inner}
      </button>
    );
  }
  return (
    <div
      style={style}
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-keep-rule bg-keep-banner"
    >
      {inner}
    </div>
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
  onQuotePost,
  onReply,
  onIconClick,
  onNameClick,
  onMentionClick,
  onWorldClick,
  onTimeClick,
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
  /** Pre-fill the parent's composer with a markdown blockquote of this post. */
  onQuotePost?: (quoteText: string) => void;
  /** Activate this post's parent topic in the composer for plain reply (no quote). */
  onReply?: () => void;
  onIconClick: (userId: string, displayName: string) => void;
  onNameClick: (userId: string, displayName: string) => void;
  onMentionClick: (name: string) => void;
  onWorldClick: (slug: string) => void;
  onTimeClick: (msgId: string) => void;
  showAuthorHeader: boolean;
  /** Viewer identities for self-mention highlighting inside this post's body. Optional. */
  selfNames?: ReadonlyArray<string>;
}) {
  // Forum posts use the block-level body renderer so blockquotes
  // (`> quoted text` line prefix) render as styled <blockquote>
  // elements — needed by the Quote-reply flow. Flat-chat lines still
  // use the inline parser (see the `Line` component further down).
  const renderedBody = useMemo(
    () => renderForumBody(msg.body, onMentionClick, onWorldClick, selfNames),
    [msg.body, onMentionClick, onWorldClick, selfNames],
  );

  // Inline editor state — when editing, the body region is replaced
  // with a textarea + Save/Cancel. Hoisted here (not in PostToolbar) so
  // the toolbar's Edit button can swap the post's main content.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.body);
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  if (msg.deletedAt) {
    return (
      <div className="rounded border border-dashed border-keep-rule/40 px-2 py-1 text-xs italic text-keep-muted/70">
        [message removed]
      </div>
    );
  }

  const showOwnControls = isOwn && REPLYABLE_KINDS.has(msg.kind);
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
          onClick={(e) => {
            e.stopPropagation();
            onIconClick(msg.userId, msg.displayName);
          }}
          size={26}
        />
      ) : null}
      <div className="min-w-0 flex-1">
        {showAuthorHeader ? (
          <div className="flex items-baseline gap-2 text-[11px]">
            <button
              type="button"
              onClick={() => onNameClick(msg.userId, msg.displayName)}
              className={
                "rounded font-semibold text-keep-text hover:text-keep-action " +
                (isSenderAdmin ? "italic" : "")
              }
              style={msg.color ? { color: msg.color } : undefined}
            >
              {msg.displayName}
            </button>
            <button
              type="button"
              onClick={() => onTimeClick(msg.id)}
              className="rounded text-keep-muted tabular-nums hover:text-keep-action hover:underline"
              title="Reply to this post"
            >
              {fmtTime(msg.createdAt)}
            </button>
            {msg.replyToDisplayName ? (
              <span className="truncate italic text-keep-muted">
                ↪ {msg.replyToDisplayName}
              </span>
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
            showEdit={showOwnControls}
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
          onClick={onEdit}
          className="keep-button rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-0.5 hover:bg-keep-banner hover:text-keep-text"
          title="Edit this post"
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
  isSenderAdmin,
  isRecipientAdmin,
  isOwn,
  isRecipient,
  canReport,
  onIconClick,
  onNameClick,
  onMentionClick,
  onWorldClick,
  onTimeClick,
  selfNames,
}: {
  msg: ChatMessage;
  gender: Gender;
  isSenderAdmin: boolean;
  isRecipientAdmin: boolean;
  isOwn: boolean;
  /** True iff the viewer is the addressed recipient on a whisper. Combined with `isOwn` to decide whether the viewer is a *party* to this whisper, which drives the resting-tint highlight. */
  isRecipient: boolean;
  canReport: boolean;
  /** Unbound - Line binds with the relevant userId/displayName for sender vs recipient. */
  onIconClick: (userId: string, displayName: string) => void;
  onNameClick: (userId: string, displayName: string) => void;
  onMentionClick: (name: string) => void;
  onWorldClick: (slug: string) => void;
  onTimeClick: (msgId: string) => void;
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
  const isReply = !!(msg.replyToId && msg.replyToDisplayName);
  // Quote preview reads at the chat body size (`text-sm`), not the
  // smaller meta size. Previously this rendered at `text-xs` which was
  // unreadable next to the actual chat lines — users were squinting at
  // the reference they were responding to. `leading-tight` keeps the
  // single-line preview compact at the larger size; `truncate` still
  // caps the run so a long parent body stays one line.
  const quote = isReply ? (
    <div className="flex items-baseline gap-1 text-sm leading-tight text-keep-muted">
      <span aria-hidden="true">↪</span>
      <span className="font-semibold">{msg.replyToDisplayName}:</span>
      <span className="truncate italic">{msg.replyToBodySnippet ?? ""}</span>
    </div>
  ) : null;
  const tag = (
    <UserNameTag
      displayName={msg.displayName}
      gender={gender}
      color={msg.color}
      italic={isSenderAdmin}
      mood={msg.moodSnapshot ?? null}
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
    return (
      <div className="text-keep-muted/70">
        <span className="mr-2 select-none text-xs tabular-nums">{timeText}</span>
        <span className="italic">[message removed]</span>
      </div>
    );
  }

  // Memoize the parsed parts on body so the splitMentions regex doesn't
  // re-run on every parent render (only when the body changes).
  const bodyParts = useMemo(() => splitMentions(msg.body), [msg.body]);
  const renderedBody = renderParts(bodyParts, onMentionClick, onWorldClick, selfNames);

  // Edit/delete controls only apply to the author's own chat-shaped lines
  // and only inside the grace window. The server re-validates both rules,
  // so the UI is just an affordance hint.
  const ageMs = Date.now() - msg.createdAt;
  const showOwnControls = isOwn && ageMs < GRACE_MS && REPLYABLE_KINDS.has(msg.kind);
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
        <div className="font-action" style={msg.color ? { color: msg.color } : { color: "rgb(var(--keep-action))" }}>
          {time}{tag} <span className="whitespace-pre-wrap">{renderedBody}</span>{editedBadge}
        </div>
      );
      break;
    case "roll":
      lineEl = (
        <div className="text-keep-system">
          {time}{tag} <span className="whitespace-pre-wrap">🎲 {renderedBody}</span>{editedBadge}
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
      lineEl = (
        <div className="text-keep-action">
          {time}{tag} <span className="text-keep-muted">whispers</span> {recipientTag}
          <span className="text-keep-muted">:</span> <span className="whitespace-pre-wrap">{renderedBody}</span>{editedBadge}
        </div>
      );
      break;
    }
    case "ooc":
      lineEl = (
        <div className="text-keep-muted">
          {time}[{tag}] <span className="whitespace-pre-wrap">{renderedBody}</span>{editedBadge}
        </div>
      );
      break;
    case "say":
    default:
      lineEl = (
        <div>
          {time}[{tag}] <span className="whitespace-pre-wrap" style={msg.color ? { color: msg.color } : undefined}>{renderedBody}</span>{editedBadge}
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
  const hasControls = showBookmark || showOwnControls || (showReport && !showOwnControls);
  const controls = hasControls ? (
    <div className="hidden group-focus-within:flex justify-end gap-1 mt-0.5 md:contents">
      {showBookmark ? <BookmarkButton msg={msg} /> : null}
      {showOwnControls ? <OwnControls msg={msg} /> : null}
      {showReport && !showOwnControls ? <ReportButton msg={msg} /> : null}
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
    <span className="inline-flex md:absolute md:right-0 md:top-0 md:invisible md:group-hover:visible">
      <button
        type="button"
        onClick={file}
        disabled={busy || done}
        title={done ? "Reported - admins will review." : "Report this message to admins"}
        className="keep-button rounded border border-keep-rule bg-keep-bg/80 px-1.5 py-0 text-[10px] text-keep-muted hover:bg-keep-accent/10 hover:text-keep-accent disabled:opacity-50"
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
      <form
        onSubmit={submitEdit}
        className="mt-1 flex items-center gap-1"
        onKeyDown={(e) => {
          if (e.key === "Escape") { setEditing(false); setDraft(msg.body); }
        }}
      >
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="flex-1 rounded border border-keep-action bg-keep-bg px-2 py-0.5 text-sm outline-none"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded border border-keep-action bg-keep-action/10 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/20 disabled:opacity-50"
        >
          {busy ? "..." : "Save"}
        </button>
        <button
          type="button"
          onClick={() => { setEditing(false); setDraft(msg.body); setError(null); }}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs hover:bg-keep-banner"
        >
          Cancel
        </button>
        {error ? <span className="text-[10px] text-keep-accent">{error}</span> : null}
      </form>
    );
  }

  return (
    <span className="inline-flex gap-1 md:absolute md:right-0 md:top-0 md:invisible md:group-hover:visible">
      <button
        type="button"
        onClick={() => { setDraft(msg.body); setEditing(true); }}
        title="Edit (within 60s of sending)"
        className="rounded border border-keep-rule bg-keep-bg/80 px-1.5 py-0 text-[10px] text-keep-muted hover:bg-keep-banner hover:text-keep-text"
      >
        edit
      </button>
      <button
        type="button"
        onClick={doDelete}
        title="Delete (within 60s of sending)"
        disabled={busy}
        className="keep-button rounded border border-keep-accent/50 bg-keep-bg/80 px-1.5 py-0 text-[10px] text-keep-accent hover:bg-keep-accent/10 disabled:opacity-50"
      >
        delete
      </button>
      {error ? <span className="text-[10px] text-keep-accent">{error}</span> : null}
    </span>
  );
}

/**
 * Hover-revealed bookmark control on each message. Sits at the top-right
 * of the line, offset to the LEFT of the existing OwnControls / Report
 * buttons so they don't overlap (both clusters use `absolute right-0
 * top-0`; we offset this one with `right-20` ≈ 80px, which leaves room
 * for either control variant without crowding).
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
    <span className="relative inline-flex md:absolute md:right-20 md:top-0 md:invisible md:group-hover:visible">
      <button
        type="button"
        onClick={openPopover}
        title="Bookmark this message"
        className="keep-button rounded border border-keep-rule bg-keep-bg/80 px-1.5 py-0 text-[10px] text-keep-muted hover:bg-keep-action/10 hover:text-keep-action"
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
