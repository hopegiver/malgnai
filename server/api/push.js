import { Hono } from 'hono'
import { createPushSubscriptionDAO } from '../dao/push-subscriptions.js'
import { sendPushNotification } from '../lib/push-notifier.js'
import { authMiddleware } from '../middleware/auth.js'
import { isSuperAdmin } from '../lib/roles.js'

const pushRouter = new Hono()
pushRouter.use('*', authMiddleware)

/**
 * POST /api/push/subscribe
 * Subscribe user to push notifications
 */
pushRouter.post('/subscribe', async (c) => {
  try {
    const body = await c.req.json()
    const userId = c.get('user')?.sub

    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    if (!body.subscription || !body.subscription.endpoint) {
      return c.json({ error: 'Invalid subscription' }, 400)
    }

    const pushDAO = createPushSubscriptionDAO(c.env.DB)
    const sub = pushDAO.upsertSubscription(userId, body.subscription)

    return c.json({
      success: true,
      subscription: sub
    })
  } catch (err) {
    console.error('[Push] Subscribe error:', err)
    return c.json({ error: err.message }, 500)
  }
})

/**
 * DELETE /api/push/unsubscribe
 * Unsubscribe user from push notifications
 */
pushRouter.delete('/unsubscribe', async (c) => {
  try {
    const body = await c.req.json()
    const endpoint = body.endpoint

    if (!endpoint) {
      return c.json({ error: 'Missing endpoint' }, 400)
    }

    const pushDAO = createPushSubscriptionDAO(c.env.DB)
    const deleted = pushDAO.deleteSubscriptionByEndpoint(endpoint)

    return c.json({
      success: deleted,
      message: deleted ? 'Subscription removed' : 'Subscription not found'
    })
  } catch (err) {
    console.error('[Push] Unsubscribe error:', err)
    return c.json({ error: err.message }, 500)
  }
})

/**
 * GET /api/push/subscriptions
 * Get all subscriptions for the current user
 */
pushRouter.get('/subscriptions', (c) => {
  try {
    const userId = c.get('user')?.sub

    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const pushDAO = createPushSubscriptionDAO(c.env.DB)
    const subscriptions = pushDAO.getSubscriptionsByUserId(userId)

    return c.json({
      success: true,
      subscriptions,
      count: subscriptions.length
    })
  } catch (err) {
    console.error('[Push] Get subscriptions error:', err)
    return c.json({ error: err.message }, 500)
  }
})

/**
 * POST /api/push/test
 * Send test notification (super_admin only)
 */
pushRouter.post('/test', async (c) => {
  try {
    const userId = c.get('user')?.sub
    const userRole = c.get('user')?.role

    if (!userId || !isSuperAdmin(userRole)) {
      return c.json({ error: 'Super admin only' }, 403)
    }

    const result = await sendPushNotification(c.env.DB, [userId], {
      title: '테스트 알림',
      body: 'Web Push가 정상 작동합니다!',
      tag: 'test-notification'
    })

    return c.json({
      success: true,
      result
    })
  } catch (err) {
    console.error('[Push] Test notification error:', err)
    return c.json({ error: err.message }, 500)
  }
})

export default pushRouter
