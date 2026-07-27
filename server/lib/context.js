// get_project_context 조합 로직(mcp-tools.md §4.1) — 최대 4개 독립 쿼리를 병렬 조회.
// 일부 section만 실패해도(예: works 조회만 타임아웃) 나머지는 정상 반환하고 실패한 section만
// null로 채운다(전부 실패했을 때만 도구 전체 에러) — D1 조회 장애가 세션 전체를 막지 않게(§4.1).
import * as decisionsLib from './decisions.js'
import * as issuesLib from './issues.js'
import * as worksLib from './works.js'

const ALL_SECTIONS = ['state', 'decisions', 'issues', 'recentWork']

export async function getProjectContext(db, projectId, { sections, limit = 10 } = {}) {
  const want = Array.isArray(sections) && sections.length ? sections.filter((s) => ALL_SECTIONS.includes(s)) : ALL_SECTIONS
  const out = { state: null, decisions: [], issues: [], recentWork: [] }
  const tasks = []
  const failures = []

  if (want.includes('state')) {
    tasks.push(
      db.prepare('SELECT * FROM project_states WHERE project_id = ?').bind(projectId).first()
        .then((r) => { out.state = r || null })
        .catch(() => { out.state = null; failures.push('state') })
    )
  }
  if (want.includes('decisions')) {
    tasks.push(
      decisionsLib.listTopForContext(db, projectId, limit)
        .then((r) => { out.decisions = r })
        .catch(() => { out.decisions = null; failures.push('decisions') })
    )
  }
  if (want.includes('issues')) {
    tasks.push(
      issuesLib.listOpenForContext(db, projectId, limit)
        .then((r) => { out.issues = r })
        .catch(() => { out.issues = null; failures.push('issues') })
    )
  }
  if (want.includes('recentWork')) {
    tasks.push(
      worksLib.listWorks(db, projectId, { limit })
        .then((r) => { out.recentWork = r.data })
        .catch(() => { out.recentWork = null; failures.push('recentWork') })
    )
  }

  await Promise.all(tasks)

  if (tasks.length > 0 && failures.length === tasks.length) {
    const e = new Error('all context sections failed')
    e.name = 'InternalError'
    throw e
  }
  return out
}
