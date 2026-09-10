// timingSafeEqualSecret() 단위테스트 — plugin-deploy-key 축(§4.4)이 의존하는 유일한 신규 함수.
// 기존 hashPassword/verifyPassword/JWT 발급·검증 등은 이 파일에서 다루지 않는다(회귀 없음,
// 신규 export만 추가했으므로 새 테스트도 신규 export 전용으로 한정한다).
import { describe, it, expect } from 'vitest'
import { timingSafeEqualSecret } from './tokens.js'

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
