import webpush from 'web-push'
import { createPushSubscriptionDAO } from '../dao/push-subscriptions.js'

// Configure VAPID keys
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY

if (vapidPublicKey && vapidPrivateKey) {
  webpush.setVapidDetails(
    'mailto:admin@malgnai.local',
    vapidPublicKey,
    vapidPrivateKey
  )
}

/**
 * Send push notification to specific users
 * @param {Object} db - Database instance
 * @param {Array<string>} userIds - User IDs to notify
 * @param {Object} options - Notification options
 * @returns {Promise<Object>} Result with sent count and errors
 */
export async function sendPushNotification(db, userIds, options) {
  if (!vapidPublicKey || !vapidPrivateKey) {
    console.warn('[Push] VAPID keys not configured, skipping notification')
    return { sent: 0, failed: 0, errors: [] }
  }

  const pushDAO = createPushSubscriptionDAO(db)
  const subscriptions = pushDAO.getSubscriptionsByUserIds(userIds)

  if (subscriptions.length === 0) {
    return { sent: 0, failed: 0, errors: [] }
  }

  const payload = JSON.stringify({
    title: options.title || '알림',
    body: options.body || '',
    icon: options.icon || '/icon-192x192.png',
    badge: options.badge || '/badge-72x72.png',
    tag: options.tag || 'malgnai',
    requireInteraction: false,
    data: options.data ? JSON.parse(options.data) : {}
  })

  let sent = 0
  let failed = 0
  const errors = []

  // Send to each subscription in parallel
  const promises = subscriptions.map(async (sub) => {
    try {
      const subscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.p256dh,
          auth: sub.auth
        }
      }

      await webpush.sendNotification(subscription, payload)
      sent++
    } catch (err) {
      failed++
      // Remove subscription if endpoint is invalid or gone (410)
      if (err.statusCode === 410 || err.statusCode === 404) {
        pushDAO.deleteSubscriptionByEndpoint(sub.endpoint)
      }
      errors.push({
        endpoint: sub.endpoint,
        message: err.message,
        statusCode: err.statusCode
      })
    }
  })

  await Promise.all(promises)

  return { sent, failed, errors }
}

/**
 * Send approval notification
 * @param {Object} db - Database instance
 * @param {string} userId - User ID to notify
 * @param {Object} command - Command object with id, title, status, etc.
 * @returns {Promise<Object>}
 */
export async function sendApprovalNotification(db, userId, command) {
  const statusLabel = {
    queued: '승인 대기',
    approved: '승인됨',
    rejected: '반려됨'
  }[command.status] || command.status

  return sendPushNotification(db, [userId], {
    title: '승인함 알림',
    body: `${command.title || '새 명령'}: ${statusLabel}`,
    tag: `approval-${command.id}`,
    data: JSON.stringify({
      type: 'approval',
      commandId: command.id,
      status: command.status,
      url: `/approvals?id=${command.id}`,
      timestamp: new Date().toISOString()
    })
  })
}

/**
 * Send project notification
 * @param {Object} db - Database instance
 * @param {string} userId - User ID to notify
 * @param {Object} options - Options with projectName, action, etc.
 * @returns {Promise<Object>}
 */
export async function sendProjectNotification(db, userId, options) {
  return sendPushNotification(db, [userId], {
    title: '프로젝트 알림',
    body: `${options.projectName}: ${options.action}`,
    tag: `project-${options.projectId}`,
    data: JSON.stringify({
      type: 'project',
      projectId: options.projectId,
      action: options.action,
      url: `/projects/${options.projectId}`,
      timestamp: new Date().toISOString()
    })
  })
}

export default {
  sendPushNotification,
  sendApprovalNotification,
  sendProjectNotification
}
