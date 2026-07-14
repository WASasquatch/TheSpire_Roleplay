export type MessageKind =
  | "say"      // normal chat: "<DisplayName>: <body>"
  | "me"       // action: "<DisplayName> <body>"  (no brackets, no colon)
  | "cmd"      // custom-command output: body is self-contained ({sender} is
               // expanded inline by the template, so the renderer does NOT
               // auto-prepend the display name like it does for "me"/"say").
               // Optional `cmdCss` styles the body.
  | "system"   // server notice (joins, kicks, topic changes)
  | "whisper"  // 1:1 private message - only sender + recipient receive
  | "roll"     // dice roll output: "<DisplayName> rolls 1d20: 17"
  | "announce" // admin broadcast
  | "scene"    // owner/mod scene-marker banner ("Scene begins: ...")
  | "npc"      // NPC voiced by a user; rendered with a "voiced by" tag
  | "ooc"      // out-of-character aside
  | "container" // themed embed block ("/container <style> [color]"); owner/mod; "Posted by X" header, no edited badge
  | "poll";    // poll post: options to vote on, body/title is the question

/**
 * OpenGraph unfurl card for a message's first link (Discord-style
 * preview). All display fields are optional — a card renders with
 * whatever the target site provided. `url` is the link that was
 * unfurled (the card's click-through).
 */
export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  siteName?: string;
}

/**
 * A resolved @mention, snapshotted at send time. When the composer inserts an
 * identity token (`@id:<userId>` / `@cid:<characterId>`), the server resolves
 * it to the exact identity, rewrites the body to `@<displayName>` for display,
 * and records one of these so the renderer can open the RIGHT profile on click
 * and highlight a self-mention by id, never by a name that two identities might
 * share. `name` is the lowercased display name as it appears in the rewritten
 * body, the key the renderer matches a mention chip against.
 */
export interface MentionRef {
  /** Lowercased display name as written into the body (the chip's text, lowercased). */
  name: string;
  /** Master account id of the mentioned identity. Always set. */
  userId: string;
  /** Character id when a specific character was mentioned (`@cid:`); null for a master/OOC mention. */
  characterId: string | null;
}

/** Safe-parse a stored `mentions_json` column into MentionRef[] (undefined when
 *  empty/invalid). Tolerant: a malformed row degrades to no snapshot rather
 *  than throwing in a message-build path. */
export function parseMentionsJson(json: string | null | undefined): MentionRef[] | undefined {
  if (!json) return undefined;
  try {
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr)) return undefined;
    const out: MentionRef[] = [];
    for (const r of arr) {
      if (r && typeof r === "object" && typeof (r as MentionRef).name === "string" && typeof (r as MentionRef).userId === "string") {
        const ref = r as MentionRef;
        out.push({ name: ref.name, userId: ref.userId, characterId: typeof ref.characterId === "string" ? ref.characterId : null });
      }
    }
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Spread helper for message-build sites: `...mentionsField(row.mentionsJson)`
 *  attaches `mentions` only when the row has a valid snapshot. */
export function mentionsField(json: string | null | undefined): { mentions?: MentionRef[] } {
  const mentions = parseMentionsJson(json);
  return mentions ? { mentions } : {};
}

export interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  characterId: string | null;
  /** snapshotted at send time so renames don't rewrite history */
  displayName: string;
  kind: MessageKind;
  body: string;
  /**
   * Body format (migration 0352). Absent or "md" = the historic chat
   * markdown grammar (parseInline). "html" = `body` is sanitized rich
   * HTML (strict whitelist, sanitized server-side at ingest and
   * re-sanitized client-side at render) and `bodyText` carries the
   * derived plaintext mirror. Old rows/clients never see this field.
   */
  format?: import("./richMessage.js").ChatMessageFormat;
  /**
   * Server-derived visible plaintext of an "html"-format body (block
   * breaks as newlines, tags stripped, entities decoded). Present iff
   * `format === "html"`. Plaintext surfaces (previews, quote-append,
   * sticker detection) read this instead of parsing the HTML.
   */
  bodyText?: string | null;
  /**
   * Resolved @mentions for this message, snapshotted at send time from any
   * `@id:`/`@cid:` identity tokens the composer inserted. Lets the renderer
   * open the exact mentioned identity on click and highlight self-mentions by
   * id. Absent on messages with no token mentions (plain `@name` text still
   * renders and resolves by name as before).
   */
  mentions?: MentionRef[];
  /** Snapshot hex color (e.g. "#990000") at send time. Null/absent = default render. */
  color?: string | null;
  /** epoch ms */
  createdAt: number;
  /** present when kind === "whisper" - recipient's userId */
  toUserId?: string;
  /**
   * Recipient's character id at send time (whispers only). Set when
   * the whisper was addressed at a specific character (`@cid:` token
   * or character-name lookup); absent / undefined when the whisper
   * was addressed at the master / OOC handle. Lets the FE build the
   * matching `@cid:<id>` continuation token on a recipient-name
   * click, without it, the next /whisper falls back to `@id:<userId>`
   * and re-routes a character thread back to the master account.
   * Added in migration 0189.
   */
  toCharacterId?: string | null;
  /** present when kind === "whisper" - recipient display name snapshotted at send time */
  toDisplayName?: string;
  /** Id of the message this one replies to. Absent on non-replies. */
  replyToId?: string | null;
  /** Snapshotted display name of the parent message's author (for inline quote preview). */
  replyToDisplayName?: string | null;
  /** Truncated snapshot of the parent body, used to render the inline quote preview. */
  replyToBodySnippet?: string | null;
  /** Snapshotted mood/expression of the author at send time. Renders as a chip next to the name. */
  moodSnapshot?: string | null;
  /** For `kind === "npc"` only: the master username of the user who voiced this NPC. */
  npcVoicedBy?: string | null;
  /** For `kind === "npc"` posted from a saved NPC: snapshot of its stat lines
   *  (label/value), rendered as a small stat block. Omitted when none. */
  npcStats?: Array<{ label: string; value: string }>;
  /**
   * Optional hero image for `kind === "scene"` banners. Set by
   * `/scene <title> | <url>` and frozen at send time. The renderer
   * paints it centered under the (enlarged) scene title with rounded
   * corners; the whole banner is click-to-collapse so a viewer who
   * wants the timeline back can tap once to shrink to the title only.
   * Absent on every non-scene row and on legacy scene rows that
   * predate migration 0190.
   */
  sceneImageUrl?: string | null;
  /**
   * For `kind === "container"` only (migration 0362). The embed STYLE
   * (solid|glass|parchment|bokeh|gradient) and an optional accent COLOR
   * keyword (alert|green|purple|red|blue|teal|pink). Set by
   * `/container <style> [color]` and frozen at send time. The renderer paints
   * a themed full-width block whose base colors track the VIEWER's active
   * theme; the accent is derived from the KEYWORD at render (never a snapshot
   * hex) so it re-themes per viewer. Absent on every non-container row.
   */
  containerStyle?: string | null;
  containerColor?: string | null;
  /**
   * Trusted-HTML body for scheduled `/announce` lines (migration
   * 0191). When set, the announce renderer paints it via
   * `dangerouslySetInnerHTML` (after a defense-in-depth sanitizer
   * pass) so admin-authored markup, links, lists, bold spans,
   * renders cleanly instead of as escaped text. Manual in-chat
   * `/announce` keeps this null and falls through to the existing
   * inline-markdown render pipeline.
   */
  bodyHtml?: string | null;
  /** Set when the author edited the message inside the grace window. Epoch ms. */
  editedAt?: number | null;
  /** Set when the author deleted the message inside the grace window. Renderer shows "[message removed]". */
  deletedAt?: number | null;
  /**
   * Original body of a soft-deleted message, surfaced ONLY to viewers
   * with `isAdminRole(role) === true` so a site admin can audit what
   * was hidden (in case the author was burying something). Mods,
   * room-owner mods, and ordinary viewers receive a wire payload
   * without this field; their renderer keeps showing the bare
   * "[message removed]" placeholder. The server gates this per-socket
   * on emit and per-request on history endpoints so non-admins can't
   * see the deleted content by sniffing the wire.
   */
  originalBody?: string | null;
  /**
   * Audit snapshot of who performed the soft-delete. Same admin-only
   * gating as `originalBody`, the server only emits these fields to
   * `isAdminRole` viewers. Compare `deletedByUserId === userId` at
   * render time to distinguish a self-delete (within the grace
   * window) from a mod/admin moderation action. Both fields are
   * absent when the message isn't deleted, or when the delete
   * predates migration 0084 and was never snapshotted.
   */
  deletedByUserId?: string | null;
  /** Display name snapshotted at delete time. See `deletedByUserId`. */
  deletedByDisplayName?: string | null;
  /**
   * Thread-category anchor for top-level messages in nested-mode rooms.
   * Null/absent = "Uncategorized" (the renderer's fallback bucket).
   * Replies inherit their parent's category implicitly, this field is
   * only meaningful when `replyToId` is absent.
   */
  threadCategoryId?: string | null;
  /**
   * Forum topic title. Present only on top-level messages in nested-
   * mode (forum) rooms, those are the "topics" replies live under.
   * Absent on replies and on every message in flat-mode chat rooms.
   */
  title?: string | null;
  /**
   * Snapshot of the author's avatar URL at send time. Used by the
   * forum renderer to show an avatar beside each post; ignored by the
   * chat renderer. Null = author had no avatar configured when posting.
   */
  avatarUrl?: string | null;
  /**
   * Timestamp the topic was locked (author or moderator action). Set on
   * top-level topics in nested-mode rooms to indicate the thread is
   * closed to new replies, server rejects `chat:input` replies under
   * a locked topic, the forum UI shows a 🔒 indicator + disables the
   * reply composer. Null/absent = unlocked. Replies and flat-room
   * messages always carry this as null.
   */
  lockedAt?: number | null;
  /**
   * Most-recent-activity timestamp for top-level topics. Updated by
   * the server when a reply is inserted under the topic, the forum
   * pagination orders by this DESC so active threads surface first.
   * For replies and flat-room messages this is null/unused.
   */
  lastActivityAt?: number | null;
  /**
   * Total replies under a top-level forum topic, computed server-side in
   * `GET /rooms/:id/topics` so the COLLAPSED topic card shows the right
   * count without first fetching the thread. (The live, expanded view
   * counts the loaded reply buffer instead, which also reflects replies
   * arriving over the socket.) Absent on replies and flat-room messages.
   */
  replyCount?: number;
  /**
   * Admin-pinned flag for forum topics. When true, the topic floats
   * above all non-sticky topics in its category and is returned on
   * every page of `GET /rooms/:id/topics`. Only admins can toggle
   * this; the forum view shows a 📌 indicator. Defaults to false.
   */
  isSticky?: boolean;
  /** Forum topic prefix id (resolve against the forum's prefix catalog).
   *  Top-level forum topics only; omitted when none. */
  prefixId?: string | null;
  /**
   * Server-validated CSS to apply to the rendered body of a `kind: "cmd"`
   * message. Stored verbatim as a CSS declaration list ("font-weight: bold;
   * color: #4a8" etc.); the renderer parses + camel-cases the properties
   * before applying them as an inline style. Snapshotted at send time so a
   * later edit to the underlying custom command's CSS doesn't restyle
   * historical messages. Absent on every kind except `cmd`.
   */
  cmdCss?: string | null;
  /**
   * OpenGraph unfurl of the body's first http(s) link — the Discord-
   * style card under the message. Filled shortly after the post lands
   * (a `message:update` carries it in); absent when there's no link,
   * the site had nothing to show, or the author removed the card.
   */
  linkPreview?: LinkPreview | null;
  /**
   * Snapshot of the author's Earning rank at send time. Drives the
   * inline sigil next to the display name on chat lines + forum
   * headers without forcing the renderer to look up each sender's
   * live rank.
   *
   * Snapshot scope mirrors the IC/OOC routing rule:
   *   - IC messages (kind != ooc/whisper and characterId set):
   *     character-pool rank
   *   - OOC messages (kind === ooc/whisper, or characterId null):
   *     master-pool rank
   *
   * Null/absent = pool had no rank at send time (fresh account, or
   * every rank disabled). Renderer falls back to no sigil.
   */
  rankKey?: string | null;
  /** Rank-tier snapshot. 1..N where 1 is the lowest enabled tier. Null when rankKey is null. */
  tier?: number | null;
  /**
   * Snapshot of whether the author had the inline-avatar cosmetic
   * enabled at send time. The chat renderer falls back to this when
   * the author isn't in the room anymore (no live occupant row), so
   * backlog inline avatars survive the sender logging out.
   * Absent on rows that predate the snapshot; treated as false.
   */
  senderInlineAvatarEnabled?: boolean;
  /**
   * Snapshot of the author's equipped border-rank key at send time.
   * Paired with `senderInlineAvatarEnabled` so the backlog inline
   * avatar still shows the right frame for offline senders.
   */
  senderSelectedBorderRankKey?: string | null;
  /**
   * Emoticon-reaction summary for this message, embedded inline so the
   * client can render the ReactionBar without a per-row fetch.
   * Absent on rows with zero reactions (the wire stays compact);
   * absent on backlog payloads predating the feature.
   */
  reactions?: import("./emoticon.js").ReactionEntry[];
  /**
   * Resolved poll state for `kind === "poll"` rows: the definition, current
   * tallies, and THIS viewer's ballot. The server hydrates it per-viewer
   * (voters list only when the poll's showVoters is on); the client renders
   * the PollCard from it and merges live `poll:update` events in. Absent on
   * every non-poll row.
   */
  poll?: import("./poll.js").PollState | null;
  /**
   * Resolved role-picker state for `/roleselect` panel rows (bodies made of
   * `{role:<usergroupId>}` token lines — see roleSelect.ts). Hydrated
   * per-viewer like `poll` above: live group names/colors plus whether THIS
   * viewer holds each role. Tokens with no matching entry render as plain
   * text (group deleted or no longer self-assignable). Absent on ordinary
   * rows and on payloads predating the feature.
   */
  roleSelect?: import("./roleSelect.js").RoleSelectState | null;
  /* ---------------------------------------------------------------
   * PER-SERVER TOPIC-CARD FLAIR (Servers Lift). Mirrors the
   * `author*` set on `ForumTopicCard`. Present ONLY on the top-level
   * topic rows from `GET /rooms/:id/topics` when the board's forum
   * HAS a server affiliation (`forums.serverId`), and they describe
   * the cosmetics the author earned/equipped ON THAT SERVER. ALL of
   * these ship together or ALL are omitted: an UNAFFILIATED forum
   * (`forums.serverId IS NULL`) sends none of them and the card MUST
   * render bare (no sigil, no border frame, no name style). The
   * individual values may be null when the author hasn't earned/
   * equipped that cosmetic on that server. The renderer gates flair
   * on "did the server send the field at all", not on its value, and
   * prefers these over the post-time `rankKey`/`tier` snapshot so a
   * (re)affiliated forum shows CURRENT per-server flair.
   * --------------------------------------------------------------- */
  /** Rank key in the forum's server (drives the topic-card RankSigil), or null. */
  authorRankKey?: string | null;
  /** Rank tier (I–IV) paired with `authorRankKey`, or null. */
  authorTier?: number | null;
  /** Equipped rank-tier avatar border key in the forum's server, or null. */
  authorSelectedBorderRankKey?: string | null;
  /** Equipped free-form avatar border key in the forum's server, or null. */
  authorSelectedFreeformBorderKey?: string | null;
  /** Per-identity color config for the equipped free-form border, or null. */
  authorFreeformBorderConfig?: Record<string, string> | null;
  /** Equipped name-style key in the forum's server, or null. */
  authorNameStyleKey?: string | null;
  /** Owned-style color config paired with `authorNameStyleKey`, or null. */
  authorNameStyleConfig?: Record<string, unknown> | null;
}

/**
 * A single result row from `GET /rooms/:id/messages/search`. The server
 * filters by privacy (whispers visible only to sender/recipient, soft-
 * deletes excluded) before ranking, so the client can render results
 * directly without secondary filtering.
 *
 * `relevance` is a unitless server-assigned score (higher = better).
 * The UI sorts by it but doesn't surface the raw number. `snippet` is
 * the raw matched body, the client renders highlight on top via the
 * same logic message rendering uses, so we don't ship pre-built HTML
 * from the server.
 */
export interface MessageSearchHit {
  id: string;
  roomId: string;
  userId: string;
  displayName: string;
  kind: MessageKind;
  snippet: string;
  createdAt: number;
  relevance: number;
  /** Top-level thread anchor when the matched message is itself a reply. Used to render "in thread: <parent>" context. */
  replyToId?: string | null;
  /**
   * Cross-room / cross-server search context (extended search v1). Optional so
   * a single-room search that omits them stays byte-identical. `roomName` is the
   * hit's room name; `serverId`/`serverName` scope the room to a community
   * server (null/absent on the default server); `title` is the forum topic
   * title when the hit lives on a forum board. The UI uses these to render
   * "in <room>" / "on <server>" breadcrumbs on a global result list.
   */
  roomName?: string;
  serverId?: string | null;
  serverName?: string;
  title?: string;
}
