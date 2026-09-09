// server/lib/google-oidc.js 단위테스트 — Google 연동(인가URL/토큰교환/id_token 클레임검증/
// 도메인강제 2계층/fail-closed). 설계 정본: docs/design/google-oauth-login.md 결정4·7·9, §4.
// 서명검증은 설계상 의도적으로 생략(§4.2, OIDC Core §3.1.3.7)하므로 여기서도 서명 부분은 임의값을
// 쓰고 payload만 base64url로 조립한 "가짜 id_token"으로 클레임 검증 로직만 정확히 검증한다.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  isGoogleConfigured, isOriginAllowed, buildAuthorizationUrl, computeCodeChallengeS256,
  exchangeCodeForToken, verifyIdTokenClaims, decodeIdTokenPayload, GOOGLE_SCOPE
} from './google-oidc.js'

function base64url(value) {
  const str = typeof value === 'string' ? value : JSON.stringify(value)
  return Buffer.from(str, 'utf8').toString('base64url')
}

function makeIdToken(claims) {
  return `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url(claims)}.fake-signature-not-verified`
}

function validClaims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: 'https://accounts.google.com',
    aud: 'test-client-id',
    exp: now + 3600,
    iat: now - 10,
    nonce: 'test-nonce',
    sub: 'google-sub-123',
    email: 'employee@malgnsoft.com',
    email_verified: true,
    hd: 'malgnsoft.com',
    ...overrides
  }
}

const baseEnv = () => ({
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_REDIRECT_URI: 'https://malgnai-hub.apiserver.kr/api/auth/google/callback',
  GOOGLE_ALLOWED_HD: 'malgnsoft.com'
})

describe('isGoogleConfigured — fail-closed(결정9)', () => {
  it('client 3종 + 도메인 통제선(HD) 전부 설정 → true', () => {
    expect(isGoogleConfigured(baseEnv())).toBe(true)
  })

  it('client 3종 + 도메인 통제선(EMAIL_DOMAIN만) 설정 → true', () => {
    const env = { ...baseEnv(), GOOGLE_ALLOWED_HD: '', GOOGLE_ALLOWED_EMAIL_DOMAIN: 'malgnsoft.com' }
    expect(isGoogleConfigured(env)).toBe(true)
  })

  it('도메인 통제선이 둘 다 비어 있으면 client가 다 있어도 false(fail-closed)', () => {
    const env = { ...baseEnv(), GOOGLE_ALLOWED_HD: '' }
    expect(isGoogleConfigured(env)).toBe(false)
  })

  it('도메인 통제선이 공백 문자열만이어도 false(trim 후 판정)', () => {
    const env = { ...baseEnv(), GOOGLE_ALLOWED_HD: '   ' }
    expect(isGoogleConfigured(env)).toBe(false)
  })

  it('client_id/secret/redirect_uri 중 하나라도 없으면 false', () => {
    expect(isGoogleConfigured({ ...baseEnv(), GOOGLE_CLIENT_SECRET: undefined })).toBe(false)
    expect(isGoogleConfigured({ ...baseEnv(), GOOGLE_CLIENT_ID: '' })).toBe(false)
    expect(isGoogleConfigured({ ...baseEnv(), GOOGLE_REDIRECT_URI: '' })).toBe(false)
  })

  it('env 자체가 완전히 비어 있으면 false', () => {
    expect(isGoogleConfigured({})).toBe(false)
  })
})

describe('isOriginAllowed — 결정7 오리진 고정', () => {
  it('요청 오리진이 GOOGLE_REDIRECT_URI 오리진과 같으면 true', () => {
    expect(isOriginAllowed(baseEnv(), 'https://malgnai-hub.apiserver.kr/api/auth/google/start?redirect=/usage')).toBe(true)
  })

  it('workers.dev 등 다른 오리진이면 false', () => {
    expect(isOriginAllowed(baseEnv(), 'https://malgnai-hub.malgnsoft.workers.dev/api/auth/google/start')).toBe(false)
  })

  it('포트가 다르면 false(로컬 dev 오리진과 프로덕션 오리진 혼용 방지)', () => {
    const env = { ...baseEnv(), GOOGLE_REDIRECT_URI: 'http://localhost:8004/api/auth/google/callback' }
    expect(isOriginAllowed(env, 'http://localhost:5173/api/auth/google/start')).toBe(false)
  })

  it('GOOGLE_REDIRECT_URI가 형식이 깨져도 예외를 던지지 않고 false', () => {
    expect(isOriginAllowed({ ...baseEnv(), GOOGLE_REDIRECT_URI: 'not-a-url' }, 'https://malgnai-hub.apiserver.kr/x')).toBe(false)
  })
})

describe('buildAuthorizationUrl — §3.1 파라미터', () => {
  it('인터랙티브 모드는 prompt=select_account, hd 파라미터 포함(GOOGLE_ALLOWED_HD 설정 시)', () => {
    const url = new URL(buildAuthorizationUrl(baseEnv(), { state: 's1', nonce: 'n1', codeChallenge: 'c1', mode: 'interactive' }))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('prompt')).toBe('select_account')
    expect(url.searchParams.get('hd')).toBe('malgnsoft.com')
    expect(url.searchParams.get('scope')).toBe(GOOGLE_SCOPE)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('access_type')).toBe('online')
    expect(url.searchParams.get('state')).toBe('s1')
    expect(url.searchParams.get('nonce')).toBe('n1')
  })

  it('무음 모드(silent)는 prompt=none', () => {
    const url = new URL(buildAuthorizationUrl(baseEnv(), { state: 's1', nonce: 'n1', codeChallenge: 'c1', mode: 'silent' }))
    expect(url.searchParams.get('prompt')).toBe('none')
  })

  it('GOOGLE_ALLOWED_HD가 비어 있으면 hd 파라미터를 아예 붙이지 않는다(비-Workspace 환경, §3.1)', () => {
    const env = { ...baseEnv(), GOOGLE_ALLOWED_HD: '', GOOGLE_ALLOWED_EMAIL_DOMAIN: 'malgnsoft.com' }
    const url = new URL(buildAuthorizationUrl(env, { state: 's1', nonce: 'n1', codeChallenge: 'c1', mode: 'interactive' }))
    expect(url.searchParams.has('hd')).toBe(false)
  })

  it('redirect_uri는 env 값을 그대로 쓴다(요청에서 조립하지 않음)', () => {
    const url = new URL(buildAuthorizationUrl(baseEnv(), { state: 's1', nonce: 'n1', codeChallenge: 'c1', mode: 'interactive' }))
    expect(url.searchParams.get('redirect_uri')).toBe(baseEnv().GOOGLE_REDIRECT_URI)
  })
})

describe('computeCodeChallengeS256 — PKCE', () => {
  it('RFC7636 부록 B 예시 verifier로 알려진 challenge 값을 재현한다', async () => {
    // RFC 7636 Appendix B의 표준 예시 벡터.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    expect(await computeCodeChallengeS256(verifier)).toBe(expected)
  })

  it('같은 verifier는 항상 같은 challenge를 낸다(결정적)', async () => {
    const a = await computeCodeChallengeS256('same-verifier-value-1234567890123')
    const b = await computeCodeChallengeS256('same-verifier-value-1234567890123')
    expect(a).toBe(b)
  })
})

describe('decodeIdTokenPayload / verifyIdTokenClaims', () => {
  it('형식이 깨진 토큰(점 2개 아님)은 null/upstream', () => {
    expect(decodeIdTokenPayload('not-a-jwt')).toBeNull()
    const result = verifyIdTokenClaims(baseEnv(), 'not-a-jwt', { nonce: 'test-nonce' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('upstream')
  })

  it('정상 클레임(hd 일치, email_verified=true) → ok:true', () => {
    const token = makeIdToken(validClaims())
    const result = verifyIdTokenClaims(baseEnv(), token, { nonce: 'test-nonce' })
    expect(result.ok).toBe(true)
    expect(result.claims.email).toBe('employee@malgnsoft.com')
  })

  it('email_verified가 문자열 "true"여도 통과한다(설계 §결정1 C1 — 문자열도 허용)', () => {
    const token = makeIdToken(validClaims({ email_verified: 'true' }))
    const result = verifyIdTokenClaims(baseEnv(), token, { nonce: 'test-nonce' })
    expect(result.ok).toBe(true)
  })

  // (a) email_verified=false 거부
  it('email_verified=false → email_unverified 거부(도메인 검증보다 먼저 걸린다)', () => {
    const token = makeIdToken(validClaims({ email_verified: false, hd: 'evil.example' }))
    const result = verifyIdTokenClaims(baseEnv(), token, { nonce: 'test-nonce' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('email_unverified')
  })

  // (b) hd 클레임 불일치 거부
  it('hd 클레임이 GOOGLE_ALLOWED_HD와 다르면 hd_mismatch(L2 — 실제 통제선)', () => {
    const token = makeIdToken(validClaims({ hd: 'personal-gmail.example' }))
    const result = verifyIdTokenClaims(baseEnv(), token, { nonce: 'test-nonce' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('hd_mismatch')
  })

  it('hd 클레임이 아예 없어도(개인 Gmail) hd_mismatch — L1(요청 파라미터)이 지워져도 L2가 막는다', () => {
    const token = makeIdToken(validClaims({ hd: undefined }))
    const result = verifyIdTokenClaims(baseEnv(), token, { nonce: 'test-nonce' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('hd_mismatch')
  })

  it('대소문자만 다른 hd는 완전일치로 취급(대소문자 무시)', () => {
    const token = makeIdToken(validClaims({ hd: 'MALGNSOFT.COM' }))
    const result = verifyIdTokenClaims(baseEnv(), token, { nonce: 'test-nonce' })
    expect(result.ok).toBe(true)
  })

  it('GOOGLE_ALLOWED_EMAIL_DOMAIN 대체 경로 — email suffix 불일치는 domain_mismatch', () => {
    const env = { ...baseEnv(), GOOGLE_ALLOWED_HD: '', GOOGLE_ALLOWED_EMAIL_DOMAIN: 'malgnsoft.com' }
    const token = makeIdToken(validClaims({ hd: undefined, email: 'someone@othercompany.example' }))
    const result = verifyIdTokenClaims(env, token, { nonce: 'test-nonce' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('domain_mismatch')
  })

  it('GOOGLE_ALLOWED_EMAIL_DOMAIN 경로에서 suffix가 일치하면 통과(hd 클레임과 무관)', () => {
    const env = { ...baseEnv(), GOOGLE_ALLOWED_HD: '', GOOGLE_ALLOWED_EMAIL_DOMAIN: 'malgnsoft.com' }
    const token = makeIdToken(validClaims({ hd: undefined, email: 'employee@malgnsoft.com' }))
    const result = verifyIdTokenClaims(env, token, { nonce: 'test-nonce' })
    expect(result.ok).toBe(true)
  })

  it('둘 다 설정되면 AND로 검증 — hd는 통과해도 email suffix가 다르면 거부', () => {
    const env = { ...baseEnv(), GOOGLE_ALLOWED_EMAIL_DOMAIN: 'onlysuffix.example' }
    const token = makeIdToken(validClaims({ hd: 'malgnsoft.com', email: 'x@malgnsoft.com' }))
    const result = verifyIdTokenClaims(env, token, { nonce: 'test-nonce' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('domain_mismatch')
  })

  it('nonce 불일치는 upstream(위조/재생 시도로 간주, 구조적 검증 계열)', () => {
    const token = makeIdToken(validClaims({ nonce: 'different-nonce' }))
    const result = verifyIdTokenClaims(baseEnv(), token, { nonce: 'test-nonce' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('upstream')
  })

  it('aud가 우리 client_id와 다르면 upstream(형제 클라이언트 혼입 방지, §4.2)', () => {
    const token = makeIdToken(validClaims({ aud: 'someone-elses-client-id' }))
    const result = verifyIdTokenClaims(baseEnv(), token, { nonce: 'test-nonce' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('upstream')
  })

  it('iss가 accounts.google.com 계열이 아니면 upstream', () => {
    const token = makeIdToken(validClaims({ iss: 'https://evil.example' }))
    const result = verifyIdTokenClaims(baseEnv(), token, { nonce: 'test-nonce' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('upstream')
  })

  it('exp가 120초 허용오차를 넘겨 만료됐으면 upstream(6.8 클럭스큐)', () => {
    const now = Math.floor(Date.now() / 1000)
    const token = makeIdToken(validClaims({ exp: now - 200 }))
    const result = verifyIdTokenClaims(baseEnv(), token, { nonce: 'test-nonce' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('upstream')
  })

  it('exp가 100초 전(120초 허용오차 이내)이면 통과(클럭스큐 허용)', () => {
    const now = Math.floor(Date.now() / 1000)
    const token = makeIdToken(validClaims({ exp: now - 100 }))
    const result = verifyIdTokenClaims(baseEnv(), token, { nonce: 'test-nonce' })
    expect(result.ok).toBe(true)
  })

  it('sub 또는 email이 없으면 upstream', () => {
    const noSub = makeIdToken(validClaims({ sub: undefined }))
    expect(verifyIdTokenClaims(baseEnv(), noSub, { nonce: 'test-nonce' }).reason).toBe('upstream')
    const noEmail = makeIdToken(validClaims({ email: undefined }))
    expect(verifyIdTokenClaims(baseEnv(), noEmail, { nonce: 'test-nonce' }).reason).toBe('upstream')
  })

  // M1 회귀 잠금 — 도메인 통제선 함수(checkDomainControl) 자체가 fail-closed인지, verifyIdTokenClaims
  // 경유로 직접 검증한다(라우트의 isGoogleConfigured() 재확인 순서에 기대지 않는다 — "보안 컨트롤은
  // 호출 순서가 아니라 자기 자신이 fail-closed여야 한다").
  describe('M1 회귀 — 도메인 통제선이 하나도 없으면 정상 id_token도 거부한다(자기 자신이 fail-closed)', () => {
    it('GOOGLE_ALLOWED_HD·GOOGLE_ALLOWED_EMAIL_DOMAIN 둘 다 미설정 + 완전히 정상인 클레임 → ok:false, not_configured', () => {
      const env = { ...baseEnv(), GOOGLE_ALLOWED_HD: undefined, GOOGLE_ALLOWED_EMAIL_DOMAIN: undefined }
      const token = makeIdToken(validClaims())
      const result = verifyIdTokenClaims(env, token, { nonce: 'test-nonce' })
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('not_configured')
    })

    it('둘 다 공백 문자열이어도(trim 후 빈 값) not_configured', () => {
      const env = { ...baseEnv(), GOOGLE_ALLOWED_HD: '   ', GOOGLE_ALLOWED_EMAIL_DOMAIN: '' }
      const token = makeIdToken(validClaims())
      expect(verifyIdTokenClaims(env, token, { nonce: 'test-nonce' }).reason).toBe('not_configured')
    })
  })

  // M3 회귀 잠금 — 구조적 검증 실패는 사용자 노출 reason은 그대로 'upstream'이지만, 내부 관측용
  // detail 필드가 원인별로 구분돼야 한다(특히 nonce_mismatch·aud_mismatch가 소실되면 안 된다).
  describe('M3 회귀 — 구조적 검증 실패의 내부 detail이 원인별로 보존된다', () => {
    it('nonce 불일치 → reason=upstream, detail=nonce_mismatch(재생·주입 시도의 유일한 신호)', () => {
      const token = makeIdToken(validClaims({ nonce: 'different-nonce' }))
      const result = verifyIdTokenClaims(baseEnv(), token, { nonce: 'test-nonce' })
      expect(result.reason).toBe('upstream')
      expect(result.detail).toBe('nonce_mismatch')
    })

    it('aud 불일치 → detail=aud_mismatch(형제 클라이언트 오주입 신호)', () => {
      const token = makeIdToken(validClaims({ aud: 'someone-elses-client-id' }))
      const result = verifyIdTokenClaims(baseEnv(), token, { nonce: 'test-nonce' })
      expect(result.detail).toBe('aud_mismatch')
    })

    it('iss 불일치 → detail=iss_mismatch', () => {
      const token = makeIdToken(validClaims({ iss: 'https://evil.example' }))
      expect(verifyIdTokenClaims(baseEnv(), token, { nonce: 'test-nonce' }).detail).toBe('iss_mismatch')
    })

    it('형식이 깨진 토큰 → detail=decode_failed', () => {
      expect(verifyIdTokenClaims(baseEnv(), 'not-a-jwt', { nonce: 'test-nonce' }).detail).toBe('decode_failed')
    })
  })

  // §4.2 전제("id_token은 토큰 엔드포인트 응답 외의 경로에서 오지 않는다") 회귀 방지 — 리뷰 §2 M3
  // "추가 권고". 주석은 회귀를 막지 못하지만 실패하는 테스트는 막는다.
  it('전제 회귀 방지: verifyIdTokenClaims 호출부는 auth-google.js에 정확히 1개, 인자는 tokenResult.idToken뿐', async () => {
    const src = await readFile(new URL('../api/auth-google.js', import.meta.url), 'utf8')
    expect(src.match(/verifyIdTokenClaims\(/g)).toHaveLength(1)
    expect(src).toContain('verifyIdTokenClaims(c.env, tokenResult.idToken')
  })
})

describe('exchangeCodeForToken — §4.1 (5초 timeout, 재시도 없음, client_secret 미로깅)', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    global.fetch = vi.fn()
  })
  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('정상 200 + id_token 포함 → ok:true', async () => {
    global.fetch.mockResolvedValue({ status: 200, json: async () => ({ id_token: 'abc.def.ghi' }) })
    const result = await exchangeCodeForToken(baseEnv(), { code: 'auth-code', codeVerifier: 'verifier' })
    expect(result).toEqual({ ok: true, idToken: 'abc.def.ghi' })
  })

  it('네트워크 오류/타임아웃 → upstream(재시도하지 않는다 — fetch가 정확히 1번만 호출)', async () => {
    global.fetch.mockRejectedValue(new Error('network down'))
    const result = await exchangeCodeForToken(baseEnv(), { code: 'auth-code', codeVerifier: 'verifier' })
    expect(result).toEqual({ ok: false, reason: 'upstream' })
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('비200 응답 → upstream', async () => {
    global.fetch.mockResolvedValue({ status: 400, json: async () => ({ error: 'invalid_grant' }) })
    const result = await exchangeCodeForToken(baseEnv(), { code: 'auth-code', codeVerifier: 'verifier' })
    expect(result).toEqual({ ok: false, reason: 'upstream' })
  })

  it('JSON 파싱 실패 → upstream', async () => {
    global.fetch.mockResolvedValue({ status: 200, json: async () => { throw new Error('bad json') } })
    const result = await exchangeCodeForToken(baseEnv(), { code: 'auth-code', codeVerifier: 'verifier' })
    expect(result).toEqual({ ok: false, reason: 'upstream' })
  })

  it('id_token 필드 부재 → upstream', async () => {
    global.fetch.mockResolvedValue({ status: 200, json: async () => ({ access_token: 'x' }) })
    const result = await exchangeCodeForToken(baseEnv(), { code: 'auth-code', codeVerifier: 'verifier' })
    expect(result).toEqual({ ok: false, reason: 'upstream' })
  })

  it('client_secret이 요청 body에 실려 나가지만 반환값·에러 어디에도 노출되지 않는다', async () => {
    global.fetch.mockResolvedValue({ status: 200, json: async () => ({ id_token: 'abc.def.ghi' }) })
    await exchangeCodeForToken(baseEnv(), { code: 'auth-code', codeVerifier: 'verifier' })
    const [, init] = global.fetch.mock.calls[0]
    expect(init.body).toContain('client_secret=test-client-secret') // 상류로는 보낸다(정상 프로토콜)
    // 반환값 자체에는 secret이 없다는 것은 위 ok:true 케이스의 toEqual로 이미 증명됨(idToken만 반환).
  })
})
