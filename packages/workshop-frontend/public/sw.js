// Push notifications only. This worker deliberately handles no `fetch`: caching would come between
// the app and its WebSocket, sign-in redirects and live chat, and the app is not meant to work
// offline.
//
// The server sends Declarative Web Push messages ({"web_push": 8030, "notification": {...}}).
// Safari shows those itself, handing the worker a push event that already carries the notification
// (`event.notification`); other browsers leave showing it to this worker.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  if (event.notification) return
  let message = {}
  try {
    message = event.data ? event.data.json() : {}
  } catch {
    // Not JSON: still show something, as some browsers revoke subscriptions whose pushes show nothing.
  }
  const notification = message.notification || {}
  event.waitUntil((async () => {
    if (typeof message.app_badge === 'number' && self.navigator.setAppBadge) {
      await self.navigator.setAppBadge(message.app_badge).catch(() => {})
    }
    await self.registration.showNotification(notification.title || 'Cloudflare OS', {
      body: notification.body,
      tag: notification.tag,
      data: { url: notification.navigate || '/' },
    })
  })())
})

// Sent by the page on sign-out, naming the subscription to drop. The page may be navigated away before it can unsubscribe itself,
// and this worker survives it.
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'release-push-subscription' || !event.data.endpoint) return
  event.waitUntil(
    self.registration.pushManager.getSubscription()
      // Only the subscription the page named: another tab may have replaced it meanwhile.
      .then((subscription) => subscription && subscription.endpoint === event.data.endpoint && subscription.unsubscribe())
      .catch(() => {}),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin)
  // Only ever open this app's own pages.
  if (url.origin !== self.location.origin) return
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      if ('navigate' in client) {
        await client.focus()
        await client.navigate(url.href)
        return
      }
    }
    await self.clients.openWindow(url.href)
  })())
})
