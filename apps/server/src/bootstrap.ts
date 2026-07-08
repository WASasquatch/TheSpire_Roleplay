// Fastify + Socket.IO bootstrap. Builds the Fastify instance with its plugins
// (cookie / CORS / rate-limit), the global security + logging + IP-gate hooks,
// and the ZodError handler; and constructs the Socket.IO server. Lifted verbatim
// from index.ts's main() so the entrypoint stays a thin orchestrator — the
// hook bodies, ordering, and env reads (CANONICAL_HOST, HSTS-in-prod) are
// unchanged. The previously module-level `documentRouteTemplate` helper moves
// here alongside its sole caller (the analytics onRequest hook).
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { Server as IoServer } from "socket.io";
import { ZodError } from "zod";
import type { Logger } from "pino";
import type { Server as HttpServer } from "node:http";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import type { Db } from "./db/index.js";
import { recordHttpIp } from "./auth/ipLog.js";
import { isIpBannedCachedSync } from "./auth/ipBan.js";
import { readBearerToken } from "./routes/auth.js";
import { recordServerPageView } from "./analytics/recorder.js";

/**
 * Map a request URL to the SPA / document-route TEMPLATE for analytics
 * page-view recording (plan_ext.md §2a). Returns null for anything that isn't a
 * known server-rendered document route (API, assets, sockets, uploads, deep
 * links we don't render server-side) so the recorder never fires on non-document
 * traffic. Recording the TEMPLATE ("/f/:slug"), not the resolved slug/id, keeps
 * the stored path low-cardinality and free of slugs/ids/PII. Query string is
 * stripped before matching.
 */
function documentRouteTemplate(url: string): string | null {
  const path = (url.split("?")[0] ?? url).replace(/\/+$/, "") || "/";
  // Exact static document routes (splash / public pages / auth landings).
  const EXACT = new Set([
    "/", "/login", "/register", "/scriptorium", "/rules", "/faqs",
    "/top-communities", "/forgot-password", "/reset-password", "/verify-email",
  ]);
  if (EXACT.has(path)) return path === "" ? "/" : path;
  // Single-segment parametric document routes → collapse the id/slug to the
  // template so the path column stays low-cardinality.
  const SEG = /^\/([^/]+)\/[^/]+$/;
  const m = SEG.exec(path);
  if (m) {
    const head = m[1];
    if (head === "p") return "/p/:name";
    if (head === "u") return "/u/:name";
    if (head === "w") return "/w/:slug";
    if (head === "f") return "/f/:slug";
    if (head === "s") return "/s/:slug";
    if (head === "faq") return "/faq/:slug";
  }
  // Deeper templated document routes.
  if (/^\/f\/[^/]+\/t\/[^/]+$/.test(path)) return "/f/:slug/t/:topicId";
  if (/^\/scriptorium\/@[^/]+\/[^/]+$/.test(path)) return "/scriptorium/@:handle/:slug";
  return null;
}

/** URL-decode a single path segment, falling back to the raw text on error. */
function safeDecodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Companion to `documentRouteTemplate`: map a RAW request URL to a per-ENTITY
 * analytics hit, where `key` is the real slug/name (not the low-cardinality
 * template). This is what lets the admin Analytics tab break out "which world /
 * forum / profile / server page / story was viewed" instead of collapsing every
 * public entity page into its `:slug` template. Forum topics count toward their
 * parent forum. The key is capped at 128 chars. Returns null for anything that
 * isn't a known public entity route. Query string is stripped before matching.
 */
function documentEntityHit(url: string): { kind: string; key: string } | null {
  const path = (url.split("?")[0] ?? url).replace(/\/+$/, "") || "/";
  const key = (seg: string) => safeDecodeSegment(seg).slice(0, 128);
  // Deeper routes first (a forum topic counts toward its forum's slug).
  let m = /^\/f\/([^/]+)\/t\/[^/]+$/.exec(path);
  if (m) return { kind: "forum", key: key(m[1]!) };
  m = /^\/scriptorium\/@[^/]+\/([^/]+)$/.exec(path);
  if (m) return { kind: "story", key: key(m[1]!) };
  // Single-segment parametric entity routes.
  m = /^\/([^/]+)\/([^/]+)$/.exec(path);
  if (m) {
    const head = m[1];
    const seg = m[2]!;
    if (head === "p" || head === "u") return { kind: "profile", key: key(seg) };
    if (head === "w") return { kind: "world", key: key(seg) };
    if (head === "f") return { kind: "forum", key: key(seg) };
    if (head === "s") return { kind: "serverPage", key: key(seg) };
    if (head === "faq") return { kind: "faq", key: key(seg) };
  }
  return null;
}

/**
 * Build the Fastify app with all global plugins + hooks + the ZodError handler,
 * ready for route registration. Returns the base FastifyInstance (the route
 * registrars use the FastifyBaseLogger-typed instance; `loggerInstance: log`
 * makes Fastify infer a pino.Logger, so we cast on the way out).
 */
export async function createApp(deps: {
  log: Logger;
  db: Db;
  sessionSecret: string;
  webOrigin: string;
  isProd: boolean;
}): Promise<FastifyInstance> {
  const { log, db } = deps;
  const SESSION_SECRET = deps.sessionSecret;
  const WEB_ORIGIN = deps.webOrigin;
  const IS_PROD = deps.isProd;
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
    // Fastify's built-in per-request logging emits an "incoming request" AND a
    // "request completed" line - each with the full req/res object - for EVERY
    // request. Under any burst (a chatty client, a reconnect storm, a poll loop,
    // a crawler) that floods the console thousands of lines deep and buries real
    // signal. We turn it off and log a single concise line ONLY for server
    // errors or slow requests via the onResponse hook below; ordinary 2xx/4xx
    // traffic stays quiet. Set LOG_LEVEL=debug to see every request again.
    disableRequestLogging: true,
  });
  // Concise access log: quiet for normal traffic, loud only where it matters.
  // Replaces the disabled built-in request logging above.
  app.addHook("onResponse", async (req, reply) => {
    const status = reply.statusCode;
    const ms = Math.round(reply.elapsedTime);
    const line = { method: req.method, url: req.url, status, ms };
    if (status >= 500) req.log.error(line, "request failed");
    else if (ms > 1000) req.log.warn(line, "slow request");
    else req.log.debug(line, "request"); // hidden at the default info level
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
    // The plugin's DEFAULT errorResponseBuilder returns an `Error`, and
    // `reply.send(error)` makes Fastify log a full stack trace for every
    // rejected request. A hammered public endpoint (e.g. the splash polling
    // /stats, or a dev page reloading under HMR) then floods the console with
    // identical stacks. Returning a PLAIN object keeps the standard 429 body
    // and the Retry-After header (set separately by the plugin) but drops the
    // stack spam - a 429 is expected traffic shaping, not a fault.
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: `Rate limit exceeded, retry in ${Math.ceil((context.ttl ?? 0) / 1000)} seconds`,
    }),
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
  app.addHook("onSend", async (req, reply, payload) => {
    if (!reply.getHeader("x-content-type-options")) {
      reply.header("x-content-type-options", "nosniff");
    }
    if (!reply.getHeader("x-frame-options")) {
      // The vendored arcade bundles under /games/* are embedded by our own
      // SPA in a same-origin iframe (Eidolon / Urugal / Grimhold windows),
      // so they must allow same-origin framing. DENY blocked them entirely
      // ("Firefox Can't Open This Page" inside the game window). SAMEORIGIN
      // still defeats cross-site clickjacking; the parent SPA's CSP
      // `frame-src 'self'` is what permits the embed. Everything else keeps
      // the stricter DENY (CSP `frame-ancestors 'none'` backs it on HTML).
      const sameOriginFramable = (req.url ?? "").split("?")[0]?.startsWith("/games/") ?? false;
      reply.header("x-frame-options", sameOriginFramable ? "SAMEORIGIN" : "DENY");
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
  // HARDENED IP ban — the FIRST onRequest hook, so a globally-banned user's
  // recent IPs get NOTHING from the app: no API, no static SPA shell, no public
  // pages. (The socket.io handshake bypasses Fastify hooks, so it's gated
  // separately in `io.use` below.) Checked against an in-memory cache (refreshed
  // on a timer + on every ban/unban) so it costs a Set lookup, not a DB hit, per
  // request. Private/loopback IPs are never cached, so dev + NAT hops are
  // unaffected. Returns a plain 403 so a direct request still shows a reason.
  app.addHook("onRequest", async (req, reply) => {
    if (isIpBannedCachedSync(req.ip)) {
      return reply.code(403).type("text/plain").send("Access from your network has been restricted.");
    }
  });
  app.addHook("onRequest", async (req) => {
    recordHttpIp(db, readBearerToken(req), req.ip, req.headers["user-agent"] ?? null);
  });

  // First-party analytics: server-side page-view recorder for server-rendered
  // document GETs (plan_ext.md §2a). Fires alongside recordHttpIp on the same
  // onRequest hook, but ONLY for GETs whose path maps to a known SPA/document
  // route TEMPLATE (never JSON API responses or asset requests). Recording the
  // TEMPLATE ("/f/:slug"), not the resolved slug/id, keeps the path column
  // low-cardinality and PII-free. Throttled + gated on `analyticsEnabled`
  // inside `recordServerPageView`; the raw IP is used only to hash/geo then
  // discarded. Fire-and-forget: never blocks or fails the request.
  app.addHook("onRequest", async (req) => {
    if (req.method !== "GET") return;
    const template = documentRouteTemplate(req.url);
    if (!template) return;
    const entity = documentEntityHit(req.url);
    recordServerPageView(db, {
      path: template,
      ...(entity ? { entity } : {}),
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
      referer: (req.headers["referer"] ?? req.headers["referrer"] ?? null) as string | null,
      headers: req.headers,
    });
  });

  // Canonical-domain 301: consolidate the free *.fly.dev hostname onto the
  // custom domain so search engines don't split ranking across two domains.
  // OPT-IN via env (`CANONICAL_HOST`, e.g. "thespire.games") — unset ⇒ no-op, so
  // dev/localhost and any non-configured deploy are byte-identical to before.
  // Scoped to *.fly.dev hosts only (never localhost, internal fly health-check
  // hosts, or the canonical host itself) and to safe GET/HEAD navigations, so it
  // can't loop or break API/POST flows. Low-level 301 + Location to stay
  // independent of Fastify's version-specific reply.redirect() argument order.
  const CANONICAL_HOST = (process.env.CANONICAL_HOST ?? "").trim().toLowerCase();
  if (CANONICAL_HOST) {
    app.addHook("onRequest", async (req, reply) => {
      if (req.method !== "GET" && req.method !== "HEAD") return;
      const host = (
        (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim()
        || (req.headers.host as string | undefined)
        || ""
      ).toLowerCase();
      if (host.endsWith(".fly.dev") && host !== CANONICAL_HOST) {
        return reply
          .code(301)
          .header("location", `https://${CANONICAL_HOST}${req.url}`)
          .send();
      }
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

  return app as unknown as FastifyInstance;
}

/** Construct the Socket.IO server bound to the Fastify HTTP server. */
export function createIo(
  httpServer: HttpServer,
  webOrigin: string,
): IoServer<ClientToServerEvents, ServerToClientEvents> {
  return new IoServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: webOrigin, credentials: true },
  });
}
