// 웹 로그인(JWT + refresh token) — api.md §5.1.
import { Hono } from 'hono'
import * as usersDao from '../dao/users.js'
import * as refreshTokensDao from '../dao/refresh-tokens.js'
import { verifyPassword, hashPassword, signAccessToken, generateOpaqueToken, sha256Hex, REFRESH_TOKEN_TTL_SECONDS, REUSE_GRACE_MS } from '../lib/tokens.js'

const NAME_MAX_LENGTH = 100
const NEW_PASSWORD_MIN_LENGTH = 12

const auth = new Hono()

async function issueTokenPair(c, user) {
  const { token, expiresIn } = await signAccessToken(user, c.env.JWT_SECRET)
  const rawRefresh = generateOpaqueToken()
  const refreshHash = await sha256Hex(rawRefresh)
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString()
  await refreshTokensDao.insert(c.env.DB, { userId: user.id, tokenHash: refreshHash, expiresAt })
  return { token, expires_in: expiresIn, refresh_token: rawRefresh, refresh_expires_in: REFRESH_TOKEN_TTL_SECONDS }
}

auth.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (!email || !password) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'email and password are required' } }, 400)
  }

  const user = await usersDao.findByEmail(c.env.DB, email)
  // 존재하지 않는 이메일과 틀린 비밀번호를 동일한 오류로 응답(계정 존재 여부 열거 방지).
  if (!user || user.status !== 'active' || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: { code: 'INVALID_CREDENTIALS', message: 'invalid email or password' } }, 401)
  }

  const pair = await issueTokenPair(c, user)
  return c.json(pair)
})

// [재사용 탐지 + grace window] 회전형 refresh token. 매 호출마다 기존 토큰을 revoke(reason='rotated')
// 하고 새 쌍을 발급한다. 이미 revoke된 토큰이 다시 들어오면 원칙적으로 탈취 신호지만, 그 revoke가
// "정상 회전"(revoke_reason='rotated')이었고 REUSE_GRACE_MS(10초) 이내라면 두 탭 동시 갱신·재시도
// 중복 도달 같은 흔한 레이스일 뿐이다 — 이 경우 탈취로 취급하지 않고 이 요청 몫의 새 쌍만 추가
// 발급한다(다른 세션은 건드리지 않음). logout으로 revoke됐거나 이미 reuse_detected로 폐기된
// 토큰의 재사용, 또는 grace window를 넘긴 재사용만 진짜 탈취로 간주해 유저 전체를 폐기한다
// (사내 private 프로젝트 ~/workspace/malgnai/server/api/auth.js — 2026-07-13 reviewer 리뷰로
// 재현·수정된 회귀 — 검증된 패턴을 이 저장소 하우스 스타일로 이식, server/lib/tokens.js 참고).
auth.post('/refresh', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const rawToken = typeof body.refresh_token === 'string' ? body.refresh_token : ''
  if (!rawToken) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'refresh_token is required' } }, 400)
  }

  const tokenHash = await sha256Hex(rawToken)
  const stored = await refreshTokensDao.findByHash(c.env.DB, tokenHash)
  if (!stored) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'invalid refresh token' } }, 401)
  }

  if (stored.status !== 'active') {
    const elapsedMs = stored.revoked_at ? Date.now() - new Date(stored.revoked_at).getTime() : Number.POSITIVE_INFINITY
    const withinGrace = stored.revoke_reason === 'rotated' && elapsedMs <= REUSE_GRACE_MS
    if (!withinGrace) {
      // grace 대상이 아니거나(logout/이미 reuse_detected) grace window 밖의 재사용 — 진짜 탈취 신호.
      await refreshTokensDao.revokeAllForUser(c.env.DB, stored.user_id)
      return c.json({ error: { code: 'TOKEN_REUSED', message: 'refresh token reuse detected, all sessions revoked' } }, 401)
    }
    // grace window 이내, 정상 회전분의 재사용 — 이 토큰은 이미 revoke되어 있으니 다시 revoke하지
    // 않고 다른 세션을 건드리지 않은 채 이 요청 몫의 새 쌍만 발급한다(아래로 그대로 진행).
  } else {
    if (new Date(stored.expires_at).getTime() < Date.now()) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'refresh token expired' } }, 401)
    }
    // 회전(rotation): 최초 사용이므로 이번에 쓴 토큰을 즉시 revoke한다.
    await refreshTokensDao.markRotated(c.env.DB, stored.id)
  }

  const user = await usersDao.findById(c.env.DB, stored.user_id)
  if (!user || user.status !== 'active') {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'account is not active' } }, 401)
  }

  const pair = await issueTokenPair(c, user)
  return c.json(pair)
})

auth.get('/me', async (c) => {
  const user = await usersDao.findById(c.env.DB, c.get('userId'))
  if (!user) return c.json({ error: { code: 'NOT_FOUND', message: 'user not found' } }, 404)
  return c.json({ id: user.id, email: user.email, name: user.name, role: user.role, status: user.status })
})

// PATCH /api/auth/me — 본인 name만 수정 가능. email/role/status는 이 엔드포인트로 불가
// (role/status는 administrator 전용 /api/admin/users/:id로만, email 변경 자체는 v1 범위 밖).
auth.patch('/me', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.name !== 'string') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name is required' } }, 400)
  }
  const name = body.name.trim()
  if (!name) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name must not be empty' } }, 400)
  }
  if (name.length > NAME_MAX_LENGTH) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: `name must be at most ${NAME_MAX_LENGTH} characters` } }, 400)
  }

  const userId = c.get('userId')
  await usersDao.updateName(c.env.DB, userId, name)
  const updated = await usersDao.findById(c.env.DB, userId)
  return c.json({ id: updated.id, email: updated.email, name: updated.name, role: updated.role, status: updated.status })
})

// POST /api/auth/change-password — 본인 비밀번호 변경. 성공 시 이 유저의 모든 refresh_token을
// revoke_reason='logout'으로 폐기(다른 세션/디바이스 강제 로그아웃 — 재사용 grace window 대상
// 아님, 'rotated'가 아니므로 auth.js POST /refresh의 grace 로직을 타지 않는다). 지금 쓰던 access
// token은 자연 만료(최대 4h, ACCESS_TOKEN_TTL_SECONDS)까지는 유효 — 의도된 단순화.
auth.post('/change-password', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : ''
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''
  if (!currentPassword || !newPassword) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'currentPassword and newPassword are required' } }, 400)
  }
  if (newPassword.length < NEW_PASSWORD_MIN_LENGTH) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: `newPassword must be at least ${NEW_PASSWORD_MIN_LENGTH} characters` } }, 400)
  }

  const userId = c.get('userId')
  const user = await usersDao.findById(c.env.DB, userId)
  if (!user) return c.json({ error: { code: 'NOT_FOUND', message: 'user not found' } }, 404)

  if (!(await verifyPassword(currentPassword, user.password_hash))) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'current password is incorrect' } }, 401)
  }

  const newHash = await hashPassword(newPassword)
  await usersDao.updatePasswordHash(c.env.DB, userId, newHash)
  await refreshTokensDao.revokeAllForUser(c.env.DB, userId, 'logout')

  return c.json({ status: 'password_changed' })
})

export default auth
