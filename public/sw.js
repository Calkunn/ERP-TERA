self.addEventListener("install", event => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", event => {
  // Pass-through service worker to fulfill PWA install criteria
  event.respondWith(fetch(event.request));
});

// Push notification event listener
self.addEventListener("push", event => {
  let data = { title: "TERA ERP", body: "Ada notifikasi baru!" };
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: "TERA ERP", body: event.data.text() };
    }
  }

  const options = {
    body: data.body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: data.url || "/",
    vibrate: [100, 50, 100],
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Notification click event listener
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const targetUrl = event.notification.data;

  event.waitUntil(
    clients.matchAll({ type: "window" }).then(windowClients => {
      // Check if there is already a window tab open with our app
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url.includes(self.location.origin) && "focus" in client) {
          if (targetUrl && client.navigate) {
            client.navigate(targetUrl);
          }
          return client.focus();
        }
      }
      // If no tab is open, open a new one
      if (clients.openWindow) {
        return clients.openWindow(targetUrl || "/");
      }
    })
  );
});
