import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { pushSubscriptions } from "../db/schema.js";
import { getSettings } from "../settings.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "./auth.js";

/**
 * Host suffixes of the legitimate Web Push services. A subscription endpoint
 * must be HTTPS and land on one of these; anything else is refused so the
 * server-side push POST (web-push → this URL) can't be pointed at an internal
 * / loopback / cloud-metadata address (SSRF). Browsers only ever hand out
 * endpoints on these hosts.
 */
const PUSH_HOST_SUFFIXES = [
  ".googleapis.com", // Chrome / Edge / Firefox via FCM (fcm.googleapis.com)
  ".push.apple.com", // Safari / iOS
  ".notify.windows.com", // legacy Edge / WNS
  ".wns.windows.com",
  ".push.services.mozilla.com", // Firefox autopush
];
function isAllowedPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOST_SUFFIXES.some((sfx) => host === sfx.slice(1) || host.endsWith(sfx));
}

const subscribeBody = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().max(200),
    auth: z.string().max(200),
  }),
}).strict();

const unsubscribeBody = z.object({
  endpoint: z.string().url().max(2000),
}).strict();

/**
 * Web Push subscription routes. Pairs with apps/web/public/sw.js (the
 * service worker that displays incoming pushes) and apps/web/src/lib/push.ts
 * (the client-side opt-in flow).
 */
export async function registerPushRoutes(app: FastifyInstance, db: Db): Promise<void> {
  /**
   * Returns the VAPID public key (and only the public key) so the client
   * can call `pushManager.subscribe` with it. Unauthenticated - the public
   * key is, by design, public.
   */
  app.get("/push/vapid-key", async (_req, reply) => {
    const s = await getSettings(db);
    if (!s.vapidPublicKey) {
      reply.code(503);
      return { error: "push not configured" };
    }
    return { publicKey: s.vapidPublicKey };
  });

  /**
   * Persist (or refresh `last_seen_at` on) a subscription. Each (user, endpoint)
   * is unique per the DB index, so re-subscribes after permission flap upsert
   * cleanly.
   */
  app.post<{ Body: unknown }>("/push/subscribe", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    let body;
    try { body = subscribeBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    // SSRF guard: only ever store endpoints on real push services, so the
    // fire-and-forget server-side push POST can't be aimed at an internal host.
    if (!isAllowedPushEndpoint(body.endpoint)) {
      reply.code(400); return { error: "unsupported push endpoint" };
    }

    const existing = (await db
      .select()
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, me.id), eq(pushSubscriptions.endpoint, body.endpoint)))
      .limit(1))[0];

    if (existing) {
      await db
        .update(pushSubscriptions)
        .set({
          p256dhKey: body.keys.p256dh,
          authKey: body.keys.auth,
          lastSeenAt: new Date(),
        })
        .where(eq(pushSubscriptions.id, existing.id));
      return { ok: true, refreshed: true };
    }

    await db.insert(pushSubscriptions).values({
      id: nanoid(),
      userId: me.id,
      endpoint: body.endpoint,
      p256dhKey: body.keys.p256dh,
      authKey: body.keys.auth,
    });
    return { ok: true };
  });

  /**
   * Explicit client-side unsubscribe. Browsers that revoke push silently are
   * GC'd via the 404/410 path in push.ts.
   */
  app.post<{ Body: unknown }>("/push/unsubscribe", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    let body;
    try { body = unsubscribeBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    await db.delete(pushSubscriptions).where(and(
      eq(pushSubscriptions.userId, me.id),
      eq(pushSubscriptions.endpoint, body.endpoint),
    ));
    return { ok: true };
  });
}
