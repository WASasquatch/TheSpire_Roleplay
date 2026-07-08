import { randomInt } from "node:crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Server as IoServer } from "socket.io";
import type {
  ChatMessage,
  ClientToServerEvents,
  MentionRef,
  MessageKind,
  ServerToClientEvents,
} from "@thekeep/shared";
import {
  extractMentions,
  extractMentionTokens,
  mentionsField,
  parseNpcStats,
  mentionTokenRegex,
  processCheckBlocks,
  stripCheckMarkers,
  validateAuthorUiRouteTokens,
} from "@thekeep/shared";
import {
  characterEarning,
  characters,
  ignores,
  messages,
  rooms,
  userActiveCosmetics,
  userEarning,
  users,
} from "../../db/schema.js";
import { pushToUser } from "../../push.js";
import { notify as notifyCenter } from "../../notifications/engine.js";
import type { Db } from "../../db/index.js";
import { roomVisibilityWhere } from "../targetedMessages.js";
import { blockedUserIdsFor } from "../../auth/blocks.js";
import type { CommandContext, SessionUser } from "../../commands/types.js";
import { expandInlineCommands } from "../../commands/registry.js";
import { getSettings, areServersEnabledCached } from "../../settings.js";
import { awardForForum, awardForMessage } from "../../earning/award.js";
import { bumpLifetimeForMessage, classifyMessageForLifetime } from "../../lib/lifetimePostCounts.js";
import { getClearedAt } from "../../lib/roomClears.js";
import { getMood } from "../moodState.js";
import { linkPreviewFromRow } from "../../unfurl.js";
import { loadReactionsForTargets } from "../../reactions.js";
import { emptyPollState, loadPollState } from "../../polls.js";
import { readPoolRank } from "../../earning/resolver.js";
import { resolveRoomServerId } from "../../earning/pool.js";
import { routeMessage } from "../../earning/routing.js";
import { userIsOnline } from "./presence.js";
import { isHiddenIncognitoIdentity } from "./incognito.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

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
    /** For an NPC voiced from a saved NPC: JSON snapshot of its stat lines. */
    npcStatsJson?: string | null;
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
  const expanded = expandInlineCommands(body, ctx.registry, ctx.user, ctx.roomId, (ctx.socket.data as { serverId?: string }).serverId);
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
  if (isHiddenIncognitoIdentity(ctx.user, ctx.user.activeCharacterId ?? null) && payload.kind !== "system") {
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
  // Rank / cosmetic snapshots read from the pool on THIS room's server
  // (flag-off: the room homes to the default server, so this is the
  // single existing pool — byte-identical to today).
  const messageServerId = await resolveRoomServerId(ctx.db, ctx.roomId);
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
        const rank = await readPoolRank(ctx.db, scope.kind === "character" ? "character" : "user", ownerId, messageServerId);
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
        .where(and(eq(characterEarning.serverId, messageServerId), eq(characterEarning.characterId, ctx.user.activeCharacterId)))
        .limit(1))[0];
      if (ce) {
        inlineAvatarEnabledSnapshot = !!ce.inlineAvatarEnabled;
        selectedBorderRankKeySnapshot = ce.selectedBorderRankKey;
      }
    } else {
      const uac = (await ctx.db
        .select({ inlineAvatarEnabled: userActiveCosmetics.inlineAvatarEnabled })
        .from(userActiveCosmetics)
        // Per-server cosmetics (migrations 0295-0299): scope to the room's
        // server like the character-scope read above + the userEarning read
        // below already do (flag off → default server, byte-identical).
        .where(and(eq(userActiveCosmetics.serverId, messageServerId), eq(userActiveCosmetics.userId, ctx.user.id)))
        .limit(1))[0];
      if (uac) inlineAvatarEnabledSnapshot = !!uac.inlineAvatarEnabled;
      const ue = (await ctx.db
        .select({ selectedBorderRankKey: userEarning.selectedBorderRankKey })
        .from(userEarning)
        .where(and(eq(userEarning.serverId, messageServerId), eq(userEarning.userId, ctx.user.id)))
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
    npcStatsJson: payload.kind === "npc" ? (payload.npcStatsJson ?? null) : null,
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
    ...(payload.kind === "npc" && payload.npcStatsJson ? { npcStats: parseNpcStats(payload.npcStatsJson) } : {}),
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

  // Per-channel unread pulse (migration 0318). Fire-and-forget: bump the
  // `room:unread` badge for room members who are NOT currently parked in this
  // room's socket band (they'd see the message live otherwise) and whose
  // per-room mute isn't active — a @mention still pierces the mute. This is a
  // cheap, bounded, incremental fan-out (one grouped query + one emit per
  // eligible member's live sockets); it deliberately does NOT recompute the
  // room tree and NEVER prompts a /rooms refetch on the client. Whisper /
  // targeted-system rows are excluded inside the helper.
  void fanRoomUnreadBump(ctx.io, ctx.db, ctx.roomId, out, ctx.user.id, payload.kind);

  // Fire-and-forget push triggers for offline recipients. Privacy contract:
  // payloads carry only the *kind* of event ("whisper" / "mention") and the
  // author's display name - never the body. The user has to come back to
  // the chat to read what was said.
  void pushTriggers(ctx.io, ctx.db, out, ctx.user, payload.kind);

  // Fire-and-forget link unfurl (OpenGraph preview). Off the hot path:
  // the card arrives via a message:update once the target site answers.
  // Failures (timeouts, unsafe hosts, no metadata) are silent.
  void import("../../unfurl.js")
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
      const lifetimeCategory = classifyMessageForLifetime({
        kind: payload.kind,
        replyMode,
        isReply: !!payload.replyToId,
        hasTitle: !!payload.title,
      });
      void bumpLifetimeForMessage(
        ctx.db,
        ctx.user.id,
        ctx.user.activeCharacterId,
        lifetimeCategory,
      );
      // Cumulative per-room "messages ever" counter (migration 0258). Bump on
      // the same kinds the lifetime counter counts so the Room Info bar's stat
      // stays consistent with per-user totals. Never decremented — retention /
      // expiry sweeps shrink the live buffer but not this number. Best-effort:
      // a failed bump must not roll back the message insert.
      if (lifetimeCategory !== null) {
        void ctx.db
          .update(rooms)
          .set({ messageCount: sql`${rooms.messageCount} + 1` })
          .where(eq(rooms.id, ctx.roomId))
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error("[room-stats] message_count bump failed", { roomId: ctx.roomId, err });
          });
      }
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
  // Re-check this member's auto-join usergroups for the server (their message
  // count / posted-in-room just changed). Flag-gated + best-effort, and a cheap
  // no-op when the server defines no auto-rule groups (one indexed SELECT).
  // Mirrors the forum auto-group hook on the forum:post path.
  if (areServersEnabledCached()) {
    void import("../../servers/usergroups.js")
      .then(({ evaluateServerAutoGroups }) => evaluateServerAutoGroups(ctx.db, messageServerId, ctx.user.id))
      .catch(() => {});
  }
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

    // The room's server, so the mention notification is grouped under it (rail
    // unseen dot) and a click lands the viewer in the right server. Looked up
    // once (ChatMessage carries no serverId); null on the default/home server.
    const roomServerId = (await db
      .select({ serverId: rooms.serverId })
      .from(rooms)
      .where(eq(rooms.id, msg.roomId))
      .limit(1))[0]?.serverId ?? null;

    // Push to a resolved target once, gated on offline + not-self + not-already-
    // notified. Shared by the exact token path and the legacy name path so a
    // message can't double-ping someone it mentions two ways.
    const seen = new Set<string>();
    const notify = async (targetUserId: string | null | undefined, disabled: boolean): Promise<void> => {
      if (!targetUserId || disabled || targetUserId === sender.id) return;
      if (seen.has(targetUserId)) return;
      seen.add(targetUserId);
      // Persist a Notification Center row + live bell pulse for everyone
      // mentioned (online or not). The engine's own push is suppressed
      // (push:false) because the offline web-push just below is this surface's
      // established path; the dedupeKey keeps one chatty author from flooding
      // the inbox with a ping per line.
      await notifyCenter(db, io, {
        userId: targetUserId,
        category: "mention",
        kind: "chat_mention",
        serverId: roomServerId,
        actor: { id: sender.id, name: sender.displayName },
        title: `${sender.displayName} mentioned you`,
        snippet: msg.body.slice(0, 140),
        target: { kind: "room", id: msg.roomId },
        // Carry the exact message so the click jumps to and flashes it (the
        // room switch is handled by jumpToMessage's room:join on the client).
        metadata: { messageId: msg.id },
        dedupeKey: `mention:${msg.roomId}:${sender.id}`,
        dedupeWindowMs: 2 * 60 * 1000,
        push: false,
      });
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

/**
 * Per-channel unread fan-out (migration 0318). After a message broadcasts, bump
 * the `room:unread` badge for the room's members who did NOT see it live:
 *
 *   - the sender never bumps themselves;
 *   - anyone currently parked in this room's socket band saw it live → skip
 *     (they'll clear their own marker on the next read anyway);
 *   - a member whose per-room mute is active is skipped UNLESS this message
 *     @mentions them (mentions always pierce a mute, matching the notify path);
 *
 * Cost is bounded and incremental by design (contract): ONE grouped query for
 * every absent member's unread/mention/mute state for THIS room, then one
 * `room:unread` emit per still-eligible member's live sockets. It deliberately
 * does NOT recompute the room tree and carries no signal that would make the
 * client refetch `/rooms`. Whisper + targeted-system rows never fan out (they're
 * not room-wide unread), and best-effort: a failure is logged, never thrown.
 */
async function fanRoomUnreadBump(
  io: Io,
  db: Db,
  roomId: string,
  msg: ChatMessage,
  senderUserId: string,
  kind: MessageKind,
): Promise<void> {
  try {
    // Whispers + any targeted-to-one-user row aren't room-wide unread. System
    // lines DO count (presence/announce are room activity), so only whisper is
    // excluded by kind; targeted rows carry a toUserId and are filtered in SQL.
    if (kind === "whisper" || msg.toUserId) return;

    const serverId = (await db
      .select({ serverId: rooms.serverId })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1))[0]?.serverId ?? null;

    // Fetch every live socket ONCE and index by userId. From this single
    // enumeration we derive BOTH "who saw it live" (a socket parked in this
    // room's band) and each absent member's delivery targets — instead of
    // calling pulseRoomUnread per member, which each ran a full-server
    // fetchSockets() (O(members × sockets) per message).
    const band = `room:${roomId}`;
    const allSockets = await io.fetchSockets();
    const liveUserIds = new Set<string>();
    const socketsByUser = new Map<string, typeof allSockets>();
    for (const s of allSockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (!uid) continue;
      if (s.rooms.has(band)) liveUserIds.add(uid);
      const list = socketsByUser.get(uid);
      if (list) list.push(s);
      else socketsByUser.set(uid, [s]);
    }

    const now = Date.now();
    // ONE grouped query: for every room member (minus the sender), their unread
    // count past their read watermark, whether any unread row mentions them (by
    // username LIKE or a mentions-JSON hit on their user id), and their active
    // mute state. Indexed by room_members(room) + messages(room_id, created_at).
    const rows = await db.all<{
      user_id: string;
      username: string;
      unread: number;
      mentions: number;
      muted: number;
      muted_until: number | null;
    }>(sql`
      SELECT rm.user_id AS user_id,
             u.username AS username,
             COUNT(m.id) AS unread,
             SUM(
               CASE WHEN m.id IS NOT NULL
                          AND (lower(m.body) LIKE '%@' || lower(u.username) || '%'
                               OR m.mentions_json LIKE '%"userId":"' || rm.user_id || '"%')
                    THEN 1 ELSE 0 END
             ) AS mentions,
             COALESCE(p.muted, 0) AS muted,
             p.muted_until AS muted_until
      FROM room_members rm
      JOIN users u ON u.id = rm.user_id
      LEFT JOIN room_reads rr ON rr.room_id = ${roomId} AND rr.user_id = rm.user_id
      LEFT JOIN per_room_notify_prefs p ON p.room_id = ${roomId} AND p.user_id = rm.user_id
      LEFT JOIN messages m ON m.room_id = ${roomId}
        AND m.kind != 'whisper'
        AND m.deleted_at IS NULL
        AND m.target_user_id IS NULL
        AND m.user_id != rm.user_id
        AND m.created_at > COALESCE(rr.last_read_at, 0)
      WHERE rm.room_id = ${roomId}
        AND rm.user_id != ${senderUserId}
      GROUP BY rm.user_id, u.username, p.muted, p.muted_until
    `);

    for (const r of rows) {
      if (liveUserIds.has(r.user_id)) continue; // saw it live
      const hasMention = (r.mentions ?? 0) > 0;
      const muteActive = !!r.muted && (!r.muted_until || r.muted_until > now);
      // A muted room stays silent unless the new activity mentions the member.
      if (muteActive && !hasMention) continue;
      const targets = socketsByUser.get(r.user_id);
      if (!targets || targets.length === 0) continue; // no live tabs; boot fetch backstops
      const payload = { roomId, serverId, unread: r.unread ?? 0, hasMention };
      for (const s of targets) s.emit("room:unread", payload);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[room-reads] unread fan-out failed", { roomId, err });
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
    ? await (await import("../../auth/permissions.js")).hasPermission(
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
  // Whispers are scoped to this room's server (NULL→default), so a whisper sent
  // in another server doesn't overlay into this backlog.
  const backlogServerId = await resolveRoomServerId(db, roomId);
  const recentPlusOne = await db
    .select()
    .from(messages)
    .where(and(
      roomVisibilityWhere(roomId, viewerUserId, backlogServerId),
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
      ...(m.npcStatsJson ? { npcStats: parseNpcStats(m.npcStatsJson) } : {}),
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
