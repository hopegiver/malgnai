// PUBLIC_PATHS 화이트리스트 테스트 — Google 로그인 3경로 추가(docs/design/google-oauth-login.md
// 결정4)가 기존 화이트리스트를 건드리지 않았고, 정확일치(Set)라 와일드카드로 새지 않음을 확인한다.
import { describe, it, expect } from 'vitest'
import { PUBLIC_PATHS } from './jwt-auth.js'

describe('PUBLIC_PATHS', () => {
  it('Google 로그인 3경로가 정확히 포함된다', () => {
    expect(PUBLIC_PATHS.has('/api/auth/google/start')).toBe(true)
    expect(PUBLIC_PATHS.has('/api/auth/google/callback')).toBe(true)
    expect(PUBLIC_PATHS.has('/api/auth/google/exchange')).toBe(true)
  })

  it('기존 화이트리스트 항목은 그대로 남아있다(자체인증/OAuth제공자/디바이스 페어링/세션)', () => {
    for (const p of [
      '/api/health', '/api/auth/login', '/api/auth/refresh',
      '/api/devices/pair-init', '/api/devices/pair-status',
      '/api/oauth/token', '/api/oauth/register', '/api/sessions'
    ]) {
      expect(PUBLIC_PATHS.has(p)).toBe(true)
    }
  })

  it('정확일치라 접두사 경로는 새지 않는다 — /api/auth/google 자체나 하위 임의경로는 미포함', () => {
    expect(PUBLIC_PATHS.has('/api/auth/google')).toBe(false)
    expect(PUBLIC_PATHS.has('/api/auth/google/start/extra')).toBe(false)
    expect(PUBLIC_PATHS.has('/api/auth/google/anything')).toBe(false)
  })

  it('제공자 축의 인증필요 경로(authorize-context/consent)는 여전히 화이트리스트 밖이다(§0.2 규약)', () => {
    expect(PUBLIC_PATHS.has('/api/oauth/authorize-context')).toBe(false)
    expect(PUBLIC_PATHS.has('/api/oauth/consent')).toBe(false)
  })

  // docs/design/plugin-deploy-notify.md §3.2 — 이 설계 최대의 함정 회귀 테스트. 접미사 없는
  // '/api/plugin-deploys'가 잘못 추가되면 GET(직원 조회)까지 무인증이 되어버리는데, 이 저장소의
  // PUBLIC_PATHS는 경로 정확일치(Set)라 접미사 포함 문자열만 정확히 있어야 그 사고가 안 난다.
  it('plugin-deploys는 /notify 접미사가 붙은 인입 경로만 화이트리스트에 있다(조회 경로는 없다)', () => {
    expect(PUBLIC_PATHS.has('/api/plugin-deploys/notify')).toBe(true)
    expect(PUBLIC_PATHS.has('/api/plugin-deploys')).toBe(false)
    expect(PUBLIC_PATHS.has('/api/plugin-deploys/')).toBe(false)
  })

  it('총 개수는 정확히 12개(기존 8 + Google 3 + plugin-deploys 1, 의도치 않은 추가 없음)', () => {
    expect(PUBLIC_PATHS.size).toBe(12)
  })
})
