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

const webApp = new Hono()

webApp.use('/api/*', async (c, next) => corsMiddleware(c.env)(c, next))
webApp.use('/api/*', jwtAuthMiddleware)

webApp.route('/api/auth', authRouter)
webApp.route('/api/devices', devicesRouter)
webApp.route('/api/projects', projectsRouter)
webApp.route('/api/projects', eventsRouter)
webApp.route('/api/repositories', repositoriesRouter)
webApp.route('/api/admin/users', adminUsersRouter)

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
          headers: { 'content-type': 'application/json' }
        })
      }
      ctx.props = authed.identity
      return MalgnMcpAgent.serve('/mcp', { binding: 'MCP_AGENT' }).fetch(request, env, ctx)
    }

    if (url.pathname.startsWith('/api')) {
      return webApp.fetch(request, env, ctx)
    }

    return new Response('Not found', { status: 404 })
  }
}
