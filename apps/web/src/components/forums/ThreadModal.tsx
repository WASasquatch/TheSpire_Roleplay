import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isAdminRole, resolveMessageColor, type ChatMessage, type RoomOccupant } from "@thekeep/shared";
import type { Gender } from "../../lib/gender.js";
import { Composer } from "../chat/Composer.js";
import { ForumAvatar, ForumPostBody, topicHeading } from "../chat/MessageList.js";
import { parseInline } from "../../lib/markdown.js";
import { useActiveTheme } from "../../lib/theme.js";
import { MODAL_CARD_CONTENT } from "../cosmetics/Modal.js";
import { CloseButton } from "../shared/CloseButton.js";

interface Props {
  /** The topic message being focused. */
  topic: ChatMessage;
  /** Replies in chronological order. Parent recomputes on every render from messagesByRoom so new replies appear live. */
  replies: ChatMessage[];
  /** Current viewer for own-controls (edit/delete shown only on their posts). */
  selfUserId: string | null;
  /** Viewer identities (master + active char) for self-mention highlighting inside post bodies. */
  selfNames: ReadonlyArray<string>;
  /** Reporting gate, report button only renders in public rooms. */
  roomType: "public" | "private" | null;
  /** Viewer is a moderator. Passed through to ForumPostBody so cross-author Delete + Lock buttons appear in the modal's toolbars. */
  canModerate: boolean;
  /** Viewer is an admin. Adds Pin/Unpin to the topic post toolbar. */
  canPin: boolean;
  /** Viewer is an admin. Adds the cross-author Edit button to every post's toolbar. */
  canAdminEdit: boolean;
  /** Room occupants, only used to derive gender + admin flags for the rendered posts so styling matches the inline forum view. */
  occupants: RoomOccupant[];
  /** Standard click handlers shared with the main forum view; passed through to ForumPostBody.
   *  `characterId` lets the handler emit a `@cid:` identity token so a same-named character on
   *  another account can't intercept the resulting whisper / profile open. */
  onIconClick: (userId: string, displayName: string, characterId?: string | null) => void;
  onNameClick: (userId: string, displayName: string, characterId?: string | null) => void;
  onMentionClick: (name: string) => void;
  onWorldClick: (slug: string) => void;
  onTimeClick: (msgId: string) => void;
  /** Optional: click the `↪ <author>` chip in a post's header to jump to its parent message. */
  onJumpToReply?: (messageId: string) => void;
  /** Send a reply targeted at this topic. App.tsx routes this through the chat:input socket emit. */
  onReply: (text: string) => void;
  /** Dismiss the modal. */
  onClose: () => void;
  /**
   * Jump-to-message highlight. When set to a message id present in
   * `topic` or `replies`, the modal scrolls that row into view and
   * applies a brief accent flash. Mirrors the same flow used in
   * MessageList for flat-room search/bookmark jumps. Cleared via
   * `onHighlightDone` once the flash has played out.
   */
  highlightMessageId?: string | null;
  onHighlightDone?: () => void;
}

/**
 * Focused-view modal for a single forum topic. Renders the topic post
 * + every reply (no NESTED_VISIBLE_REPLIES cap, the whole point of
 * popping out is to read the thread in one place) + a sticky reply
 * composer. The modal does NOT own its own copy of the messages:
 * `topic` and `replies` are passed in fresh on every parent render,
 * so as `message:new` events land the modal updates in lock-step with
 * the underlying forum view.
 *
 * Composer: deliberately simpler than the main `<Composer>` (no
 * slash-command autocomplete, no @mention popup, no history). The
 * full composer carries a lot of state that doesn't compose well
 * when mounted twice. Enter submits; Shift+Enter inserts a newline.
 *
 * Auto-scroll: when a new reply lands while the modal is open, we
 * scroll the bottom of the reply list into view so the user follows
 * the conversation without manual scrolling. We do NOT auto-scroll
 * on first open (let the user read from the top of the thread).
 */
export function ThreadModal({
  topic,
  replies,
  selfUserId,
  selfNames,
  roomType,
  canModerate,
  canPin,
  canAdminEdit,
  occupants,
  onIconClick,
  onNameClick,
  onMentionClick,
  onWorldClick,
  onTimeClick,
  onJumpToReply,
  onReply,
  onClose,
  highlightMessageId,
  onHighlightDone,
}: Props) {
  const { t } = useTranslation("forums");
  // Reply composer's text state lives here so it's scoped to the
  // modal instance, closing and reopening on a different topic
  // starts with a clean draft. The Composer is controlled; this
  // value is whatever the user has typed for *this* topic.
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Track the most recent reply count we've rendered; auto-scroll
  // only when it grows (i.e. a new reply landed), not on the initial
  // mount or on edits.
  const lastReplyCount = useRef<number>(replies.length);
  useEffect(() => {
    if (replies.length > lastReplyCount.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
    lastReplyCount.current = replies.length;
  }, [replies.length]);

  // Jump-to-message flash. Mirrors MessageList's behavior: when
  // `highlightMessageId` flips to a value present in this modal's
  // tree, find the row's DOM node via `data-message-id`, scroll it
  // to center of the scrollable body, and paint a transient accent
  // tint. Cleared via `onHighlightDone` after the flash. Suppresses
  // the bottom-anchored auto-scroll on new replies, the highlight
  // owns the scroll position while it's playing.
  useEffect(() => {
    if (!highlightMessageId) return;
    const container = scrollRef.current;
    if (!container) return;
    const node = container.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(highlightMessageId)}"]`,
    );
    if (!node) {
      // Target not rendered (deleted reply filtered out, or a
      // mismatch between expected and loaded content). Clear the
      // flag so re-opening the modal can try again.
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
  }, [highlightMessageId, onHighlightDone, replies, topic.id]);

  // Esc closes the modal. Use keydown on the backdrop so any focus
  // inside the modal still gets the event.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Derive gender + admin maps the same way MessageList does, so
  // ForumPostBody styling (admin italics, gender-tinted name) matches.
  const genderByUser = new Map<string, Gender>();
  const adminUserIds = new Set<string>();
  for (const o of occupants) {
    genderByUser.set(o.userId, o.gender);
    if (isAdminRole(o.accountRole)) adminUserIds.add(o.userId);
  }

  const heading = topicHeading(topic);
  const themeBg = useActiveTheme().bg;
  const topicAuthorColor = resolveMessageColor(topic.color, themeBg);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-stretch bg-black/60 lg:items-center lg:justify-center lg:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("thread.topicAria", { heading })}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`${MODAL_CARD_CONTENT} keep-frame bg-keep-bg lg:rounded-md`}
      >
        {/* Header strip: avatar + title + close. Title is the same
            heading helper the inline forum card uses, so the modal
            and list agree on what the topic is called. */}
        <header className="flex shrink-0 items-center gap-3 border-b border-keep-rule bg-keep-banner/40 px-4 py-3">
          <ForumAvatar
            src={topic.avatarUrl ?? null}
            name={topic.displayName}
            userId={topic.userId}
            size={48}
            onClick={(e) => {
              e.stopPropagation();
              onIconClick(topic.userId, topic.displayName, topic.characterId ?? null);
            }}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              {topic.lockedAt ? (
                <span
                  aria-label={t("thread.lockedAria")}
                  title={t("thread.lockedTitle")}
                  className="shrink-0 text-keep-muted"
                >
                  🔒
                </span>
              ) : null}
              <div className="truncate text-base font-semibold text-keep-text" title={heading}>
                {parseInline(heading)}
              </div>
            </div>
            <div className="flex items-baseline gap-2 text-[11px] text-keep-muted">
              <span>{t("thread.by")}</span>
              <button
                type="button"
                onClick={() => onNameClick(topic.userId, topic.displayName, topic.characterId ?? null)}
                className={
                  "rounded font-semibold text-keep-action hover:underline " +
                  // Staff italic only when OOC. Character voices stay
                  // un-italicized even when authored by a staff account
                  //, preserves the OOC ↔ character partition.
                  (topic.characterId === null && adminUserIds.has(topic.userId) ? "italic" : "")
                }
                style={topicAuthorColor ? { color: topicAuthorColor } : undefined}
              >
                {topic.displayName}
              </button>
              <span className="tabular-nums">
                · {t("thread.replyCount", { count: replies.length })}
              </span>
            </div>
          </div>
          {/* h-10 w-10 on mobile gives a comfortable 40px touch target
              (close to the 44px WCAG recommendation); md+ falls back
              to CloseButton's default h-7 since pointer precision is
              higher and we want visual parity with the other modals. */}
          <CloseButton
            onClick={onClose}
            label={t("thread.closeLabel")}
            className="h-10 w-10 md:h-7 md:w-7"
          />
        </header>

        {/* Scrollable thread body. Topic post first, then the reply
            chain, all expanded (no NESTED_VISIBLE_REPLIES cap, the
            modal is the focused reading view). */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="mb-3 rounded border border-keep-rule/40 bg-keep-banner/20 p-3">
            <ForumPostBody
              msg={topic}
              isOwn={!!selfUserId && topic.userId === selfUserId}
              isSenderAdmin={topic.characterId === null && adminUserIds.has(topic.userId)}
              canReport={roomType === "public"}
              canModerate={canModerate}
              canPin={canPin}
              canAdminEdit={canAdminEdit}
              onQuotePost={(q) => setDraft((cur) => (cur ? `${cur}\n\n${q}` : q))}
              {...(onJumpToReply ? { onJumpToReply } : {})}
              onIconClick={onIconClick}
              onNameClick={onNameClick}
              onMentionClick={onMentionClick}
              onWorldClick={onWorldClick}
              onTimeClick={onTimeClick}
              showAuthorHeader={false}
              selfNames={selfNames}
            />
          </div>
          {replies.length === 0 ? (
            <div className="px-1 py-2 text-xs italic text-keep-muted">
              {t("thread.noReplies")}
            </div>
          ) : (
            <div className="flex flex-col gap-2 border-t border-keep-rule/30 pt-2">
              {replies.map((r) => (
                <div key={r.id} className="rounded border border-keep-rule/30 bg-keep-banner/10 p-2">
                  <ForumPostBody
                    msg={r}
                    isOwn={!!selfUserId && r.userId === selfUserId}
                    isSenderAdmin={r.characterId === null && adminUserIds.has(r.userId)}
                    canReport={roomType === "public"}
                    canModerate={canModerate}
                    canPin={canPin}
                    canAdminEdit={canAdminEdit}
                    onQuotePost={(q) => setDraft((cur) => (cur ? `${cur}\n\n${q}` : q))}
                    {...(onJumpToReply ? { onJumpToReply } : {})}
                    onIconClick={onIconClick}
                    onNameClick={onNameClick}
                    onMentionClick={onMentionClick}
                    onWorldClick={onWorldClick}
                    onTimeClick={onTimeClick}
                    showAuthorHeader
                    selfNames={selfNames}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Reply composer. Three shapes:
              - locked + not-mod: notice in place of the composer.
              - locked + mod:     a moderator-override hint strip,
                                  then the composer (mods bypass the
                                  server-side reply lock).
              - unlocked:         the composer.
            The server is authoritative on the lock gate, this is
            purely UX. If the topic flips to locked while the modal is
            open, the composer disappears (or swaps to the override
            variant for mods) on the next render. */}
        {topic.lockedAt && !canModerate ? (
          <div className="flex shrink-0 items-center gap-2 border-t border-keep-rule bg-keep-banner/40 px-3 py-3 text-sm text-keep-muted">
            <span aria-hidden>🔒</span>
            <span>{t("thread.lockedNotice")}</span>
          </div>
        ) : (
          <>
            {topic.lockedAt && canModerate ? (
              <div className="flex shrink-0 items-center gap-2 border-t border-keep-rule bg-keep-accent/10 px-3 py-2 text-xs text-keep-accent">
                <span aria-hidden>🔒</span>
                <span>{t("thread.lockedModNotice")}</span>
              </div>
            ) : null}
            {/* Reuses the main `<Composer>` so `/command` autocomplete,
                `@mention` autocomplete, history (Up/Down), multi-line
                auto-grow, and the mobile newline button all work the
                same as the chat input below. We pass `isForumRoom=false`
                so the composer DOESN'T render its tri-mode forum hints,
                the modal is already the focused reply context; an inline
                "Replying to" indicator would duplicate the header above.
                The placeholder override tells the user where their text
                is going. onSend ignores the `opts` since we already
                know the parent topic from this modal's props. */}
            <Composer
              value={draft}
              onChange={setDraft}
              onSend={(text) => onReply(text)}
              occupants={occupants}
              placeholder={
                topic.lockedAt
                  ? t("thread.modReplyPlaceholder", { heading })
                  : t("thread.replyPlaceholder", { heading })
              }
            />
          </>
        )}
      </div>
    </div>
  );
}
