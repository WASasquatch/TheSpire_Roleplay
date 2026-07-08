import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Bookmark, BookmarkCheck, Flag, Pencil, Pin, PinOff, Reply, SmilePlus, Trash2 } from "lucide-react";
import { canonicalizeNameForLookup, customCmdCssToStyle, extractMentions, renderUiRouteChipsInHtml, resolveMessageColor, type AvatarCrop, type ChatMessage, type MentionRef } from "@thekeep/shared";
import { useActiveTheme } from "../../lib/theme.js";
import { BorderedAvatar } from "../cosmetics/BorderedAvatar.js";
import { UserNameTag } from "../UserNameTag.js";
import type { Gender } from "../../lib/gender.js";
import { parseInline, solitaryEmoticonToken } from "../../lib/markdown.js";
import { sanitizeUserHtml } from "../../lib/userHtml.js";
import { handleUiRouteClickInHtml } from "../../lib/uiRouteOpen.js";
import { hydrateDynamicUiRouteChips } from "../../lib/hydrateDynamicUiRouteChips.js";
import { EmoticonSprite } from "../emoticons/EmoticonSprite.js";
import { useEmoticons } from "../../state/emoticons.js";
import { splitMentions } from "../../lib/mentions.js";
import { useChat } from "../../state/store.js";
import { LinkPreviewCard } from "../LinkPreviewCard.js";
import { useMentionsCache, requestMentionResolve } from "../../state/mentions.js";
import { useReducedMotion } from "../../lib/reducedMotion.js";
import { fmtTime } from "../messageTime.js";
import { ReactionAddButton, ReactionBar } from "./ReactionBar.js";
import { PollCard } from "./PollCard.js";

/** Kinds eligible for /reports - mirrors the server's privacy gate. */
export const REPORTABLE_KINDS = new Set(["say", "me", "ooc", "announce", "npc"]);

export const REPLYABLE_KINDS = new Set(["say", "me", "ooc", "npc"]);

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
  // Shared `canonicalizeNameForLookup` folds NBSP + lowercases (same fold the
  // server name lookups use), keeping the client render paths in lockstep.
  const norm = (s: string) => canonicalizeNameForLookup(s);
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

export function Line({
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
  canPinMessage,
  isPinned,
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
  /** Viewer can pin/unpin this chat message (sitewide `pin_message` or room owner/mod). Surfaces a Pin/Unpin action beside the bookmark button. */
  canPinMessage: boolean;
  /** This message is currently pinned in the room, so the action renders Unpin. */
  isPinned: boolean;
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
  // Pin/Unpin (migration 0316): shown to privileged viewers on content-
  // bearing room lines. Whispers are private threads and never pinnable
  // (mirrors the server gate); soft-deleted rows can't be pinned. An
  // already-pinned message keeps the control visible so it can be UNpinned.
  const PINNABLE_KINDS = new Set(["say", "me", "ooc", "npc", "roll", "scene", "announce", "cmd"]);
  const showPinMessage = canPinMessage && PINNABLE_KINDS.has(msg.kind) && !msg.deletedAt;

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
  const hasControls = showBookmark || showPinMessage || showOwnControls || showModControls || effectiveShowReport || reactAvailable;
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
      {/* Pin/Unpin sits beside Bookmark (both are "keep this around" saves,
          but Pin is the shared, mod-gated one). */}
      {showPinMessage ? <PinToggleButton msg={msg} isPinned={isPinned} /> : null}
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
 * Pin / Unpin control (migration 0316). Mod/admin (or room owner/mod) toggle
 * whether this message is pinned to the top of the room. POST/DELETE
 * `/messages/:id/pin`; the server re-checks the same gate and broadcasts
 * `room:pins`, which flips the `isPinned` prop and re-labels this button — so
 * no optimistic state is needed beyond a brief in-flight lock. Styled to match
 * the bookmark / edit / delete buttons so the row reads as one set.
 */
function PinToggleButton({ msg, isPinned }: { msg: ChatMessage; isPinned: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/messages/${encodeURIComponent(msg.id)}/pin`, {
        method: isPinned ? "DELETE" : "POST",
        credentials: "include",
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      // Success: the room:pins broadcast updates isPinned; nothing else to do.
    } catch (err) {
      setError(err instanceof Error ? err.message : "pin failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      title={error ?? (isPinned ? "Unpin this message" : "Pin this message to the top of the room")}
      aria-label={isPinned ? "Unpin this message" : "Pin this message"}
      aria-pressed={isPinned}
      className={
        "flex h-5 items-center gap-1 rounded border px-1.5 text-[10px] leading-none disabled:opacity-50 " +
        (isPinned
          ? "border-keep-action/60 bg-keep-action/15 text-keep-action hover:bg-keep-action/25"
          : "border-keep-rule bg-keep-bg/80 text-keep-muted hover:border-keep-action/60 hover:bg-keep-banner hover:text-keep-action md:invisible md:group-hover:visible md:group-focus-within:visible")
      }
    >
      {isPinned ? <PinOff className="h-3 w-3" aria-hidden /> : <Pin className="h-3 w-3" aria-hidden />}
    </button>
  );
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
  // Calm-mode ease: desktop dropdown (md:top-5) AND mobile bottom-sheet (fixed
  // bottom-2), so fade in (opacity only) — a slide direction would be wrong in
  // one of the two layouts.
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
          className={`fixed inset-x-2 bottom-2 z-30 max-h-[80vh] overflow-y-auto rounded border border-keep-rule bg-keep-bg p-2 text-xs normal-case tracking-normal shadow-lg md:absolute md:inset-x-auto md:bottom-auto md:right-0 md:top-5 md:max-h-none md:min-w-[16rem] md:normal-case md:tracking-normal${reduceMotion ? " tk-fade-in" : ""}`}
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
