/**
 * Web Push Notification Client
 * Handles subscription and receiving push notifications
 */

export const PushClient = {
  /**
   * Check if browser supports web push notifications
   */
  isSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  },

  /**
   * Request notification permission
   */
  async requestPermission() {
    if (!this.isSupported()) {
      console.warn('[Push] Browser does not support web push')
      return 'denied'
    }

    if (Notification.permission === 'granted') {
      return 'granted'
    }

    if (Notification.permission === 'denied') {
      return 'denied'
    }

    return await Notification.requestPermission()
  },

  /**
   * Register service worker
   */
  async registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
      console.warn('[Push] Service Worker not supported')
      return null
    }

    try {
      const registration = await navigator.serviceWorker.register('/sw.js', {
        scope: '/'
      })
      console.log('[Push] Service Worker registered:', registration)
      return registration
    } catch (err) {
      console.error('[Push] Service Worker registration failed:', err)
      return null
    }
  },

  /**
   * Subscribe to push notifications
   */
  async subscribe() {
    if (!this.isSupported()) {
      console.warn('[Push] Web push not supported')
      return null
    }

    try {
      // Request permission first
      const permission = await this.requestPermission()
      if (permission !== 'granted') {
        console.warn('[Push] Notification permission denied')
        return null
      }

      // Register service worker
      const registration = await this.registerServiceWorker()
      if (!registration) {
        return null
      }

      // Get VAPID public key from server
      const vapidPublicKey = await this.getVapidPublicKey()
      if (!vapidPublicKey) {
        console.error('[Push] VAPID public key not available')
        return null
      }

      // Convert VAPID key to Uint8Array
      const vapidPublicKeyBytes = this.urlBase64ToUint8Array(vapidPublicKey)

      // Subscribe to push
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidPublicKeyBytes
      })

      console.log('[Push] Subscribed to push notifications:', subscription)

      // Send subscription to server
      const result = await this.sendSubscriptionToServer(subscription)
      console.log('[Push] Subscription saved on server:', result)

      return subscription
    } catch (err) {
      console.error('[Push] Subscription failed:', err)
      return null
    }
  },

  /**
   * Unsubscribe from push notifications
   */
  async unsubscribe() {
    if (!('serviceWorker' in navigator)) {
      return false
    }

    try {
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()

      if (!subscription) {
        console.warn('[Push] No active subscription')
        return false
      }

      // Notify server
      await this.removeSubscriptionFromServer(subscription)

      // Unsubscribe from push manager
      const success = await subscription.unsubscribe()
      console.log('[Push] Unsubscribed:', success)
      return success
    } catch (err) {
      console.error('[Push] Unsubscribe failed:', err)
      return false
    }
  },

  /**
   * Get current subscription
   */
  async getSubscription() {
    if (!('serviceWorker' in navigator)) {
      return null
    }

    try {
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      return subscription
    } catch (err) {
      console.error('[Push] Get subscription failed:', err)
      return null
    }
  },

  /**
   * Get VAPID public key from server
   */
  async getVapidPublicKey() {
    try {
      const response = await fetch('/api/system/vapid-public-key')
      if (!response.ok) {
        console.error('[Push] Failed to get VAPID key:', response.statusText)
        return null
      }
      const data = await response.json()
      return data.publicKey
    } catch (err) {
      console.error('[Push] VAPID key fetch failed:', err)
      return null
    }
  },

  /**
   * Send subscription to server
   */
  async sendSubscriptionToServer(subscription) {
    try {
      const response = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.getToken()}`
        },
        body: JSON.stringify({
          subscription
        })
      })

      if (!response.ok) {
        console.error('[Push] Failed to save subscription:', response.statusText)
        return null
      }

      return await response.json()
    } catch (err) {
      console.error('[Push] Send subscription failed:', err)
      return null
    }
  },

  /**
   * Remove subscription from server
   */
  async removeSubscriptionFromServer(subscription) {
    try {
      const response = await fetch('/api/push/unsubscribe', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.getToken()}`
        },
        body: JSON.stringify({
          endpoint: subscription.endpoint
        })
      })

      if (!response.ok) {
        console.error('[Push] Failed to remove subscription:', response.statusText)
        return false
      }

      return true
    } catch (err) {
      console.error('[Push] Remove subscription failed:', err)
      return false
    }
  },

  /**
   * Convert VAPID public key from base64 to Uint8Array
   */
  urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
    const base64 = (base64String + padding)
      .replace(/\-/g, '+')
      .replace(/_/g, '/')

    const rawData = window.atob(base64)
    const outputArray = new Uint8Array(rawData.length)

    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i)
    }
    return outputArray
  },

  /**
   * Get JWT token from localStorage
   */
  getToken() {
    return localStorage.getItem('token') || ''
  },

  /**
   * Test push notification (admin only)
   */
  async sendTestNotification() {
    try {
      const response = await fetch('/api/push/test', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.getToken()}`
        }
      })

      if (!response.ok) {
        console.error('[Push] Test notification failed:', response.statusText)
        return null
      }

      return await response.json()
    } catch (err) {
      console.error('[Push] Test notification error:', err)
      return null
    }
  }
}

export default PushClient
