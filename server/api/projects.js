// 프로젝트 조회 라우트 — api.md §5.3. 프로젝트는 사용자 1명 소유(project_members 없음, §0-9).
import { Hono } from 'hono'
import * as projectsDao from '../dao/projects.js'
import { computeProjectState } from '../lib/context.js'
import { requireAdmin } from '../middleware/jwt-auth.js'
import { normalizeRepositoryKey } from '../lib/repository-key.js'

const projects = new Hono()

// GET /api/projects — 본인 소유만(WHERE user_id = ?).
projects.get('/', async (c) => {
  const list = await projectsDao.listForUser(c.env.DB, c.get('userId'))
  return c.json({ data: list })
})

// GET /api/projects/:id — 본인 소유만. 타인 소유는 403 대신 404로 위장(IDOR 방지).
// state는 더 이상 project_states 조인이 아니라 mcp-tools.md §4.1과 동일 로직으로 즉석 계산
// (works 최신행+wbs 롤업+open issues, computeProjectState는 server/lib/context.js 재사용 —
// 2026-07-28 project_states 폐기, api.md §5.3). 키는 phase/health/progress/currentWork/
// nextAction/blockerSummary — activeBranch/latestCommit은 v1에서 두지 않는다.
projects.get('/:id', async (c) => {
  const id = c.req.param('id')
  const isAdmin = c.get('userRole') === 'administrator'
  const project = isAdmin ? await projectsDao.findByIdAny(c.env.DB, id) : await projectsDao.findOwnedById(c.env.DB, c.get('userId'), id)
  if (!project) return c.json({ error: { code: 'NOT_FOUND', message: 'project not found' } }, 404)

  const { state } = await computeProjectState(c.env.DB, id)
  return c.json({
    id: project.id,
    repository_key: project.repository_key,
    repository_name: project.repository_name,
    project_key: project.project_key,
    name: project.name,
    status: project.status,
    classification: project.classification,
    state,
    created_at: project.created_at,
    updated_at: project.updated_at
  })
})

// GET /api/repositories/:key/projects — administrator만(같은 repository_key의 여러 사용자 작업 열람).
// repositories 테이블 폐기(2026-08-11) 이후 :key는 projects.repository_key 문자열 그대로.
export const repositories = new Hono()
repositories.get('/:key/projects', requireAdmin, async (c) => {
  const repositoryKey = normalizeRepositoryKey(c.req.param('key'))
  const list = await projectsDao.listByRepositoryKey(c.env.DB, repositoryKey)
  return c.json({ data: list })
})

export default projects
