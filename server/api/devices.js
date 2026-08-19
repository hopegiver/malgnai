// 디바이스 페어링 + 디바이스 관리 — api.md §5.2, architecture.md §6.2.
import { Hono } from 'hono'
import * as devicePairingsDao from '../dao/device-pairings.js'
import * as deviceTokensDao from '../dao/device-tokens.js'
import * as auditLogsDao from '../dao/audit-logs.js'
import * as oauthRefreshTokensDao from '../dao/oauth-refresh-tokens.js'
import { generateOpaqueToken, sha256Hex } from '../lib/tokens.js'

const devices = new Hono()

// POST /api/devices/pair-init — 무인증(PUBLIC_PATHS). device_pairings만 'pending'으로 생성, 아직 권한 없음.
devices.post('/pair-init', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const deviceId = typeof body.device_id === 'string' ? body.device_id.trim() : ''
  const deviceName = typeof body.device_name === 'string' ? body.device_name.trim() : null
  if (!deviceId) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'device_id is required' } }, 400)

  const { pairingCode, expiresIn } = await devicePairingsDao.create(c.env.DB, { deviceId, deviceName })
  const webOrigin = c.env.WEB_APP_URL || new URL(c.req.url).origin
  return c.json({
    pairing_code: pairingCode,
    pairing_url: `${webOrigin}/devices/pair?code=${encodeURIComponent(pairingCode)}`,
    expires_in: expiresIn
  })
})

// POST /api/devices/pair-approve — JWT 인증(본인). 코드+로그인 세션 조합이 있어야 승인 가능(무차별 대입 방지).
devices.post('/pair-approve', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const code = typeof body.pairing_code === 'string' ? body.pairing_code.trim().toUpperCase() : ''
  if (!code) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'pairing_code is required' } }, 400)

  const pairing = await devicePairingsDao.findByCode(c.env.DB, code)
  if (!pairing) return c.json({ error: { code: 'NOT_FOUND', message: 'pairing code not found' } }, 404)
  if (pairing.status !== 'pending') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: `pairing is already ${pairing.status}` } }, 400)
  }
  if (devicePairingsDao.isExpired(pairing)) {
    await devicePairingsDao.markExpired(c.env.DB, code)
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'pairing code expired' } }, 400)
  }

  const userId = c.get('userId')
  const rawToken = generateOpaqueToken()
  const tokenHash = await sha256Hex(rawToken)
  const created = await deviceTokensDao.insert(c.env.DB, {
    userId, deviceId: pairing.device_id, deviceName: pairing.device_name, tokenHash
  })
  const approved = await devicePairingsDao.approve(c.env.DB, code, {
    approvedBy: userId, deviceTokenId: created.id, rawTokenOnce: rawToken
  })
  if (!approved) {
    // 레이스: 그 사이 다른 요청이 먼저 승인/만료시켰다면 방금 만든 device_token은 무효화한다.
    await deviceTokensDao.revoke(c.env.DB, created.id)
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'pairing already resolved' } }, 400)
  }
  await auditLogsDao.record(c.env.DB, {
    actorUserId: userId, action: 'device_token.issued', targetType: 'device_token', targetId: created.id,
    metadata: { device_id: pairing.device_id, device_name: pairing.device_name }
  })
  return c.json({ status: 'approved', device_id: pairing.device_id })
})

// GET /api/devices/pair-status?code=... — 무인증(PUBLIC_PATHS) 폴링. approved 시 단 1회 raw device_token 포함.
devices.get('/pair-status', async (c) => {
  const code = (c.req.query('code') || '').trim().toUpperCase()
  if (!code) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'code query param is required' } }, 400)

  const pairing = await devicePairingsDao.findByCode(c.env.DB, code)
  if (!pairing) return c.json({ error: { code: 'NOT_FOUND', message: 'pairing code not found' } }, 404)

  if (pairing.status === 'pending' && devicePairingsDao.isExpired(pairing)) {
    await devicePairingsDao.markExpired(c.env.DB, code)
    return c.json({ status: 'expired' })
  }
  if (pairing.status !== 'approved') {
    return c.json({ status: pairing.status })
  }
  if (pairing.raw_token_once) {
    const rawToken = pairing.raw_token_once
    await devicePairingsDao.consumeRawToken(c.env.DB, code)
    return c.json({ status: 'approved', device_token: rawToken })
  }
  // 이미 1회 소비됨 — 재폴링은 평문 없이 상태만.
  return c.json({ status: 'approved' })
})

// GET /api/devices — 본인 디바이스 목록(평문 노출 안 함).
devices.get('/', async (c) => {
  const list = await deviceTokensDao.listForUser(c.env.DB, c.get('userId'))
  return c.json({ data: list })
})

// DELETE /api/devices/:id — 본인 or administrator. 즉시 폐기 + audit_logs.
devices.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const token = await deviceTokensDao.findById(c.env.DB, id)
  if (!token) return c.json({ error: { code: 'NOT_FOUND', message: 'device token not found' } }, 404)

  const userId = c.get('userId')
  const isOwner = token.user_id === userId
  const isAdmin = c.get('userRole') === 'administrator'
  if (!isOwner && !isAdmin) return c.json({ error: { code: 'FORBIDDEN', message: 'not your device' } }, 403)

  const revoked = await deviceTokensDao.revoke(c.env.DB, id)
  if (revoked) {
    // 이 디바이스 토큰이 OAuth로 발급된 것이었다면 연결된 refresh token도 함께 폐기한다(레거시
    // pair-approve 발급분은 애초에 oauth_refresh_tokens 행이 없으므로 그냥 0건 UPDATE로 끝난다).
    await oauthRefreshTokensDao.revokeAllForDeviceToken(c.env.DB, id, 'device_revoked')
    await auditLogsDao.record(c.env.DB, {
      actorUserId: userId, action: 'device_token.revoked', targetType: 'device_token', targetId: id,
      metadata: isAdmin && !isOwner ? { cross_user: true, owner_user_id: token.user_id } : undefined
    })
  }
  return c.json({ status: 'revoked' })
})

export default devices
