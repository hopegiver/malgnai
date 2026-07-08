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
