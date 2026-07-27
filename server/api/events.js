// 결정/이슈/작업이력(읽기 전용) + 히스토리 검색 — api.md §5.4. 쓰기는 MCP 전용(§0-11 3테이블 분리).
//
// [설계 판단] GET /:id/wbs: docs/api.md §5.4에는 명시되어 있지 않지만(REST 스펙에 wbs 라우트가
// 없음 — wbs_items가 architecture.md §0 결정20으로 나중에 추가되며 api.md가 갱신되지 않은 문서
// 갭으로 판단), COO 위임 지시("웹 REST 읽기 API: projects/decisions/issues/works/wbs 조회 라우트")가
// 명시적으로 wbs 조회를 요구해 server/lib/wbs.js(wbs_list와 동일 로직)를 재사용해 추가했다.
// 완료 보고 시 이 문서 갭을 별도로 명시한다.
import { Hono } from 'hono'
import * as projectsDao from '../dao/projects.js'
import * as decisionsLib from '../lib/decisions.js'
import * as issuesLib from '../lib/issues.js'
import * as worksLib from '../lib/works.js'
import * as wbsLib from '../lib/wbs.js'
import { searchProjectHistory } from '../lib/search.js'

const events = new Hono()

async function resolveOwnedProject(c, id) {
  const isAdmin = c.get('userRole') === 'administrator'
  return isAdmin ? projectsDao.findByIdAny(c.env.DB, id) : projectsDao.findOwnedById(c.env.DB, c.get('userId'), id)
}

function parseLimit(c, fallback = 20, max = 100) {
  const n = Number.parseInt(c.req.query('limit') || '', 10)
  if (!Number.isInteger(n) || n < 1) return fallback
  return Math.min(n, max)
}

events.get('/:id/decisions', async (c) => {
  const project = await resolveOwnedProject(c, c.req.param('id'))
  if (!project) return c.json({ error: { code: 'NOT_FOUND', message: 'project not found' } }, 404)
  const importanceMin = c.req.query('importance_min') ? Number.parseInt(c.req.query('importance_min'), 10) : undefined
  const page = await decisionsLib.listDecisions(c.env.DB, project.id, {
    cursor: c.req.query('cursor') || undefined, limit: parseLimit(c), importanceMin
  })
  return c.json(page)
})

events.get('/:id/issues', async (c) => {
  const project = await resolveOwnedProject(c, c.req.param('id'))
  if (!project) return c.json({ error: { code: 'NOT_FOUND', message: 'project not found' } }, 404)
  const page = await issuesLib.listIssues(c.env.DB, project.id, {
    cursor: c.req.query('cursor') || undefined,
    limit: parseLimit(c),
    status: c.req.query('status') || 'open',
    severity: c.req.query('severity') || undefined
  })
  return c.json(page)
})

events.get('/:id/activities', async (c) => {
  const project = await resolveOwnedProject(c, c.req.param('id'))
  if (!project) return c.json({ error: { code: 'NOT_FOUND', message: 'project not found' } }, 404)
  const page = await worksLib.listWorks(c.env.DB, project.id, {
    cursor: c.req.query('cursor') || undefined, limit: parseLimit(c), category: c.req.query('category') || undefined
  })
  return c.json(page)
})

events.get('/:id/history/search', async (c) => {
  const project = await resolveOwnedProject(c, c.req.param('id'))
  if (!project) return c.json({ error: { code: 'NOT_FOUND', message: 'project not found' } }, 404)
  const typesParam = c.req.query('types')
  const types = typesParam ? typesParam.split(',').map((s) => s.trim()).filter(Boolean) : undefined
  const result = await searchProjectHistory(c.env.DB, project.id, {
    query: c.req.query('query') || '', types, limit: parseLimit(c, 10, 30)
  })
  return c.json(result)
})

// GET /api/projects/:id/wbs — 문서 갭 보완(위 주석 참고). wbs_list와 동일 조회 로직 재사용.
events.get('/:id/wbs', async (c) => {
  const project = await resolveOwnedProject(c, c.req.param('id'))
  if (!project) return c.json({ error: { code: 'NOT_FOUND', message: 'project not found' } }, 404)
  const result = await wbsLib.wbsList(c.env.DB, project.id, {
    parentId: c.req.query('parent_id') || undefined,
    status: c.req.query('status') || undefined,
    includeDone: c.req.query('include_done') === 'true'
  })
  return c.json(result)
})

export default events
