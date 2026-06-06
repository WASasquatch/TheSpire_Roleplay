/* eslint-disable no-restricted-globals */
/**
 * The Spire, service worker for Web Push notifications.
 *
 * Privacy contract: payloads from the server contain no message bodies, only
 * generic copy ("You have a whisper waiting" / "You were mentioned in
 * chat"). The lockscreen preview never leaks chat content.
 *
 * No offline caching; this worker exists purely as the push delivery channel.
 * Treat it as a thin shim, the real notification logic lives server-side.
 */

self.addEventListener("install", (event) => {
  // Activate immediately on first install so the user doesn't have to
  // refresh twice to get pushes working.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = { title: "The Spire", body: "New activity in chat." };
  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      // Server should always send JSON, but if a malformed push arrives we
      // still want to show something so the user knows to come back.
    }
  }
  const { title, body, tag, url } = payload;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/favicon-196x196.png",
      badge: "/favicon-32x32.png",
      tag,
      data: { url: url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // If a Spire tab is already open, focus it instead of opening another.
      for (const client of allClients) {
        try {
          const u = new URL(client.url);
          if (u.origin === self.location.origin) {
            await client.focus();
            return;
          }
        } catch { /* ignore unparsable client URL */ }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
