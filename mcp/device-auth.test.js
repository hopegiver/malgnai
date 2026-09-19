// mcp/device-auth.js(deviceAuthMiddleware) 단위테스트 — /mcp 전체와 POST /api/sessions가 공유하는
// 유일한 device_token 검증 지점(docs/security/device-token-revocation-investigation-2026-09-19.md
// §2 "검증"). 계정상태 게이트 자체의 SQL 정확성은 server/dao/device-tokens.test.js(node:sqlite 실DDL)가
// 증명하므로, 이 파일은 findActiveByHash를 vi.mock으로 대체해 미들웨어의 제어흐름(헤더 파싱·만료
// 판정·touchLastUsed 실패 무시)만 검증한다 — 두 파일이 서로 다른 층을 각자 책임진다.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const findActiveByHashMock = vi.fn()
const touchLastUsedMock = vi.fn()

vi.mock('../server/dao/device-tokens.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    findActiveByHash: (...args) => findActiveByHashMock(...args),
    touchLastUsed: (...args) => touchLastUsedMock(...args)
  }
})

const { deviceAuthMiddleware } = await import('./device-auth.js')

const ENV = { DB: {} }

function makeRequest(headers = {}) {
  return new Request('https://example.test/mcp', { headers })
}

function activeToken(overrides = {}) {
  return {
    id: 'device-token-1', user_id: 'user-1', device_id: 'device-1',
    scopes: 'project.read,project.write,telemetry.write', expires_at: null,
    ...overrides
  }
}

beforeEach(() => {
  findActiveByHashMock.mockReset()
  touchLastUsedMock.mockReset().mockResolvedValue(undefined)
})

describe('deviceAuthMiddleware — 입력 검증', () => {
  it('Authorization 헤더가 없으면 ok:false', async () => {
    const result = await deviceAuthMiddleware(makeRequest(), ENV)
    expect(result).toEqual({ ok: false, reason: 'missing bearer device token' })
    expect(findActiveByHashMock).not.toHaveBeenCalled()
  })

  it('Bearer가 아닌 스킴이면 ok:false', async () => {
    const result = await deviceAuthMiddleware(makeRequest({ Authorization: 'Basic abc123' }), ENV)
    expect(result).toEqual({ ok: false, reason: 'missing bearer device token' })
    expect(findActiveByHashMock).not.toHaveBeenCalled()
  })
})

// 계정상태 게이트 자체(disabled 사용자 → findActiveByHash가 undefined 반환)는 DAO 레벨에서 실증되므로
// 여기서는 "DAO가 undefined를 반환하면 미들웨어가 어떻게 반응하는가"만 확인한다 — DAO 응답을 그대로
// 신뢰해 401 사유를 매핑하는 얇은 계층이라는 뜻이다.
describe('deviceAuthMiddleware — DAO 응답 매핑', () => {
  it('DAO가 undefined(비활성 계정/고아 user_id/revoked 전부 이 형태로 수렴) → ok:false invalid_or_revoked', async () => {
    findActiveByHashMock.mockResolvedValue(undefined)
    const result = await deviceAuthMiddleware(makeRequest({ Authorization: 'Bearer raw-token' }), ENV)
    expect(result).toEqual({ ok: false, reason: 'invalid or revoked device token' })
    expect(touchLastUsedMock).not.toHaveBeenCalled()
  })

  it('DAO가 active 토큰을 반환하고 만료 전이면 ok:true + identity 매핑, touchLastUsed 1회', async () => {
    findActiveByHashMock.mockResolvedValue(activeToken())
    const result = await deviceAuthMiddleware(makeRequest({ Authorization: 'Bearer raw-token' }), ENV)
    expect(result.ok).toBe(true)
    expect(result.identity).toEqual({ userId: 'user-1', deviceId: 'device-1', scopes: 'project.read,project.write,telemetry.write' })
    expect(touchLastUsedMock).toHaveBeenCalledTimes(1)
  })

  it('expires_at이 과거면 ok:false expired(active 계정이라도 시간 만료는 별도로 걸린다)', async () => {
    findActiveByHashMock.mockResolvedValue(activeToken({ expires_at: '2020-01-01T00:00:00.000Z' }))
    const result = await deviceAuthMiddleware(makeRequest({ Authorization: 'Bearer raw-token' }), ENV)
    expect(result).toEqual({ ok: false, reason: 'device token expired' })
  })

  it('touchLastUsed가 실패해도 인증 자체는 성공한다(best-effort, 인증 게이트에 영향 없음)', async () => {
    findActiveByHashMock.mockResolvedValue(activeToken())
    touchLastUsedMock.mockRejectedValue(new Error('D1 write failed'))
    const result = await deviceAuthMiddleware(makeRequest({ Authorization: 'Bearer raw-token' }), ENV)
    expect(result.ok).toBe(true)
  })
})
