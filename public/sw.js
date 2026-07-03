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
