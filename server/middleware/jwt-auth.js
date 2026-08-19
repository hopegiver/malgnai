// JWT 인증 미들웨어 — 웹 REST API(§6.1). 전역 부착 후 PUBLIC_PATHS만 예외(backend-security-audit
// 규약 ① 인증 화이트리스트 게이트). fail-closed: JWT_SECRET 미설정이면 500으로 거부(통과 아님).
import { verifyAccessToken } from '../lib/tokens.js'

/** 인증 없이 통과하는 경로(정확히 일치) — 로그인/리프레시/디바이스 페어링 무인증 단계. */
export const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/devices/pair-init',
  '/api/devices/pair-status',
  // OAuth 2.1(PKCE) 표준 프로토콜 엔드포인트 — 클라이언트 등록/토큰 교환은 세션 없이 호출된다.
  // /api/oauth/authorize-context, /api/oauth/consent는 여기에 넣지 않는다(JWT 게이트 유지).
  '/api/oauth/token',
  '/api/oauth/register',
  // POST /api/sessions — JWT가 아니라 device_token 인증(architecture.md §7.2, §0 결정10).
  // 여기서는 전역 JWT 게이트만 우회시키고, 실제 인증은 server/api/sessions.js의
  // requireDeviceToken 미들웨어(mcp/device-auth.js 재사용)가 무조건 강제한다 — "무인증 통과"가
  // 아니라 "인증 방식이 다를 뿐"이다.
  '/api/sessions'
])

export async function jwtAuthMiddleware(c, next) {
  if (PUBLIC_PATHS.has(c.req.path)) {
    await next()
    return
  }

  if (!c.env.JWT_SECRET) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'JWT secret not configured' } }, 500)
  }

  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'missing bearer token' } }, 401)
  }

  const token = authHeader.slice(7)
  try {
    const payload = await verifyAccessToken(token, c.env.JWT_SECRET)
    // 클라이언트가 보내는 값은 신뢰하지 않는다 — 서버가 토큰 서명 검증으로 확정한 값만 사용(idea.md §12.3).
    c.set('userId', payload.sub)
    c.set('userRole', payload.role)
    c.set('userEmail', payload.email)
    await next()
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'invalid or expired token' } }, 401)
  }
}

/** administrator 전용 라우트 가드(backend-security-audit 규약 ② 역할 기반 인가 미들웨어). */
export async function requireAdmin(c, next) {
  if (c.get('userRole') !== 'administrator') {
    return c.json({ error: { code: 'FORBIDDEN', message: 'administrator role required' } }, 403)
  }
  await next()
}
