// CORS 미들웨어 — 프로덕션은 Pages+Worker가 동일 오리진이라 원칙적으로 불필요하지만(architecture.md §1),
// 향후 별도 서브도메인 분리 가능성과 로컬 개발(SPA 별도 포트)을 대비해 화이트리스트 기반으로 기본 장착한다.
// cors() 무인자 사용(Origin reflect)은 금지 — domain-serverless-edge-api-security 함정 참고.
import { cors } from 'hono/cors'

export function corsMiddleware(env) {
  const configured = (env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  return cors({
    origin: (origin) => {
      if (!origin) return undefined
      if (configured.includes(origin)) return origin
      // 로컬 개발 편의: localhost/127.0.0.1의 임의 포트만 허용(운영 오리진은 반드시 CORS_ALLOWED_ORIGINS로 명시).
      if (/^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return origin
      return undefined
    },
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    credentials: true
  })
}
