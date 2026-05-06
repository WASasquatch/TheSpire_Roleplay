import "dotenv/config";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import argon2 from "argon2";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import pino from "pino";
import { Server as IoServer } from "socket.io";
import { ZodError } from "zod";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@thekeep/shared";

import { db } from "./db/index.js";
import { rooms } from "./db/schema.js";
import { CommandRegistry } from "./commands/registry.js";
import { registerBuiltins } from "./commands/builtins/index.js";
import { dispatchChatInput } from "./realtime/dispatch.js";
import {
  addSystemMessage,
  broadcastPresence,
  expireIfEmpty,
  joinRoom,
  userHasSocketInRoom,
  userIsOnline,
} from "./realtime/broadcast.js";
import { lookupProfile } from "./commands/builtins/profile.js";
import { loadSessionUser } from "./auth/session.js";
import { registerAuthRoutes, getSessionUser, userIdFromSessionId, SESSION_COOKIE_NAME } from "./routes/auth.js";
import { registerCharacterRoutes } from "./routes/characters.js";
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

// Resolve the built web bundle relative to this file. Works whether we're
// running from `src/` (tsx in dev) or `dist/` (compiled prod): we walk up
// to apps/server then over to apps/web/dist.
const __dirname = dirname(fileURLToPath(import.meta.url));
const webDistPath = resolve(__dirname, "..", "..", "..", "web", "dist");

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
  // pino.Logger here, which is structurally incompatible — cast to the
  // base instance shape just for the registrar calls.
  const baseApp = app as unknown as FastifyInstance;
  await registerAuthRoutes(baseApp, db);
  await registerCharacterRoutes(baseApp, db);
  await registerCommandsRoutes(baseApp, db, registry);
  await registerNavLinkRoutes(baseApp, db, async (req) => {
    const u = await getSessionUser(req, db);
    return u?.role === "admin";
  });
  // (Admin routes need io for the room-delete boot-and-redirect flow, so they
  // are registered after the IoServer is constructed below.)

  app.get("/profiles/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const profile = await lookupProfile(db, name);
    if (!profile) {
      reply.code(404);
      return { error: "no profile" };
    }
    return profile;
  });

  /**
   * Public branding endpoint — readable without authentication so the login
   * screen, boot splash, and tab title can show the site's configured name
   * and logo styling. Returns ONLY the public-facing fields; admin-only
   * settings (retention, session TTL) live behind /admin/settings.
   */
  app.get("/site", async () => {
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
    };
  });

  app.get("/health", async () => ({ ok: true }));

  const httpServer = app.server;
  const io = new IoServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: WEB_ORIGIN, credentials: true },
  });

  // Routes that need io for socket-room introspection (currently-online
  // occupants per room, etc.) — registered after io is constructed.
  await registerStatsRoutes(baseApp, db, io);
  await registerUsersRoutes(baseApp, db, io);
  await registerRoomsRoutes(baseApp, db, io);
  await registerAdminRoutes(baseApp, {
    db,
    io,
    registry,
    getSessionUser: (req) => getSessionUser(req, db),
  });

  /* Socket auth handshake — pull session id from cookie. */
  io.use(async (socket, next) => {
    try {
      const cookieHeader = socket.handshake.headers.cookie ?? "";
      const sid = parseCookie(cookieHeader, SESSION_COOKIE_NAME);
      if (!sid) return next(new Error("unauthenticated"));
      const userId = await userIdFromSessionId(db, sid);
      if (!userId) return next(new Error("unauthenticated"));
      const user = await loadSessionUser(db, userId);
      if (!user) return next(new Error("unauthenticated"));
      (socket.data as { userId: string }).userId = userId;
      (socket.data as { user: typeof user }).user = user;
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
    const landing =
      (await db.select().from(rooms).where(eq(rooms.name, "The_Spire")).limit(1))[0]
      ?? (await db.select().from(rooms).where(eq(rooms.isSystem, true)).limit(1))[0];
    if (landing) await joinRoom(io, db, socket, user, landing.id);

    socket.on("chat:input", async (payload, ack) => {
      try {
        const fresh = await loadSessionUser(db, user.id);
        if (!fresh) {
          ack?.({ ok: false, code: "AUTH", message: "Session expired." });
          return;
        }
        Object.assign(user, fresh);
        await dispatchChatInput({
          io, socket, db, registry, user,
          roomId: payload.roomId,
          text: payload.text,
        });
        ack?.({ ok: true });
      } catch (err) {
        log.error({ err }, "chat:input error");
        ack?.({ ok: false, code: "ERR", message: err instanceof Error ? err.message : "error" });
      }
    });

    socket.on("room:join", async (payload, ack) => {
      try {
        const room = (await db.select().from(rooms).where(eq(rooms.id, payload.roomId)).limit(1))[0];
        if (!room) {
          ack?.({ ok: false, code: "NO_ROOM", message: "Room not found." });
          return;
        }
        let passwordOk = false;
        if (room.type === "private" && room.passwordHash && payload.password) {
          passwordOk = await argon2.verify(room.passwordHash, payload.password).catch(() => false);
          if (!passwordOk) {
            ack?.({ ok: false, code: "BAD_PASSWORD", message: "Incorrect password." });
            return;
          }
        }
        await joinRoom(io, db, socket, user, room.id, { passwordOk });
        ack?.({ ok: true });
      } catch (err) {
        ack?.({ ok: false, code: "ERR", message: err instanceof Error ? err.message : "error" });
      }
    });

    socket.on("room:leave", async (payload) => {
      socket.leave(`room:${payload.roomId}`);
      await broadcastPresence(io, db, payload.roomId);
    });

    socket.on("profile:fetch", async (payload, ack) => {
      const profile = await lookupProfile(db, payload.username);
      if (!profile) ack({ ok: false, code: "NO_USER", message: "Not found." });
      else ack({ ok: true, profile });
    });

    // We use `disconnecting` (not `disconnect`) because by the time `disconnect`
    // fires, socket.rooms is already empty — we'd miss the room ids we need to
    // notify and check for auto-expiry.
    socket.on("disconnecting", () => {
      const roomIds = [...socket.rooms]
        .filter((r) => r.startsWith("room:"))
        .map((r) => r.slice(5));
      // Snapshot the user identity now — by the time the deferred cleanup
      // runs, the SessionUser object on this socket may already be gone.
      const userId = user.id;
      const displayName = user.displayName;
      const socketId = socket.id;

      // Defer the work so the socket actually finishes leaving its rooms first;
      // otherwise expireIfEmpty would still see this socket present.
      setTimeout(() => {
        (async () => {
          // "Has this user gone offline entirely?" — drives the wording of
          // the system message ("disconnected" vs "left"). When the user has
          // another tab open elsewhere, only the per-room departure shows.
          const fullyOffline = !(await userIsOnline(io, userId, socketId));

          for (const id of roomIds) {
            const expired = await expireIfEmpty(io, db, id);
            if (expired) continue;
            const stillThere = await userHasSocketInRoom(io, userId, id, socketId);
            if (!stillThere) {
              const body = fullyOffline
                ? `${displayName} has disconnected.`
                : `${displayName} left.`;
              await addSystemMessage(io, db, id, body);
            }
            await broadcastPresence(io, db, id);
          }
        })().catch((err) => log.error({ err }, "disconnecting cleanup failed"));
      }, 0);
    });
  });

  // Janitor: hourly sweep for expired sessions and (if admin enabled it)
  // messages older than the retention window.
  startJanitor(db, log);

  /* ---------- production: serve the built web bundle ----------
   *
   * In dev, Vite serves the SPA on :5173 and proxies API calls to :3001.
   * In prod we serve the built bundle from this same Fastify instance so
   * Fly.io (or any single-port host) can route external 80/443 to one
   * internal port without an extra reverse-proxy hop.
   *
   * Order matters: this must register AFTER all API routes — fastify-static
   * doesn't shadow earlier routes, and the setNotFoundHandler that follows
   * is the SPA fallback so deep links like /room/foo serve index.html and
   * the React router takes over.
   */
  if (IS_PROD) {
    if (!existsSync(webDistPath)) {
      log.warn({ webDistPath }, "production mode but web/dist not found — did `pnpm --filter @thekeep/web run build` run?");
    } else {
      await app.register(fastifyStatic, {
        root: webDistPath,
        // Cache hashed bundle assets aggressively. Vite emits content-hashed
        // filenames in /assets/, so anything in there is safe to cache for a
        // year. Everything else (index.html, favicons, the_spire_bg.jpg)
        // gets short caching so admin-uploaded changes propagate quickly.
        setHeaders(res, path) {
          if (path.includes("/assets/")) {
            res.setHeader("cache-control", "public, max-age=31536000, immutable");
          } else {
            res.setHeader("cache-control", "public, max-age=300");
          }
        },
      });

      // SPA fallback. Any GET that didn't match an API route or a static file
      // is treated as a client-side route and served index.html so the React
      // app can resolve it. Non-GET methods get a real 404 — they were
      // genuinely meant for an API endpoint that doesn't exist.
      app.setNotFoundHandler((req, reply) => {
        if (req.method !== "GET") {
          reply.code(404);
          return reply.send({ error: "not found" });
        }
        // Don't SPA-fallback API-shaped paths — these should genuinely 404
        // so a typo'd /admin/foo doesn't return HTML and confuse a fetch().
        const apiPrefixes = ["/auth", "/admin", "/characters", "/profiles", "/nav-links", "/rooms", "/stats", "/commands", "/me", "/health", "/users", "/site", "/socket.io"];
        if (apiPrefixes.some((p) => req.url === p || req.url.startsWith(p + "/") || req.url.startsWith(p + "?"))) {
          reply.code(404);
          return reply.send({ error: "not found" });
        }
        return reply.sendFile("index.html");
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

main().catch((err) => {
  log.error({ err }, "fatal");
  process.exit(1);
});
