// POST /api/oauth/token 회귀·신규 테스트 — 이 파일은 이번 변경 전에는 존재하지 않았다
// (docs/design/oauth-refresh-race-mitigation.md §11.4). refresh_token grant가 MCP_OAUTH_REFRESH_POLICY로
// 정책 분기됐음을 라우트 레벨에서 증명한다: 버스트가 200으로 흡수되는지(R-3), grace 밖에서도
// 가족이 보존되는지(R-4), 클라이언트가 판정 경계를 구분할 수 없는지(R-9). 하우스 스타일은
// server/api/auth.test.js(vi.mock + importOriginal 스프레드)를 따른다. 라우트가 form-urlencoded로
// 들어오는 점에 주의(parseTokenRequestBody, oauth.js:106).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'

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

describe('POST /api/oauth/token — authorization_code grant', () => {
  it('R-2 정상 — 200, expires_in===28800, device_tokens.expires_at ≈ now+8h', async () => {
    const now = BASE_TIME.getTime()
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

    const res = await tokenRequest({
      grant_type: 'authorization_code',
      code: 'code-1',
      code_verifier: 'a'.repeat(43),
      redirect_uri: 'http://127.0.0.1:9999/callback',
      client_id: 'client-1'
    })
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
})
