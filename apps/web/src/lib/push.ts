/**
 * Web Push opt-in flow. Pairs with apps/web/public/sw.js (the worker that
 * displays incoming pushes) and apps/server/src/routes/push.ts (subscribe /
 * unsubscribe endpoints).
 *
 * Browsers REQUIRE the subscribe call be triggered from a user gesture, so
 * the editor's "Enable browser push" button calls `enablePush()` directly
 * from the click handler.
 */

const SW_URL = "/sw.js";

export type PushState =
  | "unsupported"     // browser lacks PushManager / Notification API
  | "denied"          // user previously denied permission
  | "default"         // not yet asked
  | "subscribed"      // active subscription exists for this user
  | "permission-only"; // permission granted but no subscription registered

export function isSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Read current state without prompting. */
export async function readPushState(): Promise<PushState> {
  if (!isSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "default") return "default";
  // permission === "granted"
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return "permission-only";
  const sub = await reg.pushManager.getSubscription();
  return sub ? "subscribed" : "permission-only";
}

/**
 * Register the service worker if it isn't yet, then return its registration.
 * Safe to call repeatedly - getRegistration short-circuits the second time.
 */
export async function ensureRegistered(): Promise<ServiceWorkerRegistration | null> {
  if (!isSupported()) return null;
  const existing = await navigator.serviceWorker.getRegistration(SW_URL);
  if (existing) return existing;
  try {
    return await navigator.serviceWorker.register(SW_URL);
  } catch {
    return null;
  }
}

/**
 * Convert a urlsafe-base64 VAPID key (server-supplied) to the Uint8Array the
 * Push API requires.
 */
function urlBase64ToUint8Array(b64: string): Uint8Array {
  const padding = "=".repeat((4 - (b64.length % 4)) % 4);
  const padded = (b64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Full opt-in flow:
 *   1. Register the SW (no-op if already registered).
 *   2. Request notification permission (must be from a user gesture).
 *   3. Fetch the server's public VAPID key.
 *   4. PushManager.subscribe(...).
 *   5. POST the subscription to /push/subscribe.
 *
 * Returns the resolved state. Throws on hard failure (server unreachable,
 * subscribe rejected) so the caller can surface the message; permission
 * "denied" is a soft return rather than a throw.
 */
export async function enablePush(): Promise<PushState> {
  if (!isSupported()) return "unsupported";

  const perm = await Notification.requestPermission();
  if (perm === "denied") return "denied";
  if (perm !== "granted") return "default";

  const reg = await ensureRegistered();
  if (!reg) throw new Error("service worker registration failed");

  // Reuse existing subscription if it already exists.
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const keyRes = await fetch("/push/vapid-key", { credentials: "include" });
    if (!keyRes.ok) {
      const j = await keyRes.json().catch(() => ({} as { error?: string }));
      throw new Error(j.error ?? `vapid-key HTTP ${keyRes.status}`);
    }
    const { publicKey } = (await keyRes.json()) as { publicKey: string };
    // applicationServerKey expects a BufferSource. Newer TS lib.dom narrows
    // Uint8Array<ArrayBufferLike> in a way that doesn't fit the parameter
    // shape, so cast through BufferSource explicitly. Runtime is fine.
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
    });
  }

  // Stringify and ship to the server. The PushSubscription's toJSON gives us
  // exactly the shape the server expects.
  const payload = sub.toJSON();
  const subRes = await fetch("/push/subscribe", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: payload.endpoint,
      keys: { p256dh: payload.keys?.p256dh, auth: payload.keys?.auth },
    }),
  });
  if (!subRes.ok) {
    const j = await subRes.json().catch(() => ({} as { error?: string }));
    throw new Error(j.error ?? `subscribe HTTP ${subRes.status}`);
  }
  return "subscribed";
}

/**
 * Unsubscribe locally and tell the server to forget the subscription.
 * Browser permission stays granted; the user can re-enable later without
 * a fresh prompt.
 */
export async function disablePush(): Promise<PushState> {
  if (!isSupported()) return "unsupported";
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  if (!reg) return Notification.permission === "denied" ? "denied" : "default";
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return "permission-only";
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  try {
    await fetch("/push/unsubscribe", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    // Server-side cleanup is best-effort; browser-side is the source of truth.
  }
  return "permission-only";
}
