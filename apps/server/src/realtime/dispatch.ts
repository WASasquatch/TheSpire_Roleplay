import { and, eq } from "drizzle-orm";
import type { Server as IoServer, Socket } from "socket.io";
import { isAdminRole } from "@thekeep/shared";
import type {
  ClientToServerEvents,
  Role,
  ServerToClientEvents,
} from "@thekeep/shared";
import { parseInput } from "../commands/parser.js";
import type { CommandRegistry } from "../commands/registry.js";
import type { CommandContext, SessionUser } from "../commands/types.js";
import type { Db } from "../db/index.js";
import { accountMutes, messages, mutes, rooms } from "../db/schema.js";
import { formatDuration } from "../commands/duration.js";
import { areServersEnabled, getServerSettings, getSettings } from "../settings.js";
import { resolveRoomServerId } from "../earning/pool.js";
import { hasPermission } from "../auth/permissions.js";
import { recordAudit } from "../audit.js";
import { addMessage, addMessageDirect, exitIncognitoOnCharSwitch } from "./broadcast.js";
import { evaluateAntiSpam } from "./antiSpam.js";
import { applyFilters, AUTOMOD_DEFAULT_MUTE_MS, getCompiledRuleset } from "./automod.js";
import { tFor } from "../i18n.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;
type Sock = Socket<ClientToServerEvents, ServerToClientEvents>;

/**
 * Per-user chat rate limiter. Uses a sliding window of timestamps in a Map
 * keyed by userId. A user can send up to RATE_MAX messages within
 * RATE_WINDOW_MS; the (RATE_MAX + 1)th lands them in a brief cooldown.
 *
 * Admins are exempted (they shouldn't be locked out of their own moderation).
 * Map entries are pruned on each check so the table doesn't leak memory for
 * users who disconnect and never come back.
 */
const RATE_MAX = 12;
/** Trusted accounts get 2× the headroom - earned via the auto-promotion sweep. */
const RATE_MAX_TRUSTED = 24;
const RATE_WINDOW_MS = 10_000;
const COOLDOWN_MS = 5_000;
const recentByUser = new Map<string, number[]>();
const cooldownUntil = new Map<string, number>();

function checkChatRate(userId: string, now: number, max: number): { ok: true } | { ok: false; retryMs: number } {
  const cooldown = cooldownUntil.get(userId) ?? 0;
  if (cooldown > now) return { ok: false, retryMs: cooldown - now };

  const window = recentByUser.get(userId) ?? [];
  // Drop timestamps outside the window before counting.
  const cutoff = now - RATE_WINDOW_MS;
  let i = 0;
  while (i < window.length && window[i]! < cutoff) i++;
  const fresh = i > 0 ? window.slice(i) : window;

  if (fresh.length >= max) {
    cooldownUntil.set(userId, now + COOLDOWN_MS);
    return { ok: false, retryMs: COOLDOWN_MS };
  }
  fresh.push(now);
  recentByUser.set(userId, fresh);
  return { ok: true };
}

export async function dispatchChatInput(args: {
  io: Io;
  socket: Sock;
  db: Db;
  registry: CommandRegistry;
  user: SessionUser;
  roomId: string;
  text: string;
  /**
   * Optional thread-category bucket for new top-level topics in
   * nested-mode rooms. Validated by the caller (`socket.on("chat:input")`)
   * to belong to the target room; an invalid id is silently dropped to
   * null here rather than rejecting the send, so a racing admin delete
   * of the chosen category never costs the user their message.
   */
  threadCategoryId?: string | null;
  /**
   * Non-empty when the user is starting a new forum topic. Carried
   * straight through to the persisted message row as `title`. Caller
   * has already trimmed; we just verify it's not blank when present.
   */
  threadTitle?: string;
  /**
   * When set, this send is a reply under that topic. The dispatcher
   * also accepts inline `/reply <id>` syntax for the same effect; this
   * explicit field is what the forum composer uses since it doesn't
   * require encoding the parent id inside the body text.
   */
  replyToId?: string;
}): Promise<void> {
  const { io, socket, db, registry, user, roomId, text, threadCategoryId, threadTitle, replyToId } = args;

  const trimmed = text.trim();
  if (!trimmed) return;
  // Admin-configurable caps. Forum posts get a separate (typically
  // larger) ceiling because long-form forum bodies routinely exceed
  // chat's cap. We pick the ceiling here so a runaway paste hits the
  // right limit early, the second forum-only post-length check
  // farther down is the "did this specific forum send fit?" gate,
  // while this one is the "is this input even sane?" pre-filter.
  // Per-server caps: resolve the crediting room's server (NULL/legacy room →
  // DEFAULT_SERVER_ID) and read its effective length caps. NULL overrides
  // inherit the platform default, so with the flag off (single, system server)
  // these are byte-identical to `getSettings(db)`. `maxForumTopicTitleLength`
  // has no per-server override (platform-global), so it stays on `getSettings`.
  const serverId = await resolveRoomServerId(db, roomId);
  const serverSettings = await getServerSettings(db, serverId);
  const { maxMessageLength, maxForumPostLength } = serverSettings;
  const { maxForumTopicTitleLength, antiSpamEnabled, automodEnabled } = await getSettings(db);
  // Use the larger of the two so a forum-bound long body isn't
  // rejected before we know it's destined for a forum room. The
  // forum-specific check inside the nested-mode branch enforces the
  // exact `maxForumPostLength` cap; chat-bound input is gated below
  // by the standard `maxMessageLength` check after the room is
  // resolved.
  const earlyCap = Math.max(maxMessageLength, maxForumPostLength);
  if (trimmed.length > earlyCap) {
    socket.emit("error:notice", { code: "TOO_LONG", message: tFor(user.locale, "errors:server.realtime.messagesCapped", { max: earlyCap }) });
    return;
  }

  // Per-user rate limit. Site mods and admins are exempt entirely
  // (moderation flurries shouldn't get throttled). Trusted users (auto-
  // promoted by the janitor after the trust thresholds are met) get a 2×
  // budget; everyone else uses the default cap. The limiter applies to ALL
  // chat:input - slash commands included - because a flood of /me or /roll
  // is just as disruptive as a flood of plain text.
  // Both admin tiers + mods bypass the rate limit, moderation
  // flurries (rapid kicks, mutes, /announce sequences) shouldn't get
  // throttled. Adding masteradmin via isAdminRole keeps both admin
  // tiers exempt without enumerating them here.
  if (!isAdminRole(user.role) && user.role !== "mod") {
    const max = user.role === "trusted" ? RATE_MAX_TRUSTED : RATE_MAX;
    const rate = checkChatRate(user.id, Date.now(), max);
    if (!rate.ok) {
      socket.emit("error:notice", {
        code: "RATE_LIMIT",
        message: tFor(user.locale, "errors:server.realtime.rateLimit", { seconds: Math.ceil(rate.retryMs / 1000) }),
      });
      return;
    }
  }

  // Reject sends targeted at a room the socket isn't joined to. Without this
  // a stale client (or a hostile one) could chat into rooms it never joined,
  // bypassing private/password gates. We use socket.rooms because it's the
  // ground truth for "what rooms this socket actually broadcasts into."
  if (!socket.rooms.has(`room:${roomId}`)) {
    socket.emit("error:notice", {
      code: "WRONG_ROOM",
      message: tFor(user.locale, "errors:server.realtime.wrongRoom"),
    });
    return;
  }

  const parsed = parseInput(text);

  // Mute check - applies to plain chat, /me-style emotes, /whisper, and most
  // other speech-producing commands. We deliberately allow some non-speech
  // commands to pass (e.g. /char list, /profile, /help, /refresh, /go) so a
  // muted user isn't completely paralyzed in the room. Anything that emits a
  // visible message routes through addMessage which also checks the mute.
  const muteRow = (await db
    .select()
    .from(mutes)
    .where(and(eq(mutes.roomId, roomId), eq(mutes.userId, user.id)))
    .limit(1))[0];
  let mutedFor: number | null = null;
  if (muteRow) {
    const remaining = +muteRow.until - Date.now();
    if (remaining > 0) mutedFor = remaining;
    else {
      // Auto-clean expired mutes so the row doesn't keep tripping checks.
      await db.delete(mutes).where(and(eq(mutes.roomId, roomId), eq(mutes.userId, user.id)));
    }
  }
  // Wider account-level mutes (server-wide / site-wide). Reach follows the
  // ISSUER's authority: a site mute silences the user everywhere, a server mute
  // silences every room in that server. We take the LONGEST remaining across
  // room + wide so the notice shows the true wait. Normally zero rows (a cheap
  // indexed lookup by user), so the extra query is negligible on the hot path.
  const wideMutes = await db
    .select()
    .from(accountMutes)
    .where(eq(accountMutes.userId, user.id));
  if (wideMutes.length) {
    const roomServerId = (await db
      .select({ serverId: rooms.serverId })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1))[0]?.serverId ?? null;
    for (const w of wideMutes) {
      const remaining = +w.until - Date.now();
      if (remaining <= 0) {
        // Auto-clean any expired wide mute we touch, same as the room row above.
        await db.delete(accountMutes).where(eq(accountMutes.id, w.id));
        continue;
      }
      const applies =
        w.scope === "site" ||
        (w.scope === "server" && w.serverId != null && w.serverId === roomServerId);
      if (applies) mutedFor = Math.max(mutedFor ?? 0, remaining);
    }
  }
  const isSpeechCommand = (cmd: string | null): boolean => {
    if (cmd === null) return true; // plain say
    return [
      "me", "he", "she", "they", "it", "em", "action", "pose", "emote",
      "whisper", "wh", "w", "to", "msg", "message", "pm",
      "reply", "re",
      "roll", "dice",
      "topic",
      "scene", "npc",
    ].includes(cmd);
  };
  // Whisper / DM commands (kind:"whisper", targeted at one `toUserId`). These
  // are private, one-to-one sends that never reach the room broadcast, so
  // content auto-moderation MUST skip them: matching a whisper would (a) police
  // a private message the room can't see, and (b) — worse — a mute action posts
  // a PUBLIC room system line naming the sender, leaking the very fact that a
  // whisper happened. Kept in lockstep with the whisper builtin's name+aliases
  // (commands/builtins/whisper.ts). The rate limit + mute gates above still
  // apply (a whisper flood is still a flood); only the content matcher is
  // excluded, matching the "exclude whisper-kind from automod entirely" rule.
  const isWhisperCommand = (cmd: string | null): boolean => {
    if (cmd === null) return false; // a plain say is never a whisper
    return ["whisper", "wh", "w", "to", "msg", "message", "pm"].includes(cmd);
  };
  if (mutedFor !== null && isSpeechCommand(parsed.command)) {
    socket.emit("error:notice", {
      code: "MUTED",
      message: tFor(user.locale, "errors:server.realtime.mutedInRoom", { duration: formatDuration(mutedFor) }),
    });
    return;
  }

  // Escalating anti-spam ladder (admin-toggled). Runs AFTER the mute gate so a
  // user we just auto-muted isn't re-counted, and only for speech-producing
  // input (a burst of /help isn't a chat flood). Site staff and anyone holding
  // `bypass_anti_spam` (trusted/mods/admins by default) are exempt, so it only
  // ever polices ordinary accounts. The base rate limit above stays as a coarse
  // always-on backstop; this is the sharper, opt-in layer that escalates a
  // genuine rapid-fire flood into a growing auto-mute when no mod is watching.
  if (
    antiSpamEnabled &&
    isSpeechCommand(parsed.command) &&
    // Exclude whispers/DMs exactly as the automod block below does: a
    // whisper-triggered auto-mute posts a PUBLIC room system line naming the
    // sender, which would leak the fact that a whisper happened. The always-on
    // base rate limit above still covers a whisper flood.
    !isWhisperCommand(parsed.command) &&
    !isAdminRole(user.role) &&
    user.role !== "mod" &&
    !(await hasPermission(user, "bypass_anti_spam", db))
  ) {
    const verdict = evaluateAntiSpam(user.id, Date.now());
    if (verdict.action === "blocked") {
      socket.emit("error:notice", {
        code: "RATE_LIMIT",
        message: tFor(user.locale, "errors:server.realtime.tooFast", { seconds: Math.ceil(verdict.retryMs / 1000) }),
      });
      return;
    }
    if (verdict.action === "warn") {
      socket.emit("error:notice", {
        code: "SPAM_WARNING",
        message: tFor(user.locale, "errors:server.realtime.spamWarning", { warning: verdict.warning, limit: verdict.limit }),
      });
      return;
    }
    if (verdict.action === "mute") {
      const until = new Date(Date.now() + verdict.muteMs);
      await db
        .insert(mutes)
        .values({ roomId, userId: user.id, until, reason: "Automatic anti-spam mute", issuedById: null })
        .onConflictDoUpdate({
          target: [mutes.roomId, mutes.userId],
          set: { until, reason: "Automatic anti-spam mute", issuedById: null },
        });
      socket.emit("error:notice", {
        code: "MUTED",
        message: tFor(user.locale, "errors:server.realtime.mutedForSpam", { duration: formatDuration(verdict.muteMs) }),
      });
      // Public system line so returning mods can see the auto-action in backlog.
      await addMessageDirect({
        db,
        io,
        roomId,
        userId: user.id,
        displayName: user.displayName,
        kind: "system",
        body: `${user.displayName} was automatically muted for ${formatDuration(verdict.muteMs)} for spam.`,
      });
      return;
    }
    // action === "allow" falls through to normal message handling.
  }

  // Content auto-moderation (admin-toggled). Runs AFTER the anti-spam ladder
  // and uses the EXACT same exemption predicate: site staff and anyone holding
  // `bypass_automod` (trusted/mods/admins by default) are never filtered, and
  // only speech-producing input is inspected. Where anti-spam polices rate,
  // this polices content, an admin-authored rule matching the message body.
  //
  // The matcher is a pure function over a compiled ruleset (compiled once and
  // cached in automod.ts; the admin CRUD routes invalidate the cache on any
  // write), so this hot path never re-reads or re-compiles rules per message.
  //
  // Actions:
  //   - warn   -> SPAM_WARNING-style notice; the send is dropped (never persisted).
  //   - delete -> silently drop the message before it reaches addMessage.
  //   - mute   -> reuse the anti-spam mutes upsert + a MUTED notice + a public
  //               system line, then drop the message.
  // Every hit is recorded via recordAudit(action: "automod").
  if (
    automodEnabled &&
    isSpeechCommand(parsed.command) &&
    // Whispers / DMs are excluded from content auto-moderation entirely: they're
    // private one-to-one sends, and a mute triggered by one would leak the
    // whisper via a public room system line (see isWhisperCommand above).
    !isWhisperCommand(parsed.command) &&
    !isAdminRole(user.role) &&
    user.role !== "mod" &&
    !(await hasPermission(user, "bypass_automod", db))
  ) {
    // Surface: forum (nested-mode room) vs flat chat. Determines which
    // scoped rules apply (a chat-only rule never fires on a forum post).
    const amRoom = (await db.select({ replyMode: rooms.replyMode }).from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
    const surface: "chat" | "forum" = amRoom?.replyMode === "nested" ? "forum" : "chat";
    // Match against the actual message body (the argsText for a slash-speech
    // command like /me, or the full input for a plain say).
    const filterBody = parsed.command === null ? trimmed : parsed.argsText.trim();
    const ruleset = await getCompiledRuleset(db);
    const verdict = applyFilters(filterBody, ruleset, surface);
    if (verdict.action) {
      // Log EVERY hit (not just the winning action) so an admin tuning rules
      // can see exactly which fired. Best-effort; never blocks the action.
      for (const hit of verdict.hits) {
        void recordAudit(db, {
          actorUserId: user.id,
          action: "automod",
          targetUserId: user.id,
          targetRoomId: roomId,
          reason: `automod ${hit.action}: ${hit.label}`,
          metadata: { ruleId: hit.ruleId, kind: hit.kind, action: hit.action, surface },
        });
      }
      if (verdict.action === "warn") {
        socket.emit("error:notice", {
          code: "SPAM_WARNING",
          message: tFor(user.locale, "errors:server.realtime.automodReword"),
        });
        return;
      }
      if (verdict.action === "delete") {
        // Silent drop, no message persisted, no visible notice beyond a
        // generic acknowledgement so the sender isn't left wondering.
        socket.emit("error:notice", {
          code: "BLOCKED",
          message: tFor(user.locale, "errors:server.realtime.automodBlocked"),
        });
        return;
      }
      if (verdict.action === "mute") {
        const muteMs = verdict.muteMs ?? AUTOMOD_DEFAULT_MUTE_MS;
        const until = new Date(Date.now() + muteMs);
        await db
          .insert(mutes)
          .values({ roomId, userId: user.id, until, reason: "Automatic content-moderation mute", issuedById: null })
          .onConflictDoUpdate({
            target: [mutes.roomId, mutes.userId],
            set: { until, reason: "Automatic content-moderation mute", issuedById: null },
          });
        socket.emit("error:notice", {
          code: "MUTED",
          message: tFor(user.locale, "errors:server.realtime.automodMuted", { duration: formatDuration(muteMs) }),
        });
        // Public system line so returning mods see the auto-action in backlog.
        await addMessageDirect({
          db,
          io,
          roomId,
          userId: user.id,
          displayName: user.displayName,
          kind: "system",
          body: `${user.displayName} was automatically muted for ${formatDuration(muteMs)} by an auto-moderation rule.`,
        });
        return;
      }
    }
  }

  // Plain chat. Behavior splits based on the room's replyMode:
  //   - flat rooms: standard chronological chat (the historic behavior).
  //   - nested rooms: forum-style. Plain sends MUST be either a new
  //     topic (threadTitle set) or a reply under an existing topic
  //     (replyToId set). Bare chat-style sends are rejected, the
  //     composer enforces this client-side, but the server is
  //     authoritative.
  if (parsed.command === null) {
    const roomRow = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
    const isForum = roomRow?.replyMode === "nested";
    // Per-surface cap. Forum bodies allow up to maxForumPostLength;
    // flat chat bodies use the lower maxMessageLength. The early
    // gate above used the larger of the two so this branch can apply
    // the right one with a clean error message.
    const effectiveCap = isForum ? maxForumPostLength : maxMessageLength;
    if (trimmed.length > effectiveCap) {
      socket.emit("error:notice", {
        code: "TOO_LONG",
        message: isForum
          ? tFor(user.locale, "errors:server.realtime.forumPostsCapped", { max: effectiveCap })
          : tFor(user.locale, "errors:server.realtime.messagesCapped", { max: effectiveCap }),
      });
      return;
    }
    const ctx: CommandContext = {
      io, socket, db, registry, user, roomId,
      argsText: parsed.argsText,
      args: [],
      invokedAs: "say",
    };
    if (isForum) {
      // New topic path. Title is required to start one; the client
      // should never send an empty topic title with no replyToId, but
      // we reject defensively.
      if (threadTitle && !replyToId) {
        const cappedTitle = threadTitle.trim().slice(0, maxForumTopicTitleLength);
        if (!cappedTitle) {
          socket.emit("error:notice", {
            code: "EMPTY_TITLE",
            message: tFor(user.locale, "errors:server.realtime.emptyTitle"),
          });
          return;
        }
        await addMessage(ctx, {
          kind: "say",
          body: parsed.argsText.trimEnd(),
          title: cappedTitle,
          ...(threadCategoryId ? { threadCategoryId } : {}),
        });
        return;
      }
      // Reply path. The parent must exist, be in the same room, and
      // itself be a top-level topic (not a reply to a reply, forum
      // structure is two-level: topic + flat reply chain). We
      // snapshot the parent author's name + a body excerpt for the
      // inline quote preview, same as the /reply slash command does.
      if (replyToId && !threadTitle) {
        const parent = (await db.select().from(messages).where(eq(messages.id, replyToId)).limit(1))[0];
        if (!parent || parent.roomId !== roomId) {
          socket.emit("error:notice", {
            code: "BAD_TOPIC",
            message: tFor(user.locale, "errors:server.realtime.badTopic"),
          });
          return;
        }
        if (parent.replyToId) {
          socket.emit("error:notice", {
            code: "NOT_A_TOPIC",
            message: tFor(user.locale, "errors:server.realtime.notATopic"),
          });
          return;
        }
        // Deleted topics are hidden from end-user views, but a stale
        // client (or a determined one) could still submit a reply to a
        // remembered id. Reject with the same code the client uses for
        // missing-topics so the user sees a graceful message.
        if (parent.deletedAt) {
          socket.emit("error:notice", {
            code: "BAD_TOPIC",
            message: tFor(user.locale, "errors:server.realtime.badTopic"),
          });
          return;
        }
        // Locked topics reject new replies for users, but holders of
        // `bypass_topic_lock` (mod + admin by default seed) post past
        // the gate so they can drop verdicts / notices in the same
        // thread the lock applies to. Mirrors the slash-command path
        // in commands/builtins/reply.ts.
        if (parent.lockedAt && !(await hasPermission(user, "bypass_topic_lock", db))) {
          socket.emit("error:notice", {
            code: "TOPIC_LOCKED",
            message: tFor(user.locale, "errors:server.realtime.topicLocked"),
          });
          return;
        }
        const snippet = parent.body.length > 120 ? `${parent.body.slice(0, 120)}…` : parent.body;
        await addMessage(ctx, {
          kind: "say",
          body: parsed.argsText.trimEnd(),
          replyToId: parent.id,
          replyToDisplayName: parent.displayName,
          replyToBodySnippet: snippet,
        });
        return;
      }
      // Neither a topic nor a reply, forum rooms don't accept loose
      // chat. The composer is supposed to disable in this state; this
      // is the server's belt-and-suspenders.
      socket.emit("error:notice", {
        code: "FORUM_NEEDS_TOPIC",
        message: tFor(user.locale, "errors:server.realtime.forumNeedsTopic"),
      });
      return;
    }
    // Flat-room path (historic). threadCategoryId is still honored for
    // installs that flipped a categorized room back to flat: the field
    // is harmless if present, ignored by the flat renderer.
    await addMessage(ctx, {
      kind: "say",
      body: parsed.argsText.trim(),
      ...(threadCategoryId ? { threadCategoryId } : {}),
    });
    return;
  }

  // Scope custom-command resolution to the room's server (built-ins are global).
  const handler = registry.resolve(parsed.command, (socket.data as { serverId?: string }).serverId);
  if (!handler) {
    const suggestions = registry.suggest(parsed.command);
    socket.emit("error:notice", {
      code: "UNKNOWN_CMD",
      message: suggestions.length
        ? tFor(user.locale, "errors:server.realtime.unknownCommandSuggest", {
            command: parsed.command,
            suggestions: suggestions.map((s) => `/${s}`).join(", "),
          })
        : tFor(user.locale, "errors:server.realtime.unknownCommand", { command: parsed.command }),
    });
    return;
  }

  // CommandHandler.permission is now a PermissionKey (was a Role
  // tier). The granular resolver layers per-user overrides + the
  // masteradmin bypass on top of the legacy role check, so an
  // install can hand out `/promoteadmin` to a non-admin via the
  // matrix without touching this dispatcher.
  if (handler.permission && !(await hasPermission(user, handler.permission, db))) {
    // Per-server fallback: a sub-server's staff holding the matching server
    // grant may run this command in their server's rooms even without the
    // global key (the default/system server stays on the global gate above).
    let serverOk = false;
    const sid = (socket.data as { serverId?: string }).serverId;
    if (handler.serverPermission && sid && areServersEnabled(await getSettings(db))) {
      const { serverAuthority, serverCan } = await import("../servers/authority.js");
      const a = await serverAuthority(db, user, sid);
      serverOk = !!a.server && !a.server.isSystem && serverCan(a, handler.serverPermission);
    }
    if (!serverOk) {
      socket.emit("error:notice", { code: "PERM", message: tFor(user.locale, "errors:server.realtime.noCommandPermission") });
      return;
    }
  }

  // Forum-thread auto-binding. When the composer was scoped to an
  // active topic (`replyToId` in the payload) AND the room is nested
  // mode, hydrate a fully validated reply tuple here and attach it
  // to the CommandContext. `addMessage` then auto-inherits it for
  // every non-system send so /me / /roll / /scene / /npc / etc. all
  // land as replies under the topic the composer was bound to,
  // instead of leaking out as fresh top-level posts. Validation
  // mirrors the plain-reply path above; on any failure (room is
  // flat, parent missing/deleted/locked, parent is itself a reply)
  // we just leave replyContext undefined and the message goes
  // through unchanged, that's the safe degrade for a stale client
  // submitting against a topic the user can no longer reply to.
  let replyContext: CommandContext["replyContext"] | undefined;
  if (replyToId) {
    const roomRow = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
    if (roomRow?.replyMode === "nested") {
      const parent = (await db
        .select()
        .from(messages)
        .where(eq(messages.id, replyToId))
        .limit(1))[0];
      const canBypassLock = parent?.lockedAt
        ? await hasPermission(user, "bypass_topic_lock", db)
        : true;
      if (
        parent &&
        parent.roomId === roomId &&
        !parent.replyToId &&
        !parent.deletedAt &&
        (!parent.lockedAt || canBypassLock)
      ) {
        const snippet = parent.body.length > 120
          ? `${parent.body.slice(0, 120)}…`
          : parent.body;
        replyContext = {
          replyToId: parent.id,
          replyToDisplayName: parent.displayName,
          replyToBodySnippet: snippet,
        };
      }
    }
  }

  const ctx: CommandContext = {
    io, socket, db, registry, user, roomId,
    argsText: parsed.argsText,
    args: parsed.args,
    invokedAs: parsed.command,
    ...(replyContext ? { replyContext } : {}),
  };

  // Snapshot the socket's identity BEFORE the command runs so we can tell
  // whether it was a character switch (`/char switch|use|clear|off|…`, which
  // rewrites `socket.data.tabCharId`). Resolved the same way every presence
  // path resolves it: a per-tab override wins; `undefined` means "no override
  // yet" → the account default. Captured for the incognito-un-hide guard below.
  const priorTabCharRaw = (socket.data as { tabCharId?: string | null }).tabCharId;
  const priorCharacterId: string | null =
    priorTabCharRaw !== undefined ? priorTabCharRaw : (user.activeCharacterId ?? null);

  try {
    await handler.run(ctx);
  } catch (err) {
    socket.emit("error:notice", {
      code: "CMD_ERROR",
      message: err instanceof Error ? err.message : tFor(user.locale, "errors:server.realtime.commandFailed"),
    });
  }

  // Incognito un-hide guard. If this command switched the socket's identity
  // (tabCharId changed) AND the tab was the one that went incognito, exit
  // incognito instead of letting the mod silently reappear under the new
  // identity. Keyed on the actual tabCharId delta (not the command name) so it
  // fires for every char-switching subcommand without enumerating them, and is
  // a cheap no-op for the overwhelming majority of commands that don't touch
  // identity or aren't run by an incognito user. `exitIncognitoOnCharSwitch`
  // itself re-checks that `priorCharacterId` was the hidden identity, so a
  // switch on an already-visible sibling tab leaves the cover intact.
  const nextTabCharRaw = (socket.data as { tabCharId?: string | null }).tabCharId;
  const nextCharacterId: string | null =
    nextTabCharRaw !== undefined ? nextTabCharRaw : (user.activeCharacterId ?? null);
  if (user.incognitoMode && nextCharacterId !== priorCharacterId) {
    await exitIncognitoOnCharSwitch(io, db, socket, user, priorCharacterId);
  }
}

/**
 * Role-rank hierarchy gate. Returns true when the caller's role tier is
 * at or above `required`. Used by the command dispatcher's legacy
 * `CommandHandler.permission: Role` decorator (kept around for
 * registry compatibility until every handler swaps to the new
 * `PermissionKey` shape).
 *
 * Renamed from the original `hasPermission` to avoid a name collision
 * with `auth/permissions.ts:hasPermission`, which is the granular
 * (user, PermissionKey)-shaped check. The two helpers do unrelated
 * things, `hasRoleAtLeast` answers "is this user at least an admin?",
 * `hasPermission` answers "does this user have `kick_user`?", so the
 * rename trades a misleading shared name for two unambiguous ones.
 */
function hasRoleAtLeast(user: SessionUser, required: Role): boolean {
  // `trusted` sits between `user` and `mod` - elevated rate limits / extra
  // privileges, but no moderation authority. `masteradmin` is strictly
  // above `admin`, so an `admin`-required command also accepts a
  // masteradmin without enumerating the tier explicitly.
  const order = { user: 0, trusted: 1, mod: 2, admin: 3, masteradmin: 4 } as const;
  return order[user.role] >= order[required];
}
