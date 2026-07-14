import { Hono } from 'hono'
import FeatureRequestsDao from '../dao/feature-requests.js'
import ProjectsDao from '../dao/projects.js'
import { badRequest, notFound } from '../utils/response.js'
import { authMiddleware } from '../middleware/auth.js'

/**
 * feature-requests.js — "malgnai 자체 기능 업그레이드 요청" 제출 → 엔진 완전자동 심사 파이프라인의
 * 웹 API. 사용자 프로젝트에 대한 요청이 아니라 malgnai 플랫폼 자신에 대한 요청이므로 project_id를
 * 클라이언트가 지정하지 않는다 — 서버가 PLATFORM_PROJECT_NAME('malgnai')으로 항상 고정 조회한다.
 * 개인 프로젝트 데이터가 아니라 공유 백로그라서 소유권 스코핑도 없다(로그인 사용자 전체 조회 가능).
 *
 * 완전자동 심사(사람 승인 개입 없음)가 요구사항이므로 이 라우터에는 의도적으로 PATCH(수동
 *   승인/반려) 엔드포인트가 없다 — 심사는 오직 engine/feature-review.js가 엔진 틱마다 수행한다.
 * 승인되면 기존 memories(FEEDBACK) 주입 경로를 재사용해 malgnai 자신의 다음 project_cycle이
 *   반영한다(신규 실행 파이프라인 없음).
 */
const router = new Hono()

const STATUSES = ['pending', 'reviewing', 'approved', 'rejected']
const TITLE_MAX_LEN = 200

// malgnai 자신을 가리키는 projects 행(name='malgnai', .claude/project.json의 고정 id와 동일).
// 하드코딩 UUID 대신 이름으로 조회해 프로젝트 재시딩에도 안전하게 따라간다.
const PLATFORM_PROJECT_NAME = 'malgnai'

async function resolvePlatformProject(db) {
  return await new ProjectsDao(db).findByName(PLATFORM_PROJECT_NAME)
}

/**
 * POST /api/feature-requests  [JWT]
 * body: { title, description? } — project_id는 받지 않는다(항상 malgnai 자신).
 * status는 서버가 항상 'pending'으로 고정(요청 body의 status는 무시 — DAO.create()가 강제).
 */
router.post('/', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const description = typeof body.description === 'string' ? body.description : null

  if (title.length < 1 || title.length > TITLE_MAX_LEN) {
    return badRequest(c, `title must be 1~${TITLE_MAX_LEN} characters`)
  }

  const project = await resolvePlatformProject(c.env.DB)
  if (!project) return badRequest(c, 'platform project(malgnai) not found — check projects seeding')

  const requester_user_id = c.get('user')?.sub || null
  const dao = new FeatureRequestsDao(c.env.DB)
  const feature_request = await dao.create({
    id: crypto.randomUUID(),
    project_id: project.id,
    requester_user_id,
    title,
    description,
  })

  return c.json({ feature_request }, 201)
})

/**
 * GET /api/feature-requests?status=&limit=&offset=  [JWT]
 * 공유 백로그라 소유권 스코핑 없음 — 로그인한 사용자 누구나 전체 조회.
 */
router.get('/', authMiddleware, async (c) => {
  const status = c.req.query('status')
  if (status !== undefined && !STATUSES.includes(status)) {
    return badRequest(c, `status must be one of: ${STATUSES.join(', ')}`)
  }
  const limit = Number(c.req.query('limit')) || 50
  const offset = Number(c.req.query('offset')) || 0

  const dao = new FeatureRequestsDao(c.env.DB)
  const feature_requests = await dao.findAll({ status, limit, offset })
  return c.json({ feature_requests, limit, offset })
})

/**
 * GET /api/feature-requests/:id  [JWT]  없으면 404. 공유 백로그라 소유권 검사 없음.
 */
router.get('/:id', authMiddleware, async (c) => {
  const dao = new FeatureRequestsDao(c.env.DB)
  const feature_request = await dao.findById(c.req.param('id'))
  if (!feature_request) return notFound(c, 'Feature request not found')
  return c.json({ feature_request })
})

export default router
