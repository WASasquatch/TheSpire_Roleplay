import { randomInt } from "node:crypto";
import { and, asc, desc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Server as IoServer, Socket } from "socket.io";
import type {
  ChatMessage,
  ClientToServerEvents,
  MessageKind,
  RoomOccupant,
  RoomSummary,
  ServerToClientEvents,
} from "@thekeep/shared";
import {
  clampAvatarCrop,
  DEFAULT_PRESENCE_TEMPLATES,
  extractMentions,
  extractMentionTokens,
  mentionsField,
  mentionTokenRegex,
  processCheckBlocks,
  renderPresenceTemplate,
  stripCheckMarkers,
  validateAuthorUiRouteTokens,
} from "@thekeep/shared";
import type { MentionRef } from "@thekeep/shared";
import {
  bans,
  characterEarning,
  characterOwnedFreeformBorders,
  characterOwnedNameStyles,
  characters,
  friends,
  ignores,
  messages,
  roomInvites,
  roomMembers,
  roomMods,
  roomWorldLinks,
  rooms,
  userActiveCosmetics,
  userOwnedFreeformBorders,
  userOwnedNameStyles,
  userEarning,
  users,
  worlds,
} from "../db/schema.js";
import { inArray } from "drizzle-orm";
import type { LinkedWorldRef } from "@thekeep/shared";
import { pushToUser } from "../push.js";
import type { Db } from "../db/index.js";
import {
  persistRoomDescriptionOnce,
  persistTargetedSystemMessageToActiveRooms,
  roomVisibilityWhere,
} from "./targetedMessages.js";
import { blockedUserIdsFor, blocksAmong } from "../auth/blocks.js";
import type { CommandContext, SessionUser } from "../commands/types.js";
import { expandInlineCommands } from "../commands/registry.js";
import { getSettings } from "../settings.js";
import { awardForForum, awardForMessage } from "../earning/award.js";
import { bumpLifetimeForMessage, classifyMessageForLifetime } from "../lib/lifetimePostCounts.js";
import { getClearedAt } from "../lib/roomClears.js";
import { getAway, clearAllAwayForUser } from "./awayState.js";
import { getMood, clearAllMoodForUser } from "./moodState.js";
import { linkPreviewFromRow } from "../unfurl.js";
import {
  checkpointFor,
  getTheater,
  hydrate as hydrateTheater,
  parseCheckpoint,
  parsePlaylist,
  serializeCheckpoint,
  theaterRoomIds,
  theaterSyncPayload,
} from "./theaterState.js";
import { loadReactionsForTargets } from "../reactions.js";
import { emptyPollState, loadPollState } from "../polls.js";
import { readPoolRank } from "../earning/resolver.js";
import { routeMessage } from "../earning/routing.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;
type Sock = Socket<ClientToServerEvents, ServerToClientEvents>;

/** Send a chat/system message to a room. Persists, then broadcasts. */
/**
 * Persist + broadcast a chat message authored by `ctx.user`.
 *
 * Returns the id of the inserted message on success, or null when
 * the send is aborted before persistence (size cap exceeded after
 * inline-command expansion, unauthorized UI route token, etc.).
 * Most callers ignore the return value, they fire-and-forget the
 * persist + broadcast, but a few paths (currently Story Dice's
 * post-and-seed-reaction flow) need the message id to attach a
 * server-authored reaction to the freshly-posted line. The id is
 * returned regardless of caller need so future flows that want it
 * can just await.
 */
/** NBSP, the "fake space" the mention regex treats as part of a name, so a
 *  rewritten multi-word mention (`@The Doctor`) reads as a single token. */
const MENTION_NBSP = String.fromCharCode(0xa0);

/**
 * Resolve `@id:`/`@cid:` identity tokens in a freshly-composed body. Returns the
 * body with each resolvable token rewritten to a plain `@<displayName>` (spaces
 * become NBSP so the mention regex reads it as one token) plus a snapshot of the
 * resolved identities for the wire. Unresolvable tokens (deleted/missing) are
 * left exactly as typed; an escaped token (`\@id:...`) drops the backslash and
 * stays literal so it never renders as a chip or pings anyone.
 */
async function resolveMentionTokens(
  db: Db,
  body: string,
): Promise<{ body: string; mentions: MentionRef[] | null }> {
  const hits = extractMentionTokens(body);
  if (hits.length === 0) return { body, mentions: null };

  // Resolve each unique token: `id` -> master account; `cid` -> character
  // (carrying its owning userId). Skip disabled accounts / deleted characters.
  const resolved = new Map<string, { displayName: string; userId: string; characterId: string | null }>();
  for (const hit of hits) {
    if (hit.kind === "id") {
      const u = (await db.select({ id: users.id, username: users.username, disabledAt: users.disabledAt })
        .from(users).where(eq(users.id, hit.id)).limit(1))[0];
      if (u && !u.disabledAt) resolved.set(`id:${hit.id}`, { displayName: u.username, userId: u.id, characterId: null });
    } else {
      const c = (await db.select({ id: characters.id, name: characters.name, userId: characters.userId, deletedAt: characters.deletedAt })
        .from(characters).where(eq(characters.id, hit.id)).limit(1))[0];
      if (c && !c.deletedAt) resolved.set(`cid:${hit.id}`, { displayName: c.name, userId: c.userId, characterId: c.id });
    }
  }
  if (resolved.size === 0) return { body, mentions: null };

  const newBody = body.replace(mentionTokenRegex(), (full: string, ...args: unknown[]) => {
    const groups = args[args.length - 1] as { prefix?: string; tokenKind?: string; tokenId?: string };
    const prefix = groups.prefix ?? "";
    if (prefix === "\\") return full.slice(1); // escaped: drop the backslash, keep literal
    const ref = resolved.get(`${groups.tokenKind}:${groups.tokenId}`);
    if (!ref) return full; // unresolved: leave the token as typed
    return `${prefix}@${ref.displayName.replace(/ /g, MENTION_NBSP)}`;
  });

  const mentions: MentionRef[] = [...resolved.values()].map((ref) => ({
    name: ref.displayName.replace(/ /g, MENTION_NBSP).toLowerCase(),
    userId: ref.userId,
    characterId: ref.characterId,
  }));
  return { body: newBody, mentions };
}

export async function addMessage(
  ctx: CommandContext,
  payload: {
    kind: MessageKind;
    body: string;
    toUserId?: string;
    /**
     * Per-call color override. Custom commands pass this when the admin set
     * a fixed color on the command itself. When undefined the sender's
     * chatColor is used (default behavior).
     */
    color?: string | null;
    /** Reply target. Caller is responsible for snapshotting display name + body snippet. */
    replyToId?: string;
    replyToDisplayName?: string;
    replyToBodySnippet?: string;
    /** Override the displayed name (used by /npc to inject the NPC's name in place of the author's). */
    displayNameOverride?: string;
    /** For /npc: the display name of the AUTHOR'S ACTIVE IDENTITY (character, or OOC name when OOC) who voiced this NPC. Rendered as a "voiced by" tag. The real account stays recoverable via the row's userId/characterId. */
    npcVoicedBy?: string;
    /**
     * Thread-category bucket for top-level messages in nested-mode rooms.
     * Caller (`dispatchChatInput`) validates the id belongs to the room
     * and only forwards it for non-reply, plain sends, replies inherit
     * their parent's category implicitly through the thread relation.
     */
    threadCategoryId?: string | null;
    /**
     * Forum topic title. Set on new top-level posts in nested-mode
     * rooms (the master thread the replies live under). Caller is
     * responsible for trimming and length-capping; we just persist it.
     */
    title?: string | null;
    /**
     * Snapshot CSS for `kind: "cmd"` rows. Set by the custom-command
     * handler from the (sanitized) admin-authored value on the
     * command row. Frozen on the message so a later edit to the
     * command's CSS doesn't restyle history. Ignored for every other
     * kind.
     */
    cmdCss?: string | null;
    /**
     * Optional hero image URL for `kind: "scene"` banners. Validated
     * by the /scene handler before this call lands, addMessage
     * persists it verbatim. Ignored on every other kind so a stray
     * caller can't paint an image onto a /me line.
     */
    sceneImageUrl?: string | null;
    /**
     * Serialized {@link PollData} for `kind: "poll"` rows (the /poll command
     * and the forum poll composer build it). Persisted verbatim and echoed
     * into the outgoing message's hydrated `poll` state (zero tallies at
     * creation). Ignored on every other kind.
     */
    pollDataJson?: string | null;
  },
): Promise<string | null> {
  // Inline-command expansion. The body may carry user-authored
  // `!cmd` tokens, either from a plain chat send or from a slash
  // command's free-form arg ("/me dances and !random"). We run the
  // expander here so every author path benefits without each handler
  // remembering to call it. The expander is a no-op for bodies that
  // don't contain `!`, so this is essentially free for the common
  // case. System messages bypass this function entirely (they go
  // through `addSystemMessage`), so server-authored text never sees
  // the expander.
  //
  // After expansion we re-check the size cap: a handful of `!cmd`
  // tokens with chunky inline templates can blow past
  // maxMessageLength even when the user-typed input fit. Failing
  // here drops the send and notifies the user via the same
  // TOO_LONG channel the dispatcher uses for raw-input rejections.
  let body = payload.body;
  const expanded = expandInlineCommands(body, ctx.registry, ctx.user, ctx.roomId);
  if (expanded !== body) {
    const { maxMessageLength } = await getSettings(ctx.db);
    if (expanded.length > maxMessageLength) {
      ctx.socket.emit("error:notice", {
        code: "TOO_LONG",
        message: `Messages capped at ${maxMessageLength} chars after inline-command expansion.`,
      });
      return null;
    }
    body = expanded;
  }

  // UI route token guard, rejects KNOWN tokens that the author's
  // role can't use (e.g. a regular user trying to drop
  // `{modal:admin}` into a `/say` so it renders for mods downstream).
  // Unknown tokens fall through as plain literal text so a roleplay
  // line like `{nervously}` stays unaffected. Runs after inline-cmd
  // expansion in case a custom command's template embeds a token,
  // the post-expansion body is what actually broadcasts.
  const uiTokenCheck = validateAuthorUiRouteTokens(body, ctx.user.role);
  if (!uiTokenCheck.ok) {
    ctx.socket.emit("error:notice", {
      code: "UI_ROUTE_FORBIDDEN",
      message: uiTokenCheck.reason,
    });
    return null;
  }

  // Resolve identity-token mentions (`@id:`/`@cid:`) the composer inserted.
  // We rewrite each token in the body to a plain `@<displayName>` (so every
  // render path shows the right chip with zero render changes) and snapshot the
  // resolved ids on the message, so a click opens the exact identity and a
  // self-mention highlights by id rather than by an ambiguous shared name.
  const resolvedMentions = await resolveMentionTokens(ctx.db, body);
  body = resolvedMentions.body;
  const mentionsSnapshot = resolvedMentions.mentions;

  // Dynamic pass/fail prompts. The author may have embedded a
  // `<check>…</check>` or `<roll:1d20:12>…</roll>` block; resolve it
  // server-side ONCE (authoritative, like /roll) and replace it with a
  // self-contained marker the client renders as a collapsible Pass/Fail
  // card. We strip any pre-existing markers from the (still user-derived)
  // body first so a pasted "resolved" block can't masquerade as real,
  // then process to mint authentic ones. Runs AFTER mention resolution so
  // branch prose carries resolved names, and after the inline-expansion
  // length gate so the marker's encoding overhead (URI-encoded JSON) is
  // never charged against the author's typed length.
  body = processCheckBlocks(stripCheckMarkers(body), randomInt);

  // Forum-thread auto-binding. When the dispatcher hydrated a reply
  // context (composer was scoped to an active topic in a nested-mode
  // room) AND this send didn't already specify its own reply target
  // AND the message kind is a per-author chat shape (not a room-wide
  // event), inherit the thread tuple so /me, /roll, /scene, /npc,
  // etc. all land as replies under the topic the composer was bound
  // to instead of leaking out as fresh top-level posts. Per the
  // user's request ("commands should really just work in forums as
  // replies to threads"), this auto-binding is the default for every
  // speech-shaped kind.
  //
  // Excludes:
  //   - `system`  , /kick, /mute, /lock, /topic, etc. are room-wide
  //                  notices; threading them under whichever topic the
  //                  composer happened to be on misrepresents their
  //                  scope.
  //   - `announce`, admin broadcasts are explicitly room-wide too.
  //   - `whisper` , DMs don't route through this function in practice,
  //                  but listing the kind here is a belt-and-suspenders
  //                  against a future caller picking up the auto-bind
  //                  for a recipient-targeted send.
  //
  // Explicit payload.replyToId (e.g. the /reply builtin) wins so
  // callers can always override.
  if (
    !payload.replyToId &&
    ctx.replyContext &&
    payload.kind !== "system" &&
    payload.kind !== "announce" &&
    payload.kind !== "whisper"
  ) {
    payload = {
      ...payload,
      replyToId: ctx.replyContext.replyToId,
      replyToDisplayName: ctx.replyContext.replyToDisplayName,
      replyToBodySnippet: ctx.replyContext.replyToBodySnippet,
    };
  }

  // Incognito author rewrite. A moderator who's gone incognito
  // (the /incognito command flipped users.incognito_mode = true)
  // sends every non-system chat line as a server-system line under
  // their incognito_alias (default "System"). Other participants
  // see what looks like a server announcement; only the audit log
  // retains the real author. The /incognito command's own system
  // broadcasts (kind === "system") pass through untouched, they're
  // already correctly attributed.
  //
  // Reply metadata is stripped because system lines don't render
  // reply tags and the reply target itself could leak "the mod
  // replied to message X", informative even without their name.
  if (ctx.user.incognitoMode && payload.kind !== "system") {
    // Strip reply metadata via destructure rather than `= undefined`
    // assignment, exactOptionalPropertyTypes treats the latter as a
    // type error because the field shape is `string`, not
    // `string | undefined`. Building the new payload without the keys
    // gets us a strict-clean object.
    const {
      replyToId: _replyToId,
      replyToDisplayName: _replyToDisplayName,
      replyToBodySnippet: _replyToBodySnippet,
      ...rest
    } = payload;
    void _replyToId; void _replyToDisplayName; void _replyToBodySnippet;
    payload = {
      ...rest,
      kind: "system",
      displayNameOverride: ctx.user.incognitoAlias ?? "System",
    };
  }

  const id = nanoid();
  const now = new Date();
  // System messages (server-authored via addSystemMessage) bypass this path,
  // so user-authored kinds inherit the author's snapshotted color unless
  // an explicit override is supplied. When in-character, prefer the
  // character's own chat_color over the master's, that's how Character A
  // and Character B keep visually distinct chat lines under one account.
  // Falls through to the master's color when the character hasn't set one.
  let baseColor: string | null;
  if (payload.color !== undefined) {
    baseColor = payload.color;
  } else if (ctx.user.activeCharacterId) {
    const cc = (await ctx.db
      .select({ chatColor: characters.chatColor })
      .from(characters)
      .where(eq(characters.id, ctx.user.activeCharacterId))
      .limit(1))[0];
    baseColor = cc?.chatColor ?? ctx.user.chatColor;
  } else {
    baseColor = ctx.user.chatColor;
  }
  const colorSnapshot = colorForKind(payload.kind, baseColor);
  const displayName = payload.displayNameOverride ?? ctx.user.displayName;
  // Mood snapshots only on actually-spoken kinds, never on /npc lines (the
  // NPC isn't the user, applying their mood would be misleading).
  //
  // Per-identity mood: pull from the in-memory store keyed on
  // (userId, activeCharacterId). The session-user mirror
  // (`ctx.user.currentMood`) is only fresh inside the same chat:input
  // tick that ran /mood; the store is the canonical reading.
  const moodSnapshot = payload.kind === "npc"
    ? null
    : (getMood(ctx.user.id, ctx.user.activeCharacterId) ?? null);
  // Avatar snapshot. Prefer the active character's avatar so a forum
  // post stays visually attached to the character it was authored as
  // even if the user later switches characters or that character is
  // deleted. Fall back to the master account's avatar for OOC posts.
  let avatarSnapshot: string | null = null;
  if (ctx.user.activeCharacterId) {
    const c = (await ctx.db
      .select({ avatarUrl: characters.avatarUrl })
      .from(characters)
      .where(eq(characters.id, ctx.user.activeCharacterId))
      .limit(1))[0];
    if (c?.avatarUrl) avatarSnapshot = c.avatarUrl;
  }
  if (!avatarSnapshot) {
    const u = (await ctx.db
      .select({ avatarUrl: users.avatarUrl })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1))[0];
    if (u?.avatarUrl) avatarSnapshot = u.avatarUrl;
  }
  // Rank snapshot. Routed the same way the award engine routes credits:
  // IC line → character pool's rank; OOC line → master pool's rank.
  // Lookup before insert so we can persist + emit the rank with the
  // outgoing message in a single round-trip. Best-effort: failure
  // leaves the snapshot null (renderer shows no sigil for the line)
  // but never breaks the send.
  //
  // Privacy gate (per-user `showRankInChat`): when off, we skip the
  // lookup and persist null/null on this message. The user's existing
  // messages keep whatever rank was snapshotted at their send time,
  // the toggle affects FUTURE sends only, matching the snapshot
  // contract that other fields (color, displayName, mood) follow.
  let rankKeySnapshot: string | null = null;
  let tierSnapshot: number | null = null;
  let authorShowRankInChat = true;
  try {
    const u = (await ctx.db
      .select({ showRankInChat: users.showRankInChat })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1))[0];
    if (u) authorShowRankInChat = u.showRankInChat;
  } catch { /* tolerate: default-on means a transient lookup failure errs toward showing the rank */ }
  if (authorShowRankInChat) {
    try {
      const scope = routeMessage(payload.kind, ctx.user.activeCharacterId);
      if (scope.kind !== "none") {
        const ownerId = scope.kind === "character"
          ? (ctx.user.activeCharacterId as string)
          : ctx.user.id;
        const rank = await readPoolRank(ctx.db, scope.kind === "character" ? "character" : "user", ownerId);
        rankKeySnapshot = rank.rankKey;
        tierSnapshot = rank.tier;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[earning] rank snapshot lookup failed", { err });
    }
  }
  // Inline-avatar + border snapshot. Without this the chat renderer
  // has to read the live occupant row to decide whether to paint the
  // inline avatar, meaning the avatar vanishes for backlog from
  // authors who later logged out. Scoped the same way `avatarSnapshot`
  // above is: prefer the active character's row, else the master's.
  let inlineAvatarEnabledSnapshot = false;
  let selectedBorderRankKeySnapshot: string | null = null;
  try {
    if (ctx.user.activeCharacterId) {
      const ce = (await ctx.db
        .select({
          inlineAvatarEnabled: characterEarning.inlineAvatarEnabled,
          selectedBorderRankKey: characterEarning.selectedBorderRankKey,
        })
        .from(characterEarning)
        .where(eq(characterEarning.characterId, ctx.user.activeCharacterId))
        .limit(1))[0];
      if (ce) {
        inlineAvatarEnabledSnapshot = !!ce.inlineAvatarEnabled;
        selectedBorderRankKeySnapshot = ce.selectedBorderRankKey;
      }
    } else {
      const uac = (await ctx.db
        .select({ inlineAvatarEnabled: userActiveCosmetics.inlineAvatarEnabled })
        .from(userActiveCosmetics)
        .where(eq(userActiveCosmetics.userId, ctx.user.id))
        .limit(1))[0];
      if (uac) inlineAvatarEnabledSnapshot = !!uac.inlineAvatarEnabled;
      const ue = (await ctx.db
        .select({ selectedBorderRankKey: userEarning.selectedBorderRankKey })
        .from(userEarning)
        .where(eq(userEarning.userId, ctx.user.id))
        .limit(1))[0];
      if (ue) selectedBorderRankKeySnapshot = ue.selectedBorderRankKey;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[cosmetics] inline-avatar snapshot lookup failed", { err });
  }
  await ctx.db.insert(messages).values({
    id,
    roomId: ctx.roomId,
    userId: ctx.user.id,
    characterId: ctx.user.activeCharacterId,
    displayName,
    kind: payload.kind,
    body,
    color: colorSnapshot,
    toUserId: payload.toUserId ?? null,
    replyToId: payload.replyToId ?? null,
    replyToDisplayName: payload.replyToDisplayName ?? null,
    replyToBodySnippet: payload.replyToBodySnippet ?? null,
    moodSnapshot,
    npcVoicedBy: payload.npcVoicedBy ?? null,
    threadCategoryId: payload.threadCategoryId ?? null,
    title: payload.title ?? null,
    avatarUrl: avatarSnapshot,
    // Frozen snapshot of the command's CSS at send time. Only meaningful
    // for `kind: "cmd"` rows; left null on every other kind even when the
    // caller forgot to omit it.
    cmdCss: payload.kind === "cmd" ? (payload.cmdCss ?? null) : null,
    // Scene hero image, gated to `kind: "scene"` for the same reason
    // cmdCss is gated to "cmd": a stray caller on a /me line shouldn't
    // be able to paint a hero image into chat. Validation already ran
    // upstream (scene.ts validateSceneImageUrl) before this column
    // receives a non-null value.
    sceneImageUrl: payload.kind === "scene" ? (payload.sceneImageUrl ?? null) : null,
    // Poll definition, gated to `kind: "poll"` for the same reason cmdCss /
    // sceneImageUrl are gated to their kinds.
    pollDataJson: payload.kind === "poll" ? (payload.pollDataJson ?? null) : null,
    mentionsJson: mentionsSnapshot ? JSON.stringify(mentionsSnapshot) : null,
    rankKey: rankKeySnapshot,
    tier: tierSnapshot,
    senderInlineAvatarEnabled: inlineAvatarEnabledSnapshot,
    senderSelectedBorderRankKey: selectedBorderRankKeySnapshot,
    // last_activity_at on insert:
    //   - top-level row (topic, or any flat-chat message): its own
    //     createdAt, for forum topics this seeds the ordering before
    //     any replies arrive; for flat messages it's unused.
    //   - reply: null on the reply itself (the column is only read on
    //     topics), and the parent topic gets a separate UPDATE below.
    lastActivityAt: payload.replyToId ? null : now,
  });
  // For replies, bump the parent topic's last_activity_at so the forum
  // pagination's DESC order surfaces this thread to the top on the
  // next refresh. We do this best-effort: if the parent has been
  // deleted or paged out the UPDATE just affects 0 rows. Skip for
  // non-reply rows (already covered by the insert above).
  if (payload.replyToId) {
    await ctx.db
      .update(messages)
      .set({ lastActivityAt: now })
      .where(eq(messages.id, payload.replyToId));
  }
  const out: ChatMessage = {
    id,
    roomId: ctx.roomId,
    userId: ctx.user.id,
    characterId: ctx.user.activeCharacterId,
    displayName,
    kind: payload.kind,
    body,
    color: colorSnapshot,
    createdAt: +now,
    ...(payload.toUserId ? { toUserId: payload.toUserId } : {}),
    ...(payload.replyToId ? { replyToId: payload.replyToId } : {}),
    ...(payload.replyToDisplayName ? { replyToDisplayName: payload.replyToDisplayName } : {}),
    ...(payload.replyToBodySnippet ? { replyToBodySnippet: payload.replyToBodySnippet } : {}),
    ...(moodSnapshot ? { moodSnapshot } : {}),
    ...(payload.npcVoicedBy ? { npcVoicedBy: payload.npcVoicedBy } : {}),
    ...(payload.threadCategoryId ? { threadCategoryId: payload.threadCategoryId } : {}),
    ...(payload.title ? { title: payload.title } : {}),
    ...(avatarSnapshot ? { avatarUrl: avatarSnapshot } : {}),
    // Top-level messages carry their seeded lastActivityAt; replies
    // don't (the column is unused on reply rows, and the parent's
    // separate UPDATE above is what the client listens for).
    ...(payload.replyToId ? {} : { lastActivityAt: +now }),
    // Only attach cmdCss for kind="cmd" so the wire payload stays
    // minimal for other kinds (a stray null would be harmless but adds
    // noise to every chat line).
    ...(payload.kind === "cmd" && payload.cmdCss ? { cmdCss: payload.cmdCss } : {}),
    // Same posture for sceneImageUrl, only attached when this is a
    // scene row that actually carried an image.
    ...(payload.kind === "scene" && payload.sceneImageUrl ? { sceneImageUrl: payload.sceneImageUrl } : {}),
    // Rank snapshot, only attach when present so the wire stays
    // light for unranked authors.
    ...(rankKeySnapshot ? { rankKey: rankKeySnapshot } : {}),
    ...(tierSnapshot != null ? { tier: tierSnapshot } : {}),
    ...(inlineAvatarEnabledSnapshot ? { senderInlineAvatarEnabled: true } : {}),
    ...(selectedBorderRankKeySnapshot ? { senderSelectedBorderRankKey: selectedBorderRankKeySnapshot } : {}),
    // Fresh poll: hydrate zero-tally state so the room renders the PollCard on
    // the creation broadcast. Nobody has voted yet, so myVote/tallies are
    // empty for every recipient (per-viewer myVote is restored on backlog
    // hydration via loadPollState).
    ...(payload.kind === "poll" && payload.pollDataJson && emptyPollState(payload.pollDataJson)
      ? { poll: emptyPollState(payload.pollDataJson)! }
      : {}),
    ...(mentionsSnapshot ? { mentions: mentionsSnapshot } : {}),
  };
  await emitFiltered(ctx.io, ctx.db, ctx.roomId, ctx.user.id, out);

  // Belt-and-suspenders: emit directly to the sender's socket too. The
  // room broadcast above only reaches sockets currently subscribed to
  // `room:${roomId}`, and a race between a fast room-switch and a send
  // (or a transient socket.io reconnect) can leave the sender's socket
  // unsubscribed at the moment of broadcast, they'd miss their own
  // message and not see it again until a page refetch pulled it from
  // history. The client-side `appendMessage` dedupes by id, so this
  // duplicate-on-the-wire is invisible in the typical happy path
  // (socket is in the room → first delivery wins, second is dropped).
  ctx.socket.emit("message:new", out);

  // Fire-and-forget push triggers for offline recipients. Privacy contract:
  // payloads carry only the *kind* of event ("whisper" / "mention") and the
  // author's display name - never the body. The user has to come back to
  // the chat to read what was said.
  void pushTriggers(ctx.io, ctx.db, out, ctx.user, payload.kind);

  // Fire-and-forget link unfurl (OpenGraph preview). Off the hot path:
  // the card arrives via a message:update once the target site answers.
  // Failures (timeouts, unsafe hosts, no metadata) are silent.
  void import("../unfurl.js")
    .then(({ unfurlAndAttach }) => unfurlAndAttach(ctx.db, ctx.io, {
      messageId: id,
      roomId: ctx.roomId,
      kind: payload.kind,
      body: out.body,
    }))
    .catch(() => { /* cosmetic */ });

  // Fire-and-forget Earning award. Failures inside the engine are
  // logged but never surfaced, a flaky award path must not break
  // message persistence (we just persisted + broadcast above).
  //
  // Routing:
  //   - Forum topic (top-level post in a nested-mode room) → awardForForum 'topic'
  //   - Forum reply (replyToId set in a nested-mode room)  → awardForForum 'reply'
  //   - Everything else (flat chat, whispers, OOC, etc.)   → awardForMessage
  //
  // Forum/chat split matters because the two carry independent
  // per-source amounts in EarningConfig. The room replyMode is the
  // authoritative signal, `payload.title` alone is not enough (a
  // flat room could in principle persist a title via /topic), and
  // `payload.replyToId` can also appear on flat rooms as a quote-
  // reply that isn't a forum post.
  void (async () => {
    try {
      const room = (await ctx.db
        .select({ replyMode: rooms.replyMode })
        .from(rooms)
        .where(eq(rooms.id, ctx.roomId))
        .limit(1))[0];
      const replyMode: "flat" | "nested" = room?.replyMode === "nested" ? "nested" : "flat";
      // Lifetime post-counter bump (migration 0176). One write per
      // user, plus one per character when the message was authored
      // under a character. Whispers / system / cmd / announce kinds
      // classify to null and skip. Failure is logged inside the
      // helper, don't let a stuck counter roll back the awarding
      // path below.
      void bumpLifetimeForMessage(
        ctx.db,
        ctx.user.id,
        ctx.user.activeCharacterId,
        classifyMessageForLifetime({
          kind: payload.kind,
          replyMode,
          isReply: !!payload.replyToId,
          hasTitle: !!payload.title,
        }),
      );
      const isForum = replyMode === "nested";
      if (isForum && (payload.title || payload.replyToId)) {
        await awardForForum({
          db: ctx.db,
          io: ctx.io,
          userId: ctx.user.id,
          kind: payload.replyToId ? "reply" : "topic",
          messageId: id,
          roomId: ctx.roomId,
        });
        return;
      }
      await awardForMessage({
        db: ctx.db,
        io: ctx.io,
        userId: ctx.user.id,
        characterId: ctx.user.activeCharacterId,
        defaultActiveCharacterId: ctx.user.activeCharacterId,
        kind: payload.kind,
        body,
        roomId: ctx.roomId,
        messageId: id,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[earning] award hook failed", { messageId: id, err });
    }
  })();
  // Surface the inserted row's id so callers that need to attach
  // follow-up state (server-authored reactions, audit links, etc.)
  // don't have to re-query. The award hook above runs asynchronously
  // inside an IIFE so it doesn't gate the return.
  return id;
}

/**
 * Push to anyone who would otherwise miss this message because they're not
 * connected. Currently fires for whispers (always to the recipient) and
 * @mentions (to each mentioned user who has at least one push subscription
 * and no live socket). Always best-effort - failures are logged inside
 * pushToUser, never thrown.
 *
 * Exported so the whisper handler can fire push directly, whispers don't
 * route through `addMessage` (which would broadcast to the whole room),
 * so without an explicit call here offline-recipient push notifications
 * never fire.
 */
export async function pushTriggers(
  io: Io,
  db: Db,
  msg: ChatMessage,
  sender: SessionUser,
  kind: MessageKind,
): Promise<void> {
  try {
    if (kind === "whisper" && msg.toUserId) {
      const targetOnline = await userIsOnline(io, msg.toUserId);
      if (!targetOnline) {
        await pushToUser(db, msg.toUserId, {
          title: `${sender.displayName} whispers`,
          body: "You have a whisper waiting.",
          tag: `whisper-${sender.id}`,
        });
      }
      return;
    }
    // Mention path - skip for system / scene / npc kinds (system has no
    // human author; scene/npc bodies aren't typically directed at anyone).
    if (kind !== "say" && kind !== "me" && kind !== "ooc" && kind !== "announce") return;

    const tokenRefs = msg.mentions ?? [];
    const names = extractMentions(msg.body);
    if (names.length === 0 && tokenRefs.length === 0) return;

    // Push to a resolved target once, gated on offline + not-self + not-already-
    // notified. Shared by the exact token path and the legacy name path so a
    // message can't double-ping someone it mentions two ways.
    const seen = new Set<string>();
    const notify = async (targetUserId: string | null | undefined, disabled: boolean): Promise<void> => {
      if (!targetUserId || disabled || targetUserId === sender.id) return;
      if (seen.has(targetUserId)) return;
      seen.add(targetUserId);
      if (await userIsOnline(io, targetUserId)) return;
      await pushToUser(db, targetUserId, {
        title: `Mention from ${sender.displayName}`,
        body: "You were mentioned in chat.",
        tag: `mention-${sender.id}`,
      });
    };

    // 1. Snapshot (`@id:`/`@cid:`) mentions, the exact identity, resolved at
    // send time, so a spaced or shared name can't misfire. The body was
    // rewritten to `@<name>`, so the legacy pass below would re-find these
    // names; we skip them there to avoid pinging a different identity that
    // happens to share the name.
    const tokenNames = new Set(tokenRefs.map((r) => r.name));
    for (const ref of tokenRefs) {
      const u = (await db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, ref.userId)).limit(1))[0];
      await notify(ref.userId, !u || !!u.disabledAt);
    }

    // 2. Legacy / hand-typed `@name` mentions, resolved by name. Mentions can
    // match either a master username OR an active character name.
    for (const name of names) {
      if (tokenNames.has(name)) continue; // already handled exactly above
      if (name === sender.username.toLowerCase()) continue;
      const lower = name.toLowerCase();
      // Master username first (globally unique).
      let target = (await db
        .select()
        .from(users)
        .where(sql`lower(${users.username}) = ${lower}`)
        .limit(1))[0];
      if (!target) {
        // Active character name lookup.
        const c = (await db
          .select()
          .from(characters)
          .where(sql`lower(${characters.name}) = ${lower}`)
          .limit(1))[0];
        if (c && !c.deletedAt) {
          const owner = (await db.select().from(users).where(eq(users.id, c.userId)).limit(1))[0];
          if (owner && owner.activeCharacterId === c.id) target = owner;
        }
      }
      await notify(target?.id, !!target?.disabledAt);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[push] trigger failed", { err });
  }
}


/**
 * Emit a `message:new` to every socket in the room EXCEPT those whose user
 * shouldn't see the sender, two reasons:
 *   - they have an `ignores` row pointing at the sender (one-way mute), or
 *   - they're in a `blocks` relationship with the sender (mutual, either
 *     direction) , the sender can't see them and they can't see the sender.
 * Looking these up on each send is fine at our scale; both lists are tiny.
 * If this ever becomes hot, cache by senderId with a short TTL.
 *
 * NOTE: System messages still go through `addSystemMessage` which uses a
 * direct `io.to(...).emit` - those should never be filterable by /ignore.
 */
async function emitFiltered(
  io: Io,
  db: Db,
  roomId: string,
  senderUserId: string,
  msg: ChatMessage,
): Promise<void> {
  const ignorerRows = await db
    .select({ userId: ignores.userId })
    .from(ignores)
    .where(eq(ignores.ignoredUserId, senderUserId));
  const blockedWithSender = await blockedUserIdsFor(db, senderUserId);
  if (ignorerRows.length === 0 && blockedWithSender.size === 0) {
    io.to(`room:${roomId}`).emit("message:new", msg);
    return;
  }
  const hide = new Set<string>([...ignorerRows.map((r) => r.userId), ...blockedWithSender]);
  const sockets = await io.in(`room:${roomId}`).fetchSockets();
  for (const s of sockets) {
    const uid = (s.data as { userId?: string }).userId;
    if (uid && hide.has(uid)) continue;
    s.emit("message:new", msg);
  }
}

/** Whisper / OOC keep their own theming; only say + me carry author color. */
function colorForKind(kind: MessageKind, color: string | null): string | null {
  if (color == null) return null;
  // `cmd` kind carries the admin-picked color from the custom command's
  // row (or, when the admin left it null, the sender's chat color
  // flowed through `baseColor` upstream). The earlier allow-list omitted
  // `cmd` and stripped both, so an admin who set `color: theme:system`
  // on `/check` watched their output render as plain `text-keep-text`
  // (white on dark themes) instead of the system color. Now passes
  // through so the wire payload + DB row both keep the snapshotted
  // color and the renderer's `resolveMessageColor` can turn the
  // `theme:<slot>` token into the matching CSS variable.
  if (kind === "say" || kind === "me" || kind === "cmd") return color;
  return null;
}

/**
 * Idle-ghost registry.
 *
 * Socket-level lifecycles don't map cleanly to user-level lifecycles. A user
 * sitting in a room can have their socket transiently drop and reconnect for
 * many reasons that have nothing to do with them logging in or out: tab
 * close + reopen, page refresh, background-throttled tabs, brief network
 * blips, server reload in dev, the socket.io heartbeat misfiring once. With
 * no grace, every blip would yank them out of the userlist + fire
 * "X has disconnected" / "X has connected" pairs, misleading both to the
 * affected user and to onlookers (it looks like they came and went, when
 * actually they were here the whole time).
 *
 * Instead, when a user's last socket disconnects without an explicit Exit
 * click, we keep an "idle ghost" per (room, identity) tuple. `currentOccupants`
 * merges ghosts into its output marked `idle: true` so the userlist still
 * renders the row (faded with an "(idle)" suffix on the client). The
 * disconnect is silent in chat. The ghost's room is held open against
 * `expireIfEmpty` so a private single-user room doesn't archive while its
 * only occupant is just refreshing.
 *
 * Lifetime is per-user, configurable via `site_settings.idleGraceMs`
 * (default 30 minutes). When the timer fires, the sweep clears every ghost
 * the user holds, runs `expireIfEmpty` on the affected rooms, and emits a
 * final `broadcastPresence` so the idle row finally disappears from every
 * viewer's rail. No "X has disconnected." line, silent end-to-end (the
 * opt-in announce happens at the immediate exit-click path, not here).
 *
 * On reconnect (or on the user choosing to log in elsewhere), the
 * `consumePendingDisconnect` path clears ALL of the user's ghosts and
 * rebroadcasts presence to each formerly-ghosted room so the idle row
 * vanishes cleanly. The same call returns true, which `joinRoom` reads as
 * "this is a reconnect, suppress the connected announcement."
 *
 * Why per-identity, not per-user: a user with two tabs voicing two
 * different characters in the same room shows two userlist rows (one per
 * identity). If only one tab closes, only that identity should ghost, the
 * other stays live. Per-identity keys preserve that asymmetry.
 *
 * Why a single timer per user (not per ghost): a user closing three tabs
 * across two rooms in quick succession should get one consolidated sweep
 * at the end of the window, not three sweeps. Each ghost addition resets
 * the user's timer to the configured grace.
 *
 * Memory is bounded by the number of identities currently in their idle
 * window. Entries self-clear via the timer or via the consume path.
 */
export type IdleGhost = {
  userId: string;
  characterId: string | null;
  roomId: string;
  /** Captured at ghost-creation time so callers don't need to re-resolve. Display data on the wire is rebuilt fresh by `currentOccupants` from the live DB row, not from this snapshot. */
  displayName: string;
};
function ghostKey(roomId: string, userId: string, characterId: string | null): string {
  return `${roomId}::${userId}::${characterId ?? ""}`;
}
const idleGhostsByKey = new Map<string, IdleGhost>();
const ghostKeysByUser = new Map<string, Set<string>>();
const ghostTimerByUser = new Map<string, NodeJS.Timeout>();

function trackGhost(g: IdleGhost): void {
  const key = ghostKey(g.roomId, g.userId, g.characterId);
  idleGhostsByKey.set(key, g);
  let keys = ghostKeysByUser.get(g.userId);
  if (!keys) {
    keys = new Set();
    ghostKeysByUser.set(g.userId, keys);
  }
  keys.add(key);
}

/**
 * True iff any ghost is currently held for the given room. Consulted by
 * `expireIfEmpty` so a room with only ghost occupants doesn't get archived
 * out from under them.
 */
export function hasIdleGhostsForRoom(roomId: string): boolean {
  const prefix = `${roomId}::`;
  for (const key of idleGhostsByKey.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Return the ghost identities for the given room. Consumed by
 * `currentOccupants` to merge ghosts into the live-socket presence before
 * the per-row joins run.
 */
export function getIdleGhostsForRoom(roomId: string): Array<{ userId: string; characterId: string | null }> {
  const prefix = `${roomId}::`;
  const out: Array<{ userId: string; characterId: string | null }> = [];
  for (const [key, g] of idleGhostsByKey) {
    if (key.startsWith(prefix)) {
      out.push({ userId: g.userId, characterId: g.characterId });
    }
  }
  return out;
}

/** Dump every idle ghost for the presence snapshot (graceful-shutdown
 *  persistence) so the next boot can re-show the same "(idle)" rows. */
export function exportIdleGhosts(): IdleGhost[] {
  return Array.from(idleGhostsByKey.values());
}

/** Re-register idle ghosts restored from a presence snapshot on boot. Reuses
 *  `registerIdleGhost`, so each re-tracked ghost (re)arms the per-user sweep
 *  timer at `idleGraceMs` from now — a returning user clears it silently via
 *  `consumePendingDisconnect`, a no-show is swept normally. */
export async function importIdleGhosts(db: Db, ghosts: IdleGhost[]): Promise<void> {
  for (const g of ghosts) {
    await registerIdleGhost(db, g);
  }
}

/**
 * Server-boot quiet window. The idle-ghost registry above only survives
 * inside a single process lifetime - any restart (tsx-watch reload in dev,
 * a real Fly deploy in prod) wipes it. Without a boot-grace, every client
 * that reconnects after the restart shows up looking like a fresh connect
 * and we paint a "has connected" line for each one - which is wrong both
 * semantically (they never left, the SERVER left) and visually (a single
 * dev-loop edit can spam dozens of these into the chat).
 *
 * So: for the first BOOT_GRACE_MS after this process starts, we suppress
 * "has connected" announcements entirely. Real fresh connects after the
 * window starts behaving normally. The trade-off in prod is that the very
 * first cohort of reconnects after a deploy aren't announced - which is
 * the desired behavior anyway, since those users were already in the room
 * before the deploy.
 */
const BOOT_GRACE_MS = 30_000;
const BOOT_TIME_MS = Date.now();
function isInBootGrace(): boolean {
  return Date.now() - BOOT_TIME_MS < BOOT_GRACE_MS;
}

/**
 * In-process tracker for "has this user already seen the description
 * for this room?" Joined the codebase to fix the "room description
 * fires every time I come back to the tab on mobile" complaint,
 * the prior implementation only suppressed re-emission during the
 * 20-second reconnect-grace window, so a longer suspension (screen
 * off for 30+ min) lost the marker and the description fired again
 * on the next join.
 *
 * Scope is per-process: keys are `userId`, values are sets of room
 * ids the user has seen the description for during this server's
 * lifetime. A process restart resets the map and users see each
 * room's description once again, acceptable, since restarts are
 * intentional and infrequent. If we ever need durable suppression
 * across restarts we'd promote this to a `user_seen_descriptions`
 * table.
 */
const seenDescriptions = new Map<string, Set<string>>();
function hasSeenDescription(userId: string, roomId: string): boolean {
  return seenDescriptions.get(userId)?.has(roomId) ?? false;
}
function markSeenDescription(userId: string, roomId: string): void {
  let set = seenDescriptions.get(userId);
  if (!set) {
    set = new Set();
    seenDescriptions.set(userId, set);
  }
  set.add(roomId);
}

/**
 * Drop every ghost the user currently holds, cancel their sweep timer, and
 * rebroadcast presence to each formerly-ghosted room so the idle row
 * vanishes from every viewer's rail. Returns true when at least one ghost
 * was cleared, `joinRoom` reads that as the reconnect signal and
 * suppresses the "X has connected." announcement.
 *
 * Awaited inside `joinRoom` before its own broadcast for the room being
 * joined. The double-broadcast for that one room is intentional and cheap:
 * the consume path emits the without-the-user state, then the join path
 * emits the with-the-user state. Net effect on the rail is the user
 * "returning" from idle to live, which is what we want.
 */
export async function consumePendingDisconnect(io: Io, db: Db, userId: string): Promise<boolean> {
  const keys = ghostKeysByUser.get(userId);
  if (!keys || keys.size === 0) {
    // Even with no ghosts, make sure any stray timer is cleared. Belt-and-
    // suspenders, the timer is only ever set alongside ghost entries, so
    // a leftover here would indicate a bookkeeping bug, but the cost of
    // the extra clear is nil.
    const t = ghostTimerByUser.get(userId);
    if (t) {
      clearTimeout(t);
      ghostTimerByUser.delete(userId);
    }
    return false;
  }
  const timer = ghostTimerByUser.get(userId);
  if (timer) {
    clearTimeout(timer);
    ghostTimerByUser.delete(userId);
  }
  const affectedRooms = new Set<string>();
  for (const key of keys) {
    const g = idleGhostsByKey.get(key);
    if (g) affectedRooms.add(g.roomId);
    idleGhostsByKey.delete(key);
  }
  ghostKeysByUser.delete(userId);
  for (const roomId of affectedRooms) {
    // Try to expire the room first, clearing the ghost may have left
    // it empty (no live sockets, no remaining ghosts). Without this,
    // a user-created public room they were the sole occupant of would
    // linger in the rooms tree as a zombie row: the ghost-sweep timer
    // (which would have archived it via expireIfEmpty after the grace
    // window) gets cancelled by this consume path, so the only
    // remaining archive trigger is a fresh occupant explicitly exiting
    // or switching rooms, neither of which is going to happen for an
    // unoccupied room.
    const expired = await expireIfEmpty(io, db, roomId);
    if (!expired) await broadcastPresence(io, db, roomId);
  }
  return true;
}

/**
 * Register a ghost for the given (room, identity) tuple and (re)arm the
 * user's sweep timer at `idleGraceMs`. Called by the disconnect handler
 * when a non-intentional disconnect leaves an identity with no live socket
 * in a room. Each new ghost extends the user's timer, three tabs closing
 * across two rooms get one consolidated sweep at the end, not three.
 *
 * The caller is responsible for the immediate `broadcastPresence` so the
 * idle row appears in onlookers' rails right away. We don't do it here
 * because the caller often has several rooms to ghost in one go and
 * batching the broadcasts (one per room, after all ghosts are tracked)
 * keeps `currentOccupants` from seeing partial state.
 */
export async function registerIdleGhost(
  db: Db,
  ghost: IdleGhost,
): Promise<void> {
  trackGhost(ghost);
  const { idleGraceMs } = await getSettings(db);
  const existing = ghostTimerByUser.get(ghost.userId);
  if (existing) clearTimeout(existing);
  const userId = ghost.userId;
  const timer = setTimeout(() => {
    // Move this into a fire-and-forget async closure, setTimeout can't
    // await directly, and uncaught rejections here would crash the
    // process. The sweep runs the same per-room cleanup the old grace
    // window did (expireIfEmpty + broadcastPresence) so a now-empty
    // room finally archives and the rail finally drops the idle row.
    (async () => {
      const keys = ghostKeysByUser.get(userId);
      ghostTimerByUser.delete(userId);
      if (!keys) return;
      const affectedRooms = new Set<string>();
      for (const key of keys) {
        const g = idleGhostsByKey.get(key);
        if (g) affectedRooms.add(g.roomId);
        idleGhostsByKey.delete(key);
      }
      ghostKeysByUser.delete(userId);
      // Lazy-import io from the ghost record's callback context isn't
      // possible, we need it here. The disconnect handler captures `io`
      // at ghost-creation time via a closure (see index.ts).
      // Instead we accept that this sweep needs io passed in. To keep
      // the public API simple, we stash io on the first ghost call;
      // re-stash on each call so an io rebind (unlikely) is honored.
      const io = sweepIo;
      if (!io) return;
      for (const roomId of affectedRooms) {
        try {
          const expired = await expireIfEmpty(io, db, roomId);
          if (!expired) await broadcastPresence(io, db, roomId);
        } catch { /* swallow, sweep must not crash */ }
      }
      // The user idled out without returning within the grace window, so the
      // transient session signals (away + mood) that the disconnect handler
      // deliberately LEFT in place — so a quick reconnect could keep your
      // /away mark — are finally safe to drop for a clean next-login slate.
      // Guard on still-offline: a sibling tab on another identity may have
      // reconnected while this ghost sat out its window in a different room.
      try {
        if (!(await userIsOnline(io, userId))) {
          clearAllAwayForUser(userId);
          clearAllMoodForUser(userId);
        }
      } catch { /* swallow, sweep must not crash */ }
    })().catch(() => {});
  }, idleGraceMs);
  ghostTimerByUser.set(userId, timer);
}

/**
 * Module-local io handle for the ghost-sweep timer. Set the first time
 * `setGhostSweepIo` is called (during boot wiring). The sweep timer
 * captures io via this reference rather than via per-ghost closure so the
 * `registerIdleGhost` signature stays small.
 */
let sweepIo: Io | null = null;
export function setGhostSweepIo(io: Io): void {
  sweepIo = io;
}

/**
 * Persist + broadcast a server-fired chat line without going through
 * the slash-command dispatcher (no socket, no inline-cmd expansion,
 * no incognito rewrite). Used by the announcement scheduler, which
 * needs `addMessage`-shaped behavior, a real row in `messages`, a
 * filtered emit to the room, color/bodyHtml snapshots on the wire,
 * but doesn't have a `CommandContext`. Skips the award + push
 * pipelines (those are pegged to user activity, not server cronjobs).
 *
 * The `bodyHtml` parameter is the trusted-HTML variant the renderer
 * uses for marquee-quality formatting on scheduled announces; the
 * `body` slot still carries the plain markdown so search /
 * notifications / bookmarks have a readable text snippet.
 */
export async function addMessageDirect(opts: {
  db: Db;
  io: Io;
  roomId: string;
  userId: string;
  displayName: string;
  kind: "announce" | "system";
  body: string;
  bodyHtml?: string | null;
  color?: string | null;
}): Promise<void> {
  const { db, io, roomId, userId, displayName, kind, body, bodyHtml, color } = opts;
  const id = nanoid();
  const now = new Date();
  await db.insert(messages).values({
    id,
    roomId,
    userId,
    characterId: null,
    displayName,
    kind,
    body,
    bodyHtml: bodyHtml ?? null,
    color: color ?? null,
  });
  const wire: ChatMessage = {
    id,
    roomId,
    userId,
    characterId: null,
    displayName,
    kind,
    body,
    color: color ?? null,
    createdAt: +now,
    ...(bodyHtml ? { bodyHtml } : {}),
  };
  io.to(`room:${roomId}`).emit("message:new", wire);
}

/** Server-authored system message (no associated user/character). */
export async function addSystemMessage(
  io: Io,
  db: Db,
  roomId: string,
  body: string,
): Promise<void> {
  const id = nanoid();
  const now = new Date();
  // System messages still need a userId column NOT NULL; we use the room owner
  // or a synthetic system user. For simplicity we attribute to the system
  // sentinel user 'system' which we ensure exists at boot.
  const sysUser = (await db.select().from(users).where(eq(users.username, "system")).limit(1))[0];
  if (!sysUser) return;
  await db.insert(messages).values({
    id,
    roomId,
    userId: sysUser.id,
    characterId: null,
    displayName: "system",
    kind: "system",
    body,
  });
  io.to(`room:${roomId}`).emit("message:new", {
    id,
    roomId,
    userId: sysUser.id,
    characterId: null,
    displayName: "system",
    kind: "system",
    body,
    createdAt: +now,
  });
}

/**
 * Resolve the canonical landing room. Used by every "where do we put this
 * user" path: cold-connect with no sibling tab and no last-room memory,
 * kick / ban relocation, and admin room-delete.
 *
 * Resolution order:
 *   1. The admin-flagged default room (rooms.is_default = 1). Exactly one
 *      row carries the flag thanks to the partial unique index. This is
 *      the source of truth on any post-migration install.
 *   2. Legacy fallback by name (`The_Spire`) for installs that haven't
 *      yet flipped the flag, the seed migrates them on next boot, but
 *      this guards the gap.
 *   3. The alphabetically-first system room as a last resort so a
 *      malformed install (no default, no Spire) still lands users
 *      somewhere deterministic instead of SQLite's natural row order.
 */
export async function findCanonicalLanding(db: Db): Promise<typeof rooms.$inferSelect | null> {
  const defaulted = (await db.select().from(rooms).where(eq(rooms.isDefault, true)).limit(1))[0];
  if (defaulted) return defaulted;
  const named = (await db.select().from(rooms).where(eq(rooms.name, "The_Spire")).limit(1))[0];
  if (named) return named;
  const fallback = (await db
    .select()
    .from(rooms)
    .where(eq(rooms.isSystem, true))
    .orderBy(asc(rooms.name))
    .limit(1))[0];
  return fallback ?? null;
}

/**
 * Send the per-viewer-filtered recent backlog for `roomId` to a single
 * socket. Mirrors the slice joinRoom assembles on a fresh join: ignored
 * authors are dropped, whispers are visible only to sender/recipient,
 * deleted bodies are blanked. Extracted so the moderation-relocate path
 * (kick / ban / admin room-delete) can land the booted socket on a
 * properly-populated chat log instead of leaving it stuck on the room
 * they were just removed from.
 *
 * Accepts a structural type so it works with both `Socket` (from event
 * handlers) and `RemoteSocket` (from `io.fetchSockets()`).
 */
export async function sendRoomBacklogTo(
  socket: {
    emit(event: "message:bulk", payload: ChatMessage[]): unknown;
    emit(event: "room:history_meta", payload: { roomId: string; hasMore: boolean }): unknown;
  },
  db: Db,
  roomId: string,
  viewerUserId: string,
): Promise<void> {
  // Authors the viewer must not see in scrollback: their one-way /ignore list
  // PLUS everyone they're mutually blocked with (either direction).
  const ignoredIds = new Set(
    (await db
      .select({ ignoredUserId: ignores.ignoredUserId })
      .from(ignores)
      .where(eq(ignores.userId, viewerUserId))).map((r) => r.ignoredUserId),
  );
  for (const blockedId of await blockedUserIdsFor(db, viewerUserId)) ignoredIds.add(blockedId);
  // Look the viewer's role up once so the originalBody carve-out below
  // is consistent with the per-socket gating used by the live
  // delete-broadcast path. Single row lookup; cheap relative to the
  // 50-row messages SELECT it rides alongside. Gates on the granular
  // `view_deleted_message_body` key so the matrix can hand the carve-
  // out to a mod tier without minting them as a full admin.
  const viewerRow = (await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, viewerUserId))
    .limit(1))[0];
  const viewerIsAdmin = viewerRow
    ? await (await import("../auth/permissions.js")).hasPermission(
        { id: viewerUserId, role: viewerRow.role },
        "view_deleted_message_body",
        db,
      )
    : false;
  // Overfetch by 1 so we can detect "older messages exist" reliably
  // without a separate COUNT query. The 51st row is dropped from the
  // returned backlog (which the client renders as the top of its
  // history); its mere existence flags hasMore=true. Without this,
  // a viewer in a busy room can receive fewer than 50 visible
  // messages after the ignored-user + whisper filters below, and the
  // client would incorrectly conclude there's no older history left.
  const BACKLOG_LIMIT = 50;
  // Whispers are cross-room from the viewer's POV: a whisper the viewer
  // is a party to overlays into ANY room they scroll back, at its
  // original timestamp. So the WHERE here unions "non-whisper rows from
  // this room" with "whisper rows the viewer is a party to from
  // anywhere." The wire roomId is rewritten below so the client buckets
  // them under the room being loaded.
  // Per-viewer `/clear` marker: hide everything at or before the time
  // this user last cleared the room. Null when they never cleared.
  const clearedAt = await getClearedAt(db, viewerUserId, roomId);
  const recentPlusOne = await db
    .select()
    .from(messages)
    .where(and(
      roomVisibilityWhere(roomId, viewerUserId),
      clearedAt ? gt(messages.createdAt, clearedAt) : undefined,
    ))
    .orderBy(desc(messages.createdAt))
    .limit(BACKLOG_LIMIT + 1);
  const hasMoreOlder = recentPlusOne.length > BACKLOG_LIMIT;
  const recent = hasMoreOlder ? recentPlusOne.slice(0, BACKLOG_LIMIT) : recentPlusOne;
  const backlog: ChatMessage[] = recent
    .filter((m) => !ignoredIds.has(m.userId))
    .reverse()
    .map((m) => ({
      id: m.id,
      // Rewrite whisper roomId to the room being loaded so the client
      // appends to the right bucket. Non-whispers already match.
      roomId: m.kind === "whisper" ? roomId : m.roomId,
      userId: m.userId,
      characterId: m.characterId,
      displayName: m.displayName,
      kind: m.kind,
      body: m.deletedAt ? "" : m.body,
      color: m.color,
      createdAt: +m.createdAt,
      ...(m.toUserId ? { toUserId: m.toUserId } : {}),
      ...(m.toCharacterId ? { toCharacterId: m.toCharacterId } : {}),
      ...(m.toDisplayName ? { toDisplayName: m.toDisplayName } : {}),
      ...(m.replyToId ? { replyToId: m.replyToId } : {}),
      ...(m.replyToDisplayName ? { replyToDisplayName: m.replyToDisplayName } : {}),
      ...(m.replyToBodySnippet ? { replyToBodySnippet: m.replyToBodySnippet } : {}),
      ...(m.moodSnapshot ? { moodSnapshot: m.moodSnapshot } : {}),
      ...(m.npcVoicedBy ? { npcVoicedBy: m.npcVoicedBy } : {}),
      ...(m.threadCategoryId ? { threadCategoryId: m.threadCategoryId } : {}),
      ...(m.title ? { title: m.title } : {}),
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
      ...(m.editedAt ? { editedAt: +m.editedAt } : {}),
      ...(m.deletedAt ? { deletedAt: +m.deletedAt } : {}),
      ...(m.lockedAt ? { lockedAt: +m.lockedAt } : {}),
      ...(m.lastActivityAt ? { lastActivityAt: +m.lastActivityAt } : {}),
      ...(m.isSticky ? { isSticky: true } : {}),
      ...(m.cmdCss ? { cmdCss: m.cmdCss } : {}),
      ...((() => { const lp = linkPreviewFromRow(m.linkPreviewJson); return lp ? { linkPreview: lp } : {}; })()),
      ...(m.sceneImageUrl ? { sceneImageUrl: m.sceneImageUrl } : {}),
      ...(m.bodyHtml ? { bodyHtml: m.bodyHtml } : {}),
      ...(m.rankKey ? { rankKey: m.rankKey } : {}),
      ...(m.tier != null ? { tier: m.tier } : {}),
      ...(m.senderInlineAvatarEnabled ? { senderInlineAvatarEnabled: true } : {}),
      ...(m.senderSelectedBorderRankKey ? { senderSelectedBorderRankKey: m.senderSelectedBorderRankKey } : {}),
      ...mentionsField(m.mentionsJson),
      // Admin-only audit field. Mirrors the per-socket gating in the
      // delete route + the history endpoints: site admins receive the
      // original body of a deleted message; everyone else gets the
      // bare placeholder.
      ...(viewerIsAdmin && m.deletedAt ? { originalBody: m.body } : {}),
      // Admin-only snapshot of who performed the delete. See toWire in
      // routes/messages.ts for the same shape, both paths must stay
      // in sync or admins see audit info live but not in backlog.
      ...(viewerIsAdmin && m.deletedAt && m.deletedByUserId
        ? { deletedByUserId: m.deletedByUserId }
        : {}),
      ...(viewerIsAdmin && m.deletedAt && m.deletedByDisplayName
        ? { deletedByDisplayName: m.deletedByDisplayName }
        : {}),
    }));
  // Embed reactions inline so the ReactionBar renders without a
  // per-row fetch. Single batched query keyed on the backlog's
  // message ids; messages with zero reactions just don't get the
  // field (keeps the wire compact).
  if (backlog.length > 0) {
    const reactionMap = await loadReactionsForTargets(
      db,
      "chat_message",
      backlog.map((m) => m.id),
      viewerUserId,
    );
    for (const m of backlog) {
      const r = reactionMap.get(m.id);
      if (r && r.length > 0) m.reactions = r;
    }
  }
  // Hydrate poll state per-viewer (definition + tallies + this viewer's
  // ballot) so the PollCard renders correct results on join without a
  // follow-up fetch. Voter identities are included only when showVoters.
  const pollJsonById = new Map(recent.filter((m) => m.kind === "poll").map((m) => [m.id, m.pollDataJson]));
  for (const m of backlog) {
    if (m.kind !== "poll") continue;
    const state = await loadPollState(db, m.id, viewerUserId, pollJsonById.get(m.id) ?? null);
    if (state) m.poll = state;
  }
  socket.emit("message:bulk", backlog);
  // Authoritative "older messages exist" signal for the scroll-up
  // paginator. Computed from the DB-level query length (51) so it
  // ignores per-viewer filtering, the load-older endpoint will
  // apply the same filter again when the user actually scrolls up.
  socket.emit("room:history_meta", { roomId, hasMore: hasMoreOlder });
}

/**
 * Per-socket joinRoom serialization queue. socket.io's per-socket
 * event dispatch processes events in order, but it does NOT wait for
 * async handlers to finish before dispatching the next event. The
 * room:join handler is async and contains many awaits (auth checks,
 * membership lookups, presence-template fetches, broadcastPresence
 * calls). Without this lock, two rapid room:join events from the
 * same socket interleave: handler A captures priorRooms = [The_Spire]
 * and calls socket.leave; while A yields on the next await, handler
 * B captures priorRooms = [] (A already left), skips the leave loop,
 * and socket.joins its target. A then resumes and socket.joins ITS
 * target. The socket ends up in both target rooms, the userlist shows
 * the user in both rooms, and the per-room join/leave broadcasts go
 * to the wrong rooms.
 *
 * The fix is a per-socket promise chain: each new joinRoom awaits the
 * previous one's completion before starting its own work. socket.io
 * already wraps each socket with a unique object, so a WeakMap keyed
 * on the socket gives us per-socket isolation that cleans up
 * automatically on disconnect.
 */
const joinRoomQueue = new WeakMap<Sock, Promise<void>>();

export async function joinRoom(
  io: Io,
  db: Db,
  socket: Sock,
  user: SessionUser,
  roomId: string,
  opts: { passwordOk?: boolean } = {},
): Promise<void> {
  // Chain this call onto the socket's queue. The queued promise
  // resolves AFTER the previous joinRoom finishes (or after a
  // resolved promise if there's no in-flight one). We then await
  // the chain head before doing any work. The new promise we store
  // back into the WeakMap covers BOTH waiting for the previous one
  // AND running our own body, so the NEXT call's await sees the
  // tail of our work and not the head.
  const prev = joinRoomQueue.get(socket) ?? Promise.resolve();
  let release: () => void = () => {};
  const ours = new Promise<void>((res) => { release = res; });
  joinRoomQueue.set(socket, prev.then(() => ours));
  try {
    await prev;
    await joinRoomBody(io, db, socket, user, roomId, opts);
  } finally {
    release();
  }
}

async function joinRoomBody(
  io: Io,
  db: Db,
  socket: Sock,
  user: SessionUser,
  roomId: string,
  opts: { passwordOk?: boolean } = {},
): Promise<void> {
  const room = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room) {
    socket.emit("error:notice", { code: "NO_ROOM", message: "Room not found." });
    return;
  }
  if (room.archivedAt) {
    // Stale id from before the room auto-archived. The room is
    // effectively gone to end users; the row only exists to preserve
    // settings for a future same-name resurrect via the create path.
    // Treat as 404 for this socket.
    socket.emit("error:notice", { code: "NO_ROOM", message: "Room not found." });
    return;
  }

  // Forum boards live ENTIRELY in the Forums Catalog (Forums revamp,
  // Phase 1C): reading and posting happen in the modal over HTTP +
  // forum:post, never by occupying the room. Chat joins are therefore
  // refused outright — for everyone — so a board can never appear as
  // someone's "current room", leak into presence, or pull forum
  // interactions back into chat. Legacy sessions whose lastRoomId is a
  // board fall through to the canonical landing on reconnect.
  if (room.forumId) {
    socket.emit("error:notice", {
      code: "FORUM_BOARD",
      message: "That's a forum board - it lives in the Forums Catalog. Type /forums to open it.",
    });
    return;
  }

  const banned = (await db
    .select()
    .from(bans)
    .where(and(eq(bans.roomId, roomId), eq(bans.userId, user.id)))
    .limit(1))[0];
  if (banned && (!banned.until || +banned.until > Date.now())) {
    socket.emit("error:notice", { code: "BANNED", message: "You are banished from this room." });
    return;
  }

  // Private rooms: owner always in; otherwise need either a valid password OR
  // an outstanding /invite. /invite acts as a per-user whitelist that lets the
  // user skip the password prompt.
  if (room.type === "private" && room.ownerId !== user.id) {
    const invite = opts.passwordOk
      ? null
      : (await db
          .select()
          .from(roomInvites)
          .where(
            and(eq(roomInvites.roomId, roomId), eq(roomInvites.invitedUserId, user.id)),
          )
          .limit(1))[0];
    const member = (await db
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, user.id)))
      .limit(1))[0];
    const allowed = opts.passwordOk || !!invite || !!member;
    if (!allowed) {
      socket.emit("ui:hint", {
        kind: "prompt-room-password",
        roomId: room.id,
        roomName: room.name,
      });
      return;
    }
  }

  // Upsert membership (best-effort). SQLite/Drizzle: use onConflictDoNothing.
  await db
    .insert(roomMembers)
    .values({ roomId, userId: user.id, role: "member" })
    .onConflictDoNothing();

  // Capture state BEFORE we mutate socket.rooms so we can tell:
  //   1. whether this is a fresh connect (no prior live socket of this user
  //      anywhere) - drives "X has connected" vs "X arrived";
  //   2. which rooms this socket is leaving - drives "X left." in each.
  const userWasOnlineBefore = await userIsOnline(io, user.id, socket.id);

  // Resolve the per-identity room-presence templates ONCE per join.
  // Character-active rooms read the character's OWN templates only;
  // OOC (no active character) reads the master's. We deliberately do
  // NOT fall back character -> master: the custom entrance/exit flair
  // is bought per identity, so an OOC-purchased template must never
  // leak onto a character that never bought (or enabled) one. Null on
  // the chosen source = use the default phrasing. The session-presence
  // templates are master-only.
  // Reads are bounded, one row from each table the user touches.
  const presenceMaster = (await db
    .select({
      roomJoinTemplate: userEarning.roomJoinTemplate,
      roomLeaveTemplate: userEarning.roomLeaveTemplate,
      sessionConnectTemplate: userEarning.sessionConnectTemplate,
    })
    .from(userEarning)
    .where(eq(userEarning.userId, user.id))
    .limit(1))[0] ?? null;
  const presenceCharacter = user.activeCharacterId
    ? (await db
        .select({
          roomJoinTemplate: characterEarning.roomJoinTemplate,
          roomLeaveTemplate: characterEarning.roomLeaveTemplate,
        })
        .from(characterEarning)
        .where(eq(characterEarning.characterId, user.activeCharacterId))
        .limit(1))[0] ?? null
    : null;
  // `presenceCharacter` is non-null only when a character is active, so
  // its presence is the in-character signal. When OOC it's null and we
  // fall through to the master row; when in-character we use ONLY the
  // character's columns (null -> default), never the master's.
  const roomJoinTemplate = user.activeCharacterId
    ? (presenceCharacter?.roomJoinTemplate ?? null)
    : (presenceMaster?.roomJoinTemplate ?? null);
  const roomLeaveTemplate = user.activeCharacterId
    ? (presenceCharacter?.roomLeaveTemplate ?? null)
    : (presenceMaster?.roomLeaveTemplate ?? null);
  const sessionConnectTemplate = presenceMaster?.sessionConnectTemplate ?? null;
  // Reconnect detection: if a "has disconnected" was scheduled for this user
  // and hasn't fired yet, this connect is a reconnect inside the grace window.
  // Sweep any idle ghosts the user was holding. Returns true when at
  // least one was cleared, we read that as "this is a reconnect inside
  // the idle window" and use it further down to suppress the "X has
  // connected." message + the room description re-emit. The same call
  // also rebroadcasts presence to each formerly-ghosted room so onlookers
  // see the idle row vanish (the current-room re-broadcast a few lines
  // later overlays the live state on top of it for THIS room).
  const isReconnect = await consumePendingDisconnect(io, db, user.id);
  const priorRooms = [...socket.rooms]
    .filter((r) => r.startsWith("room:") && r !== `room:${roomId}`)
    .map((r) => r.slice(5));

  // Drop the user from any previous room before joining the new one.
  // Per-room "X has left the room." chat broadcasts fire on real
  // room switches, but ONLY when no OTHER socket of this account
  // remains in the room being left, `userHasSocketInRoom` is the
  // multi-tab gate. If the user has another tab still parked in
  // the old room (desktop tab stays put while phone tab moves;
  // second browser window) the move from THIS socket isn't a real
  // "departure" and we stay silent; userlist update via
  // `broadcastPresence` is the visible signal regardless. Boot
  // grace and forum rooms suppress the broadcast. Note we do NOT
  // gate on `isReconnect` here: a real room switch always comes
  // through the explicit room:join event on a live socket, so
  // `consumePendingDisconnect` having found stale ghosts elsewhere
  // (a tab the user closed minutes ago in a different room)
  // shouldn't mute the current move. Same rationale for the entry
  // broadcast below.
  for (const prevId of priorRooms) {
    socket.leave(`room:${prevId}`);
    const expired = await expireIfEmpty(io, db, prevId);
    if (expired) continue;
    await broadcastPresence(io, db, prevId);
    const stillThere = await userHasSocketInRoom(io, user.id, prevId);
    if (stillThere || isInBootGrace()) continue;
    // Incognito gate: room transitions stay silent for an incognito
    // moderator, the whole point is they can drift across rooms
    // without trace. Their "X has left the chat" line already
    // broadcast at the moment they went incognito.
    if (user.incognitoMode) continue;
    const prevRoom = (await db.select().from(rooms).where(eq(rooms.id, prevId)).limit(1))[0];
    if (!prevRoom || prevRoom.replyMode === "nested") continue;
    await addSystemMessage(io, db, prevId, renderPresenceTemplate(
      roomLeaveTemplate,
      DEFAULT_PRESENCE_TEMPLATES.roomLeave,
      { name: user.displayName, room: prevRoom.name },
    ));
  }

  socket.join(`room:${roomId}`);

  socket.data.roomId = roomId;
  // Persist as the account-global last-room slot on EVERY join, not
  // just on the disconnect path. Mobile suspension can lose the per-
  // tab sessionStorage cache (iOS reaping the tab from memory wipes
  // it), and the disconnect-side write is only made on
  // `fullyOffline=true`, so a stale sibling socket anywhere (a
  // forgotten desktop tab, a second phone tab) would have caused the
  // mobile disconnect to skip the lastRoomId write, leaving the DB
  // pointing at whatever room the user logged in to days ago. Writing
  // here is idempotent (UPDATE to the same value when unchanged) and
  // cheap (one row, indexed PK). Mirrors the per-tab cache update the
  // client already does via `rememberTabRoom` on `room:state`.
  await db.update(users).set({ lastRoomId: roomId }).where(eq(users.id, user.id));
  await broadcastRoomState(io, db, roomId);
  await broadcastPresence(io, db, roomId);

  // Send recent backlog to just this socket. Whisper privacy + ignore
  // filtering + soft-delete blanking all live in sendRoomBacklogTo so the
  // moderation-relocate path uses the same logic.
  //
  // The arrival announcement is emitted AFTER the backlog so the joining
  // socket doesn't see it twice (once in backlog, once via room broadcast).
  await sendRoomBacklogTo(socket, db, roomId, user.id);

  // Theater rooms: snap this socket to the room's live playback state so
  // a late joiner lands on the current source + position rather than the
  // playlist's first frame. No-op when nothing has played yet.
  {
    const tp = theaterSyncPayload(roomId);
    if (tp) socket.emit("theater:sync", tp);
  }

  // Room description: fire ONCE per (user, room) over the lifetime of
  // this process. Previously we only suppressed on reconnect-inside-
  // grace, so a long mobile suspension (screen off past the 20s grace)
  // dropped the marker and the description re-fired on the next
  // joinRoom. The `seenDescriptions` map persists across reconnects
  // for the life of the server, so a returning mobile tab now only
  // sees the description on its *original* entry.
  //
  // Forum rooms still skip the description entirely, the topic feed
  // isn't a chat log, and other UI affordances surface the description
  // there.
  if (room.description && !hasSeenDescription(user.id, roomId) && room.replyMode !== "nested") {
    markSeenDescription(user.id, roomId);
    // Persist a per-user copy so the line survives a buffer-replacing
    // refetch. `isNew` is true only on the genuinely first view; on a
    // process restart the in-memory seen-set resets but the persisted
    // copy already rides the backlog (sent just above), so we must NOT
    // re-emit the live line then or the user sees it twice.
    const isNew = await persistRoomDescriptionOnce(db, user.id, roomId, `[Description]: ${room.description}`);
    if (isNew) {
      socket.emit("message:new", {
        id: `desc-${nanoid()}`,
        roomId,
        userId: "system",
        characterId: null,
        displayName: "system",
        kind: "system",
        body: `[Description]: ${room.description}`,
        color: null,
        createdAt: Date.now(),
      });
    }
  }

  // Entry/connect chat broadcast. Three mutually-exclusive cases,
  // distinguished by `loginIntent` (fresh login/register handshake)
  // and `priorRooms.length` (was this socket already in another
  // chat room before this join, i.e. a real room switch):
  //
  //   loginIntent && priorRooms.length === 0  → "X has connected."
  //     The handshake just finished, this is the user's first room
  //     of the session. `isReconnect` gates this off because
  //     mobile suspend → wake re-runs the handshake and we don't
  //     want to spam "connected" every time the screen turns back
  //     on.
  //   priorRooms.length > 0                   → "X has entered the room."
  //     Same socket moved A → B via the room:join event; pair with
  //     the "X has left the room." departure broadcast emitted in
  //     the leave loop above. NOT gated on `isReconnect`, a real
  //     room switch is an explicit action on a live socket, and
  //     `consumePendingDisconnect` may have legitimately swept
  //     ghosts from a tab the user closed in some OTHER room.
  //     That shouldn't mute this tab's announce.
  //   Anything else (reconnect after suspend, page reload, network
  //   blip, watchers reattaching)            → silent.
  //
  // Both announce paths share the multi-tab gate via
  // `userHasSocketInRoom`: if another tab of this account is
  // already in the destination, we suppress the broadcast (account
  // is "already here" from the room's perspective, even though
  // THIS socket just arrived). The userlist update via
  // `broadcastPresence` above is the visible signal regardless.
  // Boot grace and forum rooms suppress both paths.
  const loginIntent =
    (socket.data as { loginIntent?: boolean }).loginIntent === true;
  // Gate "X has connected / entered" on the IDENTITY tuple, not the raw
  // userId. A user can be live on desktop as Character A and then log
  // in on mobile as Character B, that's two distinct identities even
  // though it's one user, and the room should learn about Character B
  // arriving. The legacy user-only check (userHasSocketInRoom)
  // silenced the mobile broadcast in that case because "the user was
  // already here," masking the per-character join from observers.
  //
  // Resolve the socket's current characterId the same way the
  // userlist render path does: a per-tab `tabCharId` set by `/char`
  // wins; otherwise fall back to the user's master-row default.
  // `undefined` only happens on a socket that hasn't issued any
  // /char yet, which still resolves to the DB default, never null
  // by accident.
  const tabCharRaw = (socket.data as { tabCharId?: string | null }).tabCharId;
  const socketCharacterId: string | null =
    tabCharRaw !== undefined ? tabCharRaw : (user.activeCharacterId ?? null);
  const otherIdentitySocketHere = await userIdentityHasSocketInRoom(
    io,
    user.id,
    socketCharacterId,
    roomId,
    socket.id,
  );
  // The user-scoped check is still useful for the watcher-ping branch
  // further down: watchers care about the user coming online, not
  // about which character they happen to be voicing.
  const otherSocketHere = await userHasSocketInRoom(io, user.id, roomId, socket.id);
  const isForumRoom = room.replyMode === "nested";
  const isRoomSwitch = priorRooms.length > 0;
  // Incognito gate folds into baseGate: ANY enter/connect broadcast
  // is suppressed while the user is in incognito mode. Pair with the
  // suppress on the leave path above so the moderator can hop rooms
  // entirely silently.
  const baseGate = !otherIdentitySocketHere && !isInBootGrace() && !isForumRoom && !user.incognitoMode;
  if (loginIntent && !isRoomSwitch && baseGate && !isReconnect) {
    await addSystemMessage(io, db, roomId, renderPresenceTemplate(
      sessionConnectTemplate,
      DEFAULT_PRESENCE_TEMPLATES.sessionConnect,
      { name: user.displayName, room: room.name },
    ));
  } else if (isRoomSwitch && baseGate) {
    await addSystemMessage(io, db, roomId, renderPresenceTemplate(
      roomJoinTemplate,
      DEFAULT_PRESENCE_TEMPLATES.roomJoin,
      { name: user.displayName, room: room.name },
    ));
  }
  // Consume the loginIntent flag after the first room of the session
  // has been announced. Without this, any subsequent joinRoom on the
  // same socket whose priorRooms snapshot looks empty (e.g. a queued
  // re-join after a transient network event) would re-evaluate the
  // first branch and emit a duplicate "X has connected." line.
  (socket.data as { loginIntent?: boolean }).loginIntent = false;
  if (!otherSocketHere && !isReconnect && !userWasOnlineBefore && !isRoomSwitch) {
    // Watcher pings: still relevant in forum rooms, they're per-user
    // notifications, not room broadcasts. Fire whenever this is a
    // true online transition regardless of room type. Decoupled from
    // the chat broadcast, a watcher should still get pinged when
    // their friend reconnects after a mobile suspend, even though
    // the chat itself stays silent.
    //
    // `!isRoomSwitch` is load-bearing here. `userWasOnlineBefore`
    // alone is NOT a sufficient gate, `userIsOnline` excludes the
    // current socket so a single-tab user moving room A → room B
    // sees their only socket excluded from the check and the
    // function returns false, even though the user is plainly
    // already online. Without this gate, watchers received a
    // spurious "Wallace is online" toast (which `App.tsx` paints
    // into the watcher's CURRENT room as `☆ Wallace is online.`)
    // immediately AFTER the user's "has left the room." broadcast.
    // The room-switch path is not an online transition.
    //
    // Pass the identity this socket is voicing so watchers are only pinged
    // for the exact handle they friended, not every character on the
    // account. `socketCharacterId` was resolved above the same way the
    // userlist render path does (per-tab /char wins, else master default).
    await pingWatchers(io, db, user, socketCharacterId);
  }
}

/**
 * True iff the user has at least one live socket in the given room.
 * `excludeSocketId` skips the named socket - used at join time so the
 * caller's freshly-joined socket doesn't count as a "prior" presence.
 */
export async function userHasSocketInRoom(
  io: Io,
  userId: string,
  roomId: string,
  excludeSocketId?: string,
): Promise<boolean> {
  const sockets = await io.in(`room:${roomId}`).fetchSockets();
  for (const s of sockets) {
    if (excludeSocketId && s.id === excludeSocketId) continue;
    if ((s.data as { userId?: string }).userId === userId) return true;
  }
  return false;
}

/**
 * True iff the user has at least one live socket voicing the given
 * `characterId` in the given room. Used by the disconnect handler to
 * decide whether the just-disconnected identity needs an idle ghost or
 * whether a sibling tab is still carrying the same identity. `null`
 * characterId means "OOC" (the user's master identity).
 *
 * Resolution mirrors `currentOccupants`: tabCharId === undefined falls
 * back to the user's DB-default activeCharacterId, but we don't have
 * the user row here, so the caller is responsible for resolving
 * `undefined` to a concrete characterId before calling. (The disconnect
 * handler does this via the SessionUser it holds.)
 */
export async function userIdentityHasSocketInRoom(
  io: Io,
  userId: string,
  characterId: string | null,
  roomId: string,
  excludeSocketId?: string,
): Promise<boolean> {
  const sockets = await io.in(`room:${roomId}`).fetchSockets();
  for (const s of sockets) {
    if (excludeSocketId && s.id === excludeSocketId) continue;
    if ((s.data as { userId?: string }).userId !== userId) continue;
    const raw = (s.data as { tabCharId?: string | null }).tabCharId;
    // `undefined` over the wire means "no per-tab override." For matching
    // purposes we can't resolve it without the user row, so we conservatively
    // treat it as a non-match against an explicit characterId. The
    // disconnect handler that calls this always passes the resolved
    // characterId; sibling sockets that haven't issued /char will read
    // as `undefined` here. To avoid leaking that ambiguity, fall back
    // to "any sibling socket of this user counts as the identity still
    // being live for the master/OOC case", same conservatism we used
    // before per-tab routing existed. If you ever see a regression where
    // an idle ghost lingers despite a sibling tab, this is the place
    // to thread a userById lookup through.
    if (raw === undefined) {
      if (characterId === null) return true;
      continue;
    }
    if (raw === characterId) return true;
  }
  return false;
}

/**
 * True iff the user has at least one live socket anywhere on the io server.
 * Used to distinguish "first connect" from "another tab" when announcing
 * arrivals.
 */
export async function userIsOnline(
  io: Io,
  userId: string,
  excludeSocketId?: string,
): Promise<boolean> {
  const sockets = await io.fetchSockets();
  for (const s of sockets) {
    if (excludeSocketId && s.id === excludeSocketId) continue;
    if ((s.data as { userId?: string }).userId === userId) return true;
  }
  return false;
}

/**
 * Single source of truth for the wire-shape of a room. Used by every
 * surface that emits a RoomSummary (the websocket broadcasts AND the
 * `GET /rooms` HTTP route) so the optional `linkedWorld`/`npcDisabled`/
 * `messageExpiryMinutes`/`replyMode` fields always land populated. When
 * /rooms used to construct its own summary inline, those fields were
 * silently undefined, which broke the rail's primary-world grouping.
 */
export async function buildRoomSummary(
  db: Db,
  room: typeof rooms.$inferSelect,
): Promise<RoomSummary> {
  const memberCountRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(roomMembers)
    .where(eq(roomMembers.roomId, room.id));
  return {
    id: room.id,
    name: room.name,
    type: room.type,
    topic: room.topic,
    ownerId: room.ownerId,
    memberCount: memberCountRows[0]?.n ?? 0,
    npcDisabled: room.npcDisabled,
    linkedWorld: await loadLinkedWorld(db, room.id),
    messageExpiryMinutes: room.messageExpiryMinutes,
    replyMode: room.replyMode,
    theaterMode: room.theaterMode,
    theaterLoop: room.theaterLoop,
    theaterPlaylist: parsePlaylist(room.theaterPlaylist),
    forumId: room.forumId ?? null,
  };
}

/**
 * Push the room's LIVE theater playback state to every socket in the
 * room. Called after a controller action mutates `theaterState`. No-op
 * when there is no live state yet (nothing has played) - in that case
 * clients just sit on the playlist's first source, paused at 0.
 */
export async function broadcastTheaterSync(io: Io, roomId: string): Promise<void> {
  const payload = theaterSyncPayload(roomId);
  if (!payload) return;
  io.to(`room:${roomId}`).emit("theater:sync", payload);
}

/**
 * Persist the room's current (extrapolated) theater playback into
 * `rooms.theater_playback` so a restart can resume near where viewers
 * were. Writes NULL when there's no live state (theater off / nothing
 * played). Called on each control change and by the periodic sweep -
 * never per playback tick.
 */
export async function persistTheaterCheckpoint(db: Db, roomId: string): Promise<void> {
  const cp = checkpointFor(roomId, Date.now());
  await db
    .update(rooms)
    .set({ theaterPlayback: cp ? serializeCheckpoint(cp) : null })
    .where(eq(rooms.id, roomId));
}

/**
 * Periodic sweep: re-checkpoint every room that's actively PLAYING so
 * its persisted position stays fresh (within one sweep interval) while
 * a long video runs without any control events. Paused rooms were
 * already checkpointed at the moment they paused, so they're skipped.
 */
export async function checkpointPlayingTheaters(db: Db): Promise<void> {
  for (const roomId of theaterRoomIds()) {
    if (getTheater(roomId)?.isPlaying) {
      await persistTheaterCheckpoint(db, roomId);
    }
  }
}

/**
 * Boot rehydration: load persisted checkpoints for every theater-mode
 * room back into the in-memory map so reconnecting clients resync to the
 * resumed position. `hydrate` re-anchors the clock to now, treating the
 * downtime as a pause. Returns how many rooms were restored.
 */
export async function hydrateTheaterFromDb(db: Db): Promise<number> {
  const rows = await db
    .select({ id: rooms.id, theaterPlayback: rooms.theaterPlayback })
    .from(rooms)
    .where(and(eq(rooms.theaterMode, true), isNotNull(rooms.theaterPlayback)));
  const now = Date.now();
  let restored = 0;
  for (const r of rows) {
    const cp = parseCheckpoint(r.theaterPlayback);
    if (cp) {
      hydrateTheater(r.id, cp, now);
      restored += 1;
    }
  }
  return restored;
}

/**
 * Build the mutual-block graph for everyone relevant to a room's userlist:
 * the occupants plus the sockets parked in the room (viewers). Returns the
 * room sockets (reused by the caller to emit) and the graph. An empty graph
 * (`.size === 0`) means no two of them are blocked, so the caller can take the
 * single room-wide emit fast path instead of fanning out per-socket.
 */
async function roomBlockGraph(
  io: Io,
  db: Db,
  roomId: string,
  occupants: RoomOccupant[],
): Promise<{ sockets: Awaited<ReturnType<Io["fetchSockets"]>>; blockGraph: Map<string, Set<string>> }> {
  const sockets = await io.in(`room:${roomId}`).fetchSockets();
  const ids = new Set<string>(occupants.map((o) => o.userId));
  for (const s of sockets) {
    const uid = (s.data as { userId?: string }).userId;
    if (uid) ids.add(uid);
  }
  const blockGraph = await blocksAmong(db, [...ids]);
  return { sockets, blockGraph };
}

/** The occupant list a given viewer should see: occupants they're blocked
 *  with removed. Blocks are symmetric, so this also keeps each blocked pair
 *  out of the OTHER's list when applied per-viewer. */
function occupantsForViewer(
  occupants: RoomOccupant[],
  blockGraph: Map<string, Set<string>>,
  viewerUserId: string | undefined,
): RoomOccupant[] {
  const hide = viewerUserId ? blockGraph.get(viewerUserId) : undefined;
  return hide ? occupants.filter((o) => !hide.has(o.userId)) : occupants;
}

export async function broadcastRoomState(
  io: Io,
  db: Db,
  roomId: string,
): Promise<void> {
  const room = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room) return;
  const summary = await buildRoomSummary(db, room);
  const occupants = await currentOccupants(io, db, roomId);
  // Per-viewer block filtering (see roomBlockGraph). Fast path: no blocks
  // among the room → one room-wide emit. Otherwise fan out filtered lists.
  const { sockets, blockGraph } = await roomBlockGraph(io, db, roomId, occupants);
  if (blockGraph.size === 0) {
    io.to(`room:${roomId}`).emit("room:state", { room: summary, occupants });
  } else {
    for (const s of sockets) {
      const uid = (s.data as { userId?: string }).userId;
      s.emit("room:state", { room: summary, occupants: occupantsForViewer(occupants, blockGraph, uid) });
    }
  }
  // Tree-wide invalidate. Room metadata changed (topic, replyMode,
  // owner, archive flip, etc.), anyone with a rooms rail open
  // needs to know. Sockets in other rooms wouldn't see the room-
  // scoped emit above, so they'd be stuck on a stale tree until
  // the 20s backstop poll. Payload-free pulse; the client refetches
  // `/rooms` (debounced) and re-renders.
  io.emit("rooms:tree-changed");
}

export async function broadcastPresence(io: Io, db: Db, roomId: string): Promise<void> {
  const occupants = await currentOccupants(io, db, roomId);
  // Per-viewer block filtering: blocked accounts must not see each other in
  // the userlist. Fast path (no blocks among the room) keeps the single
  // room-wide emit; otherwise fan out filtered lists per socket.
  const { sockets, blockGraph } = await roomBlockGraph(io, db, roomId, occupants);
  if (blockGraph.size === 0) {
    io.to(`room:${roomId}`).emit("presence:update", { roomId, occupants });
  } else {
    for (const s of sockets) {
      const uid = (s.data as { userId?: string }).userId;
      s.emit("presence:update", { roomId, occupants: occupantsForViewer(occupants, blockGraph, uid) });
    }
  }
  // Same tree-invalidate as broadcastRoomState. Presence changes the
  // occupant count next to each room in the rail, and the only way
  // a viewer in room A finds out about a join/leave in room B is to
  // re-fetch the rooms tree. Client-side debounce coalesces a flurry
  // (rapid /char switches, mass disconnect) into a single refetch.
  io.emit("rooms:tree-changed");
}

/**
 * Resolve the world linked to a room, if any. Returns the brief identity
 * record the client uses to render the chat banner. Cheap join (no page
 * data; the viewer modal fetches that on demand).
 */
async function loadLinkedWorld(db: Db, roomId: string): Promise<LinkedWorldRef | null> {
  const link = (await db.select().from(roomWorldLinks).where(eq(roomWorldLinks.roomId, roomId)).limit(1))[0];
  if (!link) return null;
  const w = (await db.select().from(worlds).where(eq(worlds.id, link.worldId)).limit(1))[0];
  if (!w) return null;
  const owner = (await db.select({ username: users.username }).from(users).where(eq(users.id, w.ownerUserId)).limit(1))[0];
  return {
    id: w.id,
    slug: w.slug,
    name: w.name,
    ownerUsername: owner?.username ?? "(deleted user)",
  };
}

/**
 * Fan out a `watch:online` push to every live socket of every user who is
 * friends with the EXACT identity the user just came online as.
 *
 * Friendships are per-identity: you can friend someone's master/OOC handle
 * OR a specific character, and the row pins that side's character id (null
 * for master). `onlineAsCharacterId` is the identity this user is connecting
 * as. We only ping watchers whose friendship is pinned to that same identity,
 * so a player who friended @Aphelios does NOT get an "online" ping when the
 * owner logs in voicing a different character (or OOC). Matching the owner's
 * other characters would leak identities the watcher never friended.
 *
 * `displayName` in the payload is the connecting identity's public name, so a
 * character-pinned ping reads "☆ Aphelios is online." with no OOC crossover.
 *
 * The event name on the wire is still `watch:online` (changing it would break
 * older cached client bundles); the underlying table moved from `watches` to
 * `friends`, and as of migration 0051 friendship is symmetric, so we look at
 * both sides of every accepted edge that touches `user`.
 */
async function pingWatchers(
  io: Io,
  db: Db,
  user: SessionUser,
  onlineAsCharacterId: string | null,
): Promise<void> {
  // Incognito gate. An incognito moderator coming online (login, reconnect,
  // /char-switch, etc.) is supposed to leave no trace, friends receiving
  // a "☆ X is online" system line in their current room would directly
  // out the moderator's presence. Same rationale as the userlist
  // suppression in currentOccupants.
  if (user.incognitoMode) return;
  const rows = await db
    .select({
      frienderUserId: friends.frienderUserId,
      frienderCharacterId: friends.frienderCharacterId,
      friendedUserId: friends.friendedUserId,
      friendedCharacterId: friends.friendedCharacterId,
    })
    .from(friends)
    .where(and(
      or(eq(friends.frienderUserId, user.id), eq(friends.friendedUserId, user.id)),
      eq(friends.status, "accepted"),
    ));
  if (rows.length === 0) return;
  // Keep only edges whose USER side is pinned to the identity they're online
  // as, then collect the OTHER side's user to notify. Each side is checked
  // independently so a (rare) self-friendship across two of the user's own
  // characters resolves correctly; self-pings are dropped.
  const friendSet = new Set<string>();
  for (const r of rows) {
    if (r.frienderUserId === user.id && (r.frienderCharacterId ?? null) === onlineAsCharacterId) {
      if (r.friendedUserId !== user.id) friendSet.add(r.friendedUserId);
    }
    if (r.friendedUserId === user.id && (r.friendedCharacterId ?? null) === onlineAsCharacterId) {
      if (r.frienderUserId !== user.id) friendSet.add(r.frienderUserId);
    }
  }
  if (friendSet.size === 0) return;
  // Drop any friend who is now blocked with this user (either direction): a
  // block must suppress the "online" ping the same way it hides chat/presence.
  for (const blockedId of await blockedUserIdsFor(db, user.id)) friendSet.delete(blockedId);
  if (friendSet.size === 0) return;
  const sockets = await io.fetchSockets();
  const payload = {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
  };
  for (const s of sockets) {
    const uid = (s.data as { userId?: string }).userId;
    if (uid && friendSet.has(uid)) {
      s.emit("watch:online", payload);
    }
  }
  // Persist the "☆ X is online." line per watcher so it survives a
  // refetch. The live copy is still synthesized client-side from the
  // `watch:online` event above (so older bundles keep working); this only
  // writes the durable copy and does not emit. Body matches the client's
  // synthesized text exactly so the two are indistinguishable.
  await persistTargetedSystemMessageToActiveRooms(
    io,
    db,
    friendSet,
    `☆ ${user.displayName} is online.`,
  );
}

/**
 * Make a freshly-created or -removed block take effect live for both parties,
 * without either having to reload. Two halves:
 *
 *   1. Re-run `broadcastPresence` for every room that holds a socket of
 *      either user, so the per-viewer presence filter (see currentOccupants /
 *      broadcastPresence) repaints, the blocked pair vanish from each other's
 *      userlists (on block) or reappear (on unblock).
 *   2. Emit `relationships:changed` to both users' sockets so the client can
 *      drop the other's messages from its buffer, close an open profile / DM,
 *      and refresh its friends list.
 *
 * `blocked` is the NEW state (true = just blocked, false = just unblocked).
 */
export async function notifyBlockChange(
  io: Io,
  db: Db,
  userA: string,
  userB: string,
  blocked: boolean,
): Promise<void> {
  const sockets = await io.fetchSockets();
  const roomIds = new Set<string>();
  for (const s of sockets) {
    const uid = (s.data as { userId?: string }).userId;
    if (uid !== userA && uid !== userB) continue;
    for (const r of s.rooms) if (r.startsWith("room:")) roomIds.add(r.slice(5));
    // Tell this socket which relationship flipped. A socket belonging to A
    // hears about B and vice versa.
    s.emit("relationships:changed", { withUserId: uid === userA ? userB : userA, blocked });
  }
  for (const roomId of roomIds) await broadcastPresence(io, db, roomId);
}

/**
 * If a user-created room has no live sockets in it, ARCHIVE it.
 * Previously this was a hard DELETE that cascaded onto room_members /
 * messages / bans / invites; the user-visible behavior is the same
 * (room disappears from the tree and search) but the row + its
 * configuration (topic, description, theme via linked world,
 * replyMode, messageExpiryMinutes, npcDisabled, type/passwordHash)
 * stick around. The matching create flow detects the archived row
 * on a same-name create and resurrects it with the new caller as
 * owner, see `resurrectArchivedRoom` in routes/commands/builtins/
 * room.ts. System rooms (isSystem=true) are still exempt: they need
 * to stay live so users always have a landing place.
 *
 * Already-archived rows short-circuit so a noisy reconnect loop
 * can't churn the archived_at timestamp every pass.
 *
 * Returns true when the row transitioned active → archived (caller
 * uses it to skip the "X left." announcement the room is no longer
 * around to need). False when the room was system, populated, or
 * already archived.
 */
export async function expireIfEmpty(io: Io, db: Db, roomId: string): Promise<boolean> {
  const room = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room) return false;
  if (room.isSystem) return false;
  if (room.archivedAt) return false;
  const sockets = await io.in(`room:${roomId}`).fetchSockets();
  if (sockets.length > 0) return false;
  // Idle ghosts hold a room open against archival the same way live
  // sockets do, the user is conceptually "still here, just idle." If
  // we archived now we'd race the ghost's eventual sweep (which calls
  // back into expireIfEmpty) and a single-occupant private room would
  // disappear on every tab close. The ghost-sweep timer drives the
  // real archival call after `idleGraceMs` elapses with no return.
  if (hasIdleGhostsForRoom(roomId)) return false;
  await db.update(rooms).set({ archivedAt: new Date() }).where(eq(rooms.id, roomId));
  // Archived rooms are filtered out of the tree, so the rail in every
  // open client just got stale. Caller skips broadcastPresence on the
  // expired branch, so we emit the tree pulse here instead.
  io.emit("rooms:tree-changed");
  return true;
}

/**
 * Send room state + presence to a single socket without disturbing others in
 * the room. Used by /refresh and its auto-refresh interval - broadcasting to
 * the whole room every N seconds would create noise for users who didn't
 * opt in.
 */
export async function sendRoomStateTo(
  socket: Sock,
  io: Io,
  db: Db,
  roomId: string,
): Promise<void> {
  const room = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room) return;
  const summary = await buildRoomSummary(db, room);
  const occupants = await currentOccupants(io, db, roomId);
  // Hide occupants this single viewer is blocked with (mutual). One viewer
  // here, so a direct block-set lookup is cheaper than the room graph.
  const viewerUserId = (socket.data as { userId?: string }).userId;
  const blocked = viewerUserId ? await blockedUserIdsFor(db, viewerUserId) : new Set<string>();
  const view = blocked.size ? occupants.filter((o) => !blocked.has(o.userId)) : occupants;
  socket.emit("room:state", { room: summary, occupants: view });
  socket.emit("presence:update", { roomId, occupants: view });
  // Re-snap to live theater playback on resync (reconnect, tab wake).
  const tp = theaterSyncPayload(roomId);
  if (tp) socket.emit("theater:sync", tp);
}

export async function currentOccupants(io: Io, db: Db, roomId: string): Promise<RoomOccupant[]> {
  const sockets = await io.in(`room:${roomId}`).fetchSockets();
  // Per-tab character routing: each socket carries its own `tabCharId`
  // override (seeded from `users.activeCharacterId` at connect, then
  // mutated only by /char or me:switch-character from THAT socket).
  // The userlist must reflect what each socket is actually voicing in
  // THIS room, falling back to the DB column would leak a /char run
  // on a sibling tab into this room's occupant display.
  //
  // Dedupe is on the IDENTITY tuple (userId, resolved characterId),
  // not on userId alone. That makes a user with two tabs voicing two
  // different characters in the same room render as TWO occupants
  // (one per character), which is the per-identity contract the rest
  // of the app (DMs, friends, @mentions) already uses. Two tabs as
  // the same character (or both OOC) collapse to one row, since
  // they're the same identity. The previous userId-only dedup made
  // the second tab invisible in the userlist while their messages
  // still flowed through, the bug this comment block now exists to
  // prevent regressing.
  //
  // Resolution-before-dedup is load-bearing. `tabCharId === undefined`
  // means "this tab hasn't issued a /char yet, fall back to the user's
  // DB-default active character." If we'd deduped on the raw value, a
  // tab with `undefined` and a sibling tab with the same effective
  // character set explicitly would land in different buckets and both
  // pass dedup, even though they'd render as the same identity. We
  // therefore fetch user rows first, then key dedup on the resolved
  // `(userId, characterId)` tuple, the same tuple the render loop
  // emits, so the two layers can't disagree.
  type Raw = { userId: string; tabCharId: string | null | undefined };
  const raws: Raw[] = [];
  for (const s of sockets) {
    const uid = (s.data as { userId?: string }).userId;
    if (!uid) continue;
    const tabRaw = (s.data as { tabCharId?: string | null }).tabCharId;
    raws.push({ userId: uid, tabCharId: tabRaw });
  }
  // Merge idle ghosts: identities the user was voicing in this room when
  // their last socket dropped, kept visible (faded + "(idle)") through the
  // configured idle-grace window. A ghost is dropped from the merge as
  // soon as a live socket carries the same (userId, characterId) tuple,
  // the dedup pass below handles that automatically since live raws are
  // processed first.
  const ghosts = getIdleGhostsForRoom(roomId);
  if (!raws.length && !ghosts.length) return [];

  const userIds = [
    ...new Set([
      ...raws.map((r) => r.userId),
      ...ghosts.map((g) => g.userId),
    ]),
  ];
  const userRows = await db
    .select()
    .from(users)
    .where(sql`${users.id} IN (${sql.join(userIds.map((u) => sql`${u}`), sql`, `)})`);
  const userById = new Map(userRows.map((u) => [u.id, u]));

  const resolvedIdentities: Array<{ userId: string; characterId: string | null }> = [];
  const idleKeys = new Set<string>();
  const seen = new Set<string>();
  for (const r of raws) {
    const u = userById.get(r.userId);
    if (!u) continue;
    // Incognito filter: users with `incognitoMode = true` are
    // observation-tool moderators who chose to vanish from every
    // userlist. They still appear in the per-room socket set (so
    // socket events reach them and they can read chat normally)
    // but they don't surface in this presence list at all. The
    // /incognito command broadcasts the visible leave-message
    // before flipping the bit, so other participants saw them
    // "leave" already.
    if (u.incognitoMode) continue;
    // `tabCharId === undefined` → no per-tab override yet, fall back
    // to the DB-default active character. `null` → explicit OOC.
    // A string → /char-switched on this socket.
    const characterId = r.tabCharId !== undefined ? r.tabCharId : (u.activeCharacterId ?? null);
    const key = `${r.userId}::${characterId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolvedIdentities.push({ userId: r.userId, characterId });
  }
  // Ghost identities are explicit (characterId was resolved at
  // ghost-creation), so we add them straight to `resolvedIdentities`
  // after the live pass. Anything the dedup already saw via a live
  // socket wins, a ghost only surfaces when the identity has no
  // live presence.
  for (const g of ghosts) {
    const user = userById.get(g.userId);
    if (!user) continue;
    // Same incognito filter for the idle-ghost re-introduction
    // path, a moderator who went incognito just before their last
    // live socket dropped shouldn't reappear as an "(idle)" row.
    if (user.incognitoMode) continue;
    const key = `${g.userId}::${g.characterId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolvedIdentities.push({ userId: g.userId, characterId: g.characterId });
    idleKeys.add(key);
  }
  if (!resolvedIdentities.length) return [];
  const charIds = [...new Set(resolvedIdentities.map((i) => i.characterId).filter((v): v is string => !!v))];
  const charRows = charIds.length
    ? await db
        .select()
        .from(characters)
        .where(sql`${characters.id} IN (${sql.join(charIds.map((c) => sql`${c}`), sql`, `)}) AND ${isNull(characters.deletedAt)}`)
    : [];
  const charById = new Map(charRows.map((c) => [c.id, c]));

  // Userlist crown is PER-IDENTITY (see room_mods). Authority remains
  // per-account on room_members.role, but that role would paint a crown
  // on EVERY character an owner/mod voices, leaking staff/owner status
  // into RP. Instead we derive each occupant row's displayed role from:
  //   - room OWNER → shown only on that account's OOC/master row
  //     (ownership is an account-level fact; rooms.owner_id).
  //   - room MOD   → shown only on the exact identity a /promote targeted
  //     (room_mods, character_id '' = OOC).
  // Anyone else reads as "member" (no crown).
  const roomOwnerRow = (await db
    .select({ ownerId: rooms.ownerId })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1))[0];
  const roomOwnerId = roomOwnerRow?.ownerId ?? null;
  const modRows = await db
    .select({ userId: roomMods.userId, characterId: roomMods.characterId })
    .from(roomMods)
    .where(eq(roomMods.roomId, roomId));
  // Key: `${userId}::${characterId}` with '' for OOC, matching the
  // stored sentinel; occupant lookups map their null characterId to ''.
  const modIdentityKeys = new Set(modRows.map((m) => `${m.userId}::${m.characterId}`));

  // Primary-world resolution was removed in migration 0187. With
  // per-identity memberships there's no single "primary" badge to
  // attach to the userlist row, and the world-bucket grouping that
  // ran off of it was the surface that publicly linked a character
  // back to their master's world affiliation. Occupant payloads no
  // longer carry `primaryWorld`; the world's own member list is the
  // source of truth for "who's affiliated with this world."

  // Earning, batched rank lookup for sigil rendering. We pull the
  // denormalized (rankKey, tier) from user_earning for every user in
  // the occupant set, and from character_earning for every active
  // character. The occupant render below picks the pool that matches
  // the resolved identity (character pool when attached, master pool
  // otherwise). Both queries skip when there are no candidates.
  const userEarningRows = userIds.length
    ? await db
        .select({ userId: userEarning.userId, rankKey: userEarning.rankKey, tier: userEarning.tier })
        .from(userEarning)
        .where(inArray(userEarning.userId, userIds))
    : [];
  const userRankByUser = new Map(userEarningRows.map((r) => [r.userId, { rankKey: r.rankKey, tier: r.tier }]));
  const charEarningRows = charIds.length
    ? await db
        .select({ characterId: characterEarning.characterId, rankKey: characterEarning.rankKey, tier: characterEarning.tier })
        .from(characterEarning)
        .where(inArray(characterEarning.characterId, charIds))
    : [];
  const charRankByChar = new Map(charEarningRows.map((r) => [r.characterId, { rankKey: r.rankKey, tier: r.tier }]));

  // Active name style + inline-avatar toggle. Partitioned per
  // identity (since migration 0085): characters carry their own
  // active slots on `character_earning`; the master/OOC slot lives
  // on `user_active_cosmetics`. The render loop below picks the
  // right one based on whether the occupant is on a character.
  const userActiveRows = userIds.length
    ? await db
        .select({
          userId: userActiveCosmetics.userId,
          activeNameStyleKey: userActiveCosmetics.activeNameStyleKey,
          inlineAvatarEnabled: userActiveCosmetics.inlineAvatarEnabled,
        })
        .from(userActiveCosmetics)
        .where(inArray(userActiveCosmetics.userId, userIds))
    : [];
  const masterActiveStyleByUser = new Map(
    userActiveRows
      .filter((r): r is { userId: string; activeNameStyleKey: string; inlineAvatarEnabled: boolean } => r.activeNameStyleKey !== null)
      .map((r) => [r.userId, r.activeNameStyleKey]),
  );
  const masterInlineAvatarByUser = new Map(
    userActiveRows.map((r) => [r.userId, !!r.inlineAvatarEnabled]),
  );
  // Character-scoped active cosmetics. Pulled from the same
  // `character_earning` rows already fetched above for rank/tier;
  // we re-query just the cosmetic columns to keep the existing
  // rank-fetch helper untouched. Empty when no characters are
  // present in the room.
  const charActiveRows = charIds.length
    ? await db
        .select({
          characterId: characterEarning.characterId,
          activeNameStyleKey: characterEarning.activeNameStyleKey,
          inlineAvatarEnabled: characterEarning.inlineAvatarEnabled,
        })
        .from(characterEarning)
        .where(inArray(characterEarning.characterId, charIds))
    : [];
  const charActiveStyleByChar = new Map(
    charActiveRows
      .filter((r): r is { characterId: string; activeNameStyleKey: string; inlineAvatarEnabled: boolean } => r.activeNameStyleKey !== null)
      .map((r) => [r.characterId, r.activeNameStyleKey]),
  );
  const charInlineAvatarByChar = new Map(
    charActiveRows.map((r) => [r.characterId, !!r.inlineAvatarEnabled]),
  );
  // Selected border rank, keyed by the SCOPE of the occupant
  // (character row's selectedBorderRankKey when attached, master row's
  // otherwise). We've already pulled both earning tables above for
  // rank/tier; reuse the same query results by re-issuing two
  // lightweight column selections rather than threading the field
  // through the larger result set.
  const userBorderRows = userIds.length
    ? await db
        .select({
          userId: userEarning.userId,
          selectedBorderRankKey: userEarning.selectedBorderRankKey,
          selectedFreeformBorderKey: userEarning.selectedFreeformBorderKey,
        })
        .from(userEarning)
        .where(inArray(userEarning.userId, userIds))
    : [];
  const userBorderByUser = new Map(userBorderRows.map((r) => [r.userId, r.selectedBorderRankKey]));
  const userFreeformBorderByUser = new Map(userBorderRows.map((r) => [r.userId, r.selectedFreeformBorderKey]));
  const charBorderRows = charIds.length
    ? await db
        .select({
          characterId: characterEarning.characterId,
          selectedBorderRankKey: characterEarning.selectedBorderRankKey,
          selectedFreeformBorderKey: characterEarning.selectedFreeformBorderKey,
        })
        .from(characterEarning)
        .where(inArray(characterEarning.characterId, charIds))
    : [];
  const charBorderByChar = new Map(charBorderRows.map((r) => [r.characterId, r.selectedBorderRankKey]));
  const charFreeformBorderByChar = new Map(charBorderRows.map((r) => [r.characterId, r.selectedFreeformBorderKey]));
  // Pull owned-style configs per identity (since migration 0086).
  // Master configs come from `user_owned_name_styles`; per-character
  // configs come from `character_owned_name_styles`. We only fetch
  // the rows for users / characters that actually have a style
  // active, so the lookup is bounded by what the render loop needs.
  const usersWithMasterStyle = [...masterActiveStyleByUser.keys()];
  const charsWithStyle = charActiveRows
    .filter((r) => r.activeNameStyleKey !== null)
    .map((r) => r.characterId);
  const masterOwnedStyleRows = usersWithMasterStyle.length > 0
    ? await db
        .select({ userId: userOwnedNameStyles.userId, styleKey: userOwnedNameStyles.styleKey, configJson: userOwnedNameStyles.configJson })
        .from(userOwnedNameStyles)
        .where(inArray(userOwnedNameStyles.userId, usersWithMasterStyle))
    : [];
  const charOwnedStyleRows = charsWithStyle.length > 0
    ? await db
        .select({ characterId: characterOwnedNameStyles.characterId, styleKey: characterOwnedNameStyles.styleKey, configJson: characterOwnedNameStyles.configJson })
        .from(characterOwnedNameStyles)
        .where(inArray(characterOwnedNameStyles.characterId, charsWithStyle))
    : [];
  // Index by identity tuple so the render loop's lookup is a single
  // map get. Master rows use the "u::<userId>::<styleKey>" key
  // pattern; character rows use "c::<charId>::<styleKey>".
  const ownedConfigByIdentityStyle = new Map<string, Record<string, unknown> | null>();
  function parseConfig(json: string | null): Record<string, unknown> | null {
    if (!json) return null;
    try { return JSON.parse(json) as Record<string, unknown>; }
    catch { return null; }
  }
  for (const r of masterOwnedStyleRows) {
    ownedConfigByIdentityStyle.set(`u::${r.userId}::${r.styleKey}`, parseConfig(r.configJson));
  }
  for (const r of charOwnedStyleRows) {
    ownedConfigByIdentityStyle.set(`c::${r.characterId}::${r.styleKey}`, parseConfig(r.configJson));
  }

  // Parallel lookup for freeform-border per-identity color configs.
  // Only fetched for identities whose `selectedFreeformBorderKey` is
  // set, characters cascade off their own row, master cascades off
  // its own row, so we hit each ownership table once with the union of
  // (identity, borderKey) pairs.
  const usersWithFreeformBorder = [...userFreeformBorderByUser.entries()]
    .filter((e): e is [string, string] => e[1] !== null)
    .map(([userId]) => userId);
  const charsWithFreeformBorder = [...charFreeformBorderByChar.entries()]
    .filter((e): e is [string, string] => e[1] !== null)
    .map(([characterId]) => characterId);
  const masterFreeformBorderRows = usersWithFreeformBorder.length > 0
    ? await db
        .select({
          userId: userOwnedFreeformBorders.userId,
          borderKey: userOwnedFreeformBorders.borderKey,
          configJson: userOwnedFreeformBorders.configJson,
        })
        .from(userOwnedFreeformBorders)
        .where(inArray(userOwnedFreeformBorders.userId, usersWithFreeformBorder))
    : [];
  const charFreeformBorderRows = charsWithFreeformBorder.length > 0
    ? await db
        .select({
          characterId: characterOwnedFreeformBorders.characterId,
          borderKey: characterOwnedFreeformBorders.borderKey,
          configJson: characterOwnedFreeformBorders.configJson,
        })
        .from(characterOwnedFreeformBorders)
        .where(inArray(characterOwnedFreeformBorders.characterId, charsWithFreeformBorder))
    : [];
  function parseFreeformConfig(json: string | null): Record<string, string> | null {
    if (!json) return null;
    try {
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" && v.length > 0) out[k] = v;
      }
      return Object.keys(out).length > 0 ? out : null;
    } catch { return null; }
  }
  const masterFreeformConfigByUserBorder = new Map<string, Record<string, string> | null>();
  for (const r of masterFreeformBorderRows) {
    masterFreeformConfigByUserBorder.set(`u::${r.userId}::${r.borderKey}`, parseFreeformConfig(r.configJson));
  }
  const charFreeformConfigByCharBorder = new Map<string, Record<string, string> | null>();
  for (const r of charFreeformBorderRows) {
    charFreeformConfigByCharBorder.set(`c::${r.characterId}::${r.borderKey}`, parseFreeformConfig(r.configJson));
  }

  // Render one occupant per resolved identity. Two characters of the
  // same player in the same room (two tabs voicing different chars)
  // come out as two rows; the same character on multiple tabs (or
  // both OOC) collapses to one because the dedup pass above keys on
  // the identity tuple. Downstream consumers (React keys, @mention
  // autocomplete, gender lookup) cope fine with multiple rows
  // sharing a userId because each carries its own characterId.
  const out: RoomOccupant[] = [];
  for (const id of resolvedIdentities) {
    const u = userById.get(id.userId);
    if (!u) continue;
    const c = id.characterId ? charById.get(id.characterId) : undefined;
    // Privacy: a user whose master profile is marked private
    // (`users.isPublic = false`) only surfaces in the userlist while
    // *actively using* a character. In OOC mode (no active character)
    // they're filtered out entirely, the (ooc) badge would otherwise
    // expose the master username they specifically opted out of
    // publishing. Active-character rows still appear (and only the
    // character name is shown; the master link is independently gated
    // on the profile endpoint). Side-effect: the room's occupant
    // count reflects what's visible, not raw socket presence, fine,
    // since invisible users are by definition not "in" the room from
    // a viewer's perspective.
    if (!u.isPublic && !c) continue;
    // Same character-first / master-fallback logic the message-author
    // color path uses (see addMessage). Userlist + chat lines have to
    // agree, otherwise a user posting as Character A would show up
    // with their OOC color in the rail and a different color on the
    // line, which looks broken.
    const effectiveColor = c?.chatColor ?? u.chatColor;
    // Pick the pool whose rank should drive THIS occupant's sigil.
    // Same scope rule the award engine uses: an in-character row
    // shows the character pool's rank, an OOC row shows the master
    // pool's rank. Falls back to nulls when the pool has no earning
    // row yet (fresh account / unranked).
    const poolRank = c
      ? (charRankByChar.get(c.id) ?? { rankKey: null, tier: null })
      : (userRankByUser.get(u.id) ?? { rankKey: null, tier: null });
    // Active style + its config are both per-identity since
    // migration 0086: characters read from `character_earning`
    // (active) + `character_owned_name_styles` (config); the master
    // reads from `user_active_cosmetics` + `user_owned_name_styles`.
    // Each character can hold a different style than the master and
    // tune its colors independently.
    const activeStyleKey = c
      ? (charActiveStyleByChar.get(c.id) ?? null)
      : (masterActiveStyleByUser.get(u.id) ?? null);
    const nameStyleConfig = activeStyleKey
      ? (c
          ? (ownedConfigByIdentityStyle.get(`c::${c.id}::${activeStyleKey}`) ?? null)
          : (ownedConfigByIdentityStyle.get(`u::${u.id}::${activeStyleKey}`) ?? null))
      : null;
    // Also surface the user's MASTER slot independently. When this
    // occupant is voicing a character, the master slot is what the
    // renderer should use for any of the user's OOC backlog (and
    // for OOC whispers, etc.), without it the chat renderer has
    // no entry for `identityKey(userId, null)` while the user is
    // attached to a character, and OOC messages render unstyled.
    const masterStyleKey = masterActiveStyleByUser.get(u.id) ?? null;
    const masterStyleConfig = masterStyleKey
      ? (ownedConfigByIdentityStyle.get(`u::${u.id}::${masterStyleKey}`) ?? null)
      : null;
    // Avatar + border + inline-avatar toggle. Avatar follows the
    // character / master fallback already used for chat-line
    // snapshots in addMessage. Border + inline-avatar pick the
    // scope-appropriate row (character_earning when attached,
    // user_active_cosmetics when OOC).
    const occupantAvatarUrl = c?.avatarUrl ?? u.avatarUrl ?? null;
    // Owner-chosen zoom/pan for that resolved avatar. Same scope rule:
    // character columns when attached, master columns otherwise. The
    // schema columns are NOT NULL with sensible defaults (zoom 1.0,
    // offsets 50/50) so the fallback is just the defaults, but we
    // round-trip via `clampAvatarCrop` so any out-of-range row written
    // by an older client can't poison the wire shape.
    const occupantAvatarCrop = clampAvatarCrop(
      c
        ? { zoom: c.avatarZoom, offsetX: c.avatarOffsetX, offsetY: c.avatarOffsetY }
        : { zoom: u.avatarZoom, offsetX: u.avatarOffsetX, offsetY: u.avatarOffsetY },
    );
    const selectedBorderRankKey = c
      ? (charBorderByChar.get(c.id) ?? null)
      : (userBorderByUser.get(u.id) ?? null);
    const selectedFreeformBorderKey = c
      ? (charFreeformBorderByChar.get(c.id) ?? null)
      : (userFreeformBorderByUser.get(u.id) ?? null);
    const freeformBorderConfig = selectedFreeformBorderKey
      ? (c
          ? (charFreeformConfigByCharBorder.get(`c::${c.id}::${selectedFreeformBorderKey}`) ?? null)
          : (masterFreeformConfigByUserBorder.get(`u::${u.id}::${selectedFreeformBorderKey}`) ?? null))
      : null;
    const inlineAvatarEnabled = c
      ? (charInlineAvatarByChar.get(c.id) ?? false)
      : (masterInlineAvatarByUser.get(u.id) ?? false);
    // Master-slot fallbacks for the user's OOC identity. The chat
    // renderer indexes a separate identityKey(userId, null) entry
    // for OOC messages; these fields populate that entry even when
    // the occupant row represents the user's current character.
    const masterAvatarUrl = u.avatarUrl ?? null;
    const masterAvatarCrop = clampAvatarCrop({
      zoom: u.avatarZoom,
      offsetX: u.avatarOffsetX,
      offsetY: u.avatarOffsetY,
    });
    const masterSelectedBorderRankKey = userBorderByUser.get(u.id) ?? null;
    const masterSelectedFreeformBorderKey = userFreeformBorderByUser.get(u.id) ?? null;
    const masterFreeformBorderConfig = masterSelectedFreeformBorderKey
      ? (masterFreeformConfigByUserBorder.get(`u::${u.id}::${masterSelectedFreeformBorderKey}`) ?? null)
      : null;
    const masterInlineAvatarEnabled = masterInlineAvatarByUser.get(u.id) ?? false;
    // Away is per-identity (see `realtime/awayState.ts`): the same
    // user voicing different characters carries one row per identity
    // here, so reading from the legacy master-row column would smear
    // a /away marked on one character onto all the others. The
    // in-memory store keys on the resolved (userId, characterId)
    // tuple, same key the rest of this loop's dedupe uses.
    const awayState = getAway(u.id, id.characterId);
    out.push({
      userId: u.id,
      displayName: c ? c.name : u.username,
      characterId: c?.id ?? null,
      away: awayState != null,
      awayMessage: awayState?.message ?? null,
      idle: idleKeys.has(`${u.id}::${id.characterId ?? ""}`),
      chatColor: effectiveColor,
      gender: resolveGender(u.gender, c?.statsJson),
      // Per-identity displayed role (see modIdentityKeys / roomOwnerId
      // above). Owner shows only on the OOC/master row; a mod crown shows
      // only on the exact identity that was /promoted.
      role:
        roomOwnerId === u.id && id.characterId === null
          ? "owner"
          : modIdentityKeys.has(`${u.id}::${id.characterId ?? ""}`)
            ? "mod"
            : "member",
      accountRole: u.role,
      // Mood is per-identity in the same in-memory store as away.
      // Reading the master column here would smear a /mood set on
      // Character A onto Character B / OOC.
      mood: getMood(u.id, id.characterId),
      // Per-user toggle. When `showRankInUserlist` is off, the
      // broadcast omits the rank fields entirely (renders as
      // null/null on the wire) so the UserNameTag falls back to the
      // gender glyph automatically, no extra prop wiring needed
      // downstream. Toggling re-fires presence on the next /me/profile
      // save (see characters.ts re-broadcast gate).
      rankKey: u.showRankInUserlist ? poolRank.rankKey : null,
      tier: u.showRankInUserlist ? poolRank.tier : null,
      activeNameStyleKey: activeStyleKey,
      nameStyleConfig,
      masterNameStyleKey: masterStyleKey,
      masterNameStyleConfig: masterStyleConfig,
      avatarUrl: occupantAvatarUrl,
      avatarCrop: occupantAvatarCrop,
      selectedBorderRankKey,
      selectedFreeformBorderKey,
      freeformBorderConfig,
      inlineAvatarEnabled,
      masterAvatarUrl,
      masterAvatarCrop,
      masterSelectedBorderRankKey,
      masterSelectedFreeformBorderKey,
      masterFreeformBorderConfig,
      masterInlineAvatarEnabled,
      useRankAsUserlistIcon: u.useRankAsUserlistIcon,
    });
  }
  return out;
}

/** When a character is active, prefer its stats.gender; else the user's OOC gender. */
function resolveGender(
  userGender: "male" | "female" | "nonbinary" | "other" | "undisclosed",
  characterStatsJson?: string | null,
): "male" | "female" | "nonbinary" | "other" | "undisclosed" {
  if (!characterStatsJson) return userGender;
  try {
    const parsed = JSON.parse(characterStatsJson) as { gender?: string };
    const g = parsed.gender?.toLowerCase();
    if (g === "male" || g === "female" || g === "nonbinary" || g === "other") return g;
  } catch { /* fall through */ }
  return userGender;
}
