// Shows the Web Push notifications sent while no Workshop tab is in view. It has no fetch handler,
// so it never takes part in loading pages (caching would come between the app and its WebSocket).

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// The service sends only paths within this origin. Anything else, including "/\host" that URL
// parsing reads as "//host", opens the Workshop's home page instead.
const workshopPath = (path) => {
  try {
    let url = new URL(path, self.location.origin);
    if (typeof path === "string" && url.origin === self.location.origin) {
      return url.pathname + url.search + url.hash;
    }
  } catch {}
  return "/";
};

// Two senders feed this worker. The central notification service sends {title, body, path, tag}.
// This fork's own Web Push channel (docs/fork-maintenance.md) sends Declarative Web Push messages,
// {"web_push": 8030, "notification": {...}}, which Safari shows itself: it then hands the worker a
// push event that already carries the notification (`event.notification`).
self.addEventListener("push", (event) => {
  if (event.notification) return;
  let payload;
  try {
    payload = event.data?.json();
  } catch {}
  // A userVisibleOnly subscription must show a notification for every push.
  let fork = payload?.notification;
  let { title, body, path, tag } = typeof fork?.title === "string"
    ? { ...fork, path: fork.navigate }
    : typeof payload?.title === "string" ? payload : { title: "Cloudflare OS" };
  event.waitUntil((async () => {
    if (typeof payload?.app_badge === "number" && self.navigator.setAppBadge) {
      await self.navigator.setAppBadge(payload.app_badge).catch(() => {});
    }
    await self.registration.showNotification(
      title, { body, tag, data: { path: workshopPath(path) } });
  })());
});

// Sent by the page on sign-out. The page may be navigated away before it can unsubscribe itself,
// and this worker survives it.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "release-push-subscription") return;
  event.waitUntil(
    self.registration.pushManager.getSubscription()
      .then((subscription) => subscription && subscription.unsubscribe())
      .catch(() => {}));
});

// The browser replaced the subscription (new endpoint and keys). The worker has no credentials to
// tell the server, so it wakes the open pages, whose sync re-registers the current one.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    let windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    for (let client of windows) client.postMessage({ type: "push-subscription-changed" });
  })());
});

// Pages that render without the Workshop, so nothing there opens the chat: a connect popup that a
// failed connect left open, and sign-up. The handoff path is kept in step with HANDOFF_PATH in
// src/connectHandoff.ts by serviceWorker.test.ts.
const STANDALONE_PATHS = new Set(["/connect/handoff", "/signup"]);

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let { path } = event.notification.data;
  event.waitUntil((async () => {
    // Windows come most recently focused first.
    let windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    let client = windows.find(candidate => !STANDALONE_PATHS.has(new URL(candidate.url).pathname));
    if (client) {
      await client.focus();
      // Client.postMessage takes no target origin: it reaches only this origin's window.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      client.postMessage({ type: "cloudflare-os:open-notification", path });
    } else {
      await self.clients.openWindow(path);
    }
  })());
});
