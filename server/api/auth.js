import { Hono } from 'hono'
import { signJwt, authMiddleware } from '../middleware/auth.js'
import { badRequest, serverError } from '../utils/response.js'
import UsersDao from '../dao/users.js'
import { verifyPassword, hashPassword } from '../utils/password.js'
import { newSecret, otpauthUrl, qrDataUrl, verifyCode } from '../utils/totp.js'
import { checkLoginThrottle, recordLoginFailure, recordLoginSuccess } from '../lib/login-throttle.js'

const router = new Hono()

const TOKEN_TTL_SECONDS = 60 * 60 * 4 // 4h

/** 통일된 401 에러 응답(코드 키를 프론트 계약에 맞춤). */
const authError = (c, code, status = 401) => c.json({ error: code }, status)

/**
 * POST /api/auth/login  { username?, password, code? } → { token, expires_in }
 *
 * - username 없으면 'admin'.
 * - 비번 틀림 → 401 { error: 'invalid_credentials' }
 * - 비번 맞고 totp_enabled=1 인데 code 없음 → 401 { error: 'totp_required' }
 * - 비번 맞고 totp 켜짐 + code 틀림 → 401 { error: 'invalid_code' }
 * - 성공 → 200 { token, expires_in }  (sub=username)
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
  const role = user.role === 'admin' ? 'admin' : 'user'
  const token = await signJwt({ sub: user.username, role }, c.env.JWT_SECRET, TOKEN_TTL_SECONDS)
  return c.json({ token, expires_in: TOKEN_TTL_SECONDS })
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
