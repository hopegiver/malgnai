import { Hono } from 'hono'
import ActivitiesDao from '../dao/activities.js'
import { badRequest } from '../utils/response.js'
import { apiKeyMiddleware } from '../middleware/auth.js'
import { ACTIVITY_LEVELS, ACTIVITY_CATEGORIES } from '../lib/activity-normalize.js'

const router = new Hono()

const TRUTHY = new Set(['1', 'true', 'on', 'yes'])

// GET /api/activities?project_id=&command_id=&agent_name=&level=&category=&since=&until=&limit=&offset=&include_telemetry=
//
// 하위호환(§10 M2): 파라미터 無 = 기존 동작(최신 50). limit/offset 은 값이 있을 때만 전달하고
//   limit>200 은 200 클램프. level 미지정 시 사람 뷰 기본 = work+audit(telemetry 제외, §B);
//   include_telemetry=1 이면 전체. (배포 시점엔 모든 기존 행이 level 기본값 'work' 라 백필 전까지 결과 동일.)
router.get('/', async (c) => {
  const dao = new ActivitiesDao(c.env.DB)

  const includeTelemetry = TRUTHY.has((c.req.query('include_telemetry') || '').toLowerCase())
  const levelParam = c.req.query('level')
  let level
  if (levelParam) {
    level = levelParam.split(',').map((s) => s.trim()).filter(Boolean)
    const bad = level.find((l) => !ACTIVITY_LEVELS.includes(l))
    if (bad) return badRequest(c, `invalid level: ${bad}`)
  } else if (!includeTelemetry) {
    level = ['work', 'audit'] // §B 기본: 엔진 텔레메트리 제외
  } // else: level=undefined → 전체(telemetry 포함)

  const category = c.req.query('category')
  if (category && !ACTIVITY_CATEGORIES.includes(category)) {
    return badRequest(c, `invalid category: ${category}`)
  }

  const opts = {
    project_id: c.req.query('project_id'),
    command_id: c.req.query('command_id'),
    agent_name: c.req.query('agent_name'),
    level,
    category: category || undefined,
    since: c.req.query('since'),
    until: c.req.query('until'),
  }

  // limit/offset 은 값이 있을 때만 전달 → 없으면 DAO 기본(50/0) 그대로(M2 회귀 가드).
  const limitRaw = c.req.query('limit')
  if (limitRaw !== undefined) {
    let n = parseInt(limitRaw, 10)
    if (Number.isNaN(n) || n <= 0) n = 50
    opts.limit = Math.min(n, 200) // 상한 클램프
  }
  const offsetRaw = c.req.query('offset')
  if (offsetRaw !== undefined) {
    let o = parseInt(offsetRaw, 10)
    if (Number.isNaN(o) || o < 0) o = 0
    opts.offset = o
  }

  const activities = await dao.findAll(opts)
  return c.json({ activities })
})

// POST /api/activities  [X-API-Key] — 두 기록 주체(MCP·엔진) 공용.
// 신규 필드 전부 optional. §10 B1: enum 위반에 400 던지지 않고 서버측 정규화/폴백(공용 함수).
router.post('/', apiKeyMiddleware, async (c) => {
  const body = await c.req.json()
  if (!body.agent_name || !body.action) return badRequest(c, 'agent_name and action are required')
  const dao = new ActivitiesDao(c.env.DB)
  // 단일 쓰기관문(dao.create→logActivity): level/category/result/links 정규화(§10 B1, 위반→안전 기본,
  //   400 안 던짐) + id 기준 멱등 upsert(MCP 재전송 안전, created_at 보존). detail 은 불변.
  const activity = await dao.create(body)
  return c.json({ activity }, 201)
})

export default router
