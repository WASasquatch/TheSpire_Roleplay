// Crash diagnostics must install BEFORE any other import that could
// throw at module-eval time, so a top-level import error still
// lands in the persistent crash log. The module is import-only side
// effects free; the side-effecting `installCrashHandlers()` call
// below binds the process handlers.
import {
  installCrashHandlers,
  recordBootFailure,
  recordBootStart,
  recordBootSuccess,
} from "./crashLog.js";
installCrashHandlers();
recordBootStart();

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
import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";
import { Server as IoServer } from "socket.io";
import { ZodError } from "zod";
import {
  DEFAULT_PRESENCE_TEMPLATES,
  renderPresenceTemplate,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "@thekeep/shared";

import { db } from "./db/index.js";
import { bans, characters, roomMembers, roomThreadCategories, rooms, sessions, userEarning, users } from "./db/schema.js";
import { CommandRegistry } from "./commands/registry.js";
import { registerBuiltins } from "./commands/builtins/index.js";
import { dispatchChatInput } from "./realtime/dispatch.js";
import {
  addSystemMessage,
  broadcastPresence,
  broadcastTheaterSync,
  checkpointPlayingTheaters,
  hydrateTheaterFromDb,
  persistTheaterCheckpoint,
  expireIfEmpty,
  findCanonicalLanding,
  joinRoom,
  registerIdleGhost,
  sendRoomBacklogTo,
  sendRoomStateTo,
  setGhostSweepIo,
  userHasSocketInRoom,
  userIdentityHasSocketInRoom,
  userIsOnline,
} from "./realtime/broadcast.js";
import { clearAllAwayForUser } from "./realtime/awayState.js";
import { applyControl, parsePlaylist } from "./realtime/theaterState.js";
import { callerCanEditRoom } from "./auth/roomPermissions.js";
import { clearAllMoodForUser } from "./realtime/moodState.js";
import {
  clearTyperEverywhere,
  clearTyperFromRoom,
  markTyping,
  startTypingTracker,
} from "./realtime/typing.js";
import { lookupProfile } from "./commands/builtins/profile.js";
import { emitMutualSettled, respondToPrompt } from "./titles/service.js";
import {
  generateCspNonce,
  originFromRequest,
  render404Html,
  renderRobotsTxt,
  renderSitemapXml,
  renderSplashHtml,
  resolveIndexHtmlPath,
} from "./seo.js";
import { readFile } from "node:fs/promises";
import { extendSession, loadSessionUser, resolveDisplayName } from "./auth/session.js";
import { recordHttpIp, recordSocketIp, extractSocketIp } from "./auth/ipLog.js";
import { registerAuthRoutes, getSessionUser, userIdFromSessionId, slugToUsername, readBearerToken } from "./routes/auth.js";
import { registerCharacterRoutes } from "./routes/characters.js";
import { registerAffiliateRoutes } from "./routes/affiliates.js";
import { registerBookmarkRoutes } from "./routes/bookmarks.js";
import { registerDirectMessageRoutes } from "./routes/directMessages.js";
import { registerEmoticonRoutes } from "./routes/emoticons.js";
import { registerFriendsRoutes } from "./routes/friends.js";
import { registerBlockRoutes } from "./routes/blocks.js";
import { registerJournalRoutes } from "./routes/journal.js";
import { registerLinkRoutes } from "./routes/links.js";
import { registerWorldRoutes } from "./routes/worlds.js";
import { registerStoryRoutes } from "./routes/stories.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerReportRoutes } from "./routes/reports.js";
import { registerPushRoutes } from "./routes/push.js";
import { initPush } from "./push.js";
import { registerCommandsRoutes } from "./routes/commands.js";
import { registerAnnouncementsRoutes } from "./routes/announcements.js";
import { registerProfileFlairRoutes } from "./routes/profileFlair.js";
import { startAnnouncementScheduler } from "./admin/announcements.js";
import { registerNavLinkRoutes } from "./routes/nav-links.js";
import { registerRoomsRoutes } from "./routes/rooms.js";
import { registerEarningRoutes } from "./routes/earning.js";
import { registerArcadeRoutes } from "./routes/arcade.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { registerThesaurusRoutes } from "./routes/thesaurus.js";
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

/**
 * Persistent uploads directory, sibling of the SQLite database file.
 * On Fly.io both live on the mounted /data volume so admin-uploaded
 * logos survive a container restart. The directory is created on
 * demand by the upload route; we just resolve the path here so the
 * fastify-static registration below has something to point at.
 *
 * Mirrors the same env-precedence as db/index.ts so a local .env that
 * still uses DATABASE_URL keeps working without a rename.
 */
const dbPath = resolve(process.env.SQLITE_PATH ?? process.env.DATABASE_URL ?? "./data/thekeep.sqlite");
const uploadsRoot = resolve(dirname(dbPath), "uploads");

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

  // bodyLimit bumped from the 1MB Fastify default so the admin
  // logo-upload route (base64-encoded image in JSON body, up to 8MB
  // raw → ~10.7MB encoded) doesn't bounce off 413. Every other route
  // is well under 1MB; the global cap is fine to keep loose since
  // each route still imposes its own zod max where it matters.
  //
  // trustProxy: true makes `req.ip` honor `X-Forwarded-For` so we
  // record the real client public IP instead of the proxy's
  // RFC1918 hop address. The server runs behind Fly.io's edge
  // proxy (and, in any reasonable deploy, some other reverse
  // proxy); without this every user gets logged under the same
  // 172.16.x.x internal address and the per-IP rate limiter
  // collapses everyone into one bucket. Safe to leave on for
  // Fly because the machine's listening port is only reachable
  // through the edge proxy, there's no path for a direct client
  // to spoof X-Forwarded-For. Local dev has no proxy hop at all,
  // so `req.ip` cleanly falls back to the socket remote address.
  const app = Fastify({
    loggerInstance: log,
    bodyLimit: 12 * 1024 * 1024,
    trustProxy: true,
  });
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

  /**
   * Baseline security headers applied to every response. The strict CSP
   * (with a per-request nonce) lives on the HTML routes below, these
   * lighter directives belong on JSON + static-asset responses too so
   * an attacker can't bypass them by targeting a non-HTML endpoint:
   *
   *   X-Content-Type-Options: nosniff, block MIME confusion attacks
   *     where the browser is tricked into rendering JSON as HTML.
   *   X-Frame-Options: DENY, clickjacking defense; older-browser
   *     analogue of the CSP `frame-ancestors 'none'` we set on HTML.
   *   Referrer-Policy: strict-origin-when-cross-origin, leak only
   *     the origin (not the full URL) when navigating to a different
   *     site. Sane modern default.
   *   Cross-Origin-Opener-Policy: same-origin, isolates this origin
   *     from cross-origin window references; pairs with the strict
   *     CSP to defeat Spectre-class side-channels.
   *   Permissions-Policy, opt out of every powerful browser API we
   *     don't use, so an admin-injected analytics script or a future
   *     bug can't quietly start using the camera/mic/geolocation/etc.
   *     `interest-cohort=()` opts out of Chrome's FLoC tracking.
   */
  app.addHook("onSend", async (_req, reply, payload) => {
    if (!reply.getHeader("x-content-type-options")) {
      reply.header("x-content-type-options", "nosniff");
    }
    if (!reply.getHeader("x-frame-options")) {
      reply.header("x-frame-options", "DENY");
    }
    if (!reply.getHeader("referrer-policy")) {
      reply.header("referrer-policy", "strict-origin-when-cross-origin");
    }
    if (!reply.getHeader("cross-origin-opener-policy")) {
      reply.header("cross-origin-opener-policy", "same-origin");
    }
    if (!reply.getHeader("permissions-policy")) {
      reply.header(
        "permissions-policy",
        [
          "camera=()",
          "microphone=()",
          "geolocation=()",
          "payment=()",
          "usb=()",
          "accelerometer=()",
          "gyroscope=()",
          "magnetometer=()",
          "midi=()",
          "interest-cohort=()",
        ].join(", "),
      );
    }
    return payload;
  });

  // Default `Cache-Control: private, no-store` on every Fastify response that
  // hasn't already set one. The SPA shell, hashed asset paths, and 404 page
  // all set their own (see below); this hook catches the JSON API routes
  // (`/me`, `/rooms/*/messages/around`, `/rooms/*/topics`, etc.) so an
  // intermediary or aggressive browser heuristic can't cache them. We
  // deliberately don't set it on responses that already carry a cache-
  // control header so the existing immutable/static rules still win.
  //
  // `private` keeps shared caches (corporate proxies, ISPs) from holding
  // user-scoped JSON; `no-store` forbids any cache from retaining it at
  // all. Cheap to set, one header per request, and we're not relying on
  // cacheable APIs anywhere.
  app.addHook("onSend", async (_req, reply, payload) => {
    if (!reply.getHeader("cache-control")) {
      reply.header("cache-control", "private, no-store");
    }
    return payload;
  });

  // Event-time IP capture for authenticated HTTP requests (forum posts,
  // scriptorium edits, world saves, etc.). `sessions.ip` is frozen at login,
  // so this keeps the admin alt-detection current as users roam networks.
  // Anonymous requests (static assets, the SPA shell, public polls) carry no
  // bearer token and short-circuit instantly; authenticated requests are
  // throttled to one effective write per (token, ip) per minute inside
  // recordHttpIp, so a busy tab never turns this into a write storm.
  // `trustProxy` (set above) makes `req.ip` the real client address behind
  // Fly's edge. Fire-and-forget: never blocks or fails the request.
  app.addHook("onRequest", async (req) => {
    recordHttpIp(db, readBearerToken(req), req.ip, req.headers["user-agent"] ?? null);
  });

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
  // Public marquee banners, unauthenticated; the splash + chat
  // shell paint these for every viewer. Admin CRUD lives behind
  // /admin/announcements/* via the admin route module.
  await registerAnnouncementsRoutes(baseApp, db);
  // Profile-flair surfaces: visitor-count tracker + rotating-quote
  // marquee. View logging is always-on (so equipping the flair has
  // data the moment it lands); display + owner CRUD are
  // ownership-gated against the matching identity's earning_ledger
  // purchase row.
  await registerProfileFlairRoutes(baseApp, db);
  await registerNavLinkRoutes(baseApp, db, async (req) => {
    const u = await getSessionUser(req, db);
    if (!u) return false;
    const { hasPermission } = await import("./auth/permissions.js");
    return hasPermission(u, "manage_nav_links", db);
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
    // URLs present NBSP as a regular space for readability; restore the
    // canonical DB form (NBSP) before lookup. No-op for names that don't
    // contain a space at all.
    // Resolve viewer FIRST so metrics can bypass the owner's hide flags
    // when they're viewing their own profile (the flags are meant to
    // hide counts from OTHER users, not from the owner themselves).
    const me = await getSessionUser(req, db);
    // lookupProfile applies the mutual-block gate internally (a blocked
    // user's profile resolves to null, i.e. 404), so no extra check here.
    const profile = await lookupProfile(db, slugToUsername(name), me?.id);
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
    // `me` is resolved before the lookupProfile call above so the
    // owner's hide flags can be bypassed in computeProfileMetrics.
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
      // Canonical site URL the banner logo links to. Empty string =
      // no link wrapping; the client renders the logo as a non-
      // interactive element. Public so the splash + banner can wire
      // it before login.
      siteUrl: s.siteUrl,
      bannerCoverCss: s.bannerCoverCss,
      logoColor: s.logoColor,
      logoFont: s.logoFont,
      // Banner/splash logo URL. Empty string = no logo (text title
      // is used). Default = the SPA-bundled /thespire-logo.png; can
      // be replaced by an /uploads/... path written by the upload
      // endpoint, or by any remote https URL.
      logoUrl: s.logoUrl,
      defaultTheme: s.defaultTheme,
      // Surface the raw JSON column so the splash can distinguish
      // "admin set an explicit default" from "fell back to the
      // built-in DEFAULT_THEME because nothing's configured". Null
      // means no override → the splash is free to honor
      // prefers-color-scheme and pick the Darkness preset for
      // dark-mode systems / cached-dark visitors.
      defaultThemeJson: s.defaultThemeJson,
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
      // Author-edit / author-delete grace window in ms. Surfaced so
      // the chat client can paint the right "Edit (within Xs)"
      // tooltip and gate the hover-controls without a separate
      // authenticated lookup.
      editGraceMs: s.editGraceMs,
      // Master toggle for surfacing live community activity. The splash
      // hides its user/room counters when this is false (default during
      // cold-start so an empty community doesn't telegraph "dead site").
      activityFeedsEnabled: s.activityFeedsEnabled,
      // Splash carousel toggle. When true the AuthGate fetches a
      // randomized slice of open worlds via /worlds/featured.
      featuredWorldsEnabled: s.featuredWorldsEnabled,
      // Independent toggle for the rolling 24h chat message count
      // on the splash. Not gated by activityFeedsEnabled, either
      // can be on alone, and the splash renders only the sections
      // whose toggle is on. When both are on they share one row.
      splashMessages24hEnabled: s.splashMessages24hEnabled,
      // Default theme STYLE, orthogonal to defaultTheme above. Users
      // without a per-user style override inherit this. Seeded default
      // is 'medieval'; the catalog also includes 'modern' and 'scifi'.
      defaultStyleKey: s.defaultStyleKey,
      // Per-preset design map ({ "Parchment": "medieval", "Twilight":
      // "scifi", … }). The client matches the active palette against
      // THEME_PRESETS by name and uses this map to pick the default
      // design for it. Empty object = no pinning (every theme falls
      // through to `defaultStyleKey`).
      themeDesignMap: s.themeDesignMap,
    };
  });

  /**
   * Public rules JSON endpoint, returns the admin-configured house
   * rules and the privacy/safety notice.
   *
   * Path moved from `/rules` to `/api/rules` in this revision because
   * the `/rules` path is now a public SPA route rendering a dedicated
   * landing page (so a not-yet-registered visitor can read the rules
   * before signing up). The page route fetches THIS endpoint for its
   * content; the rename keeps the JSON endpoint and the page URL on
   * distinct slots so the SPA-shell catchall doesn't accidentally
   * serve HTML in response to a fetch.
   */
  app.get("/api/rules", publicLimit, async () => {
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
  // Hand io to the ghost-sweep timer in broadcast.ts so its setTimeout
  // closure can call back into expireIfEmpty + broadcastPresence when an
  // idle ghost finally times out. We don't pass io through `registerIdleGhost`
  // every call because the timer outlives the call that scheduled it.
  setGhostSweepIo(io);
  // Phase 4 typing indicator, kicks off the periodic sweep that
  // expires stale typer entries and re-broadcasts shrunken sets.
  // Idempotent if called more than once.
  startTypingTracker(io, db);

  // Theater (watch-party) playback resilience. Rehydrate each theater
  // room's persisted checkpoint so reconnecting clients resync to where
  // viewers were before this restart (the boot re-anchor treats the
  // downtime as a pause, not a fast-forward). Then checkpoint actively-
  // playing rooms every 30s so the persisted position stays fresh while
  // a long video runs without any control events. `.unref()` so the
  // timer never keeps the process alive on shutdown.
  void hydrateTheaterFromDb(db).catch(() => { /* a bad row shouldn't crash boot */ });
  const THEATER_CHECKPOINT_MS = 30_000;
  setInterval(() => {
    void checkpointPlayingTheaters(db).catch(() => { /* swallow; next tick retries */ });
  }, THEATER_CHECKPOINT_MS).unref();

  // Zombie-room sweep. Fires once 60s after boot, long enough that
  // every client that was in a user-created room when the server
  // restarted has had a chance to reconnect and re-occupy it, but
  // not so long that the rooms tree drags around a dead room for
  // half a session. Any non-system, non-archived room with zero
  // live sockets at sweep time gets archived (its config row
  // survives for resurrection on a fresh /create with the same
  // name). Without this, a user-created room whose owner closed
  // the tab AND never came back inside the idle-grace window, or
  // a room that was active when the server last shut down and
  // nobody returned to, would linger in the tree forever as a
  // ghost entry with (0) occupants. The runtime triggers
  // (expireIfEmpty on exit / room-switch / ghost-sweep /
  // consume-pending-disconnect) only fire when there's a live
  // event to ride on; a "nobody is here and nobody is coming"
  // room produces no events to fire on.
  const ZOMBIE_SWEEP_DELAY_MS = 60_000;
  setTimeout(() => {
    void (async () => {
      try {
        const candidates = await db
          .select({ id: rooms.id })
          .from(rooms)
          .where(and(eq(rooms.isSystem, false), isNull(rooms.archivedAt)));
        for (const r of candidates) {
          try { await expireIfEmpty(io, db, r.id); }
          catch { /* swallow, one bad row shouldn't stop the sweep */ }
        }
      } catch { /* swallow, sweep failure shouldn't crash boot */ }
    })();
  }, ZOMBIE_SWEEP_DELAY_MS);

  // Routes that need io for socket-room introspection (currently-online
  // occupants per room, presence rebroadcast on character delete, etc.) -
  // registered after io is constructed.
  await registerCharacterRoutes(baseApp, db, io);
  await registerLinkRoutes(baseApp, db);
  await registerJournalRoutes(baseApp, db);
  await registerAffiliateRoutes(baseApp, db);
  await registerBookmarkRoutes(baseApp, db);
  await registerWorldRoutes(baseApp, db, io);
  await registerStoryRoutes(baseApp, db, io);
  await registerFriendsRoutes(baseApp, db, io);
  await registerBlockRoutes(baseApp, db, io);
  await registerDirectMessageRoutes(baseApp, db, io);
  await registerEmoticonRoutes(baseApp, db, io, uploadsRoot);
  await registerMessageRoutes(baseApp, db, io);
  await registerReportRoutes(baseApp, db);
  await registerPushRoutes(baseApp, db);
  // Generate VAPID keys at first boot if missing, then configure web-push.
  // Idempotent on subsequent starts; survives deploys via the persisted keys.
  await initPush(db);
  await registerStatsRoutes(baseApp, db, io);
  await registerEarningRoutes(baseApp, db, io);
  await registerArcadeRoutes(baseApp, db, io);
  await registerThesaurusRoutes(baseApp, db);
  await registerUsersRoutes(baseApp, db, io);
  await registerRoomsRoutes(baseApp, db, io);
  await registerAdminRoutes(baseApp, {
    db,
    io,
    registry,
    uploadsRoot,
    getSessionUser: (req) => getSessionUser(req, db),
  });

  // Serve admin-uploaded files (logos today, possibly more later).
  // Lives on the persistent data volume so deploys don't lose them.
  // Filenames are content-hashed by the upload route, so the
  // 1-year immutable cache is safe, a replaced logo gets a new
  // filename + URL, busting any stale cache automatically. Registered
  // BEFORE the SPA static below so /uploads/* never falls into the
  // SPA fallback in prod.
  //
  // Decorate-skipped so we can register a second fastify-static for
  // the SPA later: only one instance can claim the default
  // decorators per Fastify scope.
  if (!existsSync(uploadsRoot)) {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(uploadsRoot, { recursive: true });
  }
  await baseApp.register(fastifyStatic, {
    root: uploadsRoot,
    prefix: "/uploads/",
    decorateReply: false,
    setHeaders(res) {
      res.setHeader("cache-control", "public, max-age=31536000, immutable");
    },
  });

  /**
   * Socket auth handshake, pulls the session id from the client's
   * `auth: { token: ... }` handshake field. That field is set by the
   * web client from sessionStorage, so a fresh tab without a token
   * gets rejected at connect time and the user lands back on the
   * splash + login flow.
   *
   * We accept the token at two well-known shapes: `auth.token` (our
   * canonical) or the legacy `auth.sid` (Socket.io's "set whatever
   * key you like" surface, kept tolerant for future clients).
   */
  io.use(async (socket, next) => {
    try {
      const a = socket.handshake.auth as {
        token?: unknown;
        sid?: unknown;
        intent?: unknown;
        tabCharId?: unknown;
        tabRoomId?: unknown;
      } | undefined;
      const raw = typeof a?.token === "string" ? a.token : typeof a?.sid === "string" ? a.sid : "";
      const sid = raw.trim();
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
      // `intent === "login"` flags this connection as the one created
      // immediately after a fresh login / register submit. The client
      // consumes a one-shot sessionStorage marker so this is set on
      // exactly the first socket connect after a form submit, never
      // on socket reconnects, never on page reloads. The join broadcast
      // gates the "X has connected." chat message on this flag so
      // mobile suspend / network blip / tab reload no longer spam the
      // chat log; only an actual login produces the announcement.
      (socket.data as { loginIntent?: boolean }).loginIntent = a?.intent === "login";
      // Per-tab active character. Two seed sources, in order of priority:
      //
      //   1. `auth.tabCharId`, the client's persisted per-tab identity,
      //      replayed on every (re)connect from sessionStorage. The
      //      string value is a character id; `null` is an explicit OOC
      //      choice; undefined/missing means "no override, fall back to
      //      the DB". This is the multi-tab safety net: without it, a
      //      reconnect would re-seed from `users.activeCharacterId`,
      //      which a sibling tab may have mutated, the reconnected tab
      //      would then start posting messages tagged with the sibling
      //      tab's character even though its own UI still shows the
      //      original identity.
      //
      //   2. `user.activeCharacterId`, the DB default, used on the
      //      very first connect of a new tab before any /char has been
      //      issued. Always falls through to OOC when the user has no
      //      character set.
      //
      // We validate any string id against `characters` to ensure the
      // user actually owns it (defensive: handshake auth is client-
      // supplied, so don't trust the id blind). Invalid ids degrade
      // silently to the DB default, same behavior as a stale tab
      // whose character was deleted by another session.
      let tabCharId: string | null = user.activeCharacterId;
      if (typeof a?.tabCharId === "string") {
        const c = (await db
          .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
          .from(characters)
          .where(eq(characters.id, a.tabCharId))
          .limit(1))[0];
        if (c && c.userId === userId && !c.deletedAt) {
          tabCharId = c.id;
        }
      } else if (a?.tabCharId === null) {
        // Explicit OOC handshake, the user's last action on this tab
        // was /char clear (or never switched in), and they want to
        // stay master-voiced even though the DB may default elsewhere.
        tabCharId = null;
      }
      (socket.data as { tabCharId?: string | null }).tabCharId = tabCharId;
      // Per-tab last-known room. Same rationale as tabCharId: each tab
      // tracks its own room separately so a server restart / refresh
      // puts it back where IT was, instead of inheriting whatever
      // `users.lastRoomId` happens to hold (an account-global slot that
      // multiple tabs on different devices race to write). Stored raw
      // here, the connection handler validates existence /
      // public-vs-private / ban state before joining.
      if (typeof a?.tabRoomId === "string" && a.tabRoomId.length > 0) {
        (socket.data as { tabRoomId?: string }).tabRoomId = a.tabRoomId;
      }
      // Sync the in-memory user's activeCharacterId + displayName to
      // match the resolved tabCharId. Otherwise the user object the
      // socket carries until the next loadSessionUser still reflects
      // the DB default, and any early handler (e.g. room:join's
      // presence broadcast) would render this socket under the wrong
      // identity for the first beat.
      if (tabCharId !== user.activeCharacterId) {
        user.activeCharacterId = tabCharId;
        user.displayName = await resolveDisplayName(db, userId, tabCharId);
      }
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  io.on("connection", async (socket) => {
    const user = (socket.data as { user: import("./commands/types.js").SessionUser }).user;

    // Event-time IP capture. A socket's IP is fixed for the life of its TCP
    // connection, so recording it here covers every chat send / room switch on
    // this connection; a network change forces a reconnect, which re-captures
    // the new address. Cached on socket.data so per-event hooks below can keep
    // `last_seen_at` fresh without re-parsing the handshake. socket.io bypasses
    // Fastify's trustProxy, so extractSocketIp reproduces it from the headers.
    const clientIp = extractSocketIp(socket.handshake);
    (socket.data as { clientIp?: string | null }).clientIp = clientIp;
    {
      const ua = socket.handshake.headers["user-agent"];
      recordSocketIp(db, user.id, clientIp, Array.isArray(ua) ? ua[0] : ua, "connect");
    }

    // Auto-join the canonical landing room on connect for instant chat.
    // Prefers "The_Spire" by name (the seeded default); falls back to any
    // system room so installs with custom landings or pre-migration MainHall
    // still work.
    //
    // Multi-tab sync: if this user already has another live socket parked
    // in some room, the new tab should follow that room instead of the
    // landing default, otherwise opening a second tab silently drops you
    // into The_Spire while your other tab is still in (say) Tavern. Pick
    // any sibling that's currently in a room: ties are unlikely (a single
    // user usually has one focused room) and harmless (siblings are by
    // definition all in the same room post-sync).
    // Resolve a candidate room id to a join-able one, or null when it's
    // gone / private-and-not-a-member / banned / archived. Shared between
    // the per-tab cache (handshake `tabRoomId`) and the account-global
    // `users.lastRoomId` fallback so both go through the same gating.
    async function validateRoomForUser(candidateId: string | null): Promise<string | null> {
      if (!candidateId) return null;
      const room = (await db.select().from(rooms).where(eq(rooms.id, candidateId)).limit(1))[0];
      if (!room || room.archivedAt) return null;
      const ban = (await db
        .select()
        .from(bans)
        .where(and(eq(bans.roomId, room.id), eq(bans.userId, user.id)))
        .limit(1))[0];
      if (ban && (!ban.until || +ban.until > Date.now())) return null;
      if (room.type === "public") return room.id;
      const member = (await db
        .select()
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, user.id)))
        .limit(1))[0];
      return member ? room.id : null;
    }

    // Room-placement priority on (re)connect, highest wins:
    //
    //   1. This tab's per-tab cache (`socket.data.tabRoomId` from the
    //      handshake), replayed by the client from sessionStorage on
    //      every reconnect. Survives server restarts, mobile suspend,
    //      and page reloads. Account-isolated: a desktop tab in Tavern
    //      and a phone tab in Library each keep their own value.
    //      MUST run before the sibling-follow check below, otherwise a
    //      mass reconnect (server restart, network blip on a desktop
    //      with several tabs open) collapses every tab onto whichever
    //      one's handshake landed first, because that one had no
    //      siblings yet and the rest followed it. This tab's own
    //      remembered room is always the correct answer when it has
    //      one; sibling-follow is only meaningful for a tab that has
    //      no memory of its own.
    //   2. Sibling tab in this same browser, if there's another live
    //      socket for this user AND this tab had no remembered room,
    //      follow the sibling. Multi-tab UX: opening a brand-new tab
    //      silently lands you next to your existing tab instead of in
    //      the canonical landing.
    //   3. `users.lastRoomId`, account-global slot updated on every
    //      join. Useful for brand-new tabs on a new device that have
    //      no sessionStorage to replay yet AND no live siblings.
    //   4. The canonical landing (The_Spire / system-flagged default).
    //
    // Each candidate runs through validateRoomForUser so a stale id
    // (deleted room, since-archived, newly banned) silently degrades to
    // the next tier instead of dead-ending the connect.
    let initialRoomId: string | null = null;
    const tabRoomId = (socket.data as { tabRoomId?: string }).tabRoomId ?? null;
    initialRoomId = await validateRoomForUser(tabRoomId);
    if (!initialRoomId) {
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
    }
    if (!initialRoomId) {
      const userRow = (await db.select().from(users).where(eq(users.id, user.id)).limit(1))[0];
      initialRoomId = await validateRoomForUser(userRow?.lastRoomId ?? null);
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
      // Refresh the event-time IP log on real activity (chat send, room
      // switch, etc. all funnel through here). The connection's IP is fixed,
      // so this just bumps `last_seen_at`; the throttle inside recordSocketIp
      // keeps it to one write/min so a chat spammer can't hammer SQLite.
      const ip = (socket.data as { clientIp?: string | null }).clientIp;
      const uid = (socket.data as { userId?: string }).userId;
      recordSocketIp(db, uid, ip, null, "active");
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
        // Identity resolution for this send, in priority order:
        //
        //   1. `payload.asCharacterId`, the client's per-send claim
        //      pulled from its React state. This is the source of
        //      truth: it's what the user's UI says they're voicing
        //      RIGHT NOW. Validated against the user's owned
        //      characters; invalid (deleted / not owned) degrades
        //      silently to (2) so a stale tab doesn't get its send
        //      rejected.
        //   2. `socket.data.tabCharId`, the socket-scoped override
        //      from the handshake / last /char on this socket. The
        //      legacy path, kept as a fallback for older clients that
        //      don't ship `asCharacterId`.
        //   3. `fresh.activeCharacterId`, the DB default, applied
        //      when neither of the above is set.
        //
        // Without (1), a multi-tab race could let the server hand
        // this tab an identity its UI hasn't agreed to: sibling tab
        // /char SwitchToA mutates the shared `users.activeCharacterId`,
        // a reconnect on this tab re-seeds tabCharId from that DB
        // value, and the next send goes out tagged as A even though
        // this tab's UI is still rendering OOC.
        let resolvedCharId: string | null = user.activeCharacterId;
        const claim = payload.asCharacterId;
        if (typeof claim === "string") {
          const c = (await db
            .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
            .from(characters)
            .where(eq(characters.id, claim))
            .limit(1))[0];
          if (c && c.userId === user.id && !c.deletedAt) {
            resolvedCharId = c.id;
          } else {
            // Invalid claim → fall through to tabCharId (legacy path).
            const tabCharId = (socket.data as { tabCharId?: string | null }).tabCharId;
            if (tabCharId !== undefined) resolvedCharId = tabCharId;
          }
        } else if (claim === null) {
          // Explicit OOC claim.
          resolvedCharId = null;
        } else {
          // No claim, legacy path (tabCharId fallback).
          const tabCharId = (socket.data as { tabCharId?: string | null }).tabCharId;
          if (tabCharId !== undefined) resolvedCharId = tabCharId;
        }
        if (resolvedCharId !== user.activeCharacterId) {
          user.activeCharacterId = resolvedCharId;
          user.displayName = await resolveDisplayName(db, user.id, resolvedCharId);
        }
        // Keep the socket's sticky tabCharId in sync with the resolved
        // identity. This way a follow-up event handler that reads
        // socket.data.tabCharId (e.g. a presence broadcast triggered
        // by this send) sees the latest authoritative value, and a
        // reconnect-replay round-trip stays consistent.
        (socket.data as { tabCharId?: string | null }).tabCharId = resolvedCharId;
        // Validate the thread-category bucket (if any) belongs to the
        // target room. Race condition: an admin can delete the category
        // between the user opening the picker and submitting. Rather
        // than reject the send, drop to null and let the message land
        // in the "Uncategorized" bucket, discarding the message would
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
        // Forum payload, title (new topic) / replyToId (reply under
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
        // Drop this user's typing-indicator entry for the room now
        // that the message landed. Without this, a re-pulse mid-send
        // could leave their "is typing…" hanging in peers' UIs for
        // the entry-ttl window after their actual message displayed.
        clearTyperFromRoom(io, db, { roomId: payload.roomId, userId: user.id });
        ack?.({ ok: true });
      } catch (err) {
        log.error({ err }, "chat:input error");
        ack?.({ ok: false, code: "ERR", message: err instanceof Error ? err.message : "error" });
      }
    });

    /**
     * Typing pulse, see TypingTracker for the broadcast logic.
     * Authentication piggybacks on the connection's session
     * (`user` captured above); we don't gate on
     * `checkAndExtendSession` here because typing pulses fire many
     * times during normal use and shouldn't pay the session-write
     * cost of a chat send. Sessions still expire on chat:input /
     * presence:active / heartbeat, typing alone never extends them.
     *
     * Cheap rate-limit: drop pulses arriving faster than once every
     * 1.5s for the same room. The client throttles to ~2s already;
     * this guards against a misbehaving / hostile client.
     */
    let lastTypingPulseAt = 0;
    socket.on("chat:typing", async (payload) => {
      const now = Date.now();
      if (now - lastTypingPulseAt < 1_500) return;
      lastTypingPulseAt = now;
      // Reject pulses for rooms this socket isn't subscribed to,
      // typing in a room you can't see has no signal value and
      // would let a stale tab pollute another room's indicator.
      if (!socket.rooms.has(`room:${payload.roomId}`)) return;
      // Resolve the typer's identity from the per-tab claim, same
      // pattern as chat:input. Without this, the indicator pulled
      // identity off the closure-captured `user.displayName`, which
      // a sibling tab's /char-switch could rewrite mid-conversation;
      // a tab actually composing on OOC would still emit pulses
      // labeled with the user's character. The claim is validated
      // against the user's own characters; an invalid or omitted
      // claim falls back to socket.data.tabCharId, then user.activeCharacterId.
      let typingCharId: string | null = user.activeCharacterId;
      const claim = payload.asCharacterId;
      if (typeof claim === "string") {
        const c = (await db
          .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
          .from(characters)
          .where(eq(characters.id, claim))
          .limit(1))[0];
        if (c && c.userId === user.id && !c.deletedAt) {
          typingCharId = c.id;
        } else {
          const tabCharId = (socket.data as { tabCharId?: string | null }).tabCharId;
          if (tabCharId !== undefined) typingCharId = tabCharId;
        }
      } else if (claim === null) {
        typingCharId = null;
      } else {
        const tabCharId = (socket.data as { tabCharId?: string | null }).tabCharId;
        if (tabCharId !== undefined) typingCharId = tabCharId;
      }
      const typingDisplayName = typingCharId === user.activeCharacterId
        ? user.displayName
        : await resolveDisplayName(db, user.id, typingCharId);
      markTyping(io, db, {
        roomId: payload.roomId,
        userId: user.id,
        displayName: typingDisplayName,
        characterId: typingCharId,
      });
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
      clearTyperFromRoom(io, db, { roomId: payload.roomId, userId: user.id });
      await broadcastPresence(io, db, payload.roomId);
    });

    /**
     * Theater (watch-party) playback control. Owner/mod-only: we re-check
     * the room-edit gate server-side so a viewer can't drive playback by
     * crafting the event in devtools. Mutates the in-memory live state and
     * fans the new `theater:sync` out to the whole room.
     */
    socket.on("theater:control", async (payload, ack) => {
      if (!(await checkAndExtendSession())) {
        ack?.({ ok: false, code: "AUTH", message: "Session expired. Please log in again." });
        return;
      }
      const { roomId, action } = payload;
      if (!socket.rooms.has(`room:${roomId}`)) {
        ack?.({ ok: false, code: "NO_ROOM", message: "You are not in that room." });
        return;
      }
      const room = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
      if (!room || !room.theaterMode) {
        ack?.({ ok: false, code: "NO_THEATER", message: "Theater mode is not on in this room." });
        return;
      }
      // `ended` / `error` are PASSIVE end-of-source signals any viewer's
      // player emits; allowing them from non-controllers is what keeps the
      // playlist advancing (and skipping dead sources) when no mod is around.
      // ACTIVE controls still require the room-edit gate.
      const isPassive = action === "ended" || action === "error";
      if (!isPassive && !(await callerCanEditRoom(db, user, roomId))) {
        ack?.({ ok: false, code: "PERM", message: "Only the room owner or a mod can control playback." });
        return;
      }
      const playlist = parsePlaylist(room.theaterPlaylist);
      applyControl(roomId, action, {
        positionSec: payload.positionSec,
        index: payload.index,
        len: playlist.length,
        loop: room.theaterLoop,
        now: Date.now(),
      });
      await broadcastTheaterSync(io, roomId);
      // Checkpoint the new playback state so a restart resumes from this
      // control (a fresh seek/pause survives even a crash 1s later, ahead
      // of the next 30s sweep). The `progress` heartbeat fires every ~10s,
      // though; let the periodic sweep persist those rather than writing the
      // row on every beat.
      if (action !== "progress") await persistTheaterCheckpoint(db, roomId);
      ack?.({ ok: true });
    });

    /**
     * Floating emoji reaction over the theater video. Open to any occupant
     * (it's a lightweight cheer, not a control action). Rate-limited per
     * socket so a hostile client can't flood the room. `side` alternates so
     * reactions drift up both edges.
     */
    let theaterReactTimes: number[] = [];
    let theaterReactSide: "left" | "right" = "left";
    socket.on("theater:react", async (payload) => {
      if (!(await checkAndExtendSession())) return;
      const { roomId } = payload;
      if (!socket.rooms.has(`room:${roomId}`)) return;
      const now = Date.now();
      theaterReactTimes = theaterReactTimes.filter((t) => t > now - 5_000);
      if (theaterReactTimes.length >= 12) return; // 12 reactions / 5s
      theaterReactTimes.push(now);
      const emoji = (payload.emoji ?? "").trim().slice(0, 8);
      if (!emoji) return;
      theaterReactSide = theaterReactSide === "left" ? "right" : "left";
      io.to(`room:${roomId}`).emit("theater:reaction", {
        roomId,
        userId: user.id,
        displayName: user.displayName,
        emoji,
        side: theaterReactSide,
      });
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
      // Same slug → username normalization as the HTTP /profiles/:name
      // route. Some clients (in-chat name clicks) hand us the canonical
      // NBSP form already; others (URL-derived calls) carry the slug
      // with a regular space. slugToUsername resolves both.
      // Pass the socket's authenticated userId so the owner viewing
      // their own profile bypasses the hide-count redaction.
      const viewerId = (socket.data as { userId?: string }).userId;
      const profile = await lookupProfile(db, slugToUsername(payload.username), viewerId);
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
    /**
     * Per-tab character switch. Mirrors what `/char switch` does in chat,
     * but is the entry point for UI buttons (ProfileEditor "Switch to
     * this character", profile-modal action chip) that previously hit
     * the HTTP `PUT /me/active-character` endpoint and synced every tab.
     *
     * Side effects on success:
     *   1. socket.data.tabCharId is set, this socket's outgoing messages
     *      now carry the new identity.
     *   2. user.activeCharacterId + user.displayName mutate in-place so
     *      any in-flight handler on this socket sees the fresh value.
     *   3. users.activeCharacterId in the DB is updated so a *fresh* tab
     *      opened later defaults to this character. Already-connected
     *      tabs are NOT touched, that's the entire point of the per-
     *      socket scope.
     *   4. Presence in the current room is rebroadcast so the userlist
     *      reflects the new name on everyone's screen.
     *   5. me:character-update is emitted to this socket so the React
     *      state in this tab can refresh activeCharacterId/Name + theme
     *      without polling /me/profile.
     */
    socket.on("me:switch-character", async (payload, ack) => {
      try {
        if (!(await checkAndExtendSession())) {
          ack?.({ ok: false, code: "AUTH", message: "Session expired." });
          return;
        }
        const requested = payload.characterId;
        if (requested !== null) {
          const c = (await db
            .select()
            .from(characters)
            .where(eq(characters.id, requested))
            .limit(1))[0];
          if (!c || c.deletedAt || c.userId !== user.id) {
            ack?.({ ok: false, code: "NO_CHAR", message: "Character not found." });
            return;
          }
        }
        await db.update(users).set({ activeCharacterId: requested }).where(eq(users.id, user.id));
        (socket.data as { tabCharId?: string | null }).tabCharId = requested;
        user.activeCharacterId = requested;
        user.displayName = await resolveDisplayName(db, user.id, requested);
        const roomId = (socket.data as { roomId?: string }).roomId;
        if (roomId) {
          const { broadcastPresence } = await import("./realtime/broadcast.js");
          await broadcastPresence(io, db, roomId);
        }
        const name = requested === null ? null : user.displayName;
        socket.emit("me:character-update", {
          activeCharacterId: requested,
          activeCharacterName: name,
        });
        ack?.({ ok: true, activeCharacterId: requested, activeCharacterName: name });
      } catch (err) {
        log.error({ err }, "me:switch-character error");
        ack?.({ ok: false, code: "ERR", message: err instanceof Error ? err.message : "error" });
      }
    });

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

    // Intentional exit: client fires this immediately before
    // disconnecting via the Exit button. The flag tells the
    // disconnect handler to emit the "X has disconnected." chat
    // broadcast, otherwise the disconnect is treated as transient
    // (mobile suspend, tab close, network drop) and stays silent.
    // No ack needed; the client doesn't wait for one (it disconnects
    // right after the emit).
    socket.on("me:exit", () => {
      (socket.data as { exitIntent?: boolean }).exitIntent = true;
    });

    // Client-driven re-sync. Fires when the Chat component mounts onto a
    // socket that was already connected by an App-level effect (e.g.
    // the deep-link standalone shell created the socket while the user
    // viewed /p/<name>, then they dismissed and Chat mounted late),
    // the initial join broadcasts went out before Chat's listeners were
    // attached, so the chat shell renders blank until we re-emit the
    // current room's state and backlog to this socket.
    socket.on("me:resync", async () => {
      const currentRoomId = [...socket.rooms]
        .filter((r) => r.startsWith("room:"))
        .map((r) => r.slice(5))[0] ?? null;
      if (!currentRoomId) return;
      await sendRoomStateTo(socket, io, db, currentRoomId);
      await sendRoomBacklogTo(socket, db, currentRoomId, user.id);
    });

    // We use `disconnecting` (not `disconnect`) because by the time
    // `disconnect` fires, socket.rooms is already empty - we'd miss the
    // room ids we need to notify and check for auto-expiry.
    socket.on("disconnecting", () => {
      const roomIds = [...socket.rooms]
        .filter((r) => r.startsWith("room:"))
        .map((r) => r.slice(5));
      // Drop any typing-indicator entries this user had. If a
      // sibling tab is still typing, its next pulse (within ~2s)
      // re-adds them. Worst case is a brief flicker in peers' UIs;
      // far less awkward than a stuck "is typing…" pinned to a
      // disconnected tab for the full TTL.
      clearTyperEverywhere(io, db, user.id);
      // Snapshot the user identity now - by the time the deferred cleanup
      // runs, the SessionUser object on this socket may already be gone.
      const userId = user.id;
      const displayName = user.displayName;
      const socketId = socket.id;
      // Resolve the identity this socket was voicing. tabCharId is the
      // per-socket override; when `undefined` (no /char issued on this
      // tab) we fall back to the user-level activeCharacterId we hold on
      // the SessionUser. Captured here, in the sync handler, so the
      // deferred cleanup doesn't see a stale value if the user object
      // mutates underneath us. `null` means OOC; a string is the active
      // character id.
      const tabCharRaw = (socket.data as { tabCharId?: string | null }).tabCharId;
      const characterId: string | null = tabCharRaw !== undefined
        ? tabCharRaw
        : (user.activeCharacterId ?? null);
      // Snapshot the intentional-exit flag too. The Exit button emits
      // `me:exit` immediately before disconnecting, which sets this on
      // socket.data, the disconnect handler reads it to decide between
      // (a) firing "X has disconnected." + immediate cleanup, vs.
      // (b) ghosting the identity into the userlist as idle so a
      // returning tab doesn't churn the rail or the chat log.
      const exitIntent = (socket.data as { exitIntent?: boolean }).exitIntent === true;

      // Defer the work so the socket actually finishes leaving its rooms first;
      // otherwise expireIfEmpty would still see this socket present.
      setTimeout(() => {
        (async () => {
          // "Has this user gone offline entirely?" - true only when no
          // sibling sockets remain anywhere on the io server. Drives
          // the lastRoomId persist (so the next cold connect lands them
          // back where they were).
          const fullyOffline = !(await userIsOnline(io, userId, socketId));

          if (fullyOffline) {
            // Defensive re-write of lastRoomId on full disconnect. The
            // canonical path now writes lastRoomId on every joinRoom
            // (see realtime/broadcast.ts), so by the time we get here
            // the DB already holds the right value. We still write it
            // again as a backstop in case a future joinRoom path skips
            // the update, idempotent, costs one indexed UPDATE.
            const lastRoomId = (socket.data as { roomId?: string }).roomId ?? null;
            if (lastRoomId) {
              await db.update(users).set({ lastRoomId }).where(eq(users.id, userId));
            }
            // Drop every per-identity away + mood mark for this
            // user. Both are session signals, when the user has
            // truly closed every tab and gone, the next login should
            // land them present with a clean mood slate, not carrying
            // a stale "brb" / "tired" from yesterday.
            clearAllAwayForUser(userId);
            clearAllMoodForUser(userId);
          }

          // Per-room decision. For each room the socket was in:
          //   - exitIntent (Exit button): fire the "has disconnected"
          //     line immediately (forum rooms suppress as before) and
          //     run the usual expireIfEmpty + broadcastPresence. No
          //     ghosting, the user explicitly left.
          //   - non-exit (tab close, refresh, network drop): if this
          //     identity has no other live socket in the room, register
          //     an idle ghost. The userlist re-broadcast that follows
          //     shows the row faded with "(idle)". The room is held
          //     open via the ghost's expireIfEmpty short-circuit until
          //     the idle window elapses with no return.
          // Master-only session-exit template lookup. Same fetch
          // shape the join path uses for the connect side. One row
          // per disconnect; null = use the default "X has
          // disconnected." phrasing.
          const sessionExitRow = (await db
            .select({ sessionExitTemplate: userEarning.sessionExitTemplate })
            .from(userEarning)
            .where(eq(userEarning.userId, userId))
            .limit(1))[0];
          const sessionExitTemplate = sessionExitRow?.sessionExitTemplate ?? null;
          for (const id of roomIds) {
            if (exitIntent) {
              const expired = await expireIfEmpty(io, db, id);
              if (expired) continue;
              const stillThere = await userHasSocketInRoom(io, userId, id);
              if (!stillThere) {
                const r = (await db.select().from(rooms).where(eq(rooms.id, id)).limit(1))[0];
                // Forum rooms suppress regardless of intent, the topic
                // feed isn't a chat log.
                if (r?.replyMode !== "nested") {
                  await addSystemMessage(io, db, id, renderPresenceTemplate(
                    sessionExitTemplate,
                    DEFAULT_PRESENCE_TEMPLATES.sessionExit,
                    { name: displayName, room: r?.name ?? "" },
                  ));
                }
              }
              await broadcastPresence(io, db, id);
              continue;
            }
            // Non-intentional disconnect: ghost this identity if it
            // has no other live socket in this room. Same-character
            // sibling tab in the same room keeps the row live and we
            // skip the ghost. Different-character sibling means the
            // closed tab's identity still needs a ghost; the live
            // sibling shows up as its own row.
            const identityStillLive = await userIdentityHasSocketInRoom(
              io,
              userId,
              characterId,
              id,
            );
            if (!identityStillLive) {
              await registerIdleGhost(db, {
                userId,
                characterId,
                roomId: id,
                displayName,
              });
            }
            // Broadcast presence regardless, the userlist either
            // gains the idle row (just ghosted) or rebroadcasts the
            // unchanged state (sibling kept the identity live). Skip
            // expireIfEmpty: a ghost is now holding the room, and
            // even if the identity stayed live, a sibling socket is
            // still present so the room isn't empty.
            await broadcastPresence(io, db, id);
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
    return await renderSitemapXml(db, originFromRequest(req));
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

      /**
       * Build the per-response Content-Security-Policy. Strict by design:
       * scripts and styles must carry the fresh nonce (or be loaded by
       * something that did, courtesy of `'strict-dynamic'` on scripts).
       * Inline `style="..."` attributes are governed by the separate
       * `style-src-attr` directive, React's `style={{...}}` props
       * produce those and we can't reasonably hash them per render, so
       * we accept `'unsafe-inline'` *for attributes only*. Inline
       * `<style>` blocks still need the nonce.
       *
       * Tweak guides for future edits:
       *   - `img-src 'self' data: https:` is permissive on purpose:
       *     avatars and admin-uploaded banner covers can point anywhere
       *     on HTTPS.
       *   - `connect-src 'self'` covers the websocket too (same-origin
       *     ws:// is treated as same-origin per the CSP3 spec).
       *   - `frame-ancestors 'none'` is the modern replacement for
       *     X-Frame-Options: DENY; we ship both for older browsers.
       *   - `frame-src` lists only the embed origins that the markdown
       *     renderer's "Show video" toggle can build src URLs for (see
       *     `parseVideoEmbed` in apps/web/src/lib/markdown.tsx). Keep this
       *     list in sync with the providers supported there, every new
       *     provider needs both a parser branch AND a frame-src origin or
       *     the iframe will silently fail with a CSP violation.
       */
      function buildCsp(nonce: string): string {
        return [
          "default-src 'self'",
          `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
          // Google Fonts CSS sheet is loaded via <link rel=stylesheet>
          // for the font-picker preview surface; the stylesheet body
          // itself references fonts.gstatic.com (covered in font-src).
          `style-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com`,
          "style-src-attr 'unsafe-inline'",
          "img-src 'self' data: https:",
          // Google Fonts woff2 files live on fonts.gstatic.com.
          "font-src 'self' data: https://fonts.gstatic.com",
          "connect-src 'self'",
          "media-src 'self'",
          "worker-src 'self'",
          "manifest-src 'self'",
          "object-src 'none'",
          "base-uri 'self'",
          "frame-ancestors 'none'",
          "frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com",
          "form-action 'self'",
          "upgrade-insecure-requests",
        ].join("; ");
      }

      // GET / and any non-API GET that should serve the SPA shell go
      // through the SEO renderer so admin-configured siteName / meta
      // description / analytics scripts land in the HTML before crawlers
      // (or anyone) parses it.
      const serveSplash = async (req: FastifyRequest, reply: FastifyReply) => {
        const nonce = generateCspNonce();
        const html = await renderSplashHtml(
          db,
          originFromRequest(req),
          req.url.split("?")[0] ?? "/",
          await getIndexHtml(),
          nonce,
        );
        reply.header("content-security-policy", buildCsp(nonce));
        reply.type("text/html; charset=utf-8");
        // The SPA shell references content-hashed asset filenames that
        // change on every build. If we let browsers (or any intermediary
        // cache: ISP, corporate proxy, Fly's edge) hold onto an old copy
        // of this HTML, a returning visitor's `index.html` will point at
        // /assets/index-OLDHASH.js, which no longer exists on the new
        // deploy, and the app silently breaks. Previously we shipped
        // `public, max-age=60`, which combined with Chrome's heuristic
        // cache extension routinely held the shell for hours and forced
        // users to clear history to recover. `no-cache` (NOT `no-store`)
        // permits caching but requires revalidation on every use, so the
        // hashed assets underneath still get their year-long immutable
        // caching, only the thin HTML shell pays the round-trip cost.
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
      // the bookmarkable entrance pages, the React app picks them off
      // window.location.pathname and mounts the right form. Without
      // these explicit handlers, the setNotFoundHandler below would
      // serve the themed 404 page and the React app would never boot.
      // Single-segment params only, /p/foo/bar still falls through to
      // the 404.
      app.get("/p/:name", publicLimit, serveSplash);
      app.get("/u/:name", publicLimit, serveSplash);
      app.get("/w/:slug", publicLimit, serveSplash);
      app.get("/login", publicLimit, serveSplash);
      app.get("/register", publicLimit, serveSplash);
      // Scriptorium, public catalog of SFW stories + canonical story
      // permalinks. `/scriptorium` opens the catalog modal; the
      // `@handle/slug` form is the shareable per-story URL. The catalog
      // endpoint already enforces SFW-only for anonymous viewers, so the
      // page is safe to render to unauthenticated visitors.
      app.get("/scriptorium", publicLimit, serveSplash);
      app.get("/scriptorium/@:handle/:slug", publicLimit, serveSplash);
      // Public Rules page, same anonymous-safe SPA route pattern. The
      // not-found handler's `apiPrefixes` block intentionally OMITS
      // `/rules` so the JSON moved to `/api/rules` doesn't get shadowed,
      // but that change alone left `/rules` hitting `setNotFoundHandler`
      // and rendering the themed 404 ("Lost the path") instead of
      // booting the React app. Add the explicit handler here alongside
      // the other deep-link routes so the SPA shell actually serves.
      app.get("/rules", publicLimit, serveSplash);

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
        // `/rules` is intentionally NOT in this list, it's now a public
        // SPA route rendering a dedicated rules page. The JSON endpoint
        // moved to `/api/rules` (in the list below) so the SPA shell
        // doesn't shadow it.
        const apiPrefixes = ["/api", "/auth", "/admin", "/characters", "/profiles", "/nav-links", "/rooms", "/stats", "/commands", "/messages", "/reports", "/push", "/affiliates", "/worlds", "/me", "/health", "/users", "/site", "/socket.io", "/thesaurus"];
        if (apiPrefixes.some((p) => req.url === p || req.url.startsWith(p + "/") || req.url.startsWith(p + "?"))) {
          reply.code(404);
          return reply.send({ error: "not found" });
        }
        const nonce = generateCspNonce();
        const html = await render404Html(db, originFromRequest(req), nonce);
        reply.code(404);
        reply.header("content-security-policy", buildCsp(nonce));
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
  // Launch the announcement scheduler AFTER `app.listen` so any
  // crash during the read/dispatch path doesn't block boot. The
  // tick is idempotent so a double-call (dev hot-reload) won't
  // stack timers; the started timer captures `db` + `io` by
  // closure so its lifetime is the process's.
  startAnnouncementScheduler({ db, io });
  // Durable boot-ok marker. Survives the Fly log purge so a future
  // "what was the last successful boot?" question has an answer.
  recordBootSuccess({ port: PORT, mode: IS_PROD ? "production" : "development" });
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
  // Persistent boot-fail entry on the /data volume so even when Fly
  // purges the in-memory log scrollback (after 10 restarts), the
  // last error survives. The pino log goes to stdout too in case a
  // human is watching live.
  recordBootFailure(err);
  log.error({ err }, "fatal");
  process.exit(1);
});
