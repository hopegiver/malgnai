// 사용량/세션 조회 라우트 — api.md §5.5(2단계). JWT 인증(POST /api/sessions만 예외, server/api/sessions.js
// 참고). 쓰기는 POST /api/sessions 하나뿐이라 이 파일은 GET 전용.
import { Hono } from 'hono'
import * as projectsDao from '../dao/projects.js'
import * as sessionsDao from '../dao/sessions.js'
import * as usageDailyDao from '../dao/usage-daily.js'
import * as usersDao from '../dao/users.js'
import * as auditLogsDao from '../dao/audit-logs.js'
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

// §5.8 관리자 사용량 드릴다운 공통 — from/to 형식·기본값(§5.8.0). YYYY-MM-DD 아니면 에러, 둘 다
// 생략 시 최근 30일(to=오늘 UTC, from=to-29일), 한쪽만 주면 나머지만 기본값 적용, from>to면 에러.
const ADMIN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// 정규식은 자릿수 형식만 보고 달력상 실재 여부는 보지 않는다(M-2) — 2026-13-01·9999-99-99처럼
// Date.UTC가 오버플로 롤오버시키는 값을 넣어 연/월/일을 되짚어 원래 문자열과 일치하는지 확인한다.
// 불일치(롤오버 발생 또는 범위 밖)면 false. Date.UTC는 RangeError를 던지지 않으므로 안전.
function isValidCalendarDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10)
}

function addDaysUTC(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function resolveAdminRange(c) {
  const rawFrom = c.req.query('from')
  const rawTo = c.req.query('to')
  if (rawFrom && (!ADMIN_DATE_RE.test(rawFrom) || !isValidCalendarDate(rawFrom))) {
    return { error: 'from must be in YYYY-MM-DD format' }
  }
  if (rawTo && (!ADMIN_DATE_RE.test(rawTo) || !isValidCalendarDate(rawTo))) {
    return { error: 'to must be in YYYY-MM-DD format' }
  }
  const to = rawTo || todayUTC()
  const from = rawFrom || addDaysUTC(to, -29)
  if (from > to) return { error: 'from must not be after to' }
  return { from, to }
}

function toUserSummaryRow(row) {
  return {
    user_id: row.user_id,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    session_count: row.session_count,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read_tokens: row.cache_read_tokens,
    cache_write_tokens: row.cache_write_tokens,
    total_tokens: row.total_tokens,
    tool_calls: row.tool_calls,
    tool_errors: row.tool_errors,
    retries: row.retries,
    turns: row.turns,
    api_calls: row.api_calls,
    active_days: row.active_days,
    last_active_day: row.last_active_day
  }
}

function toPublicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, status: user.status }
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

// GET /api/admin/usage/users?from=&to=&sort=&order=&limit= — 사용자별 기간 합계 목록(api.md §5.8.1).
adminUsage.get('/users', requireAdmin, async (c) => {
  const range = resolveAdminRange(c)
  if (range.error) return c.json({ error: { code: 'VALIDATION_ERROR', message: range.error } }, 400)

  const sort = c.req.query('sort') || 'tokens'
  // Object.hasOwn으로 own-property만 인정 — plain object 화이트리스트는 constructor/toString/
  // valueOf/hasOwnProperty/__proto__ 같은 값이 Object.prototype 체인을 타고 truthy로 통과하는
  // 우회가 있다(M-1). in 연산자도 프로토타입 체인을 보므로 hasOwn만 안전하다.
  const sortColumn = Object.hasOwn(usageDailyDao.USER_SUMMARY_SORT_COLUMNS, sort)
    ? usageDailyDao.USER_SUMMARY_SORT_COLUMNS[sort]
    : undefined
  if (!sortColumn) {
    return c.json({
      error: {
        code: 'VALIDATION_ERROR',
        message: `sort must be one of ${Object.keys(usageDailyDao.USER_SUMMARY_SORT_COLUMNS).join(', ')}`
      }
    }, 400)
  }

  const rawOrder = c.req.query('order')
  if (rawOrder !== undefined && rawOrder !== 'asc' && rawOrder !== 'desc') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'order must be asc or desc' } }, 400)
  }
  // order 기본값은 desc, 단 sort=name일 때만 기본 asc(api.md §5.8.1 쿼리 파라미터 표).
  const order = rawOrder || (sort === 'name' ? 'asc' : 'desc')
  const orderDirection = order === 'asc' ? 'ASC' : 'DESC'

  const limit = parseLimit(c, 100, 500)

  const rows = await usageDailyDao.listUserSummaries(c.env.DB, {
    from: range.from,
    to: range.to,
    sortColumn,
    orderDirection,
    fetchLimit: limit + 1
  })
  const truncated = rows.length > limit
  const data = (truncated ? rows.slice(0, limit) : rows).map(toUserSummaryRow)

  return c.json({
    data,
    meta: { from: range.from, to: range.to, sort, order, limit, returned: data.length, truncated }
  })
})

// GET /api/admin/usage/users/:id?from=&to= — 특정 사용자 1명의 일별 롤업(api.md §5.8.2).
// data shape는 GET /api/usage/me와 완전히 동일(usageDailyDao.findForUser 그대로 재사용,
// §5.8.4 함정8 — 프런트 컴포넌트 재사용 전제).
adminUsage.get('/users/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const target = await usersDao.findById(c.env.DB, id)
  if (!target) return c.json({ error: { code: 'NOT_FOUND', message: 'user not found' } }, 404)

  const range = resolveAdminRange(c)
  if (range.error) return c.json({ error: { code: 'VALIDATION_ERROR', message: range.error } }, 400)

  const data = await usageDailyDao.findForUser(c.env.DB, id, range)

  // 감사 로그는 best-effort(§5.8.0) — INSERT 실패가 이 읽기 전용 조회 자체를 막지 않는다.
  try {
    await auditLogsDao.record(c.env.DB, {
      actorUserId: c.get('userId'),
      action: 'admin.cross_user_view',
      targetType: 'user',
      targetId: id,
      metadata: { from: range.from, to: range.to }
    })
  } catch (err) {
    console.error('admin.cross_user_view audit log write failed', err)
  }

  return c.json({ user: toPublicUser(target), data, meta: { from: range.from, to: range.to } })
})
