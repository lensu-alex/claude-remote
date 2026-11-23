// Service worker: shows push notifications sent by the laptop helper and opens the right chat on tap.
// Payload (docs/CONTRACT.md): { "title": "...", "body": "...", "url": "/c/<conversation id>" }

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const url = typeof data.url === "string" ? data.url : "/";
  // iOS revokes the subscription if a push arrives and nothing is shown, so always show something.
  event.waitUntil(
    self.registration.showNotification(data.title || "Claude Remote", {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: url,
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.url) || "/";
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        client.postMessage({ type: "navigate", url: path });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
