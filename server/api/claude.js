import { Hono } from 'hono'
import ClaudeDao from '../dao/claude.js'
import ProjectsDao from '../dao/projects.js'
import { estimateCost } from '../lib/pricing.js'

const router = new Hono()

// 요약 대시보드
router.get('/summary', async (c) => {
  const dao = new ClaudeDao(c.env.DB)
  const [summary, modelUsage] = await Promise.all([dao.getSummary(), dao.findModelUsage()])
  const cost = estimateCost(modelUsage)
  summary.total_cost_usd = cost.total_usd // 누적 추정 비용($)
  return c.json({ summary })
})

// 일별 통계 (history 기반 집계)
router.get('/stats', async (c) => {
  const dao = new ClaudeDao(c.env.DB)
  const stats = await dao.findStats({
    since: c.req.query('since'),
    until: c.req.query('until'),
  })
  return c.json({ stats })
})

// 일별 토큰 통계
router.get('/tokens', async (c) => {
  const dao = new ClaudeDao(c.env.DB)
  const [daily, modelUsage] = await Promise.all([
    dao.findTokenStats({ since: c.req.query('since'), until: c.req.query('until') }),
    dao.findModelUsage(),
  ])
  return c.json({ daily, model_usage: modelUsage })
})

// 메모리 목록
router.get('/memories', async (c) => {
  const dao = new ClaudeDao(c.env.DB)
  const memories = await dao.findMemories({
    project_key: c.req.query('project_key'),
    type: c.req.query('type'),
  })
  return c.json({ memories })
})

// 메모리 보유 프로젝트 목록
router.get('/memories/projects', async (c) => {
  const dao = new ClaudeDao(c.env.DB)
  const projects = await dao.getMemoryProjects()
  return c.json({ projects })
})

// 세션 목록
router.get('/sessions', async (c) => {
  const dao = new ClaudeDao(c.env.DB)
  const sessions = await dao.findSessions({
    limit: Number(c.req.query('limit')) || 50,
    offset: Number(c.req.query('offset')) || 0,
  })
  return c.json({ sessions })
})

// 프로젝트별 작업 세션 (트랜스크립트 기반). project_key 또는 project_id 지정 시 필터, 없으면 전역 최신순.
router.get('/project-sessions', async (c) => {
  const dao = new ClaudeDao(c.env.DB)
  const projectsDao = new ProjectsDao(c.env.DB)
  let projectKey = c.req.query('project_key')
  const projectId = c.req.query('project_id')
  const search = c.req.query('search')
  const limit = Number(c.req.query('limit')) || 100
  const offset = Number(c.req.query('offset')) || 0

  // project_id가 오면 project_key로 변환
  if (projectId && !projectKey) {
    const proj = await projectsDao.findById(projectId)
    if (proj) projectKey = proj.key
  }

  const sessions = projectKey
    ? await dao.findProjectSessionsByKey(projectKey, { search, limit, offset })
    : await dao.findProjectSessionsAll({ search, limit, offset })
  return c.json({ sessions })
})

// 프로젝트별 AI 투입 집계 (세션/메시지/도구 합계).
router.get('/project-sessions/aggregates', async (c) => {
  const dao = new ClaudeDao(c.env.DB)
  const aggregates = await dao.getProjectSessionAggregates({ limit: Number(c.req.query('limit')) || 50 })
  return c.json({ aggregates })
})

// --- Sync 엔드포인트 ---
router.post('/sync/stats', async (c) => {
  const { items } = await c.req.json()
  if (!items?.length) return c.json({ synced: 0 })
  const dao = new ClaudeDao(c.env.DB)
  const synced = await dao.syncStats(items)
  return c.json({ synced })
})

router.post('/sync/tokens', async (c) => {
  const { items } = await c.req.json()
  if (!items?.length) return c.json({ synced: 0 })
  const dao = new ClaudeDao(c.env.DB)
  const synced = await dao.syncTokenStats(items)
  return c.json({ synced })
})

router.post('/sync/model-usage', async (c) => {
  const { items } = await c.req.json()
  if (!items?.length) return c.json({ synced: 0 })
  const dao = new ClaudeDao(c.env.DB)
  const synced = await dao.syncModelUsage(items)
  return c.json({ synced })
})

router.post('/sync/memories', async (c) => {
  const { items } = await c.req.json()
  if (!items?.length) return c.json({ synced: 0 })
  const dao = new ClaudeDao(c.env.DB)
  const synced = await dao.syncMemories(items)
  return c.json({ synced })
})

router.post('/sync/sessions', async (c) => {
  const { items } = await c.req.json()
  if (!items?.length) return c.json({ synced: 0 })
  const dao = new ClaudeDao(c.env.DB)
  const synced = await dao.syncSessions(items)
  return c.json({ synced })
})

router.post('/sync/project-sessions', async (c) => {
  const { items } = await c.req.json()
  if (!items?.length) return c.json({ synced: 0 })
  const dao = new ClaudeDao(c.env.DB)
  const synced = await dao.syncProjectSessions(items)
  return c.json({ synced })
})

router.post('/sync/session-usage', async (c) => {
  const { items } = await c.req.json()
  if (!items?.length) return c.json({ synced: 0 })
  const dao = new ClaudeDao(c.env.DB)
  const synced = await dao.syncSessionUsage(items)
  return c.json({ synced })
})

router.post('/sync/agent-usage', async (c) => {
  const { items } = await c.req.json()
  if (!items?.length) return c.json({ synced: 0 })
  const dao = new ClaudeDao(c.env.DB)
  const synced = await dao.syncAgentUsage(items)
  return c.json({ synced })
})

// --- 증분 동기화 (실시간 감시 데몬) ---
router.post('/sync/incremental', async (c) => {
  const { items } = await c.req.json()
  if (!items?.length) return c.json({ synced: 0 })
  const dao = new ClaudeDao(c.env.DB)
  const synced = await dao.syncSessionUsageIncremental(items)
  return c.json({ synced })
})

// --- 토큰 도둑 색출 (읽기) ---
// since 파라미터: 'today' | 'week' | ISO문자열 (없으면 전체)
function resolveSince(v) {
  if (!v) return null
  const now = new Date()
  if (v === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  if (v === 'week') return new Date(now.getTime() - 7*864e5).toISOString()
  return v
}

// 세션 top-N (비용순)
router.get('/usage/sessions', async (c) => {
  const dao = new ClaudeDao(c.env.DB)
  const sessions = await dao.findSessionUsage({
    limit: Number(c.req.query('limit')) || 20,
    offset: Number(c.req.query('offset')) || 0,
    since: resolveSince(c.req.query('since')),
    projectKey: c.req.query('project_key') || null,
  })
  return c.json({ sessions })
})

// 프로젝트별 집계
router.get('/usage/projects', async (c) => {
  const dao = new ClaudeDao(c.env.DB)
  const projects = await dao.getProjectUsage({
    since: resolveSince(c.req.query('since')),
    limit: Number(c.req.query('limit')) || 50,
  })
  return c.json({ projects })
})

// 에이전트 type별 집계
router.get('/usage/agents', async (c) => {
  const dao = new ClaudeDao(c.env.DB)
  const agents = await dao.getAgentUsage({
    since: resolveSince(c.req.query('since')),
    limit: Number(c.req.query('limit')) || 50,
  })
  return c.json({ agents })
})

// 전체 요약 (main vs sub, 캐시쓰기 1h 비중)
router.get('/usage/summary', async (c) => {
  const dao = new ClaudeDao(c.env.DB)
  const summary = await dao.getUsageSummary({ since: resolveSince(c.req.query('since')) })
  return c.json({ summary })
})

// 세션 .jsonl 파일 조회
router.get('/project-sessions/:id/file', async (c) => {
  const sessionId = c.req.param('id')
  const dao = new ClaudeDao(c.env.DB)
  try {
    const file = await dao.getProjectSessionFile(sessionId)
    return c.json(file)
  } catch (err) {
    return c.json({ error: err.message }, 404)
  }
})

export default router
