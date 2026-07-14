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
import fastifyStatic from "@fastify/static";
import { type FastifyReply, type FastifyRequest } from "fastify";
import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import pino from "pino";
import { db } from "./db/index.js";
// i18n catalog (plan Phase 0): loads the shared locale files from disk at
// boot so `tFor` is ready before any request lands. `parseAcceptLanguage`
// resolves the splash-page language for logged-out visitors (plan §7).
import { parseAcceptLanguage } from "./i18n.js";
import { matchSupportedLocale } from "@thekeep/shared";
import { createApp, createIo } from "./bootstrap.js";
import { installHandshake } from "./handshake.js";
import { wireSocketHandlers } from "./socketHandlers.js";
import { registerAllRoutes } from "./registerRoutes.js";
import { rooms, serverSettings, servers, users } from "./db/schema.js";
import { betaBadgeActive } from "./lib/betaBadge.js";
import { DEFAULT_SERVER_ID } from "./earning/pool.js";
import { CommandRegistry } from "./commands/registry.js";
import { registerBuiltins } from "./commands/builtins/index.js";
import {
  checkpointPlayingTheaters,
  hydrateTheaterFromDb,
  expireIfEmpty,
  setGhostSweepIo,
} from "./realtime/broadcast.js";
import { restorePresenceSnapshot, writePresenceSnapshot } from "./realtime/presenceSnapshot.js";
import { startTypingTracker } from "./realtime/typing.js";
import { lookupProfile } from "./commands/builtins/profile.js";
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
import { loadBannedIpCache } from "./auth/ipBan.js";
import { registerAuthRoutes, getSessionUser, slugToUsername } from "./routes/auth.js";
import { registerGoogleAuthRoutes } from "./routes/googleAuth.js";
import { registerCommandsRoutes } from "./routes/commands.js";
import { registerAnnouncementsRoutes } from "./routes/announcements.js";
import { registerFaqRoutes } from "./routes/faqs.js";
import { registerRegistrationRulesRoutes } from "./routes/registrationRules.js";
import { registerUnsubscribeRoute } from "./routes/unsubscribe.js";
import { registerProfileFlairRoutes } from "./routes/profileFlair.js";
import { startAnnouncementScheduler } from "./admin/announcements.js";
import { startEventReminderSweep } from "./servers/events.js";
import { startEmailQueue } from "./email/queue.js";
import { registerNavLinkRoutes } from "./routes/nav-links.js";
import { startAnalyticsRollupScheduler } from "./analytics/rollup.js";
import { ensureSystemSeeds, startJanitor } from "./seed.js";
import { getSettings, areServersEnabled } from "./settings.js";
import { minimumSignupAge } from "./auth/ageGate.js";
import { googleConfigured } from "./auth/googleOauth.js";

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

  const app = await createApp({
    log,
    db,
    sessionSecret: SESSION_SECRET,
    webOrigin: WEB_ORIGIN,
    isProd: IS_PROD,
  });

  // createApp already returns the base FastifyInstance shape the route
  // registrars expect (it does the pino→FastifyBaseLogger cast internally).
  const baseApp = app;
  await registerAuthRoutes(baseApp, db);
  // Google sign-in (OAuth) routes. Self-gates to a no-op when GOOGLE_CLIENT_ID/
  // SECRET are unset, so every /auth/google/* path stays 404 on an unconfigured
  // deploy (mirrors the youtubeConfigured / googleConfigured env posture).
  await registerGoogleAuthRoutes(baseApp, db);
  await registerCommandsRoutes(baseApp, db, registry);
  // Public marquee banners, unauthenticated; the splash + chat
  // shell paint these for every viewer. Admin CRUD lives behind
  // /admin/announcements/* via the admin route module.
  await registerAnnouncementsRoutes(baseApp, db);
  await registerFaqRoutes(baseApp, db);
  // Public registration-rules read (server/forum application "I agree" gate).
  await registerRegistrationRulesRoutes(baseApp, db);
  // Public one-click unsubscribe landing for broadcast email footers.
  await registerUnsubscribeRoute(baseApp, db);
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
    // Age gate (age-restriction plan Phase 1): a signed-in viewer under 18
    // never sees an 18+ profile. lookupProfile already withheld the payload
    // (this `profile` is the hollow shell), so this branch is about handing
    // the deep-link path the friendly stub verdict, not about hiding bytes.
    // `ageRestricted` tells the client there is NO proceed path and no
    // sign-in prompt, the viewer's age is what gates it, hence
    // `requiresAuth: false`. Adults (hide preference or not) never hit this.
    if (profile.profile.isNsfw && me && !me.isAdult) {
      return {
        private: true as const,
        name: profile.kind === "master" ? profile.profile.username : profile.profile.name,
        kind: profile.kind,
        requiresAuth: false,
        ageRestricted: true as const,
      };
    }
    return profile;
  });

  /**
   * Resolve the ACTIVE server for a per-server-content request, in priority:
   *   1. an explicit `?serverId` query param (the client sends its current
   *      server) — accepted only when it names a LIVE (non-archived) server;
   *   2. otherwise the session user's `default_server_id` (their home/favorite),
   *      when it still points at a live server;
   *   3. otherwise null — no server context (e.g. the pre-login splash, or a
   *      logged-in user who hasn't picked a favorite and sent no `?serverId`).
   *
   * The system/default server resolves to null too: its per-server content is a
   * verbatim copy of the platform values, so "no active server" and "the system
   * server" are intentionally equivalent here — both surface the global copy as
   * `appRules` with `serverRules` null. FLAG-OFF SAFETY: with servers off no one
   * sends a `?serverId` and no one has a favorite, so this always returns null
   * and the responses below collapse to the legacy single-server shape.
   */
  async function resolveActiveServerId(req: FastifyRequest): Promise<string | null> {
    const liveServerId = async (id: string | null | undefined): Promise<string | null> => {
      if (!id || id === DEFAULT_SERVER_ID) return null;
      const row = (await db
        .select({ id: servers.id, status: servers.status, isSystem: servers.isSystem })
        .from(servers)
        .where(eq(servers.id, id))
        .limit(1))[0];
      if (!row || row.status === "archived" || row.isSystem) return null;
      return row.id;
    };
    const q = (req.query as { serverId?: string } | undefined)?.serverId;
    const fromQuery = await liveServerId(typeof q === "string" ? q : null);
    if (fromQuery) return fromQuery;
    const me = await getSessionUser(req, db);
    if (!me) return null;
    const u = (await db.select({ fav: users.defaultServerId }).from(users).where(eq(users.id, me.id)).limit(1))[0];
    return liveServerId(u?.fav ?? null);
  }

  /**
   * Read the RAW per-server HTML overrides off `server_settings` for the active
   * server, or all-null when there's no active server. RAW (not merged): a NULL
   * column means "this server set no override of its own", which the per-server
   * surfaces below must surface as null (NOT the inherited platform copy) so the
   * client can tell "the server has its own rules" apart from "inheriting".
   */
  async function activeServerHtml(req: FastifyRequest): Promise<{
    serverId: string | null;
    rulesHtml: string | null;
    securityNoticeHtml: string | null;
    welcomeHtml: string | null;
  }> {
    const serverId = await resolveActiveServerId(req);
    if (!serverId) return { serverId: null, rulesHtml: null, securityNoticeHtml: null, welcomeHtml: null };
    const row = (await db
      .select({
        rulesHtml: serverSettings.rulesHtml,
        securityNoticeHtml: serverSettings.securityNoticeHtml,
        welcomeHtml: serverSettings.welcomeHtml,
      })
      .from(serverSettings)
      .where(eq(serverSettings.serverId, serverId))
      .limit(1))[0];
    return {
      serverId,
      rulesHtml: row?.rulesHtml ?? null,
      securityNoticeHtml: row?.securityNoticeHtml ?? null,
      welcomeHtml: row?.welcomeHtml ?? null,
    };
  }

  /**
   * Public branding endpoint - readable without authentication so the login
   * screen, boot splash, and tab title can show the site's configured name
   * and logo styling. Returns ONLY the public-facing fields; admin-only
   * settings (retention, session TTL) live behind /admin/settings.
   */

  app.get("/site", publicLimit, async (req) => {
    const s = await getSettings(db);
    // Per-server welcome: when the request carries an active-server context
    // (`?serverId` or the session user's favorite), prefer THAT server's own
    // welcome copy and fall back to the global one when the server set none.
    // No active server (the pre-login splash) → the global copy, byte-identical.
    const serverHtml = await activeServerHtml(req);
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
      // Current signup age floor (18, or 13 when allowMinorSignups is on).
      // Cosmetic only — the register form's helper copy and the date
      // input's `max` read it; the server re-validates on POST.
      minimumSignupAge: minimumSignupAge(s),
      // Sanitized welcome message rendered above the splash login form. When an
      // active server is in context, its own welcome copy takes precedence;
      // otherwise (no active server, or the server set none) the global copy.
      welcomeHtml: serverHtml.welcomeHtml ?? s.welcomeHtml,
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
      // Splash "Beta" chip + hero line. Admin toggle ANDed with the
      // app-version gate (VERSION < 1.0.0) server-side, so the anonymous
      // splash only ever sees a single boolean and the badge self-retires
      // the moment a 1.0.0 build ships.
      betaBadgeEnabled: betaBadgeActive(s),
      // Visual bio Designer (GrapesJS) availability. When on, the profile
      // editor's bio tab offers a Designer/Source toggle (desktop only).
      profileDesignerEnabled: s.profileDesignerEnabled,
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
      // Multi-server feature flag: the soft DB switch (site_settings
      // .servers_enabled) ANDed with the SERVERS_KILL operator override.
      // The web ServerRail and every server-scoped surface render ONLY when
      // this is true; false keeps the chat shell byte-identical to the
      // single-server experience. Without this field the client always
      // defaults to false, so the feature can never light up — wire it here.
      serversEnabled: areServersEnabled(s),
      // World map uploads flag (migration 0360). The world editor reads it
      // off the branding store to decide whether to offer the map-image
      // upload picker beside the external-URL field; the map routes enforce
      // it server-side regardless. Boolean only — same public posture as
      // profileDesignerEnabled.
      worldMapUploadsEnabled: s.worldMapUploadsEnabled,
      // Env-gated: whether the operator configured Google OAuth credentials, so
      // the client hides the sign-in-with-Google button when it can't work. Pure
      // env boolean (no admin toggle). (YouTube for /theater needs no client
      // flag: videos still play without an API key — the key only enables
      // server-side playlist expansion + title lookup, gated by youtubeConfigured
      // in the /theater handler, and both degrade gracefully.)
      googleAuthEnabled: googleConfigured,
    };
  });

  /**
   * Public rules JSON endpoint. Serves a TWO-TAB rules contract:
   *
   *   - `appRules`    — the GLOBAL "App / House Rules" that GOVERN everything
   *                     (every server and the site). This stays platform-wide
   *                     (`settings.rulesHtml`); empty string → null.
   *   - `serverRules` — the ACTIVE server's own "Server Rules"
   *                     (`server_settings.rules_html`, RAW so unset = null). The
   *                     active server is the request's `?serverId` (the client
   *                     sends its current server) or the session user's
   *                     `default_server_id`; null when there's no server context
   *                     (the pre-login splash) or the server set no rules.
   *
   * The two are DISTINCT and never merged: the app rules always apply; a server
   * may ADD its own house rules on top. `rulesHtml` / `securityNoticeHtml` are
   * retained for back-compat with the existing single-tab modal — `rulesHtml`
   * stays the governing global copy; `securityNoticeHtml` prefers the active
   * server's notice when set, else the global one.
   *
   * Path moved from `/rules` to `/api/rules` in an earlier revision because the
   * `/rules` path is now a public SPA route rendering a dedicated landing page
   * (so a not-yet-registered visitor can read the rules before signing up). The
   * page route fetches THIS endpoint for its content; the rename keeps the JSON
   * endpoint and the page URL on distinct slots so the SPA-shell catchall
   * doesn't accidentally serve HTML in response to a fetch.
   */
  app.get("/api/rules", publicLimit, async (req) => {
    const s = await getSettings(db);
    const serverHtml = await activeServerHtml(req);
    return {
      // Two-tab contract (the per-server rules-modal lane consumes these two):
      appRules: s.rulesHtml.trim() ? s.rulesHtml : null,
      serverRules: serverHtml.rulesHtml,
      // Back-compat fields for the current single-tab modal. `rulesHtml` is the
      // governing global copy; the security notice prefers the active server's.
      rulesHtml: s.rulesHtml,
      securityNoticeHtml: serverHtml.securityNoticeHtml ?? s.securityNoticeHtml,
    };
  });

  app.get("/health", async () => ({ ok: true }));

  const httpServer = app.server;
  const io = createIo(httpServer, WEB_ORIGIN);
  // Hand io to the ghost-sweep timer in broadcast.ts so its setTimeout
  // closure can call back into expireIfEmpty + broadcastPresence when an
  // idle ghost finally times out. We don't pass io through `registerIdleGhost`
  // every call because the timer outlives the call that scheduled it.
  setGhostSweepIo(io);

  // ── Presence persistence across restarts ──────────────────────────────
  // Away / mood / idle state is in-memory, so a plain restart (and notably a
  // remote-deploy.sh Fly deploy) would reset everyone to "present" and drop
  // the "(idle)" rows. Restore the snapshot the LAST graceful shutdown wrote
  // BEFORE we start accepting reconnects, so a returning user reclaims their
  // away mark + clears their idle ghost silently. Best-effort + stale-guarded
  // inside, and wrapped so a bad snapshot can never block boot.
  try {
    await restorePresenceSnapshot(db);
  } catch (err) {
    log.error({ err }, "presence restore failed; booting with empty presence");
  }
  // Persist that same state on the way down. Fly's default stop signal is
  // SIGINT (then SIGTERM); we handle both. The write is synchronous and
  // best-effort so it can never hang the shutdown, and we then exit because
  // registering a handler overrides Node's default terminate-on-signal.
  let shuttingDown = false;
  const onShutdownSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      writePresenceSnapshot(db);
      log.info({ signal }, "presence snapshot saved on shutdown");
    } catch (err) {
      log.error({ err, signal }, "presence snapshot failed on shutdown");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => onShutdownSignal("SIGTERM"));
  process.on("SIGINT", () => onShutdownSignal("SIGINT"));

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

  // Account-ban expiry sweep. Timed bans set `bannedUntil`; when it
  // passes, clear the ban columns AND `disabledAt` (which the ban set to
  // block login/chat) so the account silently regains access. Login also
  // lazy-lifts an expired ban, this catches accounts that never try to log
  // back in so their banned state doesn't linger in mod review surfaces.
  // Permanent bans (bannedUntil null) and plain admin disables (bannedAt
  // null) are untouched. `.unref()` so it never holds the process open.
  const BAN_SWEEP_MS = 60_000;
  setInterval(() => {
    void (async () => {
      try {
        await db
          .update(users)
          .set({ bannedAt: null, bannedUntil: null, banReason: null, bannedById: null, disabledAt: null })
          .where(and(isNotNull(users.bannedUntil), lte(users.bannedUntil, new Date())));
      } catch { /* swallow; next tick retries */ }
    })();
  }, BAN_SWEEP_MS).unref();

  // Zombie-room sweep. Fires once 60s after boot, long enough that
  // every client that was in a user-created room when the server
  // restarted has had a chance to reconnect and re-occupy it, but
  // not so long that the rooms tree drags around a dead room for
  // half a session. Any non-system, non-persistent, non-forum,
  // non-archived room with zero live sockets at sweep time gets
  // archived (its config row survives for resurrection on a fresh
  // /create with the same name). Forum boards are exempt: chat joins
  // into boards are refused for everyone, so a board can NEVER hold
  // sockets — sweeping them archived every board 60s after each boot
  // and stranded its topics. Without this, a user-created room whose owner closed
  // the tab AND never came back inside the idle-grace window, or
  // a room that was active when the server last shut down and
  // nobody returned to, would linger in the tree forever as a
  // ghost entry with (0) occupants. The runtime triggers
  // (expireIfEmpty on exit / room-switch / ghost-sweep /
  // consume-pending-disconnect) only fire when there's a live
  // event to ride on; a "nobody is here and nobody is coming"
  // room produces no events to fire on.
  // Hydrate the hardened IP-ban cache at boot, then keep it fresh on a timer
  // (ban/unban refresh it immediately too) so the global request gate works off
  // an in-memory Set instead of a per-request DB hit.
  await loadBannedIpCache(db).catch(() => {});
  setInterval(() => { void loadBannedIpCache(db).catch(() => {}); }, 60_000);

  const ZOMBIE_SWEEP_DELAY_MS = 60_000;
  setTimeout(() => {
    void (async () => {
      try {
        const candidates = await db
          .select({ id: rooms.id })
          .from(rooms)
          .where(and(eq(rooms.isSystem, false), eq(rooms.persistent, false), isNull(rooms.forumId), isNull(rooms.archivedAt)));
        for (const r of candidates) {
          try { await expireIfEmpty(io, db, r.id); }
          catch { /* swallow, one bad row shouldn't stop the sweep */ }
        }
      } catch { /* swallow, sweep failure shouldn't crash boot */ }
    })();
  }, ZOMBIE_SWEEP_DELAY_MS);

  await registerAllRoutes(baseApp, { db, io, registry, uploadsRoot, dbPath });

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

  installHandshake(io, db);

  wireSocketHandlers(io, { db, registry, log });

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
    return renderRobotsTxt(db, originFromRequest(req));
  });
  // Sitemap: up to ~5 sequential 1000-row scans per hit, so we memoize the
  // rendered XML with a short TTL keyed on origin (the origin can differ
  // between the *.fly.dev host and a custom domain, and it's baked into every
  // <loc>). The cache-control header lets crawlers + any CDN edge cache reuse
  // the response for an hour; the in-process memo covers thundering-herd
  // bot bursts within the TTL without touching the DB. New content shows up on
  // the next TTL rollover, which is fine for a sitemap.
  const SITEMAP_TTL_MS = 15 * 60 * 1000;
  const sitemapCache = new Map<string, { xml: string; at: number }>();
  app.get("/sitemap.xml", publicLimit, async (req, reply) => {
    reply.type("application/xml; charset=utf-8");
    reply.header("cache-control", "public, max-age=3600");
    const origin = originFromRequest(req);
    const now = Date.now();
    const hit = sitemapCache.get(origin);
    if (hit && now - hit.at < SITEMAP_TTL_MS) return hit.xml;
    const xml = await renderSitemapXml(db, origin);
    sitemapCache.set(origin, { xml, at: now });
    return xml;
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
          // Theater live streams. hls.js fetches the .m3u8 + .ts segments
          // (connect-src) and plays them through an MSE `blob:` source
          // (media-src + worker-src blob:). We allow the ngrok tunnel
          // families a host streams from (free + paid + custom-domain +
          // legacy), so a host's `/theater live https://<sub>.ngrok-*/…m3u8`
          // can load. The host's tunnel must also send `Access-Control-
          // Allow-Origin` (CORS) for the cross-origin reads to succeed.
          // `media-src` lists both `blob:` (hls.js MSE) and the origins
          // (Safari native HLS uses a direct <video src=…m3u8>).
          "connect-src 'self' https://*.ngrok-free.app https://*.ngrok-free.dev https://*.ngrok.app https://*.ngrok.io",
          "media-src 'self' blob: https://*.ngrok-free.app https://*.ngrok-free.dev https://*.ngrok.app https://*.ngrok.io",
          "worker-src 'self' blob:",
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
        // Splash-page language (i18n plan §7): an explicit `?lang=` — the
        // URL shape the hreflang alternates advertise — beats the
        // Accept-Language pick; anything unknown/absent renders English,
        // byte-identical to the pre-i18n output.
        const langParam = (req.query as Record<string, unknown> | undefined)?.["lang"];
        const locale =
          matchSupportedLocale(typeof langParam === "string" ? langParam : null) ??
          parseAcceptLanguage(req.headers["accept-language"]);
        const html = await renderSplashHtml(
          db,
          originFromRequest(req),
          req.url.split("?")[0] ?? "/",
          await getIndexHtml(),
          nonce,
          locale,
        );
        reply.header("content-security-policy", buildCsp(nonce));
        reply.type("text/html; charset=utf-8");
        // The rendered <title>/meta now vary on the negotiated language;
        // tell shared caches so a revalidated copy can't cross languages.
        reply.header("vary", "accept-language");
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
      // Forums (community message boards): the shareable per-forum page.
      // Anonymous visitors get the branded landing (header + boards teaser
      // + login/register block); signed-in visitors land in the Forums
      // Catalog opened at that forum. Parsed client-side on first paint.
      // The /t/<topicId> form is a TOPIC permalink (optionally with a
      // #p-<postId> hash for a specific reply) — same shell, the client
      // resolves it via /forums/topics/:id/locate.
      app.get("/f/:slug", publicLimit, serveSplash);
      app.get("/f/:slug/t/:topicId", publicLimit, serveSplash);
      // Chat servers (Multi-Server Lift): the permanent `/s/<slug>` share
      // address. Boots the SPA shell; the client resolves the slug to a server
      // it may open and enters its rooms (see App.tsx). Without this the link
      // would fall to the 404 page below — which is what it did before.
      app.get("/s/:slug", publicLimit, serveSplash);
      // Server invite links: the shareable `/i/<code>` landing. Boots the SPA
      // shell; the client resolves the code via GET /servers/invite/:code and
      // renders the branded join/register page (see ServerInviteLanding).
      app.get("/i/:code", publicLimit, serveSplash);
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
      // Public FAQ pages: `/faqs` is the index, `/faq/:slug` a single entry.
      // Both render the SPA shell for anonymous visitors (a mod can link an
      // answer to someone who hasn't signed up). The JSON lives at
      // `/api/faqs*` (under the `/api` apiPrefix) so it doesn't shadow these.
      app.get("/faqs", publicLimit, serveSplash);
      app.get("/faq/:slug", publicLimit, serveSplash);
      // Public Top Communities board (topsite / webring). Renders the SPA shell
      // for anyone; the JSON lives at `/affiliates` (its own apiPrefix).
      app.get("/top-communities", publicLimit, serveSplash);
      // Transactional email landing pages for logged-out visitors: the
      // forgot-password request form, the password-reset form, and the
      // email-verification handler all render the SPA shell so a refresh /
      // bookmark / cold link resolves (the JSON endpoints live under
      // /auth/*; without these a direct hit would fall to the 404 page).
      app.get("/forgot-password", publicLimit, serveSplash);
      app.get("/reset-password", publicLimit, serveSplash);
      app.get("/verify-email", publicLimit, serveSplash);
      // Google OAuth client-landing routes. The callback 302s the browser here
      // carrying a single-use code the SPA reads + POSTs back. They start with
      // /auth, so without explicit handlers the not-found apiPrefixes block would
      // JSON-404 them; register the splash so the SPA boots and its landing
      // handler can run. (The matching POST /auth/google/finish is a separate
      // method, so this GET splash route doesn't shadow it.)
      app.get("/auth/google/done", publicLimit, serveSplash);
      app.get("/auth/google/finish", publicLimit, serveSplash);

      await app.register(fastifyStatic, {
        root: webDistPath,
        // We render index.html ourselves; tell fastify-static not to
        // auto-serve it on directory hits. Otherwise / would be handled
        // by the plugin and our SEO rewrite would never run.
        index: false,
        // Cache hashed bundle assets aggressively. Vite emits content-hashed
        // filenames in /assets/, so anything in there is safe to cache for a
        // year. Static brand art / icons / fonts in the web root (the hero
        // backgrounds, favicons, OG image, PWA icons) have FIXED names but change
        // only at deploy time, so they're also cached a year immutable — the hero
        // bg is referenced with a `?v=N` token (index.html + styles.css) so a new
        // commission busts every cached copy by bumping N. Everything else
        // (manifest, etc.) keeps short caching so tweaks propagate quickly.
        setHeaders(res, path) {
          if (path.includes("/assets/")) {
            res.setHeader("cache-control", "public, max-age=31536000, immutable");
          } else if (/\.(?:avif|webp|jpe?g|png|gif|svg|ico|woff2?)$/i.test(path)) {
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
        const apiPrefixes = ["/api", "/auth", "/admin", "/characters", "/profiles", "/nav-links", "/rooms", "/stats", "/commands", "/messages", "/reports", "/push", "/affiliates", "/a", "/worlds", "/me", "/health", "/users", "/site", "/socket.io", "/thesaurus"];
        if (apiPrefixes.some((p) => req.url === p || req.url.startsWith(p + "/") || req.url.startsWith(p + "?"))) {
          reply.code(404);
          return reply.send({ error: "not found" });
        }
        // Missing hashed build asset (a stale tab asking for a chunk a newer
        // deploy purged, e.g. react-player's `/assets/YouTube-<hash>.js`).
        // Answer with a PLAIN 404, never the themed HTML shell: a JS module
        // import served `text/html` is rejected by the browser for the wrong
        // MIME type, which used to bubble up and blank the SPA. A clean 404
        // lets the client error boundary reload into the fresh build instead.
        const assetPath = req.url.split("?")[0] ?? req.url;
        if (assetPath.startsWith("/assets/") || /\.(?:js|mjs|css|map|woff2?|ttf)$/i.test(assetPath)) {
          reply.code(404);
          reply.type("text/plain; charset=utf-8");
          reply.header("cache-control", "no-store");
          return "not found";
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
  // Per-server event reminders (Multi-Server Lift). Its own ~60s .unref() timer
  // that pings the going/maybe RSVPs a lead-time before a scheduled event
  // starts. Idempotent like the announcement scheduler; captures db+io by
  // closure. Inert flag-off (no events exist without the servers feature).
  startEventReminderSweep({ db, io });
  // Nightly analytics rollup + raw-row retention sweep (plan_ext.md §4). Runs at
  // most once per UTC day (hourly self-check, guarded), aggregating yesterday's
  // raw page views / events into analytics_daily then deleting raw rows past
  // `analyticsRawRetentionDays`. Idempotent; captures `db` by closure.
  startAnalyticsRollupScheduler({ db });
  // Drain the broadcast email outbox within the daily cap.
  startEmailQueue(db);
  // Durable boot-ok marker. Survives the Fly log purge so a future
  // "what was the last successful boot?" question has an answer.
  recordBootSuccess({ port: PORT, mode: IS_PROD ? "production" : "development" });
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
