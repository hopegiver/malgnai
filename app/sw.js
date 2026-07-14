/**
 * Service Worker for Web Push Notifications
 * Handles push events and displays notifications
 */

// Handle push events
self.addEventListener('push', event => {
  console.log('[SW] Push event received:', event)

  let notificationOptions = {
    body: 'Push notification',
    icon: '/assets/icons/icon-192x192.png',
    badge: '/badge-72x72.png',
    tag: 'malgnai-notification',
    requireInteraction: false
  }

  if (event.data) {
    try {
      const data = event.data.json()
      notificationOptions = {
        ...notificationOptions,
        ...data,
        data: data.data || {}
      }
    } catch (err) {
      notificationOptions.body = event.data.text()
    }
  }

  const title = notificationOptions.title || '알림'
  delete notificationOptions.title

  event.waitUntil(
    self.registration.showNotification(title, notificationOptions)
  )

  // Vibrate on push (if supported)
  if ('vibrate' in navigator) {
    navigator.vibrate([200, 100, 200])
  }
})

// Handle notification click
self.addEventListener('notificationclick', event => {
  console.log('[SW] Notification clicked:', event.notification)
  event.notification.close()

  const url = event.notification.data?.url || '/'
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Check if there's already a window/tab open with the target URL
      for (const client of clientList) {
        if (client.url === url && 'focus' in client) {
          return client.focus()
        }
      }
      // If not, open a new window/tab with the target URL
      if (clients.openWindow) {
        return clients.openWindow(url)
      }
    })
  )
})

// Handle notification close
self.addEventListener('notificationclose', event => {
  console.log('[SW] Notification closed:', event.notification)
})

// Service Worker lifecycle
self.addEventListener('install', event => {
  console.log('[SW] Service Worker installing')
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  console.log('[SW] Service Worker activating')
  event.waitUntil(clients.claim())
})
