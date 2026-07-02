// Service worker — receives push messages when the page/tab is closed.
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
importScripts("firebase-config.js");

firebase.initializeApp(self.firebaseConfig);
const messaging = firebase.messaging();

// Background messages
messaging.onBackgroundMessage((payload) => {
  const n = payload.notification || {};
  self.registration.showNotification(n.title || "Stock alert", {
    body: n.body || "",
    icon: "icon-192.png",
    badge: "icon-192.png"
  });
});

// A (mostly no-op) fetch handler is required for the app to be installable.
self.addEventListener("fetch", () => {});

// Focus/open the app when a notification is tapped.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window" }).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      if (clients.openWindow) return clients.openWindow("./index.html");
    })
  );
});
