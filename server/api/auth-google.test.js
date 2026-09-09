// GET/POST /api/auth/google/* 라우트 레벨 단위테스트. 설계 정본: docs/design/google-oauth-login.md.
// Sensitive 등급(프로덕션 인증 경로) — 완료판정의 8개 필수 케이스를 모두 실제로 실행해 잠근다
// (401/400 상태코드만 찍는 빈 테스트 금지). server/dao/*는 admin-users.test.js와 동일한 방식으로
// vi.mock(D1 없이 라우트 로직만 검증), server/lib/google-oidc.js는 Google 네트워크 왕복(토큰교환·
// 클레임검증)만 mock하고 나머지(isGoogleConfigured/isOriginAllowed/buildAuthorizationUrl/
// computeCodeChallengeS256)는 실제 구현을 그대로 태워 /start의 fail-closed·오리진 검사를 진짜로
// 검증한다. server/lib/session-tokens.js(issueWebTokenPair)는 자체인증 회귀 스코프 밖이라 mock.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const flowInsertMock = vi.fn()
const flowFindByStateMock = vi.fn()
const flowClaimMock = vi.fn()
const flowMarkFailedIfPendingMock = vi.fn()
const flowMarkFailedOwnedMock = vi.fn()
const flowSetHandoffMock = vi.fn()
const flowFindByHandoffHashMock = vi.fn()
const flowConsumeHandoffMock = vi.fn()

const usersFindByEmailMock = vi.fn()
const usersFindByIdMock = vi.fn()
const usersLinkGoogleSubMock = vi.fn()

const auditRecordMock = vi.fn()

const exchangeCodeForTokenMock = vi.fn()
const verifyIdTokenClaimsMock = vi.fn()

const issueWebTokenPairMock = vi.fn()

vi.mock('../dao/google-login-flows.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    insert: (...args) => flowInsertMock(...args),
    findByState: (...args) => flowFindByStateMock(...args),
    claim: (...args) => flowClaimMock(...args),
    markFailedIfPending: (...args) => flowMarkFailedIfPendingMock(...args),
    markFailedOwned: (...args) => flowMarkFailedOwnedMock(...args),
    setHandoff: (...args) => flowSetHandoffMock(...args),
    findByHandoffHash: (...args) => flowFindByHandoffHashMock(...args),
    consumeHandoff: (...args) => flowConsumeHandoffMock(...args)
  }
})

vi.mock('../dao/users.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    findByEmail: (...args) => usersFindByEmailMock(...args),
    findById: (...args) => usersFindByIdMock(...args),
    linkGoogleSub: (...args) => usersLinkGoogleSubMock(...args)
  }
})

vi.mock('../dao/audit-logs.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, record: (...args) => auditRecordMock(...args) }
})

vi.mock('../lib/google-oidc.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    exchangeCodeForToken: (...args) => exchangeCodeForTokenMock(...args),
    verifyIdTokenClaims: (...args) => verifyIdTokenClaimsMock(...args)
  }
})

vi.mock('../lib/session-tokens.js', () => ({
  issueWebTokenPair: (...args) => issueWebTokenPairMock(...args)
}))

const { default: authGoogle } = await import('./auth-google.js')

const ENV = {
  DB: {},
  JWT_SECRET: 'test-jwt-secret',
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost/api/auth/google/callback',
  GOOGLE_ALLOWED_HD: 'malgnsoft.com'
}

// M4 검증 전용 — https(프로덕션과 동일 조건)에서만 __Host- 쿠키 하드닝이 켜진다.
const ENV_HTTPS = {
  ...ENV,
  GOOGLE_REDIRECT_URI: 'https://malgnai-hub.apiserver.kr/api/auth/google/callback'
}

function makeApp() {
  const app = new Hono()
  app.route('/api/auth/google', authGoogle)
  return app
}

function pendingRow(overrides = {}) {
  return {
    state: 'state-1',
    binding_hash: 'BOUND_HASH',
    nonce: 'nonce-1',
    code_verifier: 'verifier-1',
    redirect_path: '/usage',
    mode: 'interactive',
    status: 'pending',
    user_id: null,
    handoff_code_hash: null,
    handoff_expires_at: null,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    created_at: new Date().toISOString(),
    completed_at: null,
    ...overrides
  }
}

function activeUser(overrides = {}) {
  return { id: 'user-1', email: 'employee@malgnsoft.com', status: 'active', google_sub: null, must_change_password: false, ...overrides }
}

beforeEach(() => {
  flowInsertMock.mockReset().mockResolvedValue({})
  flowFindByStateMock.mockReset()
  flowClaimMock.mockReset().mockResolvedValue(true)
  flowMarkFailedIfPendingMock.mockReset().mockResolvedValue(true)
  flowMarkFailedOwnedMock.mockReset().mockResolvedValue(undefined)
  flowSetHandoffMock.mockReset().mockResolvedValue(true)
  flowFindByHandoffHashMock.mockReset()
  flowConsumeHandoffMock.mockReset()
  usersFindByEmailMock.mockReset()
  usersFindByIdMock.mockReset()
  usersLinkGoogleSubMock.mockReset().mockResolvedValue(true)
  auditRecordMock.mockReset().mockResolvedValue('audit-id')
  exchangeCodeForTokenMock.mockReset().mockResolvedValue({ ok: true, idToken: 'fake.id.token' })
  verifyIdTokenClaimsMock.mockReset()
  issueWebTokenPairMock.mockReset().mockResolvedValue({
    token: 'jwt-token', expires_in: 14400, refresh_token: 'refresh-token', refresh_expires_in: 2592000
  })
})

// ---------------------------------------------------------------------------
// GET /start
// ---------------------------------------------------------------------------
describe('GET /api/auth/google/start', () => {
  // (h) 도메인 통제 env 미설정 시 /start fail-closed
  it('GOOGLE_ALLOWED_HD·GOOGLE_ALLOWED_EMAIL_DOMAIN 둘 다 미설정이면 not_configured로 fail-closed하고 플로우를 만들지 않는다', async () => {
    const app = makeApp()
    const env = { ...ENV, GOOGLE_ALLOWED_HD: undefined, GOOGLE_ALLOWED_EMAIL_DOMAIN: undefined }
    const res = await app.request('/api/auth/google/start', {}, env)

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login#ge=not_configured')
    expect(flowInsertMock).not.toHaveBeenCalled()
  })

  it('GOOGLE_CLIENT_SECRET만 없어도 not_configured', async () => {
    const app = makeApp()
    const res = await app.request('/api/auth/google/start', {}, { ...ENV, GOOGLE_CLIENT_SECRET: undefined })
    expect(res.headers.get('location')).toBe('/login#ge=not_configured')
  })

  it('요청 오리진이 GOOGLE_REDIRECT_URI 오리진과 다르면 origin_not_allowed', async () => {
    const app = makeApp()
    const res = await app.request('http://evil.example/api/auth/google/start', {}, ENV)
    expect(res.headers.get('location')).toBe('/login#ge=origin_not_allowed')
    expect(flowInsertMock).not.toHaveBeenCalled()
  })

  it('정상 설정이면 302로 accounts.google.com에 리디렉트하고 플로우 1행을 INSERT한다', async () => {
    const app = makeApp()
    const res = await app.request('/api/auth/google/start?redirect=/usage', {}, ENV)

    expect(res.status).toBe(302)
    const location = res.headers.get('location')
    expect(location.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true)
    expect(flowInsertMock).toHaveBeenCalledTimes(1)
    expect(flowInsertMock.mock.calls[0][1]).toMatchObject({ redirectPath: '/usage', mode: 'interactive' })
    expect(res.headers.get('set-cookie')).toContain('mh_gflow=')
  })

  it('redirect 파라미터가 "//evil.example"이면 무시하고 "/"로 대체한다(오픈 리다이렉트 방지)', async () => {
    const app = makeApp()
    await app.request('/api/auth/google/start?redirect=%2F%2Fevil.example', {}, ENV)
    expect(flowInsertMock.mock.calls[0][1].redirectPath).toBe('/')
  })

  // L1 회귀 잠금 — 역슬래시(URL 파서가 `\`를 `/`로 정규화해 특수 스킴에서 오리진을 바꿀 수 있다)와
  // 점세그먼트(`..`)는 이전에는 "/"로 시작하고 "//"로 시작하지 않는다는 조건만으로 통과했다(실측:
  // security의 repro-redirect.mjs). 수정 전에는 이 4개 케이스가 그대로 통과해 이 테스트가 실패한다.
  describe('L1 회귀 — sanitizeRedirectPath가 역슬래시·점세그먼트를 차단한다', () => {
    it.each([
      ['/\\evil.com'],
      ['/\\/evil.com'],
      ['/..//evil.com'],
      ['/usage/../../etc'],
    ])('redirect=%s는 "/"로 대체된다', async (raw) => {
      const app = makeApp()
      await app.request(`/api/auth/google/start?redirect=${encodeURIComponent(raw)}`, {}, ENV)
      expect(flowInsertMock.mock.calls[0][1].redirectPath).toBe('/')
    })

    it('정상적인 내부 경로는 그대로 통과한다(과차단 방지)', async () => {
      const app = makeApp()
      await app.request('/api/auth/google/start?redirect=%2Fusage%2Fdashboard', {}, ENV)
      expect(flowInsertMock.mock.calls[0][1].redirectPath).toBe('/usage/dashboard')
    })
  })

  it('silent=1이고 억제 쿠키가 이미 있으면 Google로 나가지 않고 silent_suppressed로 조용히 되돌린다', async () => {
    const app = makeApp()
    const res = await app.request('/api/auth/google/start?silent=1', {
      headers: { cookie: 'mh_gsilent_try=1' }
    }, ENV)

    expect(res.headers.get('location')).toBe('/login#ge=silent_suppressed')
    expect(flowInsertMock).not.toHaveBeenCalled()
  })

  it('silent=1이고 억제 쿠키가 없으면 prompt=none으로 진행하고 억제 쿠키를 새로 세운다', async () => {
    const app = makeApp()
    const res = await app.request('/api/auth/google/start?silent=1', {}, ENV)

    const location = new URL(res.headers.get('location'))
    expect(location.searchParams.get('prompt')).toBe('none')
    expect(flowInsertMock.mock.calls[0][1].mode).toBe('silent')
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]
    expect(setCookies.some((v) => v.includes('mh_gsilent_try=1'))).toBe(true)
  })

  // M4 처방 채택 확인 — https(프로덕션과 동일 조건)에서는 바인딩 쿠키가 __Host- 접두사 +
  // Path=/ + Secure로 발급된다. 브라우저는 이 3조건이 갖춰진 쿠키에 대해 Domain 지정과
  // 비-Secure 발급을 거부하므로, 형제 서브도메인(예: evil.apiserver.kr)이 `Domain=apiserver.kr`로
  // 이 이름의 쿠키를 심는 cookie tossing이 원천 차단된다(§2 M4).
  it('M4 — https 요청에서는 바인딩 쿠키가 __Host-mh_gflow + Path=/ + Secure로 발급된다', async () => {
    const app = makeApp()
    const res = await app.request('https://malgnai-hub.apiserver.kr/api/auth/google/start', {}, ENV_HTTPS)
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]
    const flowCookie = setCookies.find((v) => v.startsWith('__Host-mh_gflow='))
    expect(flowCookie).toBeDefined()
    expect(flowCookie).toContain('Path=/')
    expect(flowCookie).toContain('Secure')
    expect(setCookies.some((v) => v.startsWith('mh_gflow='))).toBe(false) // 접두사 없는 이름은 발급되지 않는다
  })

  // m-3 회귀 — 무음 억제 쿠키도 바인딩 쿠키와 동일하게 __Host- 하드닝을 받는다(cookie tossing
  // 방지). 이전에는 이 쿠키만 https에서도 접두사 없이 발급돼 형제 서브도메인이
  // `Domain=apiserver.kr; mh_gsilent_try=1`을 심어 무음 재로그인을 영구 억제할 수 있었다.
  it('m-3 — https에서는 무음 억제 쿠키도 __Host-mh_gsilent_try + Path=/ + Secure로 발급된다', async () => {
    const app = makeApp()
    const res = await app.request('https://malgnai-hub.apiserver.kr/api/auth/google/start?silent=1', {}, ENV_HTTPS)
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]
    const silentCookie = setCookies.find((v) => v.startsWith('__Host-mh_gsilent_try='))
    expect(silentCookie).toBeDefined()
    expect(silentCookie).toContain('Path=/')
    expect(silentCookie).toContain('Secure')
    expect(setCookies.some((v) => v.startsWith('mh_gsilent_try='))).toBe(false) // 접두사 없는 이름은 발급되지 않는다
  })

  it('http(로컬 dev)에서는 여전히 mh_gflow + 기존 경로를 쓴다(폴백 유지)', async () => {
    const app = makeApp()
    const res = await app.request('/api/auth/google/start', {}, ENV)
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]
    const flowCookie = setCookies.find((v) => v.startsWith('mh_gflow='))
    expect(flowCookie).toBeDefined()
    expect(flowCookie).toContain('Path=/api/auth/google')
  })

  // ---------------------------------------------------------------------------
  // 레이트리밋(H1 처방 + review M-C/M-D/M-E 회귀) — GOOGLE_LOGIN_RL 바인딩. 리뷰가 지적한
  // "H1 최우선 처방(레이트리밋)만 회귀 테스트가 0건이다"(M-C)를 잠근다: 바인딩 있음/없음, 한도
  // 내/초과, limit() 예외 3케이스 + gs 왕복(M-D) + 키 분리(M-E).
  // ---------------------------------------------------------------------------
  describe('레이트리밋(GOOGLE_LOGIN_RL) — M-C/M-D/M-E 회귀', () => {
    it('바인딩이 없으면(로컬/미배포) 통과한다(fail-open, H1 처방)', async () => {
      const app = makeApp()
      const res = await app.request('/api/auth/google/start', {}, ENV) // ENV에는 GOOGLE_LOGIN_RL이 없다
      expect(res.headers.get('location')?.startsWith('https://accounts.google.com/')).toBe(true)
      expect(flowInsertMock).toHaveBeenCalledTimes(1)
    })

    it('바인딩이 있고 한도 내(success:true)면 정상 진행한다', async () => {
      const app = makeApp()
      const rl = { limit: vi.fn().mockResolvedValue({ success: true }) }
      const res = await app.request('/api/auth/google/start', {}, { ...ENV, GOOGLE_LOGIN_RL: rl })
      expect(res.headers.get('location')?.startsWith('https://accounts.google.com/')).toBe(true)
      expect(rl.limit).toHaveBeenCalledWith({ key: 'unknown:start' })
    })

    it('바인딩이 있고 한도 초과(success:false)면 upstream으로 거부하고 D1에 아무것도 쓰지 않는다', async () => {
      const app = makeApp()
      const rl = { limit: vi.fn().mockResolvedValue({ success: false }) }
      const res = await app.request('/api/auth/google/start', {}, { ...ENV, GOOGLE_LOGIN_RL: rl })
      expect(res.headers.get('location')).toBe('/login#ge=upstream')
      expect(flowInsertMock).not.toHaveBeenCalled()
    })

    it('limit() 예외 시 통과(fail-open) + console.error 1회', async () => {
      const app = makeApp()
      const rl = { limit: vi.fn().mockRejectedValue(new Error('rl boom')) }
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const res = await app.request('/api/auth/google/start', {}, { ...ENV, GOOGLE_LOGIN_RL: rl })
      expect(res.headers.get('location')?.startsWith('https://accounts.google.com/')).toBe(true)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0]).toBe('[auth-google] rate limit check failed, allowing request')
      spy.mockRestore()
    })

    // M-D 회귀 — 무음(prompt=none) 요청이 레이트리밋에 걸리면 사용자가 시작하지 않은 실패에 에러
    // 배너가 뜨면 안 된다(설계 §3.1 "조용한 폴백"). 서버가 gs=1을 실어야 login.vue의
    // SILENT_QUIET(이미 'upstream' 포함)가 배너를 억제한다 — app/ 수정 없이 서버만 고쳐도 닫힌다.
    it('M-D — silent=1 요청이 레이트리밋에 걸리면 gs=1을 실어 보낸다(무음 왕복임을 프런트가 알 수 있게)', async () => {
      const app = makeApp()
      const rl = { limit: vi.fn().mockResolvedValue({ success: false }) }
      const res = await app.request('/api/auth/google/start?silent=1', {}, { ...ENV, GOOGLE_LOGIN_RL: rl })
      expect(res.headers.get('location')).toBe('/login#ge=upstream&gs=1')
    })

    it('M-D — silent=1이 아닌 일반 클릭이 레이트리밋에 걸리면 gs를 싣지 않는다(인터랙티브는 배너를 그대로 보여줘야 한다)', async () => {
      const app = makeApp()
      const rl = { limit: vi.fn().mockResolvedValue({ success: false }) }
      const res = await app.request('/api/auth/google/start', {}, { ...ENV, GOOGLE_LOGIN_RL: rl })
      expect(res.headers.get('location')).toBe('/login#ge=upstream')
    })

    // M-E 회귀 — /start와 /callback은 같은 IP라도 별도 버킷(키 접미사)을 쓴다(사무실 공용 NAT가
    // 로그인 1회(2요청)로 같은 버킷을 두 번 소비해 실질 한도가 반토막나는 것을 막는다).
    it('M-E — 레이트리밋 키에 :start 접미사가 붙어 /callback과 버킷이 분리된다', async () => {
      const app = makeApp()
      const rl = { limit: vi.fn().mockResolvedValue({ success: true }) }
      await app.request('/api/auth/google/start', {
        headers: { 'cf-connecting-ip': '10.0.0.1' }
      }, { ...ENV, GOOGLE_LOGIN_RL: rl })
      expect(rl.limit).toHaveBeenCalledWith({ key: '10.0.0.1:start' })
    })
  })
})

// ---------------------------------------------------------------------------
// GET /callback
// ---------------------------------------------------------------------------
describe('GET /api/auth/google/callback', () => {
  function callbackRequest({ query = 'code=auth-code&state=state-1', cookie = 'mh_gflow=BOUND_SECRET' } = {}) {
    const app = makeApp()
    return app.request(`/api/auth/google/callback?${query}`, {
      headers: cookie ? { cookie } : {}
    }, ENV)
  }

  // binding_hash는 sha256('BOUND_SECRET')이어야 쿠키 검증을 통과한다. 사전에 계산해 고정값으로 박아둔다.
  const BOUND_SECRET_SHA256 = 'fb6367ed58129b445067b02b5f9ee7d32306062d514e6970732eb9d9b2c53b7d'

  beforeEach(() => {
    flowFindByStateMock.mockResolvedValue(pendingRow({ binding_hash: BOUND_SECRET_SHA256 }))
  })

  // M1 회귀(라우트 레벨) — /callback도 isGoogleConfigured()를 자체 재확인한다(§2 M1 처방(2)).
  // /start~/callback 사이 최대 10분의 창에서 배포로 도메인 통제선 env가 지워졌다면, state 조회·
  // 로그 증폭까지 가지 않고 여기서 즉시 거부해야 한다.
  it('도메인 통제선 env가 콜백 시점에 사라져 있으면 state 조회 전에 not_configured로 거부한다', async () => {
    const app = new Hono()
    app.route('/api/auth/google', authGoogle)
    const envWithoutDomainControl = { ...ENV, GOOGLE_ALLOWED_HD: undefined, GOOGLE_ALLOWED_EMAIL_DOMAIN: undefined }
    const res = await app.request('/api/auth/google/callback?code=auth-code&state=state-1', {
      headers: { cookie: 'mh_gflow=BOUND_SECRET' }
    }, envWithoutDomainControl)

    expect(res.headers.get('location')).toBe('/login#ge=not_configured')
    expect(flowFindByStateMock).not.toHaveBeenCalled()
  })

  it('state에 해당하는 행이 없으면 invalid_flow(무음 여부 알 수 없어 gs 없음)', async () => {
    flowFindByStateMock.mockResolvedValue(null)
    const res = await callbackRequest()
    expect(res.headers.get('location')).toBe('/login#ge=invalid_flow')
    expect(flowMarkFailedIfPendingMock).not.toHaveBeenCalled()
    expect(flowMarkFailedOwnedMock).not.toHaveBeenCalled()
  })

  // M-G 회귀(라우트 레벨) — errorParam 경로는 claim() 이전이라 이 요청은 그 행의 소유권을
  // 증명하지 못했다. 이전에는(M2 처방) markFailedIfPending을 호출해 'pending'인 행을 'failed'로
  // 죽였는데, 그 창이 피해자가 Google 동의화면에 머무는 전체 시간이라 state 값만 아는 제3자가
  // `?state=S&error=x` 한 번으로 피해자의 진행 중인 로그인을 무력화할 수 있었다(review M-G 실증
  // 타임라인). 수정 후에는 아무것도 쓰지 않는다 — 이 테스트는 수정 전 코드(owned:'pre' 호출)에서는
  // 실패한다.
  it('error 파라미터(google_denied) — 인터랙티브 모드는 google_denied, 어떤 마킹 함수도 호출하지 않는다(쓰기 없음)', async () => {
    const res = await callbackRequest({ query: 'error=access_denied&state=state-1' })
    expect(res.headers.get('location')).toBe('/login#ge=google_denied')
    expect(flowMarkFailedIfPendingMock).not.toHaveBeenCalled()
    expect(flowMarkFailedOwnedMock).not.toHaveBeenCalled()
  })

  // M-G 회귀 — 위와 동일한 경로를, "state만 아는 제3자가 피해자의 진행 중(pending) 플로우를 죽일
  // 수 없다"는 시나리오로 명시적으로 재구성한다. 공격자는 바인딩 쿠키를 모르므로(피해자 브라우저에만
  // 있음) 이 요청에는 애초에 쿠키를 싣지 않는다 — error 파라미터만으로 도달 가능한 경로다.
  it('M-G — state만 아는 제3자가(쿠키 없이) error 파라미터를 보내도 피해자의 pending 플로우에 쓰기가 발생하지 않는다', async () => {
    const res = await callbackRequest({ query: 'error=access_denied&state=state-1', cookie: null })
    expect(res.headers.get('location')).toBe('/login#ge=google_denied')
    // 쓰기가 없으므로 실제 DB에서 이 행의 status는 여전히 'pending'이다 — 피해자의 뒤이은 claim()이
    // status='pending' 조건에 걸려 정상적으로 성공할 수 있다(claim()의 SQL 조건은
    // google-login-flows.test.js가 node:sqlite로 별도 실측).
    expect(flowMarkFailedIfPendingMock).not.toHaveBeenCalled()
    expect(flowMarkFailedOwnedMock).not.toHaveBeenCalled()
  })

  // H1 회귀 — 공격자 통제 문자열(error 파라미터)을 console.error에 그대로 넣지 않고 64자로 자른다.
  it('error 파라미터가 매우 길어도 콘솔 로그는 64자로 절단된다(H1 로그 증폭 방지)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const longError = 'A'.repeat(100000)
    await callbackRequest({ query: `error=${longError}&state=state-1` })
    const call = spy.mock.calls.find((args) => args[0] === '[auth-google] callback error param')
    expect(call).toBeDefined()
    expect(call[1].length).toBeLessThanOrEqual(64)
    spy.mockRestore()
  })

  // (g) 무음(prompt=none) 실패 시 폴백 경로
  it('무음 모드에서 error 파라미터(login_required) → silent_unavailable + gs=1, 감사기록 없음(사용자 미식별)', async () => {
    flowFindByStateMock.mockResolvedValue(pendingRow({ mode: 'silent', binding_hash: BOUND_SECRET_SHA256 }))
    const res = await callbackRequest({ query: 'error=login_required&state=state-1' })
    expect(res.headers.get('location')).toBe('/login#ge=silent_unavailable&gs=1')
    expect(auditRecordMock).not.toHaveBeenCalled()
    // M-G — 이 경로도 claim() 이전이라 쓰기가 없다(위 google_denied 케이스와 동일 사유).
    expect(flowMarkFailedIfPendingMock).not.toHaveBeenCalled()
  })

  it('쿠키 바인딩 불일치 → flow_binding_failed', async () => {
    const res = await callbackRequest({ cookie: 'mh_gflow=WRONG_SECRET' })
    expect(res.headers.get('location')).toBe('/login#ge=flow_binding_failed')
  })

  it('쿠키가 아예 없으면 flow_binding_failed', async () => {
    const res = await callbackRequest({ cookie: null })
    expect(res.headers.get('location')).toBe('/login#ge=flow_binding_failed')
  })

  // (e) state 1회성 — claim()이 changes=0(재사용/레이스)이면 invalid_flow, 이 요청은 markFailed를
  // 호출하지 않는다(소유권이 없어 다른 요청의 성공 경로를 덮어쓰면 안 된다).
  it('claim() CAS 실패(재사용/레이스) → invalid_flow, markFailed류 미호출(소유권 없음)', async () => {
    flowClaimMock.mockResolvedValue(false)
    const res = await callbackRequest()
    expect(res.headers.get('location')).toBe('/login#ge=invalid_flow')
    expect(flowMarkFailedIfPendingMock).not.toHaveBeenCalled()
    expect(flowMarkFailedOwnedMock).not.toHaveBeenCalled()
    expect(exchangeCodeForTokenMock).not.toHaveBeenCalled() // 클레임 실패 시 Google 토큰교환까지 가지 않는다
  })

  // (f) state 만료 거부 — claim()이 만료 때문에 false를 반환하는 경우도 동일 경로(SQL 조건은
  // server/dao/google-login-flows.test.js가 별도로 실측). 라우트 관점에서 재사용과 구분되지 않는
  // 것이 설계 의도다(§3.2 "state 없음/만료/재사용" 모두 invalid_flow).
  it('claim()이 만료로 false를 반환해도 동일하게 invalid_flow로 안전 종료된다', async () => {
    flowFindByStateMock.mockResolvedValue(pendingRow({ binding_hash: BOUND_SECRET_SHA256, expires_at: new Date(Date.now() - 1000).toISOString() }))
    flowClaimMock.mockResolvedValue(false)
    const res = await callbackRequest()
    expect(res.headers.get('location')).toBe('/login#ge=invalid_flow')
    expect(exchangeCodeForTokenMock).not.toHaveBeenCalled()
  })

  // M-G 회귀 — !code 경로도 claim() 이전이라 쓰기가 없다.
  it('code 파라미터가 없고 error도 없으면(기형 콜백) upstream, 마킹 함수는 호출하지 않는다(쓰기 없음)', async () => {
    const res = await callbackRequest({ query: 'state=state-1' })
    expect(res.headers.get('location')).toBe('/login#ge=upstream')
    expect(flowMarkFailedIfPendingMock).not.toHaveBeenCalled()
    expect(flowMarkFailedOwnedMock).not.toHaveBeenCalled()
  })

  // M-G 회귀(라우트 레벨, PM이 코드로 직접 확인한 항목) — 이 지점은 "이 요청은 이 행의 주인이
  // 아니다"가 방금 **반증된** 지점(바인딩 쿠키 불일치)인데, 이전에는 여기서도 markFailedIfPending을
  // 호출해 'pending'인 남의 행을 죽일 수 있었다. 수정 후에는 아무것도 쓰지 않는다 — 이 테스트는
  // 수정 전 코드(owned:'pre' 호출)에서는 실패한다.
  it('M-G — 쿠키 바인딩 불일치(반증됨)는 어떤 마킹 함수도 호출하지 않는다(post-claim 함수 미호출)', async () => {
    await callbackRequest({ cookie: 'mh_gflow=WRONG_SECRET' })
    expect(flowMarkFailedIfPendingMock).not.toHaveBeenCalled()
    expect(flowMarkFailedOwnedMock).not.toHaveBeenCalled()
  })

  it('Google 토큰 교환 실패 → upstream', async () => {
    exchangeCodeForTokenMock.mockResolvedValue({ ok: false, reason: 'upstream' })
    const res = await callbackRequest()
    expect(res.headers.get('location')).toBe('/login#ge=upstream')
    expect(usersFindByEmailMock).not.toHaveBeenCalled()
  })

  // (a) email_verified=false 거부
  it('email_verified=false → email_unverified 거부 + 감사기록(사용자 미확정이라 actor=system)', async () => {
    verifyIdTokenClaimsMock.mockReturnValue({ ok: false, reason: 'email_unverified', claims: { email: 'employee@malgnsoft.com' } })
    const res = await callbackRequest()

    expect(res.headers.get('location')).toBe('/login#ge=email_unverified')
    expect(usersFindByEmailMock).not.toHaveBeenCalled() // 클레임 검증 실패 시 사용자 매칭 단계로 가지 않는다
    expect(auditRecordMock).toHaveBeenCalledWith(ENV.DB, expect.objectContaining({
      actorUserId: 'system', action: 'auth.google',
      metadata: expect.objectContaining({ op: 'denied', reason: 'email_unverified' })
    }))
    // M2 회귀(라우트 레벨) — 클레임 검증 실패는 claim() 이후(이 요청이 소유한 authorized 행)이므로
    // markFailedOwned만 호출해야 한다.
    expect(flowMarkFailedOwnedMock).toHaveBeenCalledWith(ENV.DB, 'state-1')
    expect(flowMarkFailedIfPendingMock).not.toHaveBeenCalled()
  })

  // M3 회귀(라우트 레벨) — 구조적 검증 실패(reason==='upstream')는 사용자 응답을 그대로 upstream으로
  // 접되, nonce_mismatch·aud_mismatch는 내부 감사기록(reason에 detail 값)으로 되살아나야 한다.
  it('id_token nonce 불일치(reason=upstream, detail=nonce_mismatch) → 응답은 upstream이지만 감사기록은 남는다', async () => {
    verifyIdTokenClaimsMock.mockReturnValue({
      ok: false, reason: 'upstream', detail: 'nonce_mismatch', claims: { email: 'employee@malgnsoft.com' }
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await callbackRequest()

    expect(res.headers.get('location')).toBe('/login#ge=upstream') // 사용자 노출은 여전히 upstream(열거 방지)
    expect(auditRecordMock).toHaveBeenCalledWith(ENV.DB, expect.objectContaining({
      metadata: expect.objectContaining({ reason: 'nonce_mismatch' })
    }))
    expect(warnSpy).toHaveBeenCalledWith('[auth-google] id_token claim rejected', 'nonce_mismatch', 'mode=', 'interactive')
    warnSpy.mockRestore()
  })

  it('id_token 구조검증 실패 중 nonce/aud 외(예: exp_expired)는 감사기록을 남기지 않는다(로그만)', async () => {
    verifyIdTokenClaimsMock.mockReturnValue({
      ok: false, reason: 'upstream', detail: 'exp_expired', claims: { email: 'employee@malgnsoft.com' }
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await callbackRequest()

    expect(res.headers.get('location')).toBe('/login#ge=upstream')
    expect(auditRecordMock).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  // (b) hd 클레임 불일치 거부
  it('hd 클레임 불일치 → hd_mismatch 거부 + 감사기록', async () => {
    verifyIdTokenClaimsMock.mockReturnValue({ ok: false, reason: 'hd_mismatch', claims: { email: 'someone@gmail.com', hd: undefined } })
    const res = await callbackRequest()

    expect(res.headers.get('location')).toBe('/login#ge=hd_mismatch')
    expect(auditRecordMock).toHaveBeenCalledWith(ENV.DB, expect.objectContaining({
      metadata: expect.objectContaining({ reason: 'hd_mismatch', email_domain: 'gmail.com' })
    }))
  })

  // m-2 회귀 — /start~/callback 사이(최대 10분)에 배포로 도메인 통제선 env가 사라지면
  // checkDomainControl()이 fail-closed로 not_configured를 반환한다(M1 처방). 이 실패는 사용자의
  // 이상 행동이 아니라 env 오설정이므로 감사기록을 남기지 않는다(env 오설정 배포 창의 로그 잡음
  // 방지) — 이전에는 else 분기로 빠져 recordDenied가 호출됐다.
  it('id_token 클레임 검증 시점에 도메인 통제선이 not_configured면 감사기록 없이 거부만 한다', async () => {
    verifyIdTokenClaimsMock.mockReturnValue({ ok: false, reason: 'not_configured', claims: { email: 'employee@malgnsoft.com' } })
    const res = await callbackRequest()

    expect(res.headers.get('location')).toBe('/login#ge=not_configured')
    expect(auditRecordMock).not.toHaveBeenCalled()
  })

  // (c) hub에 없는 이메일 거부(자동생성 안 함)
  it('id_token 검증은 통과했지만 hub에 계정이 없으면 not_provisioned + 감사기록, 신규 계정 생성 없음', async () => {
    verifyIdTokenClaimsMock.mockReturnValue({ ok: true, claims: { email: 'nobody@malgnsoft.com', sub: 'sub-x', email_verified: true, hd: 'malgnsoft.com' } })
    usersFindByEmailMock.mockResolvedValue(null)
    const res = await callbackRequest()

    expect(res.headers.get('location')).toBe('/login#ge=not_provisioned')
    expect(auditRecordMock).toHaveBeenCalledWith(ENV.DB, expect.objectContaining({
      actorUserId: 'system',
      // L3 처방 — 원문 이메일은 넣지 않되(email_domain만) 동일인 반복 시도를 묶어볼 수 있도록
      // sha256 앞 16자 해시를 추가로 남긴다.
      metadata: expect.objectContaining({
        reason: 'not_provisioned', email_domain: 'malgnsoft.com', email_local_hash: expect.stringMatching(/^[0-9a-f]{16}$/)
      })
    }))
    expect(usersLinkGoogleSubMock).not.toHaveBeenCalled()
    expect(flowSetHandoffMock).not.toHaveBeenCalled()
  })

  // (d) users.status='disabled' 거부
  it('매칭된 계정이 disabled면 user_disabled 거부 + 감사기록(actor=해당 사용자)', async () => {
    verifyIdTokenClaimsMock.mockReturnValue({ ok: true, claims: { email: 'employee@malgnsoft.com', sub: 'sub-x', email_verified: true, hd: 'malgnsoft.com' } })
    usersFindByEmailMock.mockResolvedValue(activeUser({ status: 'disabled' }))
    const res = await callbackRequest()

    expect(res.headers.get('location')).toBe('/login#ge=user_disabled')
    expect(auditRecordMock).toHaveBeenCalledWith(ENV.DB, expect.objectContaining({
      actorUserId: 'user-1', targetType: 'user', targetId: 'user-1',
      metadata: expect.objectContaining({ reason: 'user_disabled' })
    }))
    expect(flowSetHandoffMock).not.toHaveBeenCalled()
  })

  it('google_sub가 이미 다른 값으로 연결돼 있으면 sub_mismatch 거부', async () => {
    verifyIdTokenClaimsMock.mockReturnValue({ ok: true, claims: { email: 'employee@malgnsoft.com', sub: 'new-sub', email_verified: true, hd: 'malgnsoft.com' } })
    usersFindByEmailMock.mockResolvedValue(activeUser({ google_sub: 'old-sub' }))
    const res = await callbackRequest()

    expect(res.headers.get('location')).toBe('/login#ge=sub_mismatch')
    expect(usersLinkGoogleSubMock).not.toHaveBeenCalled() // 이미 연결된 값이 다르면 CAS 시도 자체를 하지 않는다
  })

  it('google_sub UNIQUE 제약 위반(다른 사용자가 이미 그 sub 보유) → sub_conflict 거부', async () => {
    verifyIdTokenClaimsMock.mockReturnValue({ ok: true, claims: { email: 'employee@malgnsoft.com', sub: 'taken-sub', email_verified: true, hd: 'malgnsoft.com' } })
    usersFindByEmailMock.mockResolvedValue(activeUser())
    usersLinkGoogleSubMock.mockRejectedValue(new Error('UNIQUE constraint failed: users.google_sub: SQLITE_CONSTRAINT'))
    const res = await callbackRequest()

    expect(res.headers.get('location')).toBe('/login#ge=sub_conflict')
  })

  it('전체 성공 경로 — TOFU 링크 + 핸드오프 발급 + 두 쿠키 만료 + #gh= 리디렉트 + linked 감사기록', async () => {
    verifyIdTokenClaimsMock.mockReturnValue({ ok: true, claims: { email: 'employee@malgnsoft.com', sub: 'new-sub', email_verified: true, hd: 'malgnsoft.com' } })
    usersFindByEmailMock.mockResolvedValue(activeUser())
    usersLinkGoogleSubMock.mockResolvedValue(true)

    const res = await callbackRequest()

    const location = res.headers.get('location')
    expect(location.startsWith('/login#gh=')).toBe(true)
    expect(flowSetHandoffMock).toHaveBeenCalledWith(ENV.DB, 'state-1', expect.objectContaining({ userId: 'user-1' }))
    expect(auditRecordMock).toHaveBeenCalledWith(ENV.DB, expect.objectContaining({
      actorUserId: 'user-1', metadata: expect.objectContaining({ op: 'linked' })
    }))
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]
    expect(setCookies.some((v) => v.startsWith('mh_gflow=;'))).toBe(true)
    expect(setCookies.some((v) => v.startsWith('mh_gsilent_try=;'))).toBe(true)
  })

  // M4 회귀 — https 요청에서는 __Host- 쿠키로 성공 경로가 끝까지 동작하고, 삭제(만료)도 같은
  // 이름·Path=/로 이뤄진다(발급과 삭제가 다른 이름/경로를 쓰면 브라우저에 쿠키가 남는다).
  it('M4 — https 성공 경로에서는 __Host-mh_gflow로 검증되고 같은 이름·Path=/로 만료된다', async () => {
    verifyIdTokenClaimsMock.mockReturnValue({ ok: true, claims: { email: 'employee@malgnsoft.com', sub: 'new-sub', email_verified: true, hd: 'malgnsoft.com' } })
    usersFindByEmailMock.mockResolvedValue(activeUser())
    usersLinkGoogleSubMock.mockResolvedValue(true)

    const app = new Hono()
    app.route('/api/auth/google', authGoogle)
    const res = await app.request('https://malgnai-hub.apiserver.kr/api/auth/google/callback?code=auth-code&state=state-1', {
      headers: { cookie: '__Host-mh_gflow=BOUND_SECRET' }
    }, ENV_HTTPS)

    expect(res.headers.get('location').startsWith('/login#gh=')).toBe(true)
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]
    expect(setCookies.some((v) => v.startsWith('__Host-mh_gflow=;') && v.includes('Path=/'))).toBe(true)
    // m-3 회귀 — 무음 억제 쿠키도 같은 이름(__Host-mh_gsilent_try)·Path=/로 만료돼야 실제로 지워진다.
    expect(setCookies.some((v) => v.startsWith('__Host-mh_gsilent_try=;') && v.includes('Path=/'))).toBe(true)
  })

  it('이미 같은 sub로 연결된 재로그인은 linked 감사기록을 남기지 않는다(최초 1회만)', async () => {
    verifyIdTokenClaimsMock.mockReturnValue({ ok: true, claims: { email: 'employee@malgnsoft.com', sub: 'existing-sub', email_verified: true, hd: 'malgnsoft.com' } })
    usersFindByEmailMock.mockResolvedValue(activeUser({ google_sub: 'existing-sub' }))

    const res = await callbackRequest()

    expect(res.headers.get('location').startsWith('/login#gh=')).toBe(true)
    expect(usersLinkGoogleSubMock).not.toHaveBeenCalled()
    expect(auditRecordMock).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // 레이트리밋(H1 처방 + review M-C/M-E 회귀) — GOOGLE_LOGIN_RL 바인딩
  // ---------------------------------------------------------------------------
  describe('레이트리밋(GOOGLE_LOGIN_RL) — M-C/M-E 회귀', () => {
    // code 파라미터를 일부러 빼서(state만 유지) 레이트리밋 통과 이후 findByState까지는 가되
    // fail('upstream')로 즉시 안전 종료시킨다 — 토큰교환·클레임검증까지 가면 이 테스트의 관심사(레
    // 이트리밋 게이트 통과 여부)와 무관한 mock 설정이 추가로 필요해진다.
    it('바인딩이 없으면(로컬/미배포) 통과해 정상적으로 findByState까지 진행한다(fail-open, H1 처방)', async () => {
      await callbackRequest({ query: 'state=state-1' }) // ENV에는 GOOGLE_LOGIN_RL이 없다
      expect(flowFindByStateMock).toHaveBeenCalledWith(ENV.DB, 'state-1')
    })

    it('바인딩이 있고 한도 초과(success:false)면 findByState 조회 전에 upstream으로 거부한다', async () => {
      const app = new Hono()
      app.route('/api/auth/google', authGoogle)
      const rl = { limit: vi.fn().mockResolvedValue({ success: false }) }
      const res = await app.request('/api/auth/google/callback?code=auth-code&state=state-1', {
        headers: { cookie: 'mh_gflow=BOUND_SECRET' }
      }, { ...ENV, GOOGLE_LOGIN_RL: rl })

      expect(res.headers.get('location')).toBe('/login#ge=upstream')
      expect(flowFindByStateMock).not.toHaveBeenCalled()
    })

    it('limit() 예외 시 통과(fail-open) + console.error 1회 후 findByState까지 진행한다', async () => {
      const app = new Hono()
      app.route('/api/auth/google', authGoogle)
      const rl = { limit: vi.fn().mockRejectedValue(new Error('rl boom')) }
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await app.request('/api/auth/google/callback?state=state-1', {
        headers: { cookie: 'mh_gflow=BOUND_SECRET' }
      }, { ...ENV, GOOGLE_LOGIN_RL: rl })

      expect(flowFindByStateMock).toHaveBeenCalledWith(ENV.DB, 'state-1')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0]).toBe('[auth-google] rate limit check failed, allowing request')
      spy.mockRestore()
    })

    // M-E 회귀 — /callback은 /start와 별도 버킷(키 접미사 :callback)을 쓴다. code를 빼서(위 두
    // 테스트와 동일 이유) 레이트리밋 게이트 통과만 확인하고 즉시 안전 종료시킨다.
    it('M-E — 레이트리밋 키에 :callback 접미사가 붙어 /start와 버킷이 분리된다', async () => {
      const app = new Hono()
      app.route('/api/auth/google', authGoogle)
      const rl = { limit: vi.fn().mockResolvedValue({ success: true }) }
      await app.request('/api/auth/google/callback?state=state-1', {
        headers: { cookie: 'mh_gflow=BOUND_SECRET', 'cf-connecting-ip': '10.0.0.1' }
      }, { ...ENV, GOOGLE_LOGIN_RL: rl })

      expect(rl.limit).toHaveBeenCalledWith({ key: '10.0.0.1:callback' })
    })
  })
})

// ---------------------------------------------------------------------------
// POST /exchange
// ---------------------------------------------------------------------------
describe('POST /api/auth/google/exchange', () => {
  const VALID_CODE = 'a'.repeat(43)

  function exchangeRequest(body) {
    const app = makeApp()
    return app.request('/api/auth/google/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    }, ENV)
  }

  it('handoff_code 형식 위반은 400 VALIDATION_ERROR', async () => {
    const res = await exchangeRequest({ handoff_code: 'too-short' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('행이 없거나 만료/이미 소비됨 → 401 INVALID_HANDOFF', async () => {
    flowFindByHandoffHashMock.mockResolvedValue(null)
    const res = await exchangeRequest({ handoff_code: VALID_CODE })
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('INVALID_HANDOFF')
    expect(issueWebTokenPairMock).not.toHaveBeenCalled()
  })

  it('사전 확인은 통과했지만 consumeHandoff 커밋이 레이스로 실패(changes=0) → 401 INVALID_HANDOFF', async () => {
    flowFindByHandoffHashMock.mockResolvedValue({
      status: 'authorized', handoff_expires_at: new Date(Date.now() + 30_000).toISOString(), user_id: 'user-1', redirect_path: '/usage'
    })
    flowConsumeHandoffMock.mockResolvedValue(false)
    const res = await exchangeRequest({ handoff_code: VALID_CODE })
    expect(res.status).toBe(401)
    expect(issueWebTokenPairMock).not.toHaveBeenCalled()
  })

  it('연결된 사용자 행이 사라졌으면 404 NOT_FOUND', async () => {
    flowFindByHandoffHashMock.mockResolvedValue({
      status: 'authorized', handoff_expires_at: new Date(Date.now() + 30_000).toISOString(), user_id: 'user-1', redirect_path: '/usage'
    })
    flowConsumeHandoffMock.mockResolvedValue(true)
    usersFindByIdMock.mockResolvedValue(null)
    const res = await exchangeRequest({ handoff_code: VALID_CODE })
    expect(res.status).toBe(404)
  })

  // 결정 8-2 — 콜백과 교환 사이에 관리자가 비활성화했을 수 있어 교환 시점에 재확인한다.
  it('교환 시점에 계정이 비활성화돼 있으면 401 UNAUTHORIZED(콜백 통과 이후에도 재확인)', async () => {
    flowFindByHandoffHashMock.mockResolvedValue({
      status: 'authorized', handoff_expires_at: new Date(Date.now() + 30_000).toISOString(), user_id: 'user-1', redirect_path: '/usage'
    })
    flowConsumeHandoffMock.mockResolvedValue(true)
    usersFindByIdMock.mockResolvedValue(activeUser({ status: 'disabled' }))
    const res = await exchangeRequest({ handoff_code: VALID_CODE })
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('UNAUTHORIZED')
    expect(issueWebTokenPairMock).not.toHaveBeenCalled()
  })

  it('정상 교환 — POST /api/auth/login과 동일 스키마 + redirect_path, issueWebTokenPair(자체인증과 동일 함수) 호출', async () => {
    flowFindByHandoffHashMock.mockResolvedValue({
      status: 'authorized', handoff_expires_at: new Date(Date.now() + 30_000).toISOString(), user_id: 'user-1', redirect_path: '/usage'
    })
    flowConsumeHandoffMock.mockResolvedValue(true)
    usersFindByIdMock.mockResolvedValue(activeUser({ must_change_password: true }))

    const res = await exchangeRequest({ handoff_code: VALID_CODE })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({
      token: 'jwt-token', expires_in: 14400, refresh_token: 'refresh-token', refresh_expires_in: 2592000,
      must_change_password: true, redirect_path: '/usage'
    })
    expect(issueWebTokenPairMock).toHaveBeenCalledWith(ENV, expect.objectContaining({ id: 'user-1' }))
  })

  it('redirect_path가 없는 플로우는 "/"로 기본값 처리', async () => {
    flowFindByHandoffHashMock.mockResolvedValue({
      status: 'authorized', handoff_expires_at: new Date(Date.now() + 30_000).toISOString(), user_id: 'user-1', redirect_path: null
    })
    flowConsumeHandoffMock.mockResolvedValue(true)
    usersFindByIdMock.mockResolvedValue(activeUser())

    const res = await exchangeRequest({ handoff_code: VALID_CODE })
    expect((await res.json()).redirect_path).toBe('/')
  })

  // m-4 회귀 — /exchange도 다른 두 라우트와 동일하게 레이트리밋을 받는다.
  describe('레이트리밋(GOOGLE_LOGIN_RL) — m-4 회귀', () => {
    it('바인딩이 있고 한도 초과(success:false)면 D1 조회 전에 401 INVALID_HANDOFF(열거 방지, 형식 동일)', async () => {
      const app = new Hono()
      app.route('/api/auth/google', authGoogle)
      const rl = { limit: vi.fn().mockResolvedValue({ success: false }) }
      const res = await app.request('/api/auth/google/exchange', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handoff_code: VALID_CODE })
      }, { ...ENV, GOOGLE_LOGIN_RL: rl })

      expect(res.status).toBe(401)
      expect((await res.json()).error.code).toBe('INVALID_HANDOFF')
      expect(flowFindByHandoffHashMock).not.toHaveBeenCalled()
    })

    it('바인딩이 없으면(fail-open) 정상적으로 D1 조회까지 진행한다', async () => {
      flowFindByHandoffHashMock.mockResolvedValue(null)
      await exchangeRequest({ handoff_code: VALID_CODE })
      expect(flowFindByHandoffHashMock).toHaveBeenCalled()
    })

    it('레이트리밋 키에 :exchange 접미사가 붙어 /start·/callback과 버킷이 분리된다', async () => {
      const app = new Hono()
      app.route('/api/auth/google', authGoogle)
      const rl = { limit: vi.fn().mockResolvedValue({ success: true }) }
      flowFindByHandoffHashMock.mockResolvedValue(null)
      await app.request('/api/auth/google/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1' },
        body: JSON.stringify({ handoff_code: VALID_CODE })
      }, { ...ENV, GOOGLE_LOGIN_RL: rl })

      expect(rl.limit).toHaveBeenCalledWith({ key: '10.0.0.1:exchange' })
    })
  })
})
