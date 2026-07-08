import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { ensureSchema } from './dao/init.js'
import { authMiddleware } from './middleware/auth.js'
import register from './_registry.js'

// 앱 팩토리 — Node 진입점(server/node.js)이 env(DB 어댑터/ASSETS/시크릿/vars)를
// 주입해 호출한다. 이전의 Cloudflare Workers 전용 c.env 바인딩은 폐기했고,
// 이제 이 env 가 유일한 주입 경로다(globalThis 우회 없음).
//
// env 필수 키:
//   DB         — sqlite-adapter.wrapD1(better-sqlite3) (D1 호환 인터페이스)
//   ASSETS     — { fetch(Request): Response } 정적 자산 서빙
//   ENVIRONMENT, APP_ORIGIN, JWT_SECRET, ADMIN_PASSWORD, MALGNAI_API_KEY
export function createApp(env) {
  const app = new Hono()

  // 모든 요청 컨텍스트에 env 주입(라우트/미들웨어가 c.env 로 접근).
  app.use('*', async (c, next) => {
    c.env = env
    await next()
  })

  // [H-001] CORS: 전체 Origin 반영 금지. APP_ORIGIN(쉼표 다중) 화이트리스트만 허용.
  // 로컬 개발(ENVIRONMENT==='development')에서는 localhost 도 허용한다.
  app.use('/api/*', async (c, next) => {
    const allowed = (c.env.APP_ORIGIN || '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean)
    const isDev = c.env.ENVIRONMENT === 'development'
    const corsMw = cors({
      origin: (origin) => {
        if (!origin) return undefined
        if (allowed.includes(origin)) return origin
        if (isDev && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
          return origin
        }
        return undefined
      },
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
      credentials: false,
    })
    return corsMw(c, next)
  })

  app.use('/api/*', async (c, next) => {
    // adminPassword 를 넘겨 users 비었을 때 admin 시드(lockout 방지, 멱등).
    // 로컬 개발(.dev.vars 에 ADMIN_PASSWORD 미설정)에서도 로그인 가능하도록 dev 기본비번 사용.
    const isDev = c.env.ENVIRONMENT === 'development'
    const adminPassword = c.env.ADMIN_PASSWORD || (isDev ? 'malgnai-dev' : undefined)
    await ensureSchema(c.env.DB, { adminPassword })
    await next()
  })

  // [보안] 터널(Cloudflare) 경유 외부 요청은 JWT 로그인 필수.
  // Cloudflare 엣지는 모든 요청에 cf-ray/cf-connecting-ip 헤더를 붙이고, 이 헤더는
  // 클라이언트가 위조할 수 없다(엣지에서 덮어씀). origin 은 터널 밖에서 도달 불가하므로
  // 이 헤더 유무로 '외부(터널) vs 로컬(localhost 직결)'을 구분한다.
  //   - 로컬 직결(sync/MCP) → 통과(기존 동작 유지, 스크립트 무수정)
  //   - 외부 → /api/auth/login 만 예외, 그 외 전부 JWT 검증
  app.use('/api/*', async (c, next) => {
    const viaCloudflare = c.req.header('cf-ray') || c.req.header('cf-connecting-ip')
    if (!viaCloudflare) return next()
    const path = new URL(c.req.url).pathname
    if (path === '/api/auth/login') return next()
    return authMiddleware(c, next)
  })

  register(app)

  // 정적 자산 + SPA 폴백.
  app.get('*', async (c) => {
    const assets = c.env.ASSETS
    const url = new URL(c.req.url)
    let res = await assets.fetch(new Request(url))
    if (res.status === 404) {
      // SPA fallback: serve index.html for non-API routes
      res = await assets.fetch(new Request(new URL('/', url)))
    }
    return res
  })

  return app
}
