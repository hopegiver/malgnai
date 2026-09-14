// timingSafeEqualSecret() 단위테스트 — plugin-deploy-key 축(§4.4)이 의존하는 유일한 신규 함수.
// 기존 hashPassword/verifyPassword/JWT 발급·검증 등은 이 파일에서 다루지 않는다(회귀 없음,
// 신규 export만 추가했으므로 새 테스트도 신규 export 전용으로 한정한다).
import { describe, it, expect } from 'vitest'
import {
  timingSafeEqualSecret,
  OAUTH_ACCESS_TOKEN_TTL_SECONDS, OAUTH_REUSE_GRACE_MS, OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS, REUSE_GRACE_MS
} from './tokens.js'

// 안전 임계값 가드(docs/design/oauth-refresh-race-mitigation.md §4.1·§11.3) — 이 파일의 상수
// export가 정본이고, 여기가 "몰래 바뀜"을 잡는 유일한 장치다. 금지 상수 4개를 일부러 함께
// 고정한다 — 이번 작업에서 건드리면 안 되는 값이 실수로 바뀌는 것을 잡기 위함.
describe('안전 임계값 상수 가드', () => {
  it('OAUTH_ACCESS_TOKEN_TTL_SECONDS === 28800 (이번에 바뀌는 값, 1h → 8h)', () => {
    expect(OAUTH_ACCESS_TOKEN_TTL_SECONDS).toBe(28_800)
  })

  it('OAUTH_REUSE_GRACE_MS === 600000 (이번에 신설되는 값, MCP 축 grace 10분)', () => {
    expect(OAUTH_REUSE_GRACE_MS).toBe(600_000)
  })

  it('OAUTH_REFRESH_TOKEN_TTL_SECONDS === 7776000 (변경 금지 — 90일)', () => {
    expect(OAUTH_REFRESH_TOKEN_TTL_SECONDS).toBe(7_776_000)
  })

  it('ACCESS_TOKEN_TTL_SECONDS === 14400 (변경 금지 — 웹 4h)', () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(14_400)
  })

  it('REFRESH_TOKEN_TTL_SECONDS === 2592000 (변경 금지 — 웹 30일)', () => {
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(2_592_000)
  })

  it('REUSE_GRACE_MS === 10000 (변경 금지 — 웹 grace 10초)', () => {
    expect(REUSE_GRACE_MS).toBe(10_000)
  })
})

describe('timingSafeEqualSecret', () => {
  it('같은 문자열이면 true', async () => {
    expect(await timingSafeEqualSecret('same-secret-value', 'same-secret-value')).toBe(true)
  })

  it('다른 문자열이면 false', async () => {
    expect(await timingSafeEqualSecret('secret-a', 'secret-b')).toBe(false)
  })

  it('길이가 다른 문자열도 예외 없이 false를 반환한다(해시 후 비교라 32바이트 고정)', async () => {
    expect(await timingSafeEqualSecret('short', 'a-much-longer-secret-value-here')).toBe(false)
  })

  it('문자열이 아닌 입력(undefined/null/숫자)은 안전하게 false', async () => {
    expect(await timingSafeEqualSecret(undefined, 'x')).toBe(false)
    expect(await timingSafeEqualSecret('x', null)).toBe(false)
    expect(await timingSafeEqualSecret(123, 123)).toBe(false)
  })

  it('빈 문자열끼리는 true(둘 다 SHA-256 처리 후 동일 다이제스트)', async () => {
    expect(await timingSafeEqualSecret('', '')).toBe(true)
  })
})
