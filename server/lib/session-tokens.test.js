// server/lib/session-tokens.js 단위테스트 — docs/design/google-oauth-login.md 결정5의 순수 추출
// 함수. 자체인증(server/api/auth.test.js)과 Google 로그인(server/api/auth-google.test.js) 양쪽이
// 이 함수 하나를 공유한다는 계약을 이 파일에서 직접 확인한다.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { jwtVerify } from 'jose'

const refreshInsertMock = vi.fn()

vi.mock('../dao/refresh-tokens.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, insert: (...args) => refreshInsertMock(...args) }
})

const { issueWebTokenPair } = await import('./session-tokens.js')

beforeEach(() => {
  refreshInsertMock.mockReset().mockResolvedValue({})
})

describe('issueWebTokenPair', () => {
  const env = { DB: {}, JWT_SECRET: 'session-tokens-test-secret' }
  const user = { id: 'user-1', role: 'employee', email: 'employee@malgnsoft.com' }

  it('부작용은 refresh_tokens 1행 INSERT 하나뿐이다(호출자별로 달라야 하는 부작용 없음, 결정5)', async () => {
    await issueWebTokenPair(env, user)
    expect(refreshInsertMock).toHaveBeenCalledTimes(1)
    expect(refreshInsertMock).toHaveBeenCalledWith(env.DB, expect.objectContaining({ userId: 'user-1', tokenHash: expect.any(String), expiresAt: expect.any(String) }))
  })

  it('반환값 스키마 — {token, expires_in, refresh_token, refresh_expires_in}', async () => {
    const pair = await issueWebTokenPair(env, user)
    expect(Object.keys(pair).sort()).toEqual(['expires_in', 'refresh_expires_in', 'refresh_token', 'token'].sort())
    expect(pair.expires_in).toBe(14400)
    expect(pair.refresh_expires_in).toBe(2592000)
  })

  it('JWT는 인증수단을 나타내는 클레임(amr 등)을 담지 않는다(결정5 — 소비자 없음)', async () => {
    const pair = await issueWebTokenPair(env, user)
    const { payload } = await jwtVerify(pair.token, new TextEncoder().encode(env.JWT_SECRET), {
      issuer: 'malgnai-hub', audience: 'malgnai-hub-web', algorithms: ['HS256']
    })
    expect(payload).not.toHaveProperty('amr')
    expect(payload).not.toHaveProperty('auth_method')
    expect(Object.keys(payload).sort()).toEqual(['aud', 'email', 'exp', 'iat', 'iss', 'role', 'sub'].sort())
  })

  it('두 번 호출하면 서로 다른 refresh_token을 발급한다(재사용 없음)', async () => {
    const a = await issueWebTokenPair(env, user)
    const b = await issueWebTokenPair(env, user)
    expect(a.refresh_token).not.toBe(b.refresh_token)
  })
})
