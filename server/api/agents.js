import { Hono } from 'hono'
import AgentsDao from '../dao/agents.js'
import { badRequest, notFound } from '../utils/response.js'

const router = new Hono()

// 에이전트 목록
router.get('/', async (c) => {
  const dao = new AgentsDao(c.env.DB)
  const agents = await dao.findAll({ status: c.req.query('status') })
  return c.json({ agents })
})

// 에이전트 상세 (md_content, 학습 이력, 활동 이력 포함)
router.get('/:name', async (c) => {
  const dao = new AgentsDao(c.env.DB)
  const agent = await dao.findByName(c.req.param('name'))
  if (!agent) return notFound(c, 'Agent not found')
  const [stats, activities, learningLogs] = await Promise.all([
    dao.getStats(agent.name),
    dao.getActivities(agent.name),
    dao.getLearningLogs(agent.name)
  ])
  agent.total_tasks_completed = stats.total_tasks_completed
  agent.total_projects_participated = stats.total_projects_participated
  return c.json({ agent, activities, learning_logs: learningLogs })
})

// 에이전트 등록/수정
router.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.name || !body.role) return badRequest(c, 'name and role are required')
  const dao = new AgentsDao(c.env.DB)
  const agent = await dao.upsert(body)
  return c.json({ agent }, 201)
})

// 일괄 동기화 (.claude/agents/ 에서 읽은 전체 에이전트 목록)
router.post('/sync', async (c) => {
  const { agents } = await c.req.json()
  if (!Array.isArray(agents)) return badRequest(c, 'agents array is required')
  const dao = new AgentsDao(c.env.DB)
  const results = []
  for (const a of agents) {
    if (!a.name || !a.role) continue
    const agent = await dao.upsert(a)
    results.push(agent)
  }
  return c.json({ agents: results, synced: results.length })
})

// 스킬 수준 수동 오버라이드 (이슈 6a01f9ab): 트레이너 실질평가로 skill_level 을 확정하고,
// locked:true 면 이후 bin/sync-agents.js 일괄 /sync 의 자동 재계산으로부터 보호한다.
// locked:false 로 호출하면 다시 자동 재계산 대상으로 풀린다.
router.patch('/:name/skill-level', async (c) => {
  const name = c.req.param('name')
  const dao = new AgentsDao(c.env.DB)
  const existing = await dao.findByName(name)
  if (!existing) return notFound(c, 'Agent not found')
  const body = await c.req.json()
  const VALID_LEVELS = ['beginner', 'intermediate', 'advanced', 'expert']
  if (body.skill_level === undefined && body.locked === undefined) {
    return badRequest(c, 'skill_level or locked is required')
  }
  if (body.skill_level !== undefined && !VALID_LEVELS.includes(body.skill_level)) {
    return badRequest(c, `skill_level must be one of: ${VALID_LEVELS.join(', ')}`)
  }
  const agent = await dao.setSkillOverride(name, { skill_level: body.skill_level, locked: body.locked })
  return c.json({ agent })
})

// 학습 이력 추가
router.post('/:name/learning', async (c) => {
  const name = c.req.param('name')
  const dao = new AgentsDao(c.env.DB)
  const agent = await dao.findByName(name)
  if (!agent) return notFound(c, 'Agent not found')
  const body = await c.req.json()
  if (!body.type || !body.title) return badRequest(c, 'type and title are required')
  const id = crypto.randomUUID()
  const log = await dao.addLearningLog({ id, agent_name: name, ...body })
  return c.json({ learning_log: log }, 201)
})

export default router
