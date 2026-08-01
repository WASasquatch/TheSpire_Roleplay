/**
 * GET /media/image?u=<https url>
 *
 * The general-purpose same-origin image proxy. Overlook has its own copy of
 * this endpoint behind its feature flag; this one is for everything else that
 * has to draw remote art onto a canvas. Today that is the world-to-PDF export,
 * which rasterizes cover images, entry portraits and map plates through
 * html2canvas and would otherwise hit a tainted canvas on the first
 * hotlinked file.
 *
 * Auth-gated so it can't be used as an open proxy by anonymous callers, and
 * SSRF-guarded (see lib/imageProxy) so it can't be pointed at the private
 * network. Deliberately NOT gated on any feature switch: turning Overlook off
 * must not silently strip the art out of world exports.
 */
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/index.js";
import { serveProxiedImage } from "../lib/imageProxy.js";
import { getSessionUser } from "./auth.js";

export async function registerMediaProxyRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.get<{ Querystring: { u?: string } }>(
    "/media/image",
    // Generous but finite. One export of a large world legitimately pulls a
    // few hundred plates in a burst (a portrait per entry, plus every map and
    // every inline image), so the window has to clear a whole magazine in one
    // go without leaving the endpoint usable as a bulk fetcher. The sibling
    // /overlook/image proxy opts out of rate limiting entirely; this one does
    // not, because a world export is the only caller that bursts.
    { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      return serveProxiedImage(reply, req.query.u ?? "");
    },
  );
}
