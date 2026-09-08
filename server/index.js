// 최상위 라우팅 — architecture.md §2.3. /mcp는 device_token 인증 후 McpAgent(DO)로,
// /api/*는 Hono(webApp)로 위임한다. 단일 Worker(MCP+API 한 스크립트, §0 결정1).
import { Hono } from 'hono'
import { deviceAuthMiddleware } from '../mcp/device-auth.js'
import { MalgnMcpAgent } from '../mcp/agent.js'
import { corsMiddleware } from './middleware/cors.js'
import { jwtAuthMiddleware } from './middleware/jwt-auth.js'
import authRouter from './api/auth.js'
import devicesRouter from './api/devices.js'
import projectsRouter, { repositories as repositoriesRouter } from './api/projects.js'
import eventsRouter from './api/events.js'
import adminUsersRouter from './api/admin-users.js'
import catalogRouter from './api/catalog.js'
import adminCatalogRouter from './api/admin-catalog.js'
import { syncCatalog } from './lib/catalog-sync.js'
import { runUsageRollup, ROLLUP_CRON_BUDGET_MS } from './lib/usage-rollup.js'
import oauthRouter, { registerWellKnownRoutes } from './api/oauth.js'
import sessionsRouter from './api/sessions.js'
import usageRouter, { adminUsage as adminUsageRouter } from './api/usage.js'
import adminSharedWorkstationsRouter from './api/admin-shared-workstations.js'

const webApp = new Hono()

webApp.use('/api/*', async (c, next) => corsMiddleware(c.env)(c, next))
webApp.use('/api/*', jwtAuthMiddleware)

// well-known 2개는 /api 접두사가 없어 jwtAuthMiddleware(/api/* 부착)에 애초에 걸리지 않는다 —
// webApp 최상위에 절대경로로 직접 등록(서브라우터에 넣지 않음).
registerWellKnownRoutes(webApp)

webApp.route('/api/auth', authRouter)
webApp.route('/api/devices', devicesRouter)
webApp.route('/api/projects', projectsRouter)
webApp.route('/api/projects', eventsRouter)
webApp.route('/api/repositories', repositoriesRouter)
webApp.route('/api/admin/users', adminUsersRouter)
webApp.route('/api/catalog', catalogRouter)
webApp.route('/api/admin/catalog', adminCatalogRouter)
webApp.route('/api/oauth', oauthRouter)
webApp.route('/api/sessions', sessionsRouter)
webApp.route('/api/usage', usageRouter)
// 더 구체적인 경로를 먼저 등록한다 — adminUsageRouter에는 /shared-workstations 라우트가 없어
// 현재는 충돌하지 않지만, 나중에 그 라우터에 와일드카드가 생겨도 이 경로가 가려지지 않게 한다.
webApp.route('/api/admin/usage/shared-workstations', adminSharedWorkstationsRouter)
webApp.route('/api/admin/usage', adminUsageRouter)

webApp.get('/api/health', (c) => c.json({ ok: true }))

// error.name → HTTP 상태코드 단일 매핑(backend-security-audit 규약 — 에러 처리는 항상 이 경로로).
const STATUS_BY_ERROR_NAME = {
  ValidationError: 400,
  UnauthorizedError: 401,
  ForbiddenError: 403,
  NotFoundError: 404,
  ConflictError: 409
}

webApp.onError((err, c) => {
  const status = STATUS_BY_ERROR_NAME[err.name] || 500
  if (status === 500) {
    console.error('[unhandled]', err)
  }
  const body = { error: { code: err.code || err.name || 'INTERNAL_ERROR', message: status === 500 ? 'internal error' : err.message } }
  if (err.name === 'ConflictError' && err.current !== undefined) body.current = err.current
  return c.json(body, status)
})

webApp.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'route not found' } }, 404))

export { MalgnMcpAgent }

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (url.pathname.startsWith('/mcp')) {
      const authed = await deviceAuthMiddleware(request, env)
      if (!authed.ok) {
        return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: authed.reason } }), {
          status: 401,
          headers: {
            'content-type': 'application/json',
            // OAuth 2.1(PKCE) 401→discovery 자동흐름의 진입점 — MCP 클라이언트가 이 헤더를 보고
            // resource_metadata URL(well-known)을 따라가 authorization_server를 발견한다.
            'WWW-Authenticate': `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource', request.url)}"`
          }
        })
      }
      ctx.props = authed.identity
      return MalgnMcpAgent.serve('/mcp', { binding: 'MCP_AGENT' }).fetch(request, env, ctx)
    }

    if (url.pathname.startsWith('/api') || url.pathname.startsWith('/.well-known/oauth-')) {
      return webApp.fetch(request, env, ctx)
    }

    return new Response('Not found', { status: 404 })
  },

  // Cloudflare Cron Trigger(wrangler.jsonc triggers.crons) — controller.cron 문자열로 배치를
  // 분기한다(docs/design/usage-prometheus-realtime.md §18.3). ⚠️ 아래 문자열 리터럴은
  // wrangler.jsonc의 triggers.crons와 공백까지 정확히 일치해야 한다(Cloudflare 공식 요구) — 이
  // 값을 바꾸면 반드시 wrangler.jsonc도 같이 바꿀 것, 한쪽만 바꾸면 그 회차는 조용히 아무것도
  // 하지 않는다.
  //
  // 두 배치(카탈로그 동기화 / 사용량 롤업 적재)는 서로 독립된 ctx.waitUntil + 각자 catch에 넣는다
  // (Promise.all로 묶지 않는다) — 한쪽의 실패가 다른 쪽의 성공 여부를 가리지 않게 하기 위함
  // (설계 §18.3 규칙1). 실패해도 Worker 자체는 죽지 않는다 — 카탈로그는 다음 cron 또는 관리자 수동
  // 트리거, 사용량 롤업은 다음 회차의 결손 탐지가 자동으로 회복한다(알림/재시도 큐는 v1에서 두지
  // 않음, 기존 카탈로그 동기화와 동일 방침).
  async scheduled(controller, env, ctx) {
    if (controller.cron === '0 18 * * *') {
      ctx.waitUntil(
        syncCatalog(env.DB)
          .then((result) => console.log('[catalog-sync] cron sync done', JSON.stringify(result)))
          .catch((err) => console.error('[catalog-sync] cron sync failed', err))
      )
      // 18:00 UTC 회차는 01:00 UTC 주 적재가 실패했을 때의 같은 날 보조 재시도를 겸한다(§18.1).
      ctx.waitUntil(
        runUsageRollup(env, { budgetMs: ROLLUP_CRON_BUDGET_MS })
          .catch((err) => console.error('[usage-rollup] cron run failed', err))
      )
    } else if (controller.cron === '0 1 * * *') {
      ctx.waitUntil(
        runUsageRollup(env, { budgetMs: ROLLUP_CRON_BUDGET_MS })
          .catch((err) => console.error('[usage-rollup] cron run failed', err))
      )
    } else {
      console.error('[scheduled] unknown cron trigger — no-op', controller.cron)
    }
  }
}
