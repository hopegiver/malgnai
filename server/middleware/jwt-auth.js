// JWT 인증 미들웨어 — 웹 REST API(§6.1). 전역 부착 후 PUBLIC_PATHS만 예외(backend-security-audit
// 규약 ① 인증 화이트리스트 게이트). fail-closed: JWT_SECRET 미설정이면 500으로 거부(통과 아님).
import { verifyAccessToken } from '../lib/tokens.js'

/** 인증 없이 통과하는 경로(정확히 일치) — 로그인/리프레시/디바이스 페어링 무인증 단계. */
export const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/devices/pair-init',
  '/api/devices/pair-status'
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
