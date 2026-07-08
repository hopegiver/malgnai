import { serverError, unauthorized } from '../utils/response.js'

// [H-002] JWT 클레임 고정값 — 다른 용도 토큰 재사용 차단(iss/aud 검증).
export const JWT_ISSUER = 'malgnai'
export const JWT_AUDIENCE = 'malgnai-web'

/**
 * API 키 인증 미들웨어 (인입 경로 보호용)
 *
 * 로컬 MCP / sync 스크립트가 X-API-Key 헤더로 인증한다.
 * 키는 Workers Secret(MALGNAI_API_KEY)과 일치해야 한다.
 *
 * [C-001 fail-closed] 키 미설정 시:
 *   - 기본(=프로덕션) 거부(500). ENVIRONMENT 미설정도 프로덕션으로 간주한다.
 *     시크릿 누락 배포로 claim/PATCH(=RCE 큐 조작 경로)가 무인증 노출되는 것을 막는다.
 *   - 로컬 개발(ENVIRONMENT==='development', .dev.vars)에서만 인증을 건너뛴다.
 */
export async function apiKeyMiddleware(c, next) {
  const expected = c.env.MALGNAI_API_KEY
  if (!expected) {
    if (c.env.ENVIRONMENT !== 'development') {
      return serverError(c, 'API key not configured')
    }
    // 로컬 개발 환경에서만 인증 비활성화.
    await next()
    return
  }
  const provided = c.req.header('X-API-Key')
  // 타이밍 안전 비교 (RCE 관문이므로 보수적으로 상수시간 비교).
  if (!provided || !timingSafeEqual(provided, expected)) {
    return unauthorized(c, 'Invalid API key')
  }
  await next()
}

/**
 * API 키 또는 JWT 둘 중 하나면 통과시키는 미들웨어.
 *
 * 인입 경로(MCP/sync 스크립트는 X-API-Key)와 웹 UI(로그인한 대표는 JWT) 양쪽이
 * 같은 라우트(예: 작업 생성)를 호출할 수 있어야 한다. X-API-Key 가 있으면 키 검증을,
 * 없으면 Authorization Bearer(JWT) 검증을 시도한다. 둘 다 실패 시 401.
 */
export async function apiKeyOrJwtMiddleware(c, next) {
  // 1) X-API-Key 가 명시되면 API 키 경로로 검증.
  if (c.req.header('X-API-Key')) {
    return apiKeyMiddleware(c, next)
  }
  // 2) 그 외에는 JWT 경로로 검증(웹 UI).
  return authMiddleware(c, next)
}

/** 길이/내용 누출을 줄이는 상수시간 문자열 비교. */
function timingSafeEqual(a, b) {
  const enc = new TextEncoder()
  const ba = enc.encode(a)
  const bb = enc.encode(b)
  // 길이가 다르면 더미 비교로 시간을 맞춘 뒤 false.
  const len = Math.max(ba.length, bb.length)
  let diff = ba.length ^ bb.length
  for (let i = 0; i < len; i++) {
    diff |= (ba[i] || 0) ^ (bb[i] || 0)
  }
  return diff === 0
}

/**
 * JWT 인증 미들웨어
 *
 * 사용법:
 *   import { authMiddleware } from '../middleware/auth.js'
 *   router.get('/me', authMiddleware, (c) => { ... })
 *
 * 검증 성공 시 c.set('user', payload) 로 페이로드를 전달한다.
 * 이후 핸들러에서 const user = c.get('user') 로 접근.
 */
export async function authMiddleware(c, next) {
  // [H-002] 시크릿 미설정 = 검증 불가. 프로덕션에서는 fail-closed.
  if (!c.env.JWT_SECRET) {
    return serverError(c, 'JWT secret not configured')
  }
  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return unauthorized(c)
  }

  const token = authHeader.slice(7)
  try {
    const payload = await verifyJwt(token, c.env.JWT_SECRET)
    c.set('user', payload)
    await next()
  } catch {
    return unauthorized(c, 'Invalid or expired token')
  }
}

/** JWT 서명 검증 + 만료 확인 (Web Crypto API — Cloudflare Workers 기본 지원) */
async function verifyJwt(token, secret) {
  const [headerB64, payloadB64, signatureB64] = token.split('.')
  if (!headerB64 || !payloadB64 || !signatureB64) throw new Error('malformed token')

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  const signature = base64UrlDecode(signatureB64)
  const valid = await crypto.subtle.verify('HMAC', key, signature, data)
  if (!valid) throw new Error('invalid signature')

  const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')))
  if (payload.exp && payload.exp * 1000 < Date.now()) throw new Error('token expired')
  // [H-002] iss/aud 검증 — 이 앱이 발급한 웹 토큰만 통과.
  if (payload.iss !== JWT_ISSUER) throw new Error('invalid issuer')
  if (payload.aud !== JWT_AUDIENCE) throw new Error('invalid audience')

  return payload
}

/** JWT 발급 (로그인 핸들러에서 사용). [H-002] 기본 만료 4시간 + iss/aud 클레임. */
export async function signJwt(payload, secret, expiresInSeconds = 60 * 60 * 4) {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64UrlEncode(JSON.stringify({
    ...payload,
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    iat: Math.floor(Date.now() / 1000),
  }))

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`))
  return `${header}.${body}.${base64UrlEncode(signature)}`
}

function base64UrlEncode(input) {
  const str = typeof input === 'string' ? input : String.fromCharCode(...new Uint8Array(input))
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function base64UrlDecode(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64)
  return Uint8Array.from(binary, ch => ch.charCodeAt(0))
}
