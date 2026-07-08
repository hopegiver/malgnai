import { Hono } from 'hono'
import ContextDao from '../dao/context.js'

// Context Router 데이터 조회 API(읽기 전용). 기록은 malgnai-mcp 도구가 담당.
// 프로젝트 상세 페이지가 decisions/issues/memories 를 표시하는 데 사용.
const router = new Hono()

router.get('/decisions', async (c) => {
  const dao = new ContextDao(c.env.DB)
  const decisions = await dao.decisions(c.req.query('project_id'), Number(c.req.query('limit')) || 50)
  return c.json({ decisions })
})

router.get('/issues', async (c) => {
  const dao = new ContextDao(c.env.DB)
  const issues = await dao.issues(c.req.query('project_id'), {
    status: c.req.query('status'),
    severity: c.req.query('severity'),
    limit: Number(c.req.query('limit')) || 50,
  })
  return c.json({ issues })
})

router.get('/memories', async (c) => {
  const dao = new ContextDao(c.env.DB)
  const memories = await dao.memories(c.req.query('project_id'), {
    memory_type: c.req.query('memory_type'),
    limit: Number(c.req.query('limit')) || 50,
  })
  return c.json({ memories })
})

export default router
