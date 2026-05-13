import "dotenv/config";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import argon2 from "argon2";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import pino from "pino";
import { Server as IoServer } from "socket.io";
import { ZodError } from "zod";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@thekeep/shared";

import { db } from "./db/index.js";
import { bans, roomMembers, roomThreadCategories, rooms, sessions, users } from "./db/schema.js";
import { CommandRegistry } from "./commands/registry.js";
import { registerBuiltins } from "./commands/builtins/index.js";
import { dispatchChatInput } from "./realtime/dispatch.js";
import {
  addSystemMessage,
  broadcastPresence,
  expireIfEmpty,
  findCanonicalLanding,
  joinRoom,
  schedulePendingDisconnect,
  userHasSocketInRoom,
  userIsOnline,
} from "./realtime/broadcast.js";
import { lookupProfile } from "./commands/builtins/profile.js";
import { emitMutualSettled, respondToPrompt } from "./titles/service.js";
import {
  originFromRequest,
  render404Html,
  renderRobotsTxt,
  renderSitemapXml,
  renderSplashHtml,
  resolveIndexHtmlPath,
} from "./seo.js";
import { readFile } from "node:fs/promises";
import { extendSession, loadSessionUser } from "./auth/session.js";
import { registerAuthRoutes, getSessionUser, userIdFromSessionId, SESSION_COOKIE_NAME } from "./routes/auth.js";
import { registerCharacterRoutes } from "./routes/characters.js";
import { registerAffiliateRoutes } from "./routes/affiliates.js";
import { registerBookmarkRoutes } from "./routes/bookmarks.js";
import { registerJournalRoutes } from "./routes/journal.js";
import { registerLinkRoutes } from "./routes/links.js";
import { registerWorldRoutes } from "./routes/worlds.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerReportRoutes } from "./routes/reports.js";
import { registerPushRoutes } from "./routes/push.js";
import { initPush } from "./push.js";
import { registerCommandsRoutes } from "./routes/commands.js";
import { registerNavLinkRoutes } from "./routes/nav-links.js";
import { registerRoomsRoutes } from "./routes/rooms.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { registerUsersRoutes } from "./routes/users.js";
import { registerAdminRoutes } from "./admin/routes.js";
import { ensureSystemSeeds, startJanitor } from "./seed.js";
import { getSettings } from "./settings.js";

// In dev: server runs on 3001, Vite dev-server on 5173 with a proxy to 3001.
// In prod: a single Node process serves both the API and the built web bundle
// on PORT (Fly.io passes its own PORT env, typically 8080; Fly's edge maps
// external 80/443 → that internal port). Override locally with `PORT=80
// NODE_ENV=production node dist/index.js` if you want bare-metal port 80.
const PORT = Number(process.env.PORT ?? 3001);
const NODE_ENV = process.env.NODE_ENV ?? "development";
const IS_PROD = NODE_ENV === "production";
// In production we serve the web bundle from the same origin, so CORS is
// neither needed nor desirable. WEB_ORIGIN only matters for dev's cross-port
// localhost setup. An explicit empty string disables CORS entirely.
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? (IS_PROD ? "" : "http://localhost:5173");
const SESSION_SECRET: string = process.env.SESSION_SECRET ?? "";
if (SESSION_SECRET.length < 32) {
  throw new Error("SESSION_SECRET must be set and at least 32 chars");
}

// Resolve the built web bundle relative to this file. From either
// apps/server/src/ (tsx) or apps/server/dist/ (compiled), two `..` levels
// reach apps/, then over to web/dist. Three was wrong - that climbed
// past apps/ to the workspace root and the static-file registration
// silently no-op'd, leaving every GET as a Fastify 404.
const __dirname = dirname(fileURLToPath(import.meta.url));
const webDistPath = resolve(__dirname, "..", "..", "web", "dist");

const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  ...(process.env.NODE_ENV === "production"
    ? {}
    : { transport: { target: "pino-pretty" } }),
});

async function main() {
  await ensureSystemSeeds(db);

  const registry = new CommandRegistry();
  registerBuiltins(registry);
  await registry.reloadCustom(db);

  const app = Fastify({ loggerInstance: log });
  await app.register(cookie, { secret: SESSION_SECRET });
  // CORS is only useful when the web bundle is served from a different origin
  // (the dev setup, where Vite is on :5173 and the API is on :3001). In prod
  // they're same-origin so registering CORS would just add a useless header
  // round-trip. WEB_ORIGIN="" disables it entirely.
  if (WEB_ORIGIN) {
    await app.register(cors, { origin: WEB_ORIGIN, credentials: true });
  }
  // Global rate limit, scoped per-IP. Auth routes layer their own tighter
  // hooks on top via opts.config.rateLimit. The `global: false` flag means
  // routes opt-in via their config; Fastify still tracks per-route counters.
  await app.register(rateLimit, {
    global: false,
    timeWindow: "1 minute",
    max: 60,
  });

  // HTTP Strict Transport Security. Production only - Fly already forces
  // HTTPS at the edge, but the explicit header tells browsers to remember
  // the preference and refuse plaintext for a year (with includeSubDomains
  // so any *.thespire.fly.dev sub also stays HTTPS-only). Skipped in dev
  // because localhost runs on plain HTTP and browsers would otherwise
  // refuse to load it after the first encounter with the header.
  if (IS_PROD) {
    app.addHook("onSend", async (_req, reply, payload) => {
      reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
      return payload;
    });
  }

  // ZodError → 400 with a readable list of issues. Without this, our routes'
  // `schema.parse(req.body)` calls bubble up as 500s.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      reply.code(400);
      return reply.send({
        error: "validation",
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    throw err;
  });

  // Route registrars use the default FastifyInstance logger type
  // (FastifyBaseLogger). With `loggerInstance: log` Fastify infers a
  // pino.Logger here, which is structurally incompatible - cast to the
  // base instance shape just for the registrar calls.
  const baseApp = app as unknown as FastifyInstance;
  await registerAuthRoutes(baseApp, db);
  await registerCommandsRoutes(baseApp, db, registry);
  await registerNavLinkRoutes(baseApp, db, async (req) => {
    const u = await getSessionUser(req, db);
    return u?.role === "admin";
  });
  // (Admin routes need io for the room-delete boot-and-redirect flow, so they
  // are registered after the IoServer is constructed below.)

  // Public endpoints. Anonymous + cheap, but unrate-limited they make easy
  // amplification targets. 120/min/IP is generous (splash polls /site once
  // per tab + /stats every 30s) but caps spamming. Defined up here so
  // /profiles/:name can use it too.
  const publicLimit = {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  } as const;

  app.get("/profiles/:name", publicLimit, async (req, reply) => {
    const { name } = req.params as { name: string };
    const profile = await lookupProfile(db, name);
    if (!profile) {
      reply.code(404);
      return { error: "no profile" };
    }
    // Visibility gate. Two states matter:
    //   - Anonymous viewer + (not public OR NSFW): return a "private" stub
    //     instead of 404 so the client can render a friendly "this profile
    //     is private, please sign in or register" splash. We deliberately
    //     return HTTP 200 so anonymous fetchers don't treat it as an error;
    //     the discriminating shape is the `private: true` field.
    //   - Logged-in viewer of a non-public profile: see it normally
    //     (private == "logged-in members can view", per the spec). The NSFW
    //     warning splash is layered on top client-side via isNsfw flag.
    //   - Owner / admin: always see the full profile.
    const me = await getSessionUser(req, db);
    const restricted = !profile.profile.isPublic || profile.profile.isNsfw;
    if (restricted && !me) {
      // Stub keeps the display name (the caller already typed it, so no
      // info leak) so the splash can address the visitor by who they were
      // looking for: "Sigrid's profile is private."
      return {
        private: true as const,
        name: profile.kind === "master" ? profile.profile.username : profile.profile.name,
        kind: profile.kind,
        requiresAuth: true,
      };
    }
    return profile;
  });

  /**
   * Public branding endpoint - readable without authentication so the login
   * screen, boot splash, and tab title can show the site's configured name
   * and logo styling. Returns ONLY the public-facing fields; admin-only
   * settings (retention, session TTL) live behind /admin/settings.
   */

  app.get("/site", publicLimit, async () => {
    const s = await getSettings(db);
    return {
      siteName: s.siteName,
      bannerCoverCss: s.bannerCoverCss,
      logoColor: s.logoColor,
      logoFont: s.logoFont,
      defaultTheme: s.defaultTheme,
      // Surface so the unauthenticated AuthGate can hide the Register tab.
      registrationOpen: s.registrationOpen,
      // Sanitized welcome message rendered above the splash login form.
      welcomeHtml: s.welcomeHtml,
      // Sanitized disclaimer rendered above the register form. Users must
      // tick an "I agree" checkbox before /auth/register accepts the request.
      registerDisclaimerHtml: s.registerDisclaimerHtml,
      // SEO description - same string the server renders into <meta name=
      // "description"> on the splash. Surfaced here so the React app can
      // keep document head meta in sync after admin updates without a
      // hard reload.
      metaDescription: s.metaDescription,
      // Retention + session-lifetime values, surfaced so the splash can show
      // visitors how long their messages and login will persist BEFORE they
      // commit to creating an account. Both are durations in milliseconds;
      // messageRetentionMs === 0 means "kept indefinitely".
      messageRetentionMs: s.messageRetentionMs,
      sessionTtlMs: s.sessionTtlMs,
      // Master toggle for surfacing live community activity. The splash
      // hides its user/room counters when this is false (default during
      // cold-start so an empty community doesn't telegraph "dead site").
      activityFeedsEnabled: s.activityFeedsEnabled,
      // Splash carousel toggle. When true the AuthGate fetches a
      // randomized slice of open worlds via /worlds/featured.
      featuredWorldsEnabled: s.featuredWorldsEnabled,
      // Default theme STYLE — orthogonal to defaultTheme above. Users
      // without a per-user style override inherit this. Seeded default
      // is 'medieval'; the catalog also includes 'modern' and 'scifi'.
      defaultStyleKey: s.defaultStyleKey,
    };
  });

  /**
   * Public rules endpoint - returns the admin-configured house rules and the
   * privacy/safety notice. Public so the splash screen could surface them too.
   */
  app.get("/rules", publicLimit, async () => {
    const s = await getSettings(db);
    return {
      rulesHtml: s.rulesHtml,
      securityNoticeHtml: s.securityNoticeHtml,
    };
  });

  app.get("/health", async () => ({ ok: true }));

  const httpServer = app.server;
  const io = new IoServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: WEB_ORIGIN, credentials: true },
  });

  // Routes that need io for socket-room introspection (currently-online
  // occupants per room, presence rebroadcast on character delete, etc.) -
  // registered after io is constructed.
  await registerCharacterRoutes(baseApp, db, io);
  await registerLinkRoutes(baseApp, db);
  await registerJournalRoutes(baseApp, db);
  await registerAffiliateRoutes(baseApp, db);
  await registerBookmarkRoutes(baseApp, db);
  await registerWorldRoutes(baseApp, db, io);
  await registerMessageRoutes(baseApp, db, io);
  await registerReportRoutes(baseApp, db);
  await registerPushRoutes(baseApp, db);
  // Generate VAPID keys at first boot if missing, then configure web-push.
  // Idempotent on subsequent starts; survives deploys via the persisted keys.
  await initPush(db);
  await registerStatsRoutes(baseApp, db, io);
  await registerUsersRoutes(baseApp, db, io);
  await registerRoomsRoutes(baseApp, db, io);
  await registerAdminRoutes(baseApp, {
    db,
    io,
    registry,
    getSessionUser: (req) => getSessionUser(req, db),
  });

  /* Socket auth handshake - pull session id from cookie. */
  io.use(async (socket, next) => {
    try {
      const cookieHeader = socket.handshake.headers.cookie ?? "";
      const sid = parseCookie(cookieHeader, SESSION_COOKIE_NAME);
      if (!sid) return next(new Error("unauthenticated"));
      const userId = await userIdFromSessionId(db, sid);
      if (!userId) return next(new Error("unauthenticated"));
      const user = await loadSessionUser(db, userId);
      if (!user) return next(new Error("unauthenticated"));
      // Stash the sid so per-event handlers (and the janitor sweep) can
      // verify the session row is still alive. The userId/user fields stay
      // for backwards-compatibility with handlers that reference them.
      (socket.data as { userId: string }).userId = userId;
      (socket.data as { user: typeof user }).user = user;
      (socket.data as { sid: string }).sid = sid;
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  io.on("connection", async (socket) => {
    const user = (socket.data as { user: import("./commands/types.js").SessionUser }).user;

    // Auto-join the canonical landing room on connect for instant chat.
    // Prefers "The_Spire" by name (the seeded default); falls back to any
    // system room so installs with custom landings or pre-migration MainHall
    // still work.
    //
    // Multi-tab sync: if this user already has another live socket parked
    // in some room, the new tab should follow that room instead of the
    // landing default — otherwise opening a second tab silently drops you
    // into The_Spire while your other tab is still in (say) Tavern. Pick
    // any sibling that's currently in a room: ties are unlikely (a single
    // user usually has one focused room) and harmless (siblings are by
    // definition all in the same room post-sync).
    let initialRoomId: string | null = null;
    const existingSockets = await io.fetchSockets();
    for (const s of existingSockets) {
      if (s.id === socket.id) continue;
      if ((s.data as { userId?: string }).userId !== user.id) continue;
      const sib = [...s.rooms].find((r) => r.startsWith("room:"));
      if (sib) {
        initialRoomId = sib.slice(5);
        break;
      }
    }
    if (!initialRoomId) {
      // No sibling tab to follow — try the user's last remembered room
      // before falling back to the canonical landing. The remembered
      // room must (a) still exist, (b) be either public or one the user
      // is already a member of, and (c) not have an active ban against
      // the user. Anything else and we drop them at the default landing
      // so the connect path can't dead-end at a wall (forgot password,
      // banned, etc.).
      const userRow = (await db.select().from(users).where(eq(users.id, user.id)).limit(1))[0];
      const lastRoomId = userRow?.lastRoomId ?? null;
      if (lastRoomId) {
        const lastRoom = (await db.select().from(rooms).where(eq(rooms.id, lastRoomId)).limit(1))[0];
        if (lastRoom) {
          const isBanned = (await db
            .select()
            .from(bans)
            .where(and(eq(bans.roomId, lastRoom.id), eq(bans.userId, user.id)))
            .limit(1))[0];
          const banActive = !!isBanned && (!isBanned.until || +isBanned.until > Date.now());
          if (!banActive) {
            if (lastRoom.type === "public") {
              initialRoomId = lastRoom.id;
            } else {
              const member = (await db
                .select()
                .from(roomMembers)
                .where(and(eq(roomMembers.roomId, lastRoom.id), eq(roomMembers.userId, user.id)))
                .limit(1))[0];
              if (member) initialRoomId = lastRoom.id;
            }
          }
        }
      }
    }
    if (!initialRoomId) {
      const landing = await findCanonicalLanding(db);
      if (landing) initialRoomId = landing.id;
    }
    if (initialRoomId) await joinRoom(io, db, socket, user, initialRoomId);

    /**
     * Validate the session is still alive AND extend its idle window. Returns
     * true when the caller can proceed; false when the socket has been
     * kicked (the handler should bail early). Called at the top of every
     * user-initiated socket event so a single helper governs both checks.
     */
    async function checkAndExtendSession(): Promise<boolean> {
      const sid = (socket.data as { sid?: string }).sid;
      if (!sid) return true;
      const row = (await db.select().from(sessions).where(eq(sessions.id, sid)).limit(1))[0];
      if (!row || +row.expiresAt < Date.now()) {
        socket.emit("auth:expired");
        socket.disconnect(true);
        return false;
      }
      // Push expiresAt forward - sliding idle expiry. extendSession reads
      // the latest sessionTtlMs from settings each call so admin changes
      // take effect on the next interaction without restart.
      await extendSession(db, sid);
      return true;
    }

    socket.on("chat:input", async (payload, ack) => {
      try {
        if (!(await checkAndExtendSession())) {
          ack?.({ ok: false, code: "AUTH", message: "Session expired. Please log in again." });
          return;
        }
        const fresh = await loadSessionUser(db, user.id);
        if (!fresh) {
          socket.emit("auth:expired");
          ack?.({ ok: false, code: "AUTH", message: "Session expired." });
          socket.disconnect(true);
          return;
        }
        Object.assign(user, fresh);
        // Validate the thread-category bucket (if any) belongs to the
        // target room. Race condition: an admin can delete the category
        // between the user opening the picker and submitting. Rather
        // than reject the send, drop to null and let the message land
        // in the "Uncategorized" bucket — discarding the message would
        // be a worse failure mode.
        let threadCategoryId: string | null = null;
        if (payload.threadCategoryId) {
          const cat = (await db
            .select()
            .from(roomThreadCategories)
            .where(and(
              eq(roomThreadCategories.id, payload.threadCategoryId),
              eq(roomThreadCategories.roomId, payload.roomId),
            ))
            .limit(1))[0];
          if (cat) threadCategoryId = cat.id;
        }
        // Forum payload — title (new topic) / replyToId (reply under
        // an existing topic). dispatchChatInput validates the
        // structural constraints (reject "both", reject "neither" in
        // forum rooms); we just pass them through.
        const threadTitle = payload.threadTitle?.trim() || undefined;
        const replyToId = payload.replyToId || undefined;
        await dispatchChatInput({
          io, socket, db, registry, user,
          roomId: payload.roomId,
          text: payload.text,
          threadCategoryId,
          ...(threadTitle ? { threadTitle } : {}),
          ...(replyToId ? { replyToId } : {}),
        });
        ack?.({ ok: true });
      } catch (err) {
        log.error({ err }, "chat:input error");
        ack?.({ ok: false, code: "ERR", message: err instanceof Error ? err.message : "error" });
      }
    });

    socket.on("room:join", async (payload, ack) => {
      try {
        if (!(await checkAndExtendSession())) {
          ack?.({ ok: false, code: "AUTH", message: "Session expired. Please log in again." });
          return;
        }
        // Brute-force guard. argon2.verify is intentionally slow (~300ms)
        // which already throttles a single attacker, but it also means each
        // failed attempt pins a CPU thread. A per-user sliding window of
        // failed password attempts caps the abuse: 5 fails / 60s lands the
        // user in a 60s cooldown, regardless of which room they target.
        const passwordCooldown = roomPwCooldown(user.id, Date.now());
        if (passwordCooldown > 0) {
          ack?.({
            ok: false,
            code: "RATE_LIMIT",
            message: `Too many failed password attempts. Try again in ${Math.ceil(passwordCooldown / 1000)}s.`,
          });
          return;
        }
        const room = (await db.select().from(rooms).where(eq(rooms.id, payload.roomId)).limit(1))[0];
        if (!room) {
          ack?.({ ok: false, code: "NO_ROOM", message: "Room not found." });
          return;
        }
        let passwordOk = false;
        if (room.type === "private" && room.passwordHash && payload.password) {
          passwordOk = await argon2.verify(room.passwordHash, payload.password).catch(() => false);
          if (!passwordOk) {
            recordRoomPwFailure(user.id, Date.now());
            ack?.({ ok: false, code: "BAD_PASSWORD", message: "Incorrect password." });
            return;
          }
        }
        await joinRoom(io, db, socket, user, room.id, { passwordOk });

        // Multi-tab independence: each socket is its own occupant. A
        // user with two tabs can be in two different rooms, three tabs
        // in three rooms, etc. Previously this handler ran a sibling
        // sweep that emitted `force-room-join` to every other socket of
        // the same user, dragging them into the originator's new room
        // to keep "one user, one room" intact. That broke the natural
        // expectation that browser tabs are independent contexts. The
        // userlist already dedupes by userId within a room, so a user
        // with two tabs in the same room still shows as one occupant;
        // a user with tabs in different rooms shows in each, which is
        // exactly what the user opening multiple tabs wants.

        ack?.({ ok: true });
      } catch (err) {
        ack?.({ ok: false, code: "ERR", message: err instanceof Error ? err.message : "error" });
      }
    });

    socket.on("room:leave", async (payload) => {
      if (!(await checkAndExtendSession())) return;
      socket.leave(`room:${payload.roomId}`);
      await broadcastPresence(io, db, payload.roomId);
    });

    /**
     * profile:fetch rate limit. Authenticated, but each call hits the DB
     * twice (master lookup + character lookup), so spamming it is a cheap
     * scrape vector. 30 fetches / 10s comfortably covers an admin
     * interactively browsing the userlist while throttling automation.
     */
    let profileFetchTimes: number[] = [];
    socket.on("profile:fetch", async (payload, ack) => {
      if (!(await checkAndExtendSession())) {
        ack({ ok: false, code: "AUTH", message: "Session expired." });
        return;
      }
      const now = Date.now();
      profileFetchTimes = profileFetchTimes.filter((t) => t > now - 10_000);
      if (profileFetchTimes.length >= 30) {
        ack({ ok: false, code: "RATE_LIMIT", message: "Slow down - too many profile lookups." });
        return;
      }
      profileFetchTimes.push(now);
      const profile = await lookupProfile(db, payload.username);
      if (!profile) ack({ ok: false, code: "NO_USER", message: "Not found." });
      else ack({ ok: true, profile });
    });

    /**
     * Activity heartbeat from the client (mouse/keyboard/touch, throttled to
     * ~30s). Sole purpose: keep the session alive while the user is at the
     * keyboard but not actively sending events. Without this, an idle reader
     * would be kicked at the idle-timeout boundary even with the tab open
     * and being scrolled.
     *
     * Server-side debounce: a hostile client could ignore the 30s throttle
     * and spam this. Each call writes to the sessions table via
     * extendSession; spamming pins SQLite. We accept at most one effective
     * heartbeat every 5 seconds per socket, dropping the rest. The session's
     * own expiresAt also advances on chat:input / room:join etc., so this
     * doesn't shorten the user's effective idle window.
     */
    let lastActiveAt = 0;
    socket.on("presence:active", async () => {
      const now = Date.now();
      if (now - lastActiveAt < 5_000) return;
      lastActiveAt = now;
      await checkAndExtendSession();
    });

    /**
     * Accept | Decline response for a mutual-title prompt (request OR
     * dissolve). The service layer authorizes by row state and the
     * authenticated socket's userId; we just route the result.
     */
    socket.on("mutual:respond", async (payload, ack) => {
      if (!(await checkAndExtendSession())) {
        ack?.({ ok: false, code: "AUTH", message: "Session expired." });
        return;
      }
      const result = await respondToPrompt(db, user.id, payload.id, payload.accept);
      if (!result.ok) {
        ack?.({ ok: false, code: result.code ?? "RESPOND_FAILED", message: result.message ?? "Could not respond." });
        return;
      }
      if (result.affectedUserIds) {
        await emitMutualSettled(io, result.affectedUserIds);
      }
      ack?.({ ok: true });
    });

    // We use `disconnecting` (not `disconnect`) because by the time `disconnect`
    // fires, socket.rooms is already empty - we'd miss the room ids we need to
    // notify and check for auto-expiry.
    socket.on("disconnecting", () => {
      const roomIds = [...socket.rooms]
        .filter((r) => r.startsWith("room:"))
        .map((r) => r.slice(5));
      // Snapshot the user identity now - by the time the deferred cleanup
      // runs, the SessionUser object on this socket may already be gone.
      const userId = user.id;
      const displayName = user.displayName;
      const socketId = socket.id;

      // Defer the work so the socket actually finishes leaving its rooms first;
      // otherwise expireIfEmpty would still see this socket present.
      setTimeout(() => {
        (async () => {
          // "Has this user gone offline entirely?" - drives the wording of
          // the system message ("disconnected" vs "left"). When the user has
          // another tab open elsewhere, only the per-room departure shows.
          const fullyOffline = !(await userIsOnline(io, userId, socketId));

          if (fullyOffline) {
            // Remember the room this socket was last in so the next
            // connect can drop them back there. Captured from
            // socket.data.roomId (set by joinRoom on every room move) —
            // any one of the socket's rooms would do, but `data.roomId`
            // is the authoritative "current" room. Only persisted on the
            // fully-offline path so a tab-close that leaves a sibling
            // socket alive doesn't clobber the lastRoomId the still-
            // open tab is about to update via its own future disconnect.
            const lastRoomId = (socket.data as { roomId?: string }).roomId ?? null;
            if (lastRoomId) {
              await db.update(users).set({ lastRoomId }).where(eq(users.id, userId));
            }

            // Reconnect-grace path: don't announce or rebroadcast yet. If the
            // user reconnects inside the grace window, joinRoom() consumes
            // the pending entry and this whole block never fires - the chat
            // log + userlist look like the blip never happened. Otherwise
            // the timer fires after the grace window and the announcement
            // goes out then.
            //
            // We re-resolve room state inside the deferred callback so that
            // (a) expireIfEmpty sees the user truly gone, not just leaving,
            // and (b) per-room "still there" checks reflect any racing
            // reconnect that arrived in a different room.
            schedulePendingDisconnect(userId, async () => {
              for (const id of roomIds) {
                const expired = await expireIfEmpty(io, db, id);
                if (expired) continue;
                const stillThere = await userHasSocketInRoom(io, userId, id);
                if (!stillThere) {
                  // Forum rooms suppress "X has disconnected." — the
                  // topic feed isn't a chat log and join/leave noise
                  // doesn't belong there.
                  const r = (await db.select().from(rooms).where(eq(rooms.id, id)).limit(1))[0];
                  if (r?.replyMode !== "nested") {
                    await addSystemMessage(io, db, id, `${displayName} has disconnected.`);
                  }
                }
                await broadcastPresence(io, db, id);
              }
            });
          } else {
            // Other tabs of this user are still alive: this is a tab close /
            // room switch, not a session-level disconnect. Emit "left." per
            // affected room immediately - this is room-local, doesn't affect
            // the user's overall online status, and never fires from a
            // transient socket reconnect (those go through the fullyOffline
            // branch since the reconnecting socket is the only one).
            for (const id of roomIds) {
              const expired = await expireIfEmpty(io, db, id);
              if (expired) continue;
              const stillThere = await userHasSocketInRoom(io, userId, id, socketId);
              if (!stillThere) {
                // Same forum-room suppression as the fully-offline path.
                const r = (await db.select().from(rooms).where(eq(rooms.id, id)).limit(1))[0];
                if (r?.replyMode !== "nested") {
                  await addSystemMessage(io, db, id, `${displayName} left.`);
                }
              }
              await broadcastPresence(io, db, id);
            }
          }
        })().catch((err) => log.error({ err }, "disconnecting cleanup failed"));
      }, 0);
    });
  });

  // Janitor: hourly sweep for expired sessions and (if admin enabled it)
  // messages older than the retention window. Passing `io` lets the sweep
  // force-disconnect sockets whose underlying session was just deleted, so
  // those clients drop back to the login splash without having to type.
  startJanitor(db, log, io);

  /* ---------- production: serve the built web bundle ----------
   *
   * In dev, Vite serves the SPA on :5173 and proxies API calls to :3001.
   * In prod we serve the built bundle from this same Fastify instance so
   * Fly.io (or any single-port host) can route external 80/443 to one
   * internal port without an extra reverse-proxy hop.
   *
   * Order matters: this must register AFTER all API routes - fastify-static
   * doesn't shadow earlier routes, and the setNotFoundHandler that follows
   * is the SPA fallback so deep links like /room/foo serve index.html and
   * the React router takes over.
   */
  /**
   * Public SEO routes - registered in BOTH dev and prod so crawlers /
   * link previewers / sitemap submissions all work consistently. The
   * splash-rewrite handler (GET /) only kicks in for prod since dev runs
   * Vite at :5173, but robots.txt + sitemap.xml work everywhere.
   */
  app.get("/robots.txt", publicLimit, async (req, reply) => {
    reply.type("text/plain; charset=utf-8");
    return renderRobotsTxt(originFromRequest(req));
  });
  app.get("/sitemap.xml", publicLimit, async (req, reply) => {
    reply.type("application/xml; charset=utf-8");
    return renderSitemapXml(originFromRequest(req));
  });

  if (IS_PROD) {
    if (!existsSync(webDistPath)) {
      log.warn({ webDistPath }, "production mode but web/dist not found - did `pnpm --filter @thekeep/web run build` run?");
    } else {
      // Read index.html once at startup and cache. The bundle is baked
      // into the container image; restarting the server is the only way
      // it changes, which means the cache is implicitly invalidated by
      // process lifecycle. Avoids a disk read on every splash GET.
      const indexHtmlPath = resolveIndexHtmlPath(__dirname);
      let cachedIndexHtml: string | null = null;
      const getIndexHtml = async (): Promise<string> => {
        if (cachedIndexHtml == null) {
          cachedIndexHtml = await readFile(indexHtmlPath, "utf8");
        }
        return cachedIndexHtml;
      };

      // GET / and any non-API GET that should serve the SPA shell go
      // through the SEO renderer so admin-configured siteName / meta
      // description / analytics scripts land in the HTML before crawlers
      // (or anyone) parses it.
      const serveSplash = async (req: FastifyRequest, reply: FastifyReply) => {
        const html = await renderSplashHtml(
          db,
          originFromRequest(req),
          req.url.split("?")[0] ?? "/",
          await getIndexHtml(),
        );
        reply.type("text/html; charset=utf-8");
        // The SPA shell references content-hashed asset filenames that
        // change on every build. If we let browsers (or any intermediary
        // cache: ISP, corporate proxy, Fly's edge) hold onto an old copy
        // of this HTML, a returning visitor's `index.html` will point at
        // /assets/index-OLDHASH.js — which no longer exists on the new
        // deploy — and the app silently breaks. Previously we shipped
        // `public, max-age=60`, which combined with Chrome's heuristic
        // cache extension routinely held the shell for hours and forced
        // users to clear history to recover. `no-cache` (NOT `no-store`)
        // permits caching but requires revalidation on every use, so the
        // hashed assets underneath still get their year-long immutable
        // caching — only the thin HTML shell pays the round-trip cost.
        reply.header("cache-control", "no-cache, must-revalidate");
        return html;
      };

      // Explicit GET / handler must register BEFORE fastify-static so it
      // wins over the static plugin's default index.html serving.
      app.get("/", publicLimit, serveSplash);

      // SPA deep-link routes. /p/<username> (canonical) and /u/<username>
      // (alias) both open the profile modal; /w/<slug> opens a world
      // viewer. All three are parsed client-side on first paint (see
      // lib/profiles.ts and lib/worlds.ts). /login and /register are
      // the bookmarkable entrance pages — the React app picks them off
      // window.location.pathname and mounts the right form. Without
      // these explicit handlers, the setNotFoundHandler below would
      // serve the themed 404 page and the React app would never boot.
      // Single-segment params only — /p/foo/bar still falls through to
      // the 404.
      app.get("/p/:name", publicLimit, serveSplash);
      app.get("/u/:name", publicLimit, serveSplash);
      app.get("/w/:slug", publicLimit, serveSplash);
      app.get("/login", publicLimit, serveSplash);
      app.get("/register", publicLimit, serveSplash);

      await app.register(fastifyStatic, {
        root: webDistPath,
        // We render index.html ourselves; tell fastify-static not to
        // auto-serve it on directory hits. Otherwise / would be handled
        // by the plugin and our SEO rewrite would never run.
        index: false,
        // Cache hashed bundle assets aggressively. Vite emits content-hashed
        // filenames in /assets/, so anything in there is safe to cache for a
        // year. Everything else (favicons, the_spire_bg.jpg) gets short
        // caching so admin-uploaded changes propagate quickly.
        setHeaders(res, path) {
          if (path.includes("/assets/")) {
            res.setHeader("cache-control", "public, max-age=31536000, immutable");
          } else {
            res.setHeader("cache-control", "public, max-age=300");
          }
        },
      });

      // 404 handler for any GET that didn't match a registered route or
      // a static asset. The Spire is single-page (everything past login is
      // auth-walled UI internal to /), so unknown paths are genuinely
      // missing - we render a themed 404 page rather than the SPA shell.
      // That prevents duplicate-content SEO penalties (every weird URL
      // returning index.html), gives visitors a clear "back to chat" link,
      // and matches the noindex meta on the 404 body.
      //
      // Non-GET methods and API-shaped paths still get a JSON 404 so a
      // typo'd /admin/foo doesn't return HTML and confuse a fetch().
      app.setNotFoundHandler(async (req, reply) => {
        if (req.method !== "GET") {
          reply.code(404);
          return reply.send({ error: "not found" });
        }
        const apiPrefixes = ["/auth", "/admin", "/characters", "/profiles", "/nav-links", "/rooms", "/stats", "/commands", "/messages", "/reports", "/push", "/affiliates", "/worlds", "/me", "/health", "/users", "/site", "/rules", "/socket.io"];
        if (apiPrefixes.some((p) => req.url === p || req.url.startsWith(p + "/") || req.url.startsWith(p + "?"))) {
          reply.code(404);
          return reply.send({ error: "not found" });
        }
        const html = await render404Html(db, originFromRequest(req));
        reply.code(404);
        reply.type("text/html; charset=utf-8");
        // Tell crawlers and shared caches not to retain the 404 body. With
        // an SPA there's no risk of a real route silently 404'ing for long
        // (deploys ship a fresh process), but the directive is the SEO-
        // hygienic answer.
        reply.header("cache-control", "no-cache");
        return html;
      });
    }
  }

  await app.listen({ port: PORT, host: "0.0.0.0" });
  log.info({ port: PORT, mode: IS_PROD ? "production" : "development" }, "The Spire server up");
}

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v ?? "");
  }
  return null;
}

/**
 * Per-user sliding window for failed room password attempts. Prevents an
 * attacker from brute-forcing a private-room password and from pinning the
 * server's CPU on argon2.verify calls.
 *
 * Bucket: caller userId. Window: 60s. Max fails before cooldown: 5. Cooldown
 * after exceeding: 60s. Map keys are pruned implicitly by the slice + cooldown
 * logic; long-idle users naturally roll out of the window.
 */
const ROOM_PW_WINDOW_MS = 60_000;
const ROOM_PW_MAX_FAILS = 5;
const ROOM_PW_COOLDOWN_MS = 60_000;
const roomPwFailures = new Map<string, number[]>();
const roomPwCooldownUntil = new Map<string, number>();

function roomPwCooldown(userId: string, now: number): number {
  const until = roomPwCooldownUntil.get(userId) ?? 0;
  return until > now ? until - now : 0;
}

function recordRoomPwFailure(userId: string, now: number): void {
  const cutoff = now - ROOM_PW_WINDOW_MS;
  const list = (roomPwFailures.get(userId) ?? []).filter((t) => t >= cutoff);
  list.push(now);
  if (list.length >= ROOM_PW_MAX_FAILS) {
    roomPwCooldownUntil.set(userId, now + ROOM_PW_COOLDOWN_MS);
    roomPwFailures.delete(userId);
  } else {
    roomPwFailures.set(userId, list);
  }
}

main().catch((err) => {
  log.error({ err }, "fatal");
  process.exit(1);
});
