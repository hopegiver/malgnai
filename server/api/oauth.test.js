// POST /api/oauth/token 회귀·신규 테스트 — 이 파일은 이번 변경 전에는 존재하지 않았다
// (docs/design/oauth-refresh-race-mitigation.md §11.4). refresh_token grant가 MCP_OAUTH_REFRESH_POLICY로
// 정책 분기됐음을 라우트 레벨에서 증명한다: 버스트가 200으로 흡수되는지(R-3), grace 밖에서도
// 가족이 보존되는지(R-4), 클라이언트가 판정 경계를 구분할 수 없는지(R-9). 하우스 스타일은
// server/api/auth.test.js(vi.mock + importOriginal 스프레드)를 따른다. 라우트가 form-urlencoded로
// 들어오는 점에 주의(parseTokenRequestBody, oauth.js:106).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { sha256Hex } from '../lib/tokens.js'

const oauthFindByHashMock = vi.fn()
const oauthMarkRotatedMock = vi.fn()
const oauthRevokeAllForDeviceTokenMock = vi.fn()
const oauthInsertMock = vi.fn()

vi.mock('../dao/oauth-refresh-tokens.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    findByHash: (...args) => oauthFindByHashMock(...args),
    markRotated: (...args) => oauthMarkRotatedMock(...args),
    revokeAllForDeviceToken: (...args) => oauthRevokeAllForDeviceTokenMock(...args),
    insert: (...args) => oauthInsertMock(...args)
  }
})

const deviceFindByIdMock = vi.fn()
const deviceRevokeMock = vi.fn()
const deviceRotateTokenMock = vi.fn()
const deviceInsertMock = vi.fn()

vi.mock('../dao/device-tokens.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    findById: (...args) => deviceFindByIdMock(...args),
    revoke: (...args) => deviceRevokeMock(...args),
    rotateToken: (...args) => deviceRotateTokenMock(...args),
    insert: (...args) => deviceInsertMock(...args)
  }
})

const auditRecordMock = vi.fn()

vi.mock('../dao/audit-logs.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, record: (...args) => auditRecordMock(...args) }
})

// 계정상태 게이트 회귀 잠금(docs/security/device-token-revocation-investigation-2026-09-19.md §5
// 후보A "누락 지점" — 이 refresh grant는 findActiveByHash를 쓰지 않고 deviceTokensDao.findById로
// device_token만 직접 조회하므로 usersDao.findById를 별도로 mock해야 이 경로의 실제 동작을 관찰할
// 수 있다). 기본값은 활성 사용자 — 이 값을 바꾸지 않은 기존 R-1~R-9 테스트가 전부 그대로 통과해야
// "정상 active 사용자는 아무 영향을 받지 않는다"(완료판정 불변량)의 증거가 된다.
const usersFindByIdMock = vi.fn()

vi.mock('../dao/users.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, findById: (...args) => usersFindByIdMock(...args) }
})

const codesFindByCodeMock = vi.fn()
const codesConsumeMock = vi.fn()

vi.mock('../dao/oauth-authorization-codes.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, findByCode: (...args) => codesFindByCodeMock(...args), consume: (...args) => codesConsumeMock(...args) }
})

// PKCE 검증 자체는 rotating-token 판정과 무관한 별도 관심사라 실제 SHA-256 매칭 대신 통과로
// 고정한다 — isValidPkceVerifierFormat(형식 검사)는 실물 그대로 태운다(§4에서 다루지 않는 부분).
const verifyPkceS256Mock = vi.fn().mockResolvedValue(true)

vi.mock('../lib/tokens.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, verifyPkceS256: (...args) => verifyPkceS256Mock(...args) }
})

const { default: oauthRouter } = await import('./oauth.js')

const ENV = { DB: {} }
const BASE_TIME = new Date('2026-09-15T00:00:00.000Z')

function makeApp() {
  const app = new Hono()
  app.route('/api/oauth', oauthRouter)
  return app
}

function tokenRequest(params) {
  const app = makeApp()
  const body = new URLSearchParams(params).toString()
  return app.request('/api/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }, ENV)
}

function refreshRequest(overrides = {}) {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: 'raw-refresh-token', client_id: 'malgn-agent-test', ...overrides })
}

function oauthRow(overrides = {}) {
  return {
    id: 'rt-1',
    device_token_id: 'device-1',
    token_hash: 'hash',
    status: 'active',
    revoke_reason: null,
    revoked_at: null,
    expires_at: new Date(BASE_TIME.getTime() + 3600_000).toISOString(),
    ...overrides
  }
}

function activeDeviceToken(overrides = {}) {
  return { id: 'device-1', user_id: 'user-1', status: 'active', ...overrides }
}

function activeUser(overrides = {}) {
  return { id: 'user-1', email: 'active@malgnsoft.com', status: 'active', ...overrides }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(BASE_TIME)

  oauthFindByHashMock.mockReset()
  oauthMarkRotatedMock.mockReset()
  oauthRevokeAllForDeviceTokenMock.mockReset().mockResolvedValue(undefined)
  oauthInsertMock.mockReset().mockResolvedValue({})
  deviceFindByIdMock.mockReset()
  deviceRevokeMock.mockReset().mockResolvedValue(true)
  deviceRotateTokenMock.mockReset().mockResolvedValue(undefined)
  deviceInsertMock.mockReset().mockResolvedValue({ id: 'device-1' })
  auditRecordMock.mockReset().mockResolvedValue('audit-1')
  codesFindByCodeMock.mockReset()
  codesConsumeMock.mockReset()
  verifyPkceS256Mock.mockReset().mockResolvedValue(true)
  usersFindByIdMock.mockReset().mockResolvedValue(activeUser())
})

afterEach(() => {
  vi.useRealTimers()
})

describe('POST /api/oauth/token — refresh_token grant', () => {
  it('R-1 정상 회전 — 200, expires_in===28800, 새 refresh 행 INSERT 1회, rotateToken 1회', async () => {
    oauthFindByHashMock.mockResolvedValue(oauthRow({ status: 'active' }))
    oauthMarkRotatedMock.mockResolvedValue(true)
    deviceFindByIdMock.mockResolvedValue(activeDeviceToken())

    const res = await refreshRequest()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.expires_in).toBe(28_800)
    expect(body.token_type).toBe('Bearer')
    expect(typeof body.access_token).toBe('string')
    expect(typeof body.refresh_token).toBe('string')
    expect(oauthInsertMock).toHaveBeenCalledTimes(1)
    expect(deviceRotateTokenMock).toHaveBeenCalledTimes(1)
    expect(oauthRevokeAllForDeviceTokenMock).not.toHaveBeenCalled()
  })

  it('R-3 버스트: 같은 stale 토큰(나이 150초)으로 3연속 호출 → 3회 전부 200, 폐기 호출 0회, 매회 감사 outcome=grace_allowed', async () => {
    vi.setSystemTime(new Date(BASE_TIME.getTime() + 150_000))
    oauthFindByHashMock.mockResolvedValue(oauthRow({ status: 'rotated', revoke_reason: 'rotated', revoked_at: BASE_TIME.toISOString() }))
    deviceFindByIdMock.mockResolvedValue(activeDeviceToken())

    for (let i = 0; i < 3; i++) {
      const res = await refreshRequest()
      expect(res.status).toBe(200)
    }
    expect(oauthRevokeAllForDeviceTokenMock).not.toHaveBeenCalled()
    expect(deviceRevokeMock).not.toHaveBeenCalled()
    // security 리뷰 H1: 10초~10분 grace 통과 교환은 감사에 남아야 한다(탈취가 성공하는 순간이
    // 무기록이면 §15 R-2 재측정이 구조적으로 불가능해진다).
    expect(auditRecordMock).toHaveBeenCalledTimes(3)
    for (const call of auditRecordMock.mock.calls) {
      expect(call[1].action).toBe('oauth_refresh_token.reuse_detected')
      expect(call[1].metadata.outcome).toBe('grace_allowed')
      expect(call[1].metadata.stale_age_ms).toBe(150_000)
      expect(call[1].metadata.grace_ms).toBe(600_000)
      expect(call[1].metadata.refresh_token_id).toBe('rt-1')
      expect(call[1].metadata.policy).toBe('mcp_oauth')
    }
  })

  it('R-3b grace 통과라도 웹 grace(10초) 이내면 감사에 남기지 않는다(신호 익사 방지)', async () => {
    vi.setSystemTime(new Date(BASE_TIME.getTime() + 3_000))
    oauthFindByHashMock.mockResolvedValue(oauthRow({ status: 'rotated', revoke_reason: 'rotated', revoked_at: BASE_TIME.toISOString() }))
    deviceFindByIdMock.mockResolvedValue(activeDeviceToken())

    const res = await refreshRequest()
    expect(res.status).toBe(200)
    expect(auditRecordMock).not.toHaveBeenCalled()
  })

  it('R-4 grace 밖(나이 45분) → 401 invalid_grant, 폐기 호출 0회, 감사 outcome=rejected_only', async () => {
    vi.setSystemTime(new Date(BASE_TIME.getTime() + 45 * 60_000))
    oauthFindByHashMock.mockResolvedValue(oauthRow({ status: 'rotated', revoke_reason: 'rotated', revoked_at: BASE_TIME.toISOString() }))
    deviceFindByIdMock.mockResolvedValue(activeDeviceToken())

    const res = await refreshRequest()
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body).toEqual({ error: 'invalid_grant' })
    expect(oauthRevokeAllForDeviceTokenMock).not.toHaveBeenCalled()
    expect(deviceRevokeMock).not.toHaveBeenCalled()
    expect(auditRecordMock).toHaveBeenCalledTimes(1)
    const metadata = auditRecordMock.mock.calls[0][1].metadata
    expect(metadata.outcome).toBe('rejected_only')
    expect(metadata.stale_age_ms).toBeGreaterThan(0)
    expect(metadata.grace_ms).toBe(600_000)
    expect(metadata.refresh_token_id).toBe('rt-1')
  })

  it('R-5 revoke_reason=device_revoked 재제시 → 401, revokeAllForDeviceToken 1회, deviceTokensDao.revoke 1회, 감사 outcome=family_revoked', async () => {
    oauthFindByHashMock.mockResolvedValue(oauthRow({ status: 'revoked', revoke_reason: 'device_revoked', revoked_at: BASE_TIME.toISOString() }))
    deviceFindByIdMock.mockResolvedValue(activeDeviceToken({ status: 'revoked' }))

    const res = await refreshRequest()
    expect(res.status).toBe(401)
    expect(oauthRevokeAllForDeviceTokenMock).toHaveBeenCalledTimes(1)
    expect(deviceRevokeMock).toHaveBeenCalledTimes(1)
    expect(auditRecordMock.mock.calls[0][1].metadata.outcome).toBe('family_revoked')
  })

  it('R-6 revoke_reason=reuse_detected 재제시 → 401, 폐기 호출 0회, 감사 outcome=already_revoked', async () => {
    oauthFindByHashMock.mockResolvedValue(oauthRow({ status: 'revoked', revoke_reason: 'reuse_detected', revoked_at: BASE_TIME.toISOString() }))
    deviceFindByIdMock.mockResolvedValue(activeDeviceToken({ status: 'revoked' }))

    const res = await refreshRequest()
    expect(res.status).toBe(401)
    expect(oauthRevokeAllForDeviceTokenMock).not.toHaveBeenCalled()
    expect(deviceRevokeMock).not.toHaveBeenCalled()
    expect(auditRecordMock.mock.calls[0][1].metadata.outcome).toBe('already_revoked')
  })

  it('R-7 grace 통과했으나 device_token이 revoked → 401(oauth.js:228 경로 유지)', async () => {
    oauthFindByHashMock.mockResolvedValue(oauthRow({ status: 'active' }))
    oauthMarkRotatedMock.mockResolvedValue(true)
    deviceFindByIdMock.mockResolvedValue(activeDeviceToken({ status: 'revoked' }))

    const res = await refreshRequest()
    expect(res.status).toBe(401)
    expect(oauthInsertMock).not.toHaveBeenCalled()
  })

  it('R-8 없는 refresh_token → 401, 감사 0건(invalid는 감사 안 남김 — 현행 유지)', async () => {
    oauthFindByHashMock.mockResolvedValue(undefined)
    const res = await refreshRequest()
    expect(res.status).toBe(401)
    expect((await res.json())).toEqual({ error: 'invalid_grant' })
    expect(auditRecordMock).not.toHaveBeenCalled()
  })

  it('R-9 응답 바디 동일성 — R-4/R-5/R-6 응답 바디가 바이트 단위로 동일(클라이언트가 판정을 구분할 수 없음)', async () => {
    // R-4: grace 밖
    vi.setSystemTime(new Date(BASE_TIME.getTime() + 45 * 60_000))
    oauthFindByHashMock.mockResolvedValue(oauthRow({ status: 'rotated', revoke_reason: 'rotated', revoked_at: BASE_TIME.toISOString() }))
    deviceFindByIdMock.mockResolvedValue(activeDeviceToken())
    const r4 = await refreshRequest()
    const r4Text = await r4.text()

    // R-5: device_revoked
    oauthFindByHashMock.mockResolvedValue(oauthRow({ status: 'revoked', revoke_reason: 'device_revoked', revoked_at: BASE_TIME.toISOString() }))
    deviceFindByIdMock.mockResolvedValue(activeDeviceToken({ status: 'revoked' }))
    const r5 = await refreshRequest()
    const r5Text = await r5.text()

    // R-6: reuse_detected
    oauthFindByHashMock.mockResolvedValue(oauthRow({ status: 'revoked', revoke_reason: 'reuse_detected', revoked_at: BASE_TIME.toISOString() }))
    const r6 = await refreshRequest()
    const r6Text = await r6.text()

    expect(r4.status).toBe(401)
    expect(r5.status).toBe(401)
    expect(r6.status).toBe(401)
    expect(r4Text).toBe('{"error":"invalid_grant"}')
    expect(r4Text).toBe(r5Text)
    expect(r5Text).toBe(r6Text)
  })
})

// 계정상태 게이트 회귀 잠금(§5 후보A 누락 지점) — R-1~R-9는 위에서 이미 usersFindByIdMock을
// activeUser()로 기본 세팅해 전부 그대로 통과한다(불변량: 정상 active 사용자는 아무 영향 없음).
// 아래는 disabled/고아 계정이 이 경로에서도 실제로 막히는지를 새로 증명한다.
describe('POST /api/oauth/token — refresh_token grant — 계정상태 게이트(§5 후보A)', () => {
  it('device_token은 active인데 소유자 계정이 disabled → 401, 새 토큰 발급 없음', async () => {
    oauthFindByHashMock.mockResolvedValue(oauthRow({ status: 'active' }))
    oauthMarkRotatedMock.mockResolvedValue(true)
    deviceFindByIdMock.mockResolvedValue(activeDeviceToken())
    usersFindByIdMock.mockResolvedValue(activeUser({ status: 'disabled' }))

    const res = await refreshRequest()
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body).toEqual({ error: 'invalid_grant' })
    expect(oauthInsertMock).not.toHaveBeenCalled()
    expect(deviceRotateTokenMock).not.toHaveBeenCalled()
  })

  it('device_token의 user_id가 users에 없는 고아 계정 → 401(findById가 null을 반환하는 경우)', async () => {
    oauthFindByHashMock.mockResolvedValue(oauthRow({ status: 'active' }))
    oauthMarkRotatedMock.mockResolvedValue(true)
    deviceFindByIdMock.mockResolvedValue(activeDeviceToken())
    usersFindByIdMock.mockResolvedValue(null)

    const res = await refreshRequest()

    expect(res.status).toBe(401)
    expect(deviceRotateTokenMock).not.toHaveBeenCalled()
  })

  it('active 계정 + active device_token → 정상 200(불변량 회귀 확인, R-1의 명시적 재확인)', async () => {
    oauthFindByHashMock.mockResolvedValue(oauthRow({ status: 'active' }))
    oauthMarkRotatedMock.mockResolvedValue(true)
    deviceFindByIdMock.mockResolvedValue(activeDeviceToken())
    usersFindByIdMock.mockResolvedValue(activeUser())

    const res = await refreshRequest()
    expect(res.status).toBe(200)
    expect(deviceRotateTokenMock).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/oauth/token — authorization_code grant', () => {
  function authCodeRequest(overrides = {}) {
    return tokenRequest({
      grant_type: 'authorization_code',
      code: 'code-1',
      code_verifier: 'a'.repeat(43),
      redirect_uri: 'http://127.0.0.1:9999/callback',
      client_id: 'client-1',
      ...overrides
    })
  }

  function stubValidCode(now = BASE_TIME.getTime()) {
    codesFindByCodeMock.mockResolvedValue({
      code: 'code-1',
      client_id: 'client-1',
      redirect_uri: 'http://127.0.0.1:9999/callback',
      code_challenge: 'irrelevant-because-mocked',
      code_challenge_method: 'S256',
      expires_at: new Date(now + 60_000).toISOString(),
      user_id: 'user-1',
      device_name: 'test-device'
    })
    codesConsumeMock.mockResolvedValue(true)
  }

  it('R-2 정상 — 200, expires_in===28800, device_tokens.expires_at ≈ now+8h', async () => {
    const now = BASE_TIME.getTime()
    stubValidCode(now)

    const res = await authCodeRequest()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.expires_in).toBe(28_800)
    expect(deviceInsertMock).toHaveBeenCalledTimes(1)
    const insertArg = deviceInsertMock.mock.calls[0][1]
    const diffMs = new Date(insertArg.expiresAt).getTime() - now
    expect(diffMs).toBeGreaterThan(8 * 3600 * 1000 - 5000)
    expect(diffMs).toBeLessThan(8 * 3600 * 1000 + 5000)
    expect(oauthInsertMock).toHaveBeenCalledTimes(1)
  })

  // ---------------------------------------------------------------------------
  // 레이트리밋(OAUTH_TOKEN_RL) — authorization_code grant. auth-google.test.js의
  // GOOGLE_LOGIN_RL 회귀 스위트와 같은 형식(바인딩 없음/한도 내/한도 초과/limit() 예외 4케이스)을
  // 따른다. 키 축은 IP+scope('authcode') — google-login과 동일 모델.
  // ---------------------------------------------------------------------------
  describe('레이트리밋(OAUTH_TOKEN_RL) — authorization_code grant', () => {
    it('바인딩이 없으면(로컬/미배포) 통과한다(fail-open)', async () => {
      stubValidCode()
      const res = await authCodeRequest() // ENV에는 OAUTH_TOKEN_RL이 없다
      expect(res.status).toBe(200)
    })

    it('바인딩이 있고 한도 내(success:true)면 정상 발급한다', async () => {
      stubValidCode()
      const rl = { limit: vi.fn().mockResolvedValue({ success: true }) }
      const app = new Hono()
      app.route('/api/oauth', oauthRouter)
      const body = new URLSearchParams({
        grant_type: 'authorization_code', code: 'code-1', code_verifier: 'a'.repeat(43),
        redirect_uri: 'http://127.0.0.1:9999/callback', client_id: 'client-1'
      }).toString()
      const res = await app.request('/api/oauth/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body
      }, { ...ENV, OAUTH_TOKEN_RL: rl })
      expect(res.status).toBe(200)
      expect(rl.limit).toHaveBeenCalledWith({ key: 'unknown:authcode' })
    })

    it('바인딩이 있고 한도 초과(success:false)면 429 slow_down이고 D1에 아무것도 쓰지 않는다', async () => {
      stubValidCode()
      const rl = { limit: vi.fn().mockResolvedValue({ success: false }) }
      const app = new Hono()
      app.route('/api/oauth', oauthRouter)
      const body = new URLSearchParams({
        grant_type: 'authorization_code', code: 'code-1', code_verifier: 'a'.repeat(43),
        redirect_uri: 'http://127.0.0.1:9999/callback', client_id: 'client-1'
      }).toString()
      const res = await app.request('/api/oauth/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body
      }, { ...ENV, OAUTH_TOKEN_RL: rl })
      expect(res.status).toBe(429)
      expect(await res.json()).toEqual({ error: 'slow_down', error_description: 'too many token requests, retry later' })
      expect(res.headers.get('retry-after')).toBe('60')
      expect(codesFindByCodeMock).not.toHaveBeenCalled()
      expect(deviceInsertMock).not.toHaveBeenCalled()
    })

    it('limit() 예외 시 통과(fail-open) + console.error 1회', async () => {
      stubValidCode()
      const rl = { limit: vi.fn().mockRejectedValue(new Error('rl boom')) }
      const app = new Hono()
      app.route('/api/oauth', oauthRouter)
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const body = new URLSearchParams({
        grant_type: 'authorization_code', code: 'code-1', code_verifier: 'a'.repeat(43),
        redirect_uri: 'http://127.0.0.1:9999/callback', client_id: 'client-1'
      }).toString()
      const res = await app.request('/api/oauth/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body
      }, { ...ENV, OAUTH_TOKEN_RL: rl })
      expect(res.status).toBe(200)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0]).toBe('[oauth] rate limit check failed, allowing request')
      spy.mockRestore()
    })
  })
})

// ---------------------------------------------------------------------------
// 레이트리밋(OAUTH_TOKEN_RL) — refresh_token grant. 이 스위트의 핵심 불변량은 "정상적인 MCP
// 클라이언트가 차단되어서는 안 된다"(작업 지시 §2) — 특히 사무실 NAT 뒤 공용 IP를 공유하는 여러
// 직원이 각자 다른 refresh_token으로 동시에 갱신해도 서로를 막지 않아야 한다. "429가 나온다"만
// 보는 테스트는 빈 깡통이므로, 키 축이 IP가 아니라 토큰 해시라는 것 자체를 회귀로 고정한다.
// ---------------------------------------------------------------------------
describe('POST /api/oauth/token — refresh_token grant 레이트리밋(OAUTH_TOKEN_RL)', () => {
  it('바인딩이 없으면(로컬/미배포) 통과한다(fail-open)', async () => {
    oauthFindByHashMock.mockResolvedValue(oauthRow({ status: 'active' }))
    oauthMarkRotatedMock.mockResolvedValue(true)
    deviceFindByIdMock.mockResolvedValue(activeDeviceToken())

    const res = await refreshRequest() // ENV에는 OAUTH_TOKEN_RL이 없다
    expect(res.status).toBe(200)
  })

  it('바인딩이 있고 한도 내(success:true)면 정상 회전한다', async () => {
    oauthFindByHashMock.mockResolvedValue(oauthRow({ status: 'active' }))
    oauthMarkRotatedMock.mockResolvedValue(true)
    deviceFindByIdMock.mockResolvedValue(activeDeviceToken())
    const rl = { limit: vi.fn().mockResolvedValue({ success: true }) }

    const app = new Hono()
    app.route('/api/oauth', oauthRouter)
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'raw-refresh-token', client_id: 'malgn-agent-test' }).toString()
    const res = await app.request('/api/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body
    }, { ...ENV, OAUTH_TOKEN_RL: rl })

    expect(res.status).toBe(200)
    // 키가 IP가 아니라 제출된 refresh_token의 sha256 해시(":refresh" 접미사)라는 것을 고정한다.
    expect(rl.limit).toHaveBeenCalledTimes(1)
    const usedKey = rl.limit.mock.calls[0][0].key
    expect(usedKey.endsWith(':refresh')).toBe(true)
    expect(usedKey).not.toContain('unknown') // IP 폴백 문자열이 키에 섞이지 않는다
  })

  it('바인딩이 있고 한도 초과(success:false)면 429 slow_down이고 D1 회전 로직에 도달하지 않는다', async () => {
    const rl = { limit: vi.fn().mockResolvedValue({ success: false }) }
    const app = new Hono()
    app.route('/api/oauth', oauthRouter)
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'raw-refresh-token', client_id: 'malgn-agent-test' }).toString()
    const res = await app.request('/api/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body
    }, { ...ENV, OAUTH_TOKEN_RL: rl })

    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'slow_down', error_description: 'too many token requests, retry later' })
    expect(res.headers.get('retry-after')).toBe('60')
    // 레이트리밋에서 이미 끊겼으므로 findByHash(D1 조회) 자체에 도달하지 않는다(비용 절감 목적 검증).
    expect(oauthFindByHashMock).not.toHaveBeenCalled()
  })

  it('limit() 예외 시 통과(fail-open) + console.error 1회', async () => {
    oauthFindByHashMock.mockResolvedValue(oauthRow({ status: 'active' }))
    oauthMarkRotatedMock.mockResolvedValue(true)
    deviceFindByIdMock.mockResolvedValue(activeDeviceToken())
    const rl = { limit: vi.fn().mockRejectedValue(new Error('rl boom')) }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const app = new Hono()
    app.route('/api/oauth', oauthRouter)
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'raw-refresh-token', client_id: 'malgn-agent-test' }).toString()
    const res = await app.request('/api/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body
    }, { ...ENV, OAUTH_TOKEN_RL: rl })

    expect(res.status).toBe(200)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe('[oauth] rate limit check failed, allowing request')
    spy.mockRestore()
  })

  // 핵심 불변량 회귀 — 사무실 NAT(같은 cf-connecting-ip)를 공유하는 두 "직원"이 서로 다른
  // refresh_token으로 동시에 갱신해도 같은 버킷을 쓰지 않는다(키가 IP가 아니라 토큰 해시라서).
  // 한 명의 요청이 한도를 소진해도(success:false) 다른 직원의 요청(success:true)은 막히지 않는다
  // — "429가 나온다"만 보면 이 문서가 요구하는 불변량을 놓친다.
  it('불변량 — 같은 사무실 IP, 다른 refresh_token을 쓰는 두 직원은 서로의 레이트리밋에 영향받지 않는다', async () => {
    oauthFindByHashMock.mockResolvedValue(oauthRow({ status: 'active' }))
    oauthMarkRotatedMock.mockResolvedValue(true)
    deviceFindByIdMock.mockResolvedValue(activeDeviceToken())

    // 직원 A의 토큰이 이미 한도를 소진했다(success:false)고 실제 해시값으로 정확히 지정한다 —
    // 문자열 접두사 추측이 아니라 sha256Hex(라우트가 쓰는 것과 동일한 함수)로 계산한 진짜 키를
    // 써서, "IP가 아니라 이 특정 토큰만" 막혔다는 것을 정밀하게 고정한다.
    const employeeATokenHash = await sha256Hex('employee-a-token')
    const blockedKey = `${employeeATokenHash}:refresh`
    const rl = {
      limit: vi.fn(async ({ key }) => ({ success: key !== blockedKey }))
    }

    const officeIp = '10.0.0.1' // 두 직원이 공유하는 사무실 NAT 공용 IP
    const employeeARequest = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'employee-a-token', client_id: 'malgn-agent-test' }).toString()
    const employeeBRequest = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'employee-b-token', client_id: 'malgn-agent-test' }).toString()

    const app = new Hono()
    app.route('/api/oauth', oauthRouter)

    const resA = await app.request('/api/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': officeIp }, body: employeeARequest
    }, { ...ENV, OAUTH_TOKEN_RL: rl })
    const resB = await app.request('/api/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': officeIp }, body: employeeBRequest
    }, { ...ENV, OAUTH_TOKEN_RL: rl })

    expect(rl.limit).toHaveBeenCalledTimes(2)
    const keys = rl.limit.mock.calls.map((call) => call[0].key)
    expect(keys).toContain(blockedKey)
    expect(new Set(keys).size).toBe(2) // 같은 IP를 공유해도 키가 겹치지 않는다.
    // 직원 A(한도 소진된 토큰)만 429이고, 직원 B(다른 토큰)는 그대로 200 — IP 기반이었다면
    // 같은 버킷을 공유해 B도 함께 429가 됐을 상황.
    expect(resA.status).toBe(429)
    expect(resB.status).toBe(200)
  })
})
