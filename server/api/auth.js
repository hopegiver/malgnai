import { Hono } from 'hono'
import { signJwt, authMiddleware } from '../middleware/auth.js'
import { badRequest, serverError } from '../utils/response.js'
import UsersDao from '../dao/users.js'
import RefreshTokensDao from '../dao/refresh-tokens.js'
import { verifyPassword, hashPassword } from '../utils/password.js'
import { newSecret, otpauthUrl, qrDataUrl, verifyCode } from '../utils/totp.js'
import { checkLoginThrottle, recordLoginFailure, recordLoginSuccess } from '../lib/login-throttle.js'
import { generateRefreshToken, hashRefreshToken, REFRESH_TOKEN_TTL_SECONDS, REUSE_GRACE_MS } from '../lib/refresh-token.js'

const router = new Hono()

const TOKEN_TTL_SECONDS = 60 * 60 * 4 // 4h

/**
 * user 에 대해 access token(4h JWT) + refresh token(30일, opaque, DB 저장)을 함께 발급한다.
 * login/refresh 양쪽에서 공유. 로그인 시 opportunistic 하게 그 유저의 만료 토큰도 정리한다.
 */
async function issueTokenPair(c, user) {
  const refreshTokensDao = new RefreshTokensDao(c.env.DB)
  const role = user.role === 'admin' ? 'admin' : 'user'

  const token = await signJwt({ sub: user.username, role }, c.env.JWT_SECRET, TOKEN_TTL_SECONDS)

  const rawRefreshToken = generateRefreshToken()
  const refreshTokenHash = await hashRefreshToken(rawRefreshToken)
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString()
  await refreshTokensDao.create(user.id, refreshTokenHash, expiresAt)
  // opportunistic cleanup: 이 유저의 만료된 refresh token 행을 함께 정리(실패해도 무시).
  await refreshTokensDao.deleteExpiredForUser(user.id).catch(() => {})

  return {
    token,
    expires_in: TOKEN_TTL_SECONDS,
    refresh_token: rawRefreshToken,
    refresh_expires_in: REFRESH_TOKEN_TTL_SECONDS,
  }
}

/** 통일된 401 에러 응답(코드 키를 프론트 계약에 맞춤). */
const authError = (c, code, status = 401) => c.json({ error: code }, status)

/**
 * POST /api/auth/login  { username?, password, code? }
 *   → { token, expires_in, refresh_token, refresh_expires_in }
 *
 * - username 없으면 'admin'.
 * - 비번 틀림 → 401 { error: 'invalid_credentials' }
 * - 비번 맞고 totp_enabled=1 인데 code 없음 → 401 { error: 'totp_required' }
 * - 비번 맞고 totp 켜짐 + code 틀림 → 401 { error: 'invalid_code' }
 * - 성공 → 200 { token, expires_in, refresh_token, refresh_expires_in }  (sub=username)
 *
 * [refresh token] access token(4h)과 별도로 30일 짜리 opaque refresh token 을 함께 발급한다.
 * PWA 로 상시 설치해 쓰는 내부 도구 특성상 4h 마다 재로그인하는 불편을 줄이기 위함 —
 * 클라이언트는 access token 만료 전/직후 POST /api/auth/refresh 로 재발급받는다.
 *
 * [로컬 직결 OTP 스킵] cf-ray/cf-connecting-ip 헤더가 없으면(=터널을 거치지 않은
 * 로컬 PC 직결 접속) totp_enabled 여도 코드 검증을 건너뛴다. 이 헤더는 Cloudflare
 * 엣지가 붙이며 클라이언트가 위조할 수 없어(server/index.js 참고) 외부(터널) 요청과
 * 안전하게 구분된다.
 *
 * [브루트포스 방어] username 기준 15분 내 5회 실패(존재하지 않는 계정 포함) 시
 * 15분 잠금 → 429 { error: 'too_many_attempts', retry_after_seconds }.
 * server/lib/login-throttle.js, 인메모리(상시 단일 프로세스 전제).
 */
router.post('/login', async (c) => {
  if (!c.env.JWT_SECRET) return serverError(c, 'JWT secret not configured')

  const body = await c.req.json().catch(() => ({}))
  const username = typeof body.username === 'string' && body.username.trim()
    ? body.username.trim()
    : 'admin'
  const password = typeof body.password === 'string' ? body.password : ''
  const code = typeof body.code === 'string' || typeof body.code === 'number'
    ? String(body.code)
    : ''

  if (!password) return badRequest(c, 'password is required')

  const throttle = checkLoginThrottle(username)
  if (throttle.locked) {
    return c.json({ error: 'too_many_attempts', retry_after_seconds: throttle.retryAfterSeconds }, 429)
  }

  const usersDao = new UsersDao(c.env.DB)
  const user = await usersDao.findByUsername(username)

  // 사용자 없음/비번 불일치 모두 동일 응답(사용자 존재 여부 누출 방지).
  if (!user) {
    recordLoginFailure(username)
    return authError(c, 'invalid_credentials')
  }
  const passwordOk = await verifyPassword(password, user.password_hash, user.password_salt)
  if (!passwordOk) {
    recordLoginFailure(username)
    return authError(c, 'invalid_credentials')
  }

  // 비번 통과 후 TOTP 게이트. 터널 경유(외부) 요청만 강제한다.
  const viaCloudflare = c.req.header('cf-ray') || c.req.header('cf-connecting-ip')
  if (user.totp_enabled && viaCloudflare) {
    if (!code) return authError(c, 'totp_required')
    if (!verifyCode(code, user.totp_secret)) {
      recordLoginFailure(username)
      return authError(c, 'invalid_code')
    }
  }

  recordLoginSuccess(username)
  const tokens = await issueTokenPair(c, user)
  return c.json(tokens)
})

/**
 * POST /api/auth/refresh  { refresh_token } → { token, expires_in, refresh_token, refresh_expires_in }
 *
 * authMiddleware 없이 동작한다(access token 이 이미 만료된 상태에서 호출되는 경로이므로
 * Authorization 헤더 검증을 걸면 안 된다). refresh token 은 1회용 회전형(rotation)이다:
 * 매 호출마다 기존 토큰을 revoke 하고 새 access/refresh 쌍을 발급한다.
 *
 * - refresh_token 없음 → 400.
 * - DB 에 없는 토큰 → 401 { error: 'invalid_refresh_token' }.
 * - 만료된 토큰(최초 사용 경로) → 401 { error: 'invalid_refresh_token' }.
 * - [재사용, grace window 이내] 이미 revoke 된 토큰이 **정상 회전(revoke_reason='rotated')으로**
 *   revoke 후 REUSE_GRACE_MS(기본 10초) 이내에 다시 들어오면 — 탈취로 취급하지 않고 정상적인
 *   동시 요청(같은 stale 토큰을 들고 있던 다른 병렬 호출/다른 탭)으로 간주해 그냥 새
 *   access/refresh 쌍을 하나 더 발급한다. 다른 세션은 건드리지 않는다.
 *   (server/lib/refresh-token.js REUSE_GRACE_MS 주석 참고, reviewer 리뷰로 재현된
 *   collateral-revoke 버그의 완화책 — grace window 없이 즉시 전체 revoke하면 방금 정상
 *   발급된 최신 토큰까지 같이 죽어 정상 사용자가 강제 로그아웃당했다.)
 *   [주의] grace window 는 revoke_reason==='rotated' 인 경우에만 적용한다. logout 이나
 *   탈취탐지(reuse_detected)로 revoke된 토큰은 timing 과 무관하게 항상 즉시 거부한다 —
 *   그렇지 않으면 logout 직후/전체계정 revoke 직후에도 같은 grace window 로 되살아나는
 *   회귀가 생긴다(2026-07-13 발견, server/dao/refresh-tokens.js 상단 주석 참고).
 * - [탈취 감지] revoke_reason이 'rotated'가 아니거나(logout/이미 탈취탐지됨), 'rotated'라도
 *   REUSE_GRACE_MS 를 넘긴 재사용은 진짜 탈취 신호로 간주해 그 유저의 모든 refresh token 을
 *   강제 revoke(reuse_detected)하고 401 { error: 'invalid_refresh_token' }.
 * - 정상(최초 사용) → 기존 토큰 revoke('rotated') + 새 access/refresh 쌍 발급, login 과 동일한 응답 형태.
 */
router.post('/refresh', async (c) => {
  if (!c.env.JWT_SECRET) return serverError(c, 'JWT secret not configured')

  const body = await c.req.json().catch(() => ({}))
  const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : ''
  if (!refreshToken) return badRequest(c, 'refresh_token is required')

  const refreshTokensDao = new RefreshTokensDao(c.env.DB)
  const tokenHash = await hashRefreshToken(refreshToken)
  const stored = await refreshTokensDao.findByHash(tokenHash)

  if (!stored) return authError(c, 'invalid_refresh_token')

  if (stored.revoked_at) {
    const elapsedMs = Date.now() - new Date(stored.revoked_at).getTime()
    const withinGrace = stored.revoke_reason === 'rotated' && elapsedMs <= REUSE_GRACE_MS
    if (!withinGrace) {
      // [탈취 감지] grace 대상이 아니거나(logout/이미 탈취탐지) grace window 밖의 재사용 —
      // 이 유저의 모든 refresh token 을 강제 무효화한다.
      await refreshTokensDao.revokeAllForUser(stored.user_id)
      return authError(c, 'invalid_refresh_token')
    }
    // [grace window 이내, 정상 회전분] 정상적인 동시 요청으로 간주 — 이 토큰은 이미 revoke
    // 되어 있으니 다시 revoke하지 않고, 다른 세션을 건드리지 않은 채 이 요청 몫의 새 쌍만 발급한다.
  } else {
    if (new Date(stored.expires_at).getTime() < Date.now()) {
      return authError(c, 'invalid_refresh_token')
    }
    // 회전(rotation): 최초 사용이므로 이번에 쓴 토큰을 즉시 revoke한다.
    await refreshTokensDao.revokeByHash(tokenHash, 'rotated')
  }

  const usersDao = new UsersDao(c.env.DB)
  const user = await usersDao.findById(stored.user_id)
  if (!user) return authError(c, 'invalid_refresh_token')

  const tokens = await issueTokenPair(c, user)
  return c.json(tokens)
})

/**
 * POST /api/auth/logout  { refresh_token? } → { ok: true }
 *
 * authMiddleware 없이 동작한다(access token 이 이미 만료된 상태에서도 로그아웃을 호출할
 * 수 있어야 한다). refresh_token 이 주어지면 해당 토큰만 revoke 한다. 존재하지 않거나
 * 이미 revoke 된 토큰이어도 에러를 내지 않고 항상 200 { ok: true } 를 반환한다(로그아웃은
 * 멱등이어야 하고, 토큰 유효성 정보를 노출할 이유가 없다).
 */
router.post('/logout', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : ''
  if (refreshToken && c.env.DB) {
    const refreshTokensDao = new RefreshTokensDao(c.env.DB)
    const tokenHash = await hashRefreshToken(refreshToken)
    await refreshTokensDao.revokeByHash(tokenHash, 'logout').catch(() => {})
  }
  return c.json({ ok: true })
})

/**
 * GET /api/auth/me  [JWT] → { user: { username, role }, totp_enabled: boolean }
 */
router.get('/me', authMiddleware, async (c) => {
  const payload = c.get('user')
  const usersDao = new UsersDao(c.env.DB)
  const user = await usersDao.findByUsername(payload.sub)
  if (!user) return authError(c, 'invalid_credentials')
  return c.json({
    user: { username: user.username, role: user.role === 'admin' ? 'admin' : 'user' },
    totp_enabled: !!user.totp_enabled,
  })
})

/**
 * POST /api/auth/password  [JWT] { current_password, new_password } → { ok: true }
 *
 * 본인 비밀번호 변경(셀프서비스). 현재 비밀번호를 반드시 재확인(JWT 탈취만으로
 * 비번을 못 바꾸도록). 새 비번은 최소 8자.
 *  - 현재 비번 불일치 → 401 { error: 'invalid_password' }
 *  - 새 비번 규칙 위반 → 400 { error: ... }
 */
router.post('/password', authMiddleware, async (c) => {
  const payload = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  const currentPassword = typeof body.current_password === 'string' ? body.current_password : ''
  const newPassword = typeof body.new_password === 'string' ? body.new_password : ''

  if (newPassword.length < 8) return badRequest(c, '새 비밀번호는 최소 8자 이상이어야 합니다.')

  const usersDao = new UsersDao(c.env.DB)
  const user = await usersDao.findByUsername(payload.sub)
  if (!user) return authError(c, 'invalid_credentials')

  const ok = await verifyPassword(currentPassword, user.password_hash, user.password_salt)
  if (!ok) return authError(c, 'invalid_password')

  const { hash, salt } = await hashPassword(newPassword)
  await usersDao.updatePasswordById(user.id, hash, salt)
  return c.json({ ok: true })
})

/**
 * POST /api/auth/totp/setup  [JWT] → { otpauth_url, qr_data_url }
 *
 * 새 secret 을 생성·저장하되 enabled 는 0 유지(pending). enable 호출로 확정된다.
 * label = malgnai:<username>, issuer = malgnai.
 */
router.post('/totp/setup', authMiddleware, async (c) => {
  const payload = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  const code = body.code != null ? String(body.code) : ''
  const usersDao = new UsersDao(c.env.DB)
  const user = await usersDao.findByUsername(payload.sub)
  if (!user) return authError(c, 'invalid_credentials')

  // [M-002] 이미 2FA 활성 사용자는 현재 유효 코드 재확인 없이는 secret 재발급 불가.
  // (JWT 탈취만으로 setup 을 호출해 기존 2FA 를 pending 으로 내려 무력화하는 것을 차단)
  if (user.totp_enabled && !verifyCode(code, user.totp_secret)) {
    return authError(c, 'invalid_code', 400)
  }

  const secret = newSecret()
  // pending: secret 저장, enabled=0. (enable 검증 통과 전까지 2차 인증 강제 안 함)
  await usersDao.setTotp(user.username, secret, 0)

  const otpauth_url = otpauthUrl(user.username, secret)
  const qr_data_url = await qrDataUrl(otpauth_url)
  return c.json({ otpauth_url, qr_data_url })
})

/**
 * POST /api/auth/totp/enable  [JWT] { code } → { ok: true } | 400 { error: 'invalid_code' }
 * 저장된(pending) secret 으로 code 검증 성공 시 totp_enabled=1.
 */
router.post('/totp/enable', authMiddleware, async (c) => {
  const payload = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  const code = body.code != null ? String(body.code) : ''

  const usersDao = new UsersDao(c.env.DB)
  const user = await usersDao.findByUsername(payload.sub)
  if (!user) return authError(c, 'invalid_credentials')
  if (!user.totp_secret) return authError(c, 'invalid_code', 400)
  if (!verifyCode(code, user.totp_secret)) return authError(c, 'invalid_code', 400)

  await usersDao.setTotp(user.username, user.totp_secret, 1)
  return c.json({ ok: true })
})

/**
 * POST /api/auth/totp/disable  [JWT] { code } → { ok: true } | 400 { error: 'invalid_code' }
 * code 검증 후 secret=null, enabled=0.
 */
router.post('/totp/disable', authMiddleware, async (c) => {
  const payload = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  const code = body.code != null ? String(body.code) : ''

  const usersDao = new UsersDao(c.env.DB)
  const user = await usersDao.findByUsername(payload.sub)
  if (!user) return authError(c, 'invalid_credentials')
  if (!user.totp_secret) return authError(c, 'invalid_code', 400)
  if (!verifyCode(code, user.totp_secret)) return authError(c, 'invalid_code', 400)

  await usersDao.setTotp(user.username, null, 0)
  return c.json({ ok: true })
})

export default router
