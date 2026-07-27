// 프로젝트 조회 라우트 — api.md §5.3. 프로젝트는 사용자 1명 소유(project_members 없음, §0-9).
import { Hono } from 'hono'
import * as projectsDao from '../dao/projects.js'
import * as repositoriesDao from '../dao/repositories.js'
import * as projectStateLib from '../lib/project-state.js'
import { requireAdmin } from '../middleware/jwt-auth.js'

const projects = new Hono()

// GET /api/projects — 본인 소유만(WHERE user_id = ?).
projects.get('/', async (c) => {
  const list = await projectsDao.listForUser(c.env.DB, c.get('userId'))
  return c.json({ data: list })
})

// GET /api/projects/:id — 본인 소유만. 타인 소유는 403 대신 404로 위장(IDOR 방지).
projects.get('/:id', async (c) => {
  const id = c.req.param('id')
  const isAdmin = c.get('userRole') === 'administrator'
  const project = isAdmin ? await projectsDao.findByIdAny(c.env.DB, id) : await projectsDao.findOwnedById(c.env.DB, c.get('userId'), id)
  if (!project) return c.json({ error: { code: 'NOT_FOUND', message: 'project not found' } }, 404)

  const repository = await repositoriesDao.findById(c.env.DB, project.repository_id)
  const state = await projectStateLib.getState(c.env.DB, id)
  return c.json({
    id: project.id,
    repository_id: project.repository_id,
    repository: repository ? { name: repository.name, classification: repository.classification } : null,
    project_key: project.project_key,
    name: project.name,
    status: project.status,
    classification: project.classification,
    state: state || null,
    created_at: project.created_at,
    updated_at: project.updated_at
  })
})

// GET /api/repositories/:id/projects — administrator만(같은 레포에 대한 여러 사용자 작업 열람).
export const repositories = new Hono()
repositories.get('/:id/projects', requireAdmin, async (c) => {
  const repositoryId = c.req.param('id')
  const list = await projectsDao.listByRepository(c.env.DB, repositoryId)
  return c.json({ data: list })
})

export default projects
