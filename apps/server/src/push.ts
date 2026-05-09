import { and, eq } from "drizzle-orm";
import webPush from "web-push";
import { pushSubscriptions } from "./db/schema.js";
import { ensureVapidKeys, getSettings } from "./settings.js";
import type { Db } from "./db/index.js";

/**
 * Web-push helper. Centralises the encryption + delivery + GC pipeline so
 * callers can fire-and-forget. The privacy contract is enforced *at the call
 * sites* (only generic copy is passed into `pushToUser`); this module just
 * wires it.
 */

let initialized = false;

/**
 * One-time setup: load VAPID keys (generated at first boot if missing) and
 * configure the global `web-push` defaults so subsequent `sendNotification`
 * calls authenticate properly. Called from server startup.
 */
export async function initPush(db: Db): Promise<void> {
  if (initialized) return;
  await ensureVapidKeys(db);
  const s = await getSettings(db);
  if (!s.vapidPublicKey || !s.vapidPrivateKey) return; // generation failed; skip
  // mailto: is the convention for a contact identifier the push service can
  // reach if our app is misbehaving (e.g. spamming subscriptions). It's a
  // weak handshake, not a privacy concern - the push services accept it.
  webPush.setVapidDetails("mailto:admin@thespire.local", s.vapidPublicKey, s.vapidPrivateKey);
  initialized = true;
}

/**
 * Push a notification to every subscription this user has, fanning out to
 * each browser/device they've opted in from. Failed deliveries with a
 * 404/410 (subscription gone) are pruned so the table doesn't accumulate
 * dead rows. All other failures are logged but never thrown - callers
 * fire-and-forget from the realtime path.
 */
export async function pushToUser(
  db: Db,
  userId: string,
  payload: { title: string; body: string; tag?: string; url?: string },
): Promise<void> {
  if (!initialized) return; // server hasn't booted yet, or keys missing
  const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  if (subs.length === 0) return;
  const json = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webPush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dhKey, auth: sub.authKey },
          },
          json,
          { TTL: 60 }, // 1-minute TTL; chat is realtime, stale pushes aren't useful
        );
      } catch (err) {
        const status = isStatusCodedError(err) ? err.statusCode : null;
        if (status === 404 || status === 410) {
          // Subscription is gone (revoked or browser-tossed). GC.
          await db
            .delete(pushSubscriptions)
            .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, sub.endpoint)))
            .catch(() => {});
        } else {
          // eslint-disable-next-line no-console
          console.error("[push] sendNotification failed", { userId, endpoint: sub.endpoint, status, err });
        }
      }
    }),
  );
}

interface StatusCodedError {
  statusCode: number;
}
function isStatusCodedError(err: unknown): err is StatusCodedError {
  return typeof err === "object" && err !== null && typeof (err as { statusCode?: unknown }).statusCode === "number";
}
