import { v4 as uuid } from 'uuid'

/**
 * Create Push Subscriptions DAO with database instance
 * @param {Object} db - Database instance (D1-compatible)
 * @returns {Object} DAO methods
 */
export function createPushSubscriptionDAO(db) {
  return {
    /**
     * Create or update a push subscription
     */
    upsertSubscription(userId, subscription) {
      const id = uuid()
      const now = new Date().toISOString()

      const stmt = db.prepare(`
        INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
          user_id = excluded.user_id,
          p256dh = excluded.p256dh,
          auth = excluded.auth,
          updated_at = excluded.updated_at
      `)

      stmt.run(
        id,
        userId,
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth,
        now,
        now
      )

      return this.getSubscriptionByEndpoint(subscription.endpoint)
    },

    /**
     * Get all subscriptions for a user
     */
    getSubscriptionsByUserId(userId) {
      const stmt = db.prepare(`
        SELECT id, user_id, endpoint, p256dh, auth, created_at, updated_at
        FROM push_subscriptions
        WHERE user_id = ?
        ORDER BY created_at DESC
      `)

      const result = stmt.all(userId)
      return result.results || []
    },

    /**
     * Get a subscription by endpoint
     */
    getSubscriptionByEndpoint(endpoint) {
      const stmt = db.prepare(`
        SELECT id, user_id, endpoint, p256dh, auth, created_at, updated_at
        FROM push_subscriptions
        WHERE endpoint = ?
      `)

      return stmt.first() || null
    },

    /**
     * Delete a subscription by endpoint
     */
    deleteSubscriptionByEndpoint(endpoint) {
      const stmt = db.prepare(`
        DELETE FROM push_subscriptions
        WHERE endpoint = ?
      `)

      const result = stmt.run(endpoint)
      return (result.meta?.changes || 0) > 0
    },

    /**
     * Delete all subscriptions for a user
     */
    deleteSubscriptionsByUserId(userId) {
      const stmt = db.prepare(`
        DELETE FROM push_subscriptions
        WHERE user_id = ?
      `)

      const result = stmt.run(userId)
      return result.meta?.changes || 0
    },

    /**
     * Get all subscriptions (for broadcasting to all users)
     */
    getAllSubscriptions() {
      const stmt = db.prepare(`
        SELECT id, user_id, endpoint, p256dh, auth, created_at, updated_at
        FROM push_subscriptions
        ORDER BY user_id, created_at DESC
      `)

      const result = stmt.all()
      return result.results || []
    },

    /**
     * Get subscriptions for specific users
     */
    getSubscriptionsByUserIds(userIds) {
      if (!userIds || userIds.length === 0) return []

      const placeholders = userIds.map(() => '?').join(',')
      const stmt = db.prepare(`
        SELECT id, user_id, endpoint, p256dh, auth, created_at, updated_at
        FROM push_subscriptions
        WHERE user_id IN (${placeholders})
        ORDER BY user_id, created_at DESC
      `)

      const result = stmt.all(...userIds)
      return result.results || []
    }
  }
}

export default createPushSubscriptionDAO
