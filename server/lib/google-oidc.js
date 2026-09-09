// Google OIDC 연동(우리가 Google의 **클라이언트**인 축) — 인가 URL 조립, 토큰 교환, id_token
// 클레임 검증, 도메인 강제 2계층(결정 9), fail-closed 판정. 설계 정본:
// docs/design/google-oauth-login.md 결정 4·7·9·10, §4.
// ⚠️ server/lib/oauth-redirect-uri.js(제공자 축의 루프백 redirect_uri 검증)와 절대 혼동 금지 —
//    그 함수는 http:+루프백만 허용해 이 축(https 프로덕션 콜백)에 쓰면 즉시 고장 난다(§0.2).

// ---------------------------------------------------------------------------
// 상수 — 정본은 이 파일 하나(§7.2 "무음 관련 상수의 정본 위치"). 값을 바꾸면 이 주석과 함께 바꿀 것.
// ---------------------------------------------------------------------------
export const FLOW_TTL_SECONDS = 600 // 10분(결정 6)
export const HANDOFF_TTL_SECONDS = 60 // 60초(결정 6)
export const SILENT_SUPPRESS_COOKIE_TTL_SECONDS = 120 // 무음 억제 쿠키 수명(결정 6 — 서버측 루프 상한)
export const TOKEN_EXCHANGE_TIMEOUT_MS = 5000 // 5초, 재시도 없음(§4.1, prom-client.js AbortSignal.timeout 하우스 패턴)
export const CLOCK_SKEW_SECONDS = 120 // exp/iat 허용 오차(§4.2, §6.8)
export const GOOGLE_SCOPE = 'openid email profile' // 그 이상 요청하지 않는다(§3.1)
const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])

// ---------------------------------------------------------------------------
// fail-closed 판정(결정 9) — 도메인 통제선이 하나도 없으면 기능 자체가 켜지지 않는다.
// ---------------------------------------------------------------------------
export function isGoogleConfigured(env) {
  const hasClient = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI)
  const hasDomainControl = !!(trim(env.GOOGLE_ALLOWED_HD) || trim(env.GOOGLE_ALLOWED_EMAIL_DOMAIN))
  return hasClient && hasDomainControl
}

/** 결정 7 — 요청 오리진이 등록된 GOOGLE_REDIRECT_URI의 오리진과 정확히 같은지. redirect_uri는
 *  요청에서 조립하지 않고 항상 env 값을 그대로 쓴다(호스트 헤더 조작 표면 차단, §결정7). */
export function isOriginAllowed(env, requestUrl) {
  try {
    return new URL(requestUrl).origin === new URL(env.GOOGLE_REDIRECT_URI).origin
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 인가 URL 조립(§3.1)
// ---------------------------------------------------------------------------
export function buildAuthorizationUrl(env, { state, nonce, codeChallenge, mode }) {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT)
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID)
  url.searchParams.set('redirect_uri', env.GOOGLE_REDIRECT_URI)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', GOOGLE_SCOPE)
  url.searchParams.set('state', state)
  url.searchParams.set('nonce', nonce)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('access_type', 'online') // Google refresh token을 받지 않는다(오프라인 접근 불필요)
  url.searchParams.set('prompt', mode === 'silent' ? 'none' : 'select_account')
  // L1 힌트일 뿐 보안 경계가 아니다(결정 9) — GOOGLE_ALLOWED_HD가 설정됐을 때만 붙인다. HD만 없고
  // EMAIL_DOMAIN만 설정된 환경(비-Workspace)에서는 붙이지 않는다(필터링 효과가 없다, §3.1).
  const allowedHd = trim(env.GOOGLE_ALLOWED_HD)
  if (allowedHd) url.searchParams.set('hd', allowedHd)
  return url.toString()
}

// ---------------------------------------------------------------------------
// PKCE(S256) — 우리가 verifier를 생성하고 challenge를 계산해 Google에 보낸다(클라이언트 축).
// server/lib/tokens.js의 verifyPkceS256(제공자 축 — 우리가 검증하는 값)와는 방향이 반대라 별도로 둔다.
// ---------------------------------------------------------------------------
export async function computeCodeChallengeS256(codeVerifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  return base64UrlEncode(new Uint8Array(digest))
}

// ---------------------------------------------------------------------------
// 토큰 교환(§4.1) — 5초 timeout, 재시도 없음. client_secret·응답 body는 절대 로깅하지 않는다.
// ---------------------------------------------------------------------------
export async function exchangeCodeForToken(env, { code, codeVerifier }) {
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier
  })

  let res
  try {
    res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS)
    })
  } catch {
    return { ok: false, reason: 'upstream' } // 타임아웃/네트워크 오류
  }

  if (res.status !== 200) {
    return { ok: false, reason: 'upstream' } // 비200(재시도 없음 — code는 1회용이라 재시도가 성공할 수 없다)
  }

  let json
  try {
    json = await res.json()
  } catch {
    return { ok: false, reason: 'upstream' } // JSON 파싱 실패
  }
  if (!json || typeof json.id_token !== 'string' || !json.id_token) {
    return { ok: false, reason: 'upstream' } // id_token 부재
  }
  return { ok: true, idToken: json.id_token }
}

// ---------------------------------------------------------------------------
// id_token 클레임 검증(§4.2) — 서명 검증 생략(TLS로 보호된 서버↔서버 응답, OIDC Core §3.1.3.7).
// ⚠️ 전환 조건: id_token을 토큰 응답 이외의 경로(프런트 전달 등)로 받게 되면 즉시 JWKS 서명 검증으로
// 전환해야 한다(§4.2, §7.4의 JavaScript 원본 0개 결정이 이 전제를 콘솔 수준에서 지킨다).
// ---------------------------------------------------------------------------
export function decodeIdTokenPayload(idToken) {
  const parts = String(idToken).split('.')
  if (parts.length !== 3) return null
  try {
    return JSON.parse(base64UrlDecodeToString(parts[1]))
  } catch {
    return null
  }
}

/** 결정 9 L2 — 도메인 강제 실제 통제선. 보안점검 M1 처방: 이 함수는 isGoogleConfigured()의
 *  "/start만 지키는 관문" 가정에 기대지 않고 **자기 자신이 fail-closed**여야 한다 — /start와
 *  /callback 사이에는 FLOW_TTL_SECONDS(10분)의 창이 있고, 그 사이 배포로 env가 바뀔 수 있다
 *  (예: GOOGLE_ALLOWED_HD↔GOOGLE_ALLOWED_EMAIL_DOMAIN 전환 배포 중 한쪽만 지워진 순간). 통제선이
 *  하나도 없으면 "통과"가 아니라 즉시 거부한다(이전에는 이 경우 아래 두 if가 전부 스킵돼
 *  { ok:true }를 반환하는 fail-open이었다). */
function checkDomainControl(env, claims) {
  const allowedHd = trim(env.GOOGLE_ALLOWED_HD).toLowerCase()
  const allowedEmailDomain = trim(env.GOOGLE_ALLOWED_EMAIL_DOMAIN).toLowerCase()

  if (!allowedHd && !allowedEmailDomain) return { ok: false, reason: 'not_configured' }

  if (allowedHd) {
    const hd = typeof claims.hd === 'string' ? claims.hd.toLowerCase() : ''
    if (hd !== allowedHd) return { ok: false, reason: 'hd_mismatch' }
  }
  if (allowedEmailDomain) {
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : ''
    if (!email.endsWith('@' + allowedEmailDomain)) return { ok: false, reason: 'domain_mismatch' }
  }
  return { ok: true }
}

/**
 * id_token 전체 검증 — iss/aud/exp/iat(±120s)/nonce/email/email_verified/sub 구조적 검증 +
 * 도메인 통제선(L2). 구조적 검증(형식·iss·aud·exp·iat·nonce·sub 불일치) 실패는 설계 문서가 별도
 * ge 코드를 정의하지 않은 영역이라 §4.1과 같은 계열(Google 응답이 우리 기대를 충족하지 못함)로
 * 보고 사용자에게는 'upstream'으로 접는다(열거 방지) — 정상 흐름에서는 우리가 발급한 nonce/aud를
 * 그대로 반사하므로 발생하지 않고, 발생한다면 Google 쪽 이상이거나 위조 시도이지 사용자에게 보여줄
 * 만한 사유가 아니다.
 *
 * 보안점검 M3 처방: 사용자 노출 코드(reason)는 그대로 'upstream'으로 접되, 서버 내부 신호까지
 * 함께 접으면 안 된다 — 특히 nonce 불일치(토큰 재생·주입 시도의 유일한 신호)와 aud 불일치(형제
 * 클라이언트 오주입)는 Google 5xx·타임아웃과 구별할 방법이 없어지면 안 된다. 그래서 각 구조적
 * 실패에 외부 노출 필드가 아닌 `detail`을 덧붙인다 — 호출부(server/api/auth-google.js)가 이 값을
 * console.warn + 선별 감사기록에만 쓰고 절대 사용자 응답(ge=)에 노출하지 않는다.
 */
export function verifyIdTokenClaims(env, idToken, { nonce }) {
  const claims = decodeIdTokenPayload(idToken)
  if (!claims) return { ok: false, reason: 'upstream', detail: 'decode_failed' }

  const now = Math.floor(Date.now() / 1000)
  if (!GOOGLE_ISSUERS.has(claims.iss)) return { ok: false, reason: 'upstream', detail: 'iss_mismatch', claims }
  if (claims.aud !== env.GOOGLE_CLIENT_ID) return { ok: false, reason: 'upstream', detail: 'aud_mismatch', claims }
  if (typeof claims.exp !== 'number' || claims.exp <= now - CLOCK_SKEW_SECONDS) return { ok: false, reason: 'upstream', detail: 'exp_expired', claims }
  if (typeof claims.iat !== 'number' || claims.iat >= now + CLOCK_SKEW_SECONDS) return { ok: false, reason: 'upstream', detail: 'iat_future', claims }
  if (typeof claims.nonce !== 'string' || claims.nonce !== nonce) return { ok: false, reason: 'upstream', detail: 'nonce_mismatch', claims }
  if (typeof claims.sub !== 'string' || !claims.sub) return { ok: false, reason: 'upstream', detail: 'sub_missing', claims }
  if (typeof claims.email !== 'string' || !claims.email) return { ok: false, reason: 'upstream', detail: 'email_missing', claims }

  // C1(결정1) — email_verified가 도메인 검증보다 먼저다. false면 suffix 검증 자체가 무의미하다(결정9).
  if (!(claims.email_verified === true || claims.email_verified === 'true')) {
    return { ok: false, reason: 'email_unverified', claims }
  }

  const domainResult = checkDomainControl(env, claims)
  if (!domainResult.ok) return { ok: false, reason: domainResult.reason, claims }

  return { ok: true, claims }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function trim(v) {
  return typeof v === 'string' ? v.trim() : ''
}

function base64UrlEncode(bytes) {
  let str = ''
  for (const b of bytes) str += String.fromCharCode(b)
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function base64UrlDecodeToString(b64url) {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}
