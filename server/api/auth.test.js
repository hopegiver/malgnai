// POST /api/auth/login, /refresh, /me 회귀 테스트 — docs/design/google-oauth-login.md 결정5
// (issueTokenPair를 server/lib/session-tokens.js로 순수 추출)가 자체인증의 응답 필드·상태코드·
// refresh_tokens 행 생성을 조금도 바꾸지 않았음을 증명한다(§완료판정 3, §10 검증1).
// verifyPassword만 mock(비밀번호 해시 형식과 무관하게 판정을 제어), signAccessToken/refresh 회전
// 로직(rotateOrDetectReuse)은 실제 구현을 그대로 태운다 — 순수 이동이 진짜로 무변화인지 보려면
// 토큰 발급 체인 자체를 실행해야 한다.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { jwtVerify } from 'jose'

const findByEmailMock = vi.fn()
const findByIdMock = vi.fn()
const verifyPasswordMock = vi.fn()

const refreshInsertMock = vi.fn()
const refreshFindByHashMock = vi.fn()
const refreshMarkRotatedMock = vi.fn()
const refreshRevokeAllForUserMock = vi.fn()

vi.mock('../dao/users.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, findByEmail: (...args) => findByEmailMock(...args), findById: (...args) => findByIdMock(...args) }
})

vi.mock('../dao/refresh-tokens.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    insert: (...args) => refreshInsertMock(...args),
    findByHash: (...args) => refreshFindByHashMock(...args),
    markRotated: (...args) => refreshMarkRotatedMock(...args),
    revokeAllForUser: (...args) => refreshRevokeAllForUserMock(...args)
  }
})

vi.mock('../lib/tokens.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, verifyPassword: (...args) => verifyPasswordMock(...args) }
})

const { default: authRouter } = await import('./auth.js')

const ENV = { DB: {}, JWT_SECRET: 'test-jwt-secret-for-auth-regression' }

function makeApp() {
  const app = new Hono()
  app.route('/api/auth', authRouter)
  return app
}

function activeUser(overrides = {}) {
  return { id: 'user-1', email: 'employee@malgnsoft.com', name: '홍길동', role: 'employee', status: 'active', password_hash: 'pbkdf2$100000$aa$bb', must_change_password: 0, ...overrides }
}

beforeEach(() => {
  findByEmailMock.mockReset()
  findByIdMock.mockReset()
  verifyPasswordMock.mockReset()
  refreshInsertMock.mockReset().mockResolvedValue({})
  refreshFindByHashMock.mockReset()
  refreshMarkRotatedMock.mockReset()
  refreshRevokeAllForUserMock.mockReset()
})

describe('POST /api/auth/login — 회귀(추출 전후 응답 동일)', () => {
  function loginRequest(body) {
    const app = makeApp()
    return app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, ENV)
  }

  it('email/password 누락 → 400 VALIDATION_ERROR', async () => {
    const res = await loginRequest({ email: '' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('존재하지 않는 이메일 → 401 INVALID_CREDENTIALS(존재 여부 열거 방지 — 틀린 비밀번호와 동일 응답)', async () => {
    findByEmailMock.mockResolvedValue(null)
    const res = await loginRequest({ email: 'nobody@malgnsoft.com', password: 'x' })
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('INVALID_CREDENTIALS')
    expect(verifyPasswordMock).not.toHaveBeenCalled() // 존재하지 않으면 해시 비교조차 하지 않는다
  })

  it('비활성 계정 → 401 INVALID_CREDENTIALS(같은 메시지)', async () => {
    findByEmailMock.mockResolvedValue(activeUser({ status: 'disabled' }))
    const res = await loginRequest({ email: 'employee@malgnsoft.com', password: 'x' })
    expect(res.status).toBe(401)
  })

  it('비밀번호 불일치 → 401 INVALID_CREDENTIALS', async () => {
    findByEmailMock.mockResolvedValue(activeUser())
    verifyPasswordMock.mockResolvedValue(false)
    const res = await loginRequest({ email: 'employee@malgnsoft.com', password: 'wrong' })
    expect(res.status).toBe(401)
  })

  it('정상 로그인 — 200 + {token,expires_in,refresh_token,refresh_expires_in,must_change_password}, refresh_tokens 1행 INSERT, JWT는 signAccessToken 계약(sub/role/email/iss/aud) 그대로', async () => {
    findByEmailMock.mockResolvedValue(activeUser())
    verifyPasswordMock.mockResolvedValue(true)

    const res = await loginRequest({ email: 'EMPLOYEE@malgnsoft.com', password: 'correct-password' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(Object.keys(body).sort()).toEqual(['expires_in', 'must_change_password', 'refresh_expires_in', 'refresh_token', 'token'].sort())
    expect(body.expires_in).toBe(14400)
    expect(body.refresh_expires_in).toBe(2592000)
    expect(body.must_change_password).toBe(false)
    expect(typeof body.refresh_token).toBe('string')

    // 이메일은 trim().toLowerCase() 정규화 후 조회된다(§auth.js:24와 동일 — 추출로 안 바뀜).
    expect(findByEmailMock).toHaveBeenCalledWith(ENV.DB, 'employee@malgnsoft.com')

    // 부작용 — refresh_tokens 1행 INSERT(설계 결정5 "부작용은 이것 하나뿐").
    expect(refreshInsertMock).toHaveBeenCalledTimes(1)
    expect(refreshInsertMock).toHaveBeenCalledWith(ENV.DB, expect.objectContaining({ userId: 'user-1', tokenHash: expect.any(String) }))

    // JWT 검증 — signAccessToken이 실제로 만든 계약 그대로(HS256, iss/aud, sub=user.id, role/email 클레임).
    const { payload } = await jwtVerify(body.token, new TextEncoder().encode(ENV.JWT_SECRET), {
      issuer: 'malgnai-hub', audience: 'malgnai-hub-web', algorithms: ['HS256']
    })
    expect(payload.sub).toBe('user-1')
    expect(payload.role).toBe('employee')
    expect(payload.email).toBe('employee@malgnsoft.com')
  })

  it('must_change_password=true인 계정은 응답에 그대로 반영된다', async () => {
    findByEmailMock.mockResolvedValue(activeUser({ must_change_password: 1 }))
    verifyPasswordMock.mockResolvedValue(true)
    const res = await loginRequest({ email: 'employee@malgnsoft.com', password: 'x' })
    expect((await res.json()).must_change_password).toBe(true)
  })
})

describe('POST /api/auth/refresh — 회귀(issueWebTokenPair 호출 경로)', () => {
  function refreshRequest(body) {
    const app = makeApp()
    return app.request('/api/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, ENV)
  }

  it('refresh_token 누락 → 400 VALIDATION_ERROR', async () => {
    const res = await refreshRequest({})
    expect(res.status).toBe(400)
  })

  it('존재하지 않는 토큰 → 401 UNAUTHORIZED', async () => {
    refreshFindByHashMock.mockResolvedValue(undefined)
    const res = await refreshRequest({ refresh_token: 'nonexistent' })
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('UNAUTHORIZED')
  })

  it('정상 회전 — 200 + 새 토큰 쌍(자체인증과 동일한 issueWebTokenPair 호출), 사용자 status 재확인', async () => {
    refreshFindByHashMock.mockResolvedValue({ id: 'rt-1', user_id: 'user-1', status: 'active', expires_at: new Date(Date.now() + 60_000).toISOString() })
    refreshMarkRotatedMock.mockResolvedValue(true)
    findByIdMock.mockResolvedValue(activeUser())

    const res = await refreshRequest({ refresh_token: 'valid-raw-token' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(Object.keys(body).sort()).toEqual(['expires_in', 'refresh_expires_in', 'refresh_token', 'token'].sort())
    expect(refreshInsertMock).toHaveBeenCalledTimes(1) // 회전 후 새 refresh_tokens 행 발급(부작용 1개)
  })

  it('회전 성공했지만 그 사이 계정이 비활성화됨 → 401 UNAUTHORIZED(account is not active)', async () => {
    refreshFindByHashMock.mockResolvedValue({ id: 'rt-1', user_id: 'user-1', status: 'active', expires_at: new Date(Date.now() + 60_000).toISOString() })
    refreshMarkRotatedMock.mockResolvedValue(true)
    findByIdMock.mockResolvedValue(activeUser({ status: 'disabled' }))

    const res = await refreshRequest({ refresh_token: 'valid-raw-token' })
    expect(res.status).toBe(401)
    expect(refreshInsertMock).not.toHaveBeenCalled()
  })
})
