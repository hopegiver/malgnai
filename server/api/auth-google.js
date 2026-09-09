// Google 로그인(우리가 Google의 **클라이언트**인 축) — /api/auth/google/*. 설계 정본:
// docs/design/google-oauth-login.md. 전부 무인증(PUBLIC_PATHS, server/middleware/jwt-auth.js).
//
// ⚠️ server/api/oauth.js(우리가 **제공자**인 축 — MCP 클라이언트 대상)와 이름·로직을 절대 섞지
// 않는다(§0.2 규약). 발급되는 JWT/refresh token은 server/lib/session-tokens.js를 통해 자체인증
// (server/api/auth.js)과 100% 동일하다(결정 5).
import { Hono } from 'hono'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'
import * as usersDao from '../dao/users.js'
import * as auditLogsDao from '../dao/audit-logs.js'
import * as googleLoginFlowsDao from '../dao/google-login-flows.js'
import { generateOpaqueToken, sha256Hex } from '../lib/tokens.js'
import { issueWebTokenPair } from '../lib/session-tokens.js'
import {
  isGoogleConfigured, isOriginAllowed, buildAuthorizationUrl, computeCodeChallengeS256,
  exchangeCodeForToken, verifyIdTokenClaims,
  FLOW_TTL_SECONDS, HANDOFF_TTL_SECONDS, SILENT_SUPPRESS_COOKIE_TTL_SECONDS
} from '../lib/google-oidc.js'

const FLOW_COOKIE_PATH = '/api/auth/google'
// 보안점검 M4 처방(권장안 채택 — 근거는 이 파일 하단 flowBindingCookieName() 주석 참고).
// __Host- 접두사는 Secure + Path=/ + Domain 속성 금지를 브라우저가 강제하므로, 형제 서브도메인이
// `Domain=apiserver.kr`로 동명 쿠키를 심는 cookie tossing이 원천 차단된다. __Host-는 Secure를
// 요구해 http에서는 쓸 수 없으므로 로컬 dev(http) 전용 폴백 이름을 별도로 둔다.
const FLOW_BINDING_COOKIE_SECURE = '__Host-mh_gflow'
const FLOW_BINDING_COOKIE_INSECURE = 'mh_gflow'
// review m-3 — 무음 억제 쿠키도 같은 cookie-tossing 위협에 노출된다(형제 서브도메인이
// `Domain=apiserver.kr; mh_gsilent_try=1`을 심으면 무음 재로그인을 영구 억제할 수 있다). M4와 동일한
// __Host- 하드닝을 적용한다 — 이름 선택은 아래 silentSuppressCookieName()으로 일원화한다.
const SILENT_SUPPRESS_COOKIE_SECURE = '__Host-mh_gsilent_try'
const SILENT_SUPPRESS_COOKIE_INSECURE = 'mh_gsilent_try'
const REDIRECT_PATH_MAX_LENGTH = 512
const HANDOFF_CODE_RE = /^[A-Za-z0-9_-]{43}$/

const authGoogle = new Hono()

// D1 UNIQUE 위반 메시지 판별(admin-users.js:34와 동일 방식 — 별도 에러 클래스가 없어 메시지 문자열로
// 판별한다). idx_users_google_sub(부분 UNIQUE, migrations/0025) 위반 시 sub_conflict로 매핑한다.
function isUniqueConstraintError(err) {
  return !!err && typeof err.message === 'string' && err.message.includes('UNIQUE constraint failed')
}

// 보안점검 L1 처방 — 기존 검사(선행슬래시·//시작)는 스킴 상대 URL(//evil.com)과 절대 URL만
// 막았고, 역슬래시(`/\evil.com` — URL 파서가 `\`를 `/`로 정규화해 특수 스킴에서 실질적으로
// `evil.com`을 오리진으로 만들 수 있다)와 `..` 점세그먼트는 그대로 통과시켰다(실측:
// repro-redirect.mjs). 검증은 서버에서 끝내고, 프런트(app/pages/login.vue)의 startsWith('/')
// 체크는 심층방어로 남겨둔다.
function sanitizeRedirectPath(raw) {
  if (typeof raw !== 'string') return '/'
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/'
  if (raw.includes('\\') || raw.includes('..')) return '/'
  if (raw.length > REDIRECT_PATH_MAX_LENGTH) return '/'
  return raw
}

function isSecureRequest(c) {
  return new URL(c.req.url).protocol === 'https:'
}

/** M4 — https(프로덕션)에서는 __Host- 접두사 쿠키(Path=/ 강제)를, http(로컬 dev)에서는 기존
 *  이름·경로를 쓴다. /start(발급)·/callback(조회·삭제) 양쪽이 반드시 이 함수 하나로 이름을
 *  결정해야 한다 — 발급과 조회가 다른 이름을 쓰면 항상 flow_binding_failed가 난다. */
function flowBindingCookieName(c) {
  return isSecureRequest(c) ? FLOW_BINDING_COOKIE_SECURE : FLOW_BINDING_COOKIE_INSECURE
}

/** review m-3 — flowBindingCookieName()과 동일 판단(isSecureRequest)으로 무음 억제 쿠키 이름을
 *  고른다. 발급(/start)·조회(/start)·삭제(/callback 성공 경로) 모두 이 함수 하나로 통일해야 한다. */
function silentSuppressCookieName(c) {
  return isSecureRequest(c) ? SILENT_SUPPRESS_COOKIE_SECURE : SILENT_SUPPRESS_COOKIE_INSECURE
}

/** __Host- 쿠키는 Path=/ 없이는 브라우저가 Set-Cookie 자체를 거부한다 — cookieOpts()가 정하는
 *  path와 이 함수가 정하는 path는 항상 같은 판단(isSecureRequest)에서 나와야 한다(삭제 시에도 동일
 *  Path를 써야 실제로 지워진다). */
function flowCookiePath(c) {
  return isSecureRequest(c) ? '/' : FLOW_COOKIE_PATH
}

function cookieOpts(c, { maxAge }) {
  const secure = isSecureRequest(c)
  return { httpOnly: true, secure, sameSite: 'Lax', path: flowCookiePath(c), maxAge }
}

/** deleteCookie()에 넘길 옵션 — __Host- 접두사 쿠키는 Set-Cookie(만료값)에도 Secure 속성이
 *  없으면 hono/cookie가 예외를 던진다(브라우저 규격 그대로). 발급 때 쓴 cookieOpts()와 동일하게
 *  secure·path를 맞춰야 실제로 삭제(덮어쓰기)된다. */
function deleteFlowCookieOpts(c) {
  return { path: flowCookiePath(c), secure: isSecureRequest(c) }
}

// 보안점검 H1 처방(3) — Cloudflare Rate Limiting 바인딩(GOOGLE_LOGIN_RL, wrangler.jsonc
// ratelimits). 바인딩이 없는 환경(로컬 dev, 그리고 아직 배포되지 않은 프로덕션)에서는 통과시킨다
// (fail-open 가드) — 그래서 배포 체크리스트로 프로덕션에 이 바인딩이 실제로 붙어 있는지 반드시
// 확인해야 한다. 사유는 세분화하지 않고 upstream으로 접는다(열거 방지 — 정상 실패와 구분 불가능해야
// 한다).
//
// review M-E — 이전에는 /start·/callback이 `cf-connecting-ip` 하나만 키로 써서 같은 버킷을
// 공유했다. 로그인 1회가 /start+/callback 2요청을 쓰므로, 사무실 공용 NAT(IP 1개) 뒤에서는 분당
// 로그인 가능 횟수가 20/2=10회로 반토막났다(review 실측: "사무실 전체 분당 10회"). scope
// 파라미터('start'|'callback')를 키에 접미사로 더해 두 엔드포인트를 **별도 버킷**으로 분리한다 —
// 로그인 1회는 각 버킷에서 1건씩만 소비하므로 사무실 전체가 분당 최대 20회(엔드포인트별 한도
// 그대로)까지 로그인할 수 있게 된다. 숫자(20/60)는 올리지 않았다 — H1이 막으려던 것은
// "무인증 D1 쓰기 증폭"(자동화된 대량 /start 호출로 google_login_flows 행을 채우는 공격)이고, 그
// 방어력은 엔드포인트 단위 한도 자체(20/60)에 있다. 숫자를 함께 올리면(예: 60/60) 그 방어력이
// 3배 헐거워지므로, 이번 수정은 "부당하게 공유되던 버킷을 분리"하는 것으로 한정한다 — 실제
// 프로덕션 트래픽 없이는 어느 숫자가 맞는지 검증할 수 없다(review M-E 미확인 표기와 동일 사유).
async function checkRateLimit(c, scope) {
  const rl = c.env.GOOGLE_LOGIN_RL
  if (!rl) return true
  const ip = c.req.header('cf-connecting-ip') || 'unknown'
  const key = `${ip}:${scope}`
  try {
    const { success } = await rl.limit({ key })
    return success
  } catch (err) {
    // 레이트리밋 바인딩 자체 오류로 로그인이 전면 막히면 안 된다 — 관측만 하고 통과시킨다.
    console.error('[auth-google] rate limit check failed, allowing request', err)
    return true
  }
}

/** 302 /login#gh=... 또는 #ge=<code>[&gs=1]. 브라우저 top-level 이동이므로 JSON이 아니라 항상 리디렉트(§3.1~3.2). */
function redirectToLogin(c, { gh, ge, gs } = {}) {
  const hash = gh ? `gh=${encodeURIComponent(gh)}` : `ge=${encodeURIComponent(ge)}${gs ? '&gs=1' : ''}`
  return c.redirect(`/login#${hash}`, 302)
}

function emailDomain(email) {
  if (typeof email !== 'string') return null
  const at = email.indexOf('@')
  return at > -1 ? email.slice(at + 1).toLowerCase() : null
}

// 보안점검 L3 처방 — 이 3종은 actorUserId가 'system'(sub_mismatch/sub_conflict는 userId가 있지만
// L3 처방 문구가 "3종에 한해"라 명시했으므로 동일하게 취급)이라 email_domain만으로는 "누가"
// 시도했는지 특정할 수 없다. 이미 회사 도메인 Google 인증을 통과한 사용자만 도달하는 지점이라
// 익명 열거 표면이 아니므로, 원문 이메일 대신 해시(sha256 앞 16자, 64비트)만 남겨 동일인 반복
// 시도를 묶어볼 수 있게 한다.
const EMAIL_HASH_REASONS = new Set(['not_provisioned', 'sub_mismatch', 'sub_conflict'])

/** 사용자가 식별된 거부만 감사기록한다(§5.2 — Google 단계에서 끝난 무음 시도는 기록하지 않음). */
async function recordDenied(db, { reason, mode, email, userId }) {
  const metadata = { op: 'denied', reason, mode, email_domain: emailDomain(email) }
  if (EMAIL_HASH_REASONS.has(reason) && typeof email === 'string' && email) {
    metadata.email_local_hash = (await sha256Hex(email)).slice(0, 16)
  }
  await auditLogsDao.record(db, {
    actorUserId: userId || 'system',
    action: 'auth.google',
    targetType: userId ? 'user' : null,
    targetId: userId || null,
    metadata
  })
}

async function recordLinked(db, { userId, mode }) {
  await auditLogsDao.record(db, {
    actorUserId: userId, action: 'auth.google', targetType: 'user', targetId: userId,
    metadata: { op: 'linked', mode }
  })
}

/** 결정 1 — C5(google_sub TOFU/일치) 판정. 성공 시 { ok:true, linked }, 실패 시 { ok:false, reason }. */
async function linkOrVerifyGoogleSub(db, user, sub) {
  if (user.google_sub) {
    return user.google_sub === sub ? { ok: true, linked: false } : { ok: false, reason: 'sub_mismatch' }
  }
  try {
    const changed = await usersDao.linkGoogleSub(db, user.id, sub)
    if (changed) return { ok: true, linked: true }
    // CAS 레이스(6.6 동시 로그인) — 재조회해 재평가.
    const refreshed = await usersDao.findById(db, user.id)
    if (refreshed && refreshed.google_sub === sub) return { ok: true, linked: false }
    return { ok: false, reason: 'sub_mismatch' }
  } catch (err) {
    if (isUniqueConstraintError(err)) return { ok: false, reason: 'sub_conflict' }
    throw err
  }
}

// ---------------------------------------------------------------------------
// GET /start — 인가 개시(브라우저 top-level 이동). §2 흐름도 ⓪~③, §3.1.
// ---------------------------------------------------------------------------
authGoogle.get('/start', async (c) => {
  const url = new URL(c.req.url)
  const silentRequested = url.searchParams.get('silent') === '1'
  const redirectPath = sanitizeRedirectPath(url.searchParams.get('redirect'))

  // H1 처방(3) — 무인증 D1 쓰기(아래 insert())보다 먼저, 다른 어떤 처리보다도 먼저 검사한다.
  // silentRequested 파싱은 이 요청 자신의 쿼리 문자열을 읽을 뿐 D1을 건드리지 않으므로, 이 순서
  // 보장을 깨지 않는다. review M-D 처방 — 레이트리밋에 막힌 무음(prompt=none) 왕복은 사용자가
  // 시작하지도 않은 시도이므로 gs를 실어 보내 "조용한 폴백"(설계 §3.1)으로 처리되게 한다.
  // login.vue의 SILENT_QUIET 집합에는 이미 'upstream'이 포함돼 있어(app/ 수정 없이) 서버가 gs=1만
  // 실으면 배너가 뜨지 않는다. silentRequested는 이 요청 자신의 쿼리이므로 위조해도 공격자가 얻는
  // 것이 없다(무음으로 위조하면 위조한 요청 자신의 배너만 안 뜬다).
  if (!(await checkRateLimit(c, 'start'))) {
    return redirectToLogin(c, { ge: 'upstream', gs: silentRequested })
  }

  // ⓪ silent=1인데 120초 내 무음 시도 억제 쿠키가 이미 있으면 Google로 나가지 않는다(결정 6 루프 차단기).
  if (silentRequested && getCookie(c, silentSuppressCookieName(c))) {
    return redirectToLogin(c, { ge: 'silent_suppressed' })
  }

  // ① env 확인 — client_id/secret/redirect_uri + 도메인 통제선 1개 이상. 없으면 fail-closed(결정 9).
  if (!isGoogleConfigured(c.env)) {
    return redirectToLogin(c, { ge: 'not_configured' })
  }

  // ② 요청 origin이 등록된 GOOGLE_REDIRECT_URI의 origin과 다르면 Google로 나가지 않는다(결정 7).
  if (!isOriginAllowed(c.env, c.req.url)) {
    return redirectToLogin(c, { ge: 'origin_not_allowed' })
  }

  // ③ state/nonce/verifier/binding/mode 생성 → google_login_flows INSERT(pending, 10분)
  const state = generateOpaqueToken()
  const nonce = generateOpaqueToken()
  const codeVerifier = generateOpaqueToken()
  const codeChallenge = await computeCodeChallengeS256(codeVerifier)
  const bindingSecret = generateOpaqueToken()
  const bindingHash = await sha256Hex(bindingSecret)
  const mode = silentRequested ? 'silent' : 'interactive'
  const expiresAt = new Date(Date.now() + FLOW_TTL_SECONDS * 1000).toISOString()

  await googleLoginFlowsDao.insert(c.env.DB, { state, bindingHash, nonce, codeVerifier, redirectPath, mode, expiresAt })

  setCookie(c, flowBindingCookieName(c), bindingSecret, cookieOpts(c, { maxAge: FLOW_TTL_SECONDS }))
  if (silentRequested) {
    setCookie(c, silentSuppressCookieName(c), '1', cookieOpts(c, { maxAge: SILENT_SUPPRESS_COOKIE_TTL_SECONDS }))
  }

  const authUrl = buildAuthorizationUrl(c.env, { state, nonce, codeChallenge, mode })
  return c.redirect(authUrl, 302)
})

// ---------------------------------------------------------------------------
// GET /callback — Google이 리디렉트하는 지점. §2 흐름도 ④~⑩, §3.2 검증 순서 1~8.
// ---------------------------------------------------------------------------
authGoogle.get('/callback', async (c) => {
  // H1 처방(3) — findByState 읽기·markFailed 쓰기·로그 증폭 어느 것보다도 먼저 검사한다.
  if (!(await checkRateLimit(c, 'callback'))) {
    return redirectToLogin(c, { ge: 'upstream' })
  }

  // M1 처방(2) — /start에서 isGoogleConfigured()를 확인했더라도, claim() 전까지 최대
  // FLOW_TTL_SECONDS(10분)의 창에서 배포로 env가 바뀔 수 있다(도메인 통제선 전환 배포 등).
  // checkDomainControl() 자체도 fail-closed로 고쳤지만(M1 처방(1), google-oidc.js), 여기서도
  // 가능한 한 이른 시점에 재확인해 상태 조회·로그 증폭까지 가지 않게 한다.
  if (!isGoogleConfigured(c.env)) {
    return redirectToLogin(c, { ge: 'not_configured' })
  }

  const url = new URL(c.req.url)
  const code = url.searchParams.get('code')
  const stateParam = url.searchParams.get('state')
  const errorParam = url.searchParams.get('error')

  // 1) state 형식 + 행 조회 → 먼저 row.mode를 읽는다(이후 에러 표시·감사 여부가 이 값에 따라 갈린다).
  //    행 자체가 없으면 무음 여부를 알 수 없으므로 인터랙티브로 간주한다(§3.2 순서1) — gs는 세우지 않는다.
  const row = stateParam ? await googleLoginFlowsDao.findByState(c.env.DB, stateParam) : null
  const mode = row ? row.mode : 'interactive'
  const gs = !!(row && row.mode === 'silent')

  // fail(): 실패 응답 공통 처리 — 바인딩 쿠키 삭제(무음 억제 쿠키는 남긴다, 결정6) + 리디렉트.
  // 보안점검 M2 처방(마킹 함수 분리) 위에 review M-G 처방을 더한다 — claim() **이전**(에러
  // 파라미터·코드 부재·바인딩 쿠키 불일치)에는 이 요청이 그 행의 소유권을 **증명하지 못했으므로**
  // (바인딩 쿠키 불일치는 오히려 반증됐으므로) 행 상태를 아예 쓰지 않는다. 이전에는 'pending'
  // 조건부라도 markFailedIfPending을 호출해 'pending'인 행을 'failed'로 죽였는데, 그 창이 피해자가
  // Google 동의화면에 머무는 전체 시간(수 초~수십 초)이라 공격자가 state 값 하나만 알아도
  // `?state=S&error=x` 한 번으로 진행 중인 남의 로그인을 무력화할 수 있었다(review M-G 실증
  // 타임라인). 실패 행은 10분 TTL + 크론 스윕(§6.9)이 어차피 정리하므로 'failed' 마킹의 운영적
  // 가치는 애초에 낮다 — "소유권 없는 요청은 아무것도 쓰지 않는다"는 DAO 주석의 불변식과도 이제
  // 일치한다. markFailedIfPending 자체는 DAO에 남겨두되(테스트: google-login-flows.test.js) 이
  // 파일에서는 더 이상 호출하지 않는다.
  // 'post': claim() **이후** 실패(토큰교환·클레임검증·사용자매칭 등) — 이 요청이 claim()으로 얻은
  //        'authorized' 행이 확실하므로 그 상태를 조건으로 실패 처리한다.
  // false(기본값)/claim() 자체의 CAS 실패: 이 요청은 애초에 그 행의 소유권을 얻지 못했으므로 아무
  //        것도 쓰지 않는다(DAO 주석 참고).
  async function fail(reason, { owned = false } = {}) {
    if (owned === 'post' && row) {
      await googleLoginFlowsDao.markFailedOwned(c.env.DB, row.state)
    }
    deleteCookie(c, flowBindingCookieName(c), deleteFlowCookieOpts(c))
    return redirectToLogin(c, { ge: reason, gs })
  }

  if (!row) {
    return fail('invalid_flow')
  }

  // 2) error 파라미터 존재 → mode로 분기(원인은 서버 로그에만 남긴다, 사유별로 나누지 않는다 — §3.2).
  //    H1 처방(2) — 공격자가 통제하는 문자열이라 길이 제한 없이 로깅하면 로그 증폭 벡터가 된다.
  //    Google이 실제로 주는 값은 access_denied/login_required 등 짧은 고정 토큰뿐이라 잘라도 손실이 없다.
  //    review M-G — claim() 이전이라 소유권 증명이 없다. 쓰기 없이(owned 미지정) 거부만 한다.
  if (errorParam) {
    console.error('[auth-google] callback error param', String(errorParam).slice(0, 64), 'mode=', mode)
    return fail(mode === 'silent' ? 'silent_unavailable' : 'google_denied')
  }

  if (!code) {
    return fail('upstream')
  }

  // 4) 쿠키 mh_gflow(또는 __Host-mh_gflow, M4) 존재 + sha256(cookie)===row.binding_hash →
  //    아니면 flow_binding_failed.
  //    (§3.2의 검증순서 3 "status='pending'+미만료"는 아래 5) claim()의 조건부 UPDATE가 원자적으로
  //    함께 강제한다 — 별도 사전 읽기 체크를 두지 않는 이유는 그 사전 체크와 claim() 사이의 창에서
  //    레이스가 생기는 것을 피하기 위함이다. 이 순서 뒤바뀜[검증순서 3↔4]이 이전 markFailed가 남의
  //    소유 행을 덮어쓸 수 있었던 구조적 원인이기도 하다 — L4, 조치는 owned='pre' 분리로 흡수됨.)
  // review M-G — 이 지점은 "이 요청은 이 행의 주인이 아니다"가 방금 **반증된** 지점이다(소유권
  // 증명 실패가 아니라 반증). 쓰기 없이(owned 미지정) 거부만 한다 — 이전에는 여기서도
  // markFailedIfPending을 호출해 남의 'pending' 행을 죽일 수 있었다.
  const bindingSecret = getCookie(c, flowBindingCookieName(c))
  if (!bindingSecret || (await sha256Hex(bindingSecret)) !== row.binding_hash) {
    return fail('flow_binding_failed')
  }

  // 5) consume(state) 조건부 UPDATE(pending→authorized) — 1회성 강제. changes===0이면 재사용/레이스/만료.
  const claimed = await googleLoginFlowsDao.claim(c.env.DB, row.state)
  if (!claimed) {
    return fail('invalid_flow') // owned 지정하지 않음 — 이 요청은 소유권이 없다(DAO 주석 참고)
  }

  // 6) Google 토큰 교환(5초 timeout, 재시도 없음)
  const tokenResult = await exchangeCodeForToken(c.env, { code, codeVerifier: row.code_verifier })
  if (!tokenResult.ok) {
    // 보안점검 M3 처방 — 실패 원인(네트워크/타임아웃/비200/파싱실패/id_token부재)이 전부 응답 없이
    // 소실되지 않도록 관측만 남긴다(응답 body는 §4.1에 따라 절대 찍지 않는다).
    console.warn('[auth-google] token exchange failed', tokenResult.reason, 'mode=', mode)
    return fail('upstream', { owned: 'post' })
  }

  // 7) id_token 클레임(email_verified + 도메인 통제선 L2, 결정9)
  const claimsResult = verifyIdTokenClaims(c.env, tokenResult.idToken, { nonce: row.nonce })
  if (!claimsResult.ok) {
    // 보안점검 M3 처방 — 사용자 응답(ge=)은 그대로 claimsResult.reason('upstream' 또는 표시 가능한
    // 사유)을 쓰되, 구조적 검증 실패(reason==='upstream')의 내부 detail을 관측·선별 감사한다.
    // nonce_mismatch(재생·주입 시도의 유일한 신호)·aud_mismatch(형제 클라이언트 오주입)만
    // audit_logs에 남긴다 — 나머지(decode_failed/iss_mismatch/exp_expired/iat_future/sub_missing/
    // email_missing)는 정상 흐름에서 발생하지 않고 Google 쪽 이상과도 구분이 어려워 로그로 충분하다.
    if (claimsResult.reason === 'upstream') {
      console.warn('[auth-google] id_token claim rejected', claimsResult.detail, 'mode=', mode)
      if (claimsResult.detail === 'nonce_mismatch' || claimsResult.detail === 'aud_mismatch') {
        await recordDenied(c.env.DB, { reason: claimsResult.detail, mode, email: claimsResult.claims?.email })
      }
    } else if (claimsResult.reason === 'not_configured') {
      // review m-2 — 콜백 재확인(M1 처방(2))이 여기서도 fail-closed하는 것은 옳지만, 그 실패
      // 원인은 사용자의 이상 행동이 아니라 배포 중 env 오설정이다. 감사표(§5.2)의 취지("사용자
      // 미식별 실패는 기록하지 않는다")와 결이 같으므로 감사기록에서 제외하고 관측만 남긴다 —
      // env 오설정 배포 창에서 이 사유로 감사 로그가 쌓이는 잡음을 막는다.
      console.warn('[auth-google] id_token claim rejected: domain control env missing at callback time', 'mode=', mode)
    } else {
      await recordDenied(c.env.DB, { reason: claimsResult.reason, mode, email: claimsResult.claims?.email })
    }
    return fail(claimsResult.reason, { owned: 'post' })
  }

  // 8) 사용자 매칭(결정1) — 검증된 이메일 완전일치. 자동 생성 없음(결정2).
  const email = claimsResult.claims.email.trim().toLowerCase()
  const user = await usersDao.findByEmail(c.env.DB, email)
  if (!user) {
    await recordDenied(c.env.DB, { reason: 'not_provisioned', mode, email })
    return fail('not_provisioned', { owned: 'post' })
  }
  if (user.status !== 'active') {
    await recordDenied(c.env.DB, { reason: 'user_disabled', mode, email, userId: user.id })
    return fail('user_disabled', { owned: 'post' })
  }

  // 9) google_sub TOFU 링크(CAS) — 반드시 10)보다 먼저(멱등 재시도, 6.5)
  const linkResult = await linkOrVerifyGoogleSub(c.env.DB, user, claimsResult.claims.sub)
  if (!linkResult.ok) {
    await recordDenied(c.env.DB, { reason: linkResult.reason, mode, email, userId: user.id })
    return fail(linkResult.reason, { owned: 'post' })
  }
  if (linkResult.linked) {
    await recordLinked(c.env.DB, { userId: user.id, mode })
  }

  // 10) 핸드오프 코드 발급(60초) → 같은 행 UPDATE(authorized 유지 + handoff_*)
  const handoffRaw = generateOpaqueToken()
  const handoffHash = await sha256Hex(handoffRaw)
  const handoffExpiresAt = new Date(Date.now() + HANDOFF_TTL_SECONDS * 1000).toISOString()
  const handoffSet = await googleLoginFlowsDao.setHandoff(c.env.DB, row.state, {
    userId: user.id, handoffCodeHash: handoffHash, handoffExpiresAt
  })
  if (!handoffSet) {
    // 방어적 — claim() 직후 이 요청이 배타적으로 소유한 행이라 통상 발생하지 않는다.
    return fail('upstream', { owned: 'post' })
  }

  // 성공 — 바인딩 쿠키 + 무음 억제 쿠키 모두 만료(§2 흐름도). 두 쿠키 모두 cookieOpts()가 정한
  // path(flowCookiePath)로 세팅됐으므로 삭제도 같은 path여야 실제로 지워진다(M4).
  deleteCookie(c, flowBindingCookieName(c), deleteFlowCookieOpts(c))
  deleteCookie(c, silentSuppressCookieName(c), deleteFlowCookieOpts(c))

  return redirectToLogin(c, { gh: handoffRaw })
})

// ---------------------------------------------------------------------------
// POST /exchange — SPA가 핸드오프 코드를 토큰 쌍으로 교환(JSON). §3.3.
// ---------------------------------------------------------------------------
authGoogle.post('/exchange', async (c) => {
  // review m-4 — H1이 지목한 무인증 D1 접근 표면 3개 중 이 라우트만 레이트리밋이 없었다. 무차별
  // 대입/재사용은 성립하지 않지만(handoffCode는 43자 base64url=256비트, consumeHandoff는 CAS라
  // 재사용 불가) 남는 D1 **읽기** 비용을 다른 두 라우트와 동일하게 상한선 아래로 둔다.
  if (!(await checkRateLimit(c, 'exchange'))) {
    return c.json({ error: { code: 'INVALID_HANDOFF', message: 'handoff code is missing, expired, or already used' } }, 401)
  }

  const body = await c.req.json().catch(() => ({}))
  const handoffCode = typeof body.handoff_code === 'string' ? body.handoff_code : ''
  if (!HANDOFF_CODE_RE.test(handoffCode)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'handoff_code is required and must be a valid opaque code' } }, 400)
  }

  const handoffHash = await sha256Hex(handoffCode)
  const row = await googleLoginFlowsDao.findByHandoffHash(c.env.DB, handoffHash)
  const now = new Date().toISOString()
  if (!row || row.status !== 'authorized' || !row.handoff_expires_at || row.handoff_expires_at <= now) {
    return c.json({ error: { code: 'INVALID_HANDOFF', message: 'handoff code is missing, expired, or already used' } }, 401)
  }

  const consumed = await googleLoginFlowsDao.consumeHandoff(c.env.DB, handoffHash)
  if (!consumed) {
    // 레이스 또는 재사용(만료도 위 사전 확인에서 대부분 걸리지만, 그 사이의 창은 이 조건부 UPDATE가 닫는다).
    return c.json({ error: { code: 'INVALID_HANDOFF', message: 'handoff code is missing, expired, or already used' } }, 401)
  }

  const user = await usersDao.findById(c.env.DB, row.user_id)
  if (!user) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'linked user no longer exists' } }, 404)
  }
  // 교환 시점 재확인(결정 8-2) — 콜백과 교환 사이에 관리자가 비활성화했을 수 있다.
  if (user.status !== 'active') {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'account is not active' } }, 401)
  }

  const pair = await issueWebTokenPair(c.env, user)
  return c.json({
    ...pair,
    must_change_password: !!user.must_change_password,
    redirect_path: row.redirect_path || '/'
  })
})

export default authGoogle
