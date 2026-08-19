// 사용량/세션 조회 라우트 — api.md §5.5(2단계). JWT 인증(POST /api/sessions만 예외, server/api/sessions.js
// 참고). 쓰기는 POST /api/sessions 하나뿐이라 이 파일은 GET 전용.
import { Hono } from 'hono'
import * as projectsDao from '../dao/projects.js'
import * as sessionsDao from '../dao/sessions.js'
import * as usageDailyDao from '../dao/usage-daily.js'
import { requireAdmin } from '../middleware/jwt-auth.js'

const usage = new Hono()

function parseRange(c) {
  return { from: c.req.query('from') || undefined, to: c.req.query('to') || undefined }
}

function parseLimit(c, fallback = 20, max = 100) {
  const n = Number.parseInt(c.req.query('limit') || '', 10)
  if (!Number.isInteger(n) || n < 1) return fallback
  return Math.min(n, max)
}

// GET /api/usage/me?from=&to= — 본인 usage_daily 행(schema.sql §3.12, §0 결정25).
usage.get('/me', async (c) => {
  const data = await usageDailyDao.findForUser(c.env.DB, c.get('userId'), parseRange(c))
  return c.json({ data })
})

// GET /api/usage/projects/:id?from=&to= — 본인 소유 project만. usage_daily엔 project_id가 없어
// (§0 결정25) sessions를 WHERE project_id=? AND user_id=? GROUP BY day_at로 직접 재집계한다.
// 타인 소유 project_id는 404로 위장(IDOR 방지, api.md §5.3과 동일 house style — 403 대신 404).
usage.get('/projects/:id', async (c) => {
  const userId = c.get('userId')
  const project = await projectsDao.findOwnedById(c.env.DB, userId, c.req.param('id'))
  if (!project) return c.json({ error: { code: 'NOT_FOUND', message: 'project not found' } }, 404)

  const data = await sessionsDao.sumByProjectDay(c.env.DB, project.id, userId, parseRange(c))
  return c.json({ data })
})

// GET /api/usage/sessions?cursor=&limit=&user_id= — 본인(기본) 또는 administrator+user_id 쿼리.
usage.get('/sessions', async (c) => {
  const userId = c.get('userId')
  const isAdmin = c.get('userRole') === 'administrator'
  const queryUserId = c.req.query('user_id')

  let targetUserId = userId
  if (queryUserId && queryUserId !== userId) {
    if (!isAdmin) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'administrator role required to view other users sessions' } }, 403)
    }
    targetUserId = queryUserId
  }

  const page = await sessionsDao.listForUser(c.env.DB, targetUserId, {
    cursor: c.req.query('cursor') || undefined,
    limit: parseLimit(c)
  })
  return c.json(page)
})

export default usage

// GET /api/admin/usage/summary?from=&to= — administrator만. 전사(전 사용자) 일별 추세
// (organizations 없음 → day_at으로만 GROUP, api.md §5.6).
export const adminUsage = new Hono()
adminUsage.get('/summary', requireAdmin, async (c) => {
  const data = await usageDailyDao.sumAllByDay(c.env.DB, parseRange(c))
  return c.json({ data })
})
