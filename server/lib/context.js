// project_get_context 조합 로직(mcp-tools.md §4.1) — 최대 4개(decisions/issues/recentWork/wbs)
// 독립 쿼리를 조합하고, state는 더 이상 저장된 행이 아니라 그 4개 소스 중 recentWork(최신1건)·
// issues(open)·wbs(최상위 롤업)를 조합해 매 호출마다 즉석 계산한다(project_states 폐기,
// schema.sql §3.7, architecture.md §3.7). 일부 section만 실패해도(예: works 조회만 타임아웃)
// 나머지는 정상 반환하고 실패한 section만 null로 채운다(전부 실패했을 때만 도구 전체 에러) —
// D1 조회 장애가 세션 전체를 막지 않게(§4.1). state는 계산에 쓰이는 recentWork/issues/wbs 중
// 하나라도 실패하면 null로 반환(부분 데이터로 잘못된 health/progress를 계산하지 않기 위함).
//
// computeProjectState()는 server/api/projects.js(GET /api/projects/:id)도 그대로 재사용한다
// (architecture.md §2.1 "MCP 도구와 REST 라우트는 같은 server/lib/* 함수를 직접 import" 원칙) —
// state 계산 로직을 두 곳에 중복 구현하지 않는다.
import * as decisionsLib from './decisions.js'
import * as issuesLib from './issues.js'
import * as worksLib from './works.js'
import * as wbsLib from './wbs.js'

const ALL_SECTIONS = ['state', 'decisions', 'issues', 'recentWork', 'wbs']

function computeHealth(severityCounts, latestWorkBlocked) {
  if (severityCounts.critical > 0) return 'critical'
  if (severityCounts.high > 0 || latestWorkBlocked) return 'warning'
  return 'normal'
}

function computeProgress(rootWbsItems) {
  if (!rootWbsItems.length) return null
  const sum = rootWbsItems.reduce((s, i) => s + (i.computedProgress ?? 0), 0)
  return Math.round(sum / rootWbsItems.length)
}

function buildState(latestWork, severityCounts, rootWbsItems) {
  const noWork = !latestWork
  const noOpenIssues = severityCounts.critical === 0 && severityCounts.high === 0 && severityCounts.medium === 0 && severityCounts.low === 0
  const noWbs = rootWbsItems.length === 0
  if (noWork && noOpenIssues && noWbs) return null

  const blocked = latestWork?.category === 'blocked'
  return {
    phase: latestWork?.category ?? null,
    currentWork: latestWork ? (latestWork.detail ? `${latestWork.title}: ${latestWork.detail}` : latestWork.title) : null,
    nextAction: latestWork?.next_action ?? null,
    blockerSummary: blocked ? (latestWork.detail ?? null) : null,
    progress: computeProgress(rootWbsItems),
    health: computeHealth(severityCounts, blocked)
  }
}

/** state 즉석 계산(§4.1) — MCP project_get_context/project_bootstrap과 REST GET /api/projects/:id가
 *  공유. 내부 쿼리(최신 work 1건/open issue severity 분포/wbs 전체 롤업) 중 하나라도 실패하면
 *  ok:false + state:null(부분 데이터로 잘못된 health/progress를 계산하지 않기 위함, §4.1 비정상 케이스). */
export async function computeProjectState(db, projectId) {
  try {
    const [workPage, severityCounts, wbsPage] = await Promise.all([
      worksLib.listWorks(db, projectId, { limit: 1 }),
      issuesLib.getOpenSeverityCounts(db, projectId),
      wbsLib.wbsList(db, projectId, { includeDone: true })
    ])
    const latestWork = workPage.data[0] || null
    const rootWbsItems = wbsPage.items.filter((i) => i.depth === 0)
    return { ok: true, state: buildState(latestWork, severityCounts, rootWbsItems) }
  } catch {
    return { ok: false, state: null }
  }
}

export async function getProjectContext(db, projectId, { sections, limit = 10 } = {}) {
  const want = Array.isArray(sections) && sections.length ? sections.filter((s) => ALL_SECTIONS.includes(s)) : ALL_SECTIONS
  const out = { state: null, decisions: [], issues: [], recentWork: [], wbs: [] }
  const tasks = []
  const failures = []

  if (want.includes('state')) {
    tasks.push(
      computeProjectState(db, projectId).then(({ ok, state }) => {
        out.state = state
        if (!ok) failures.push('state')
      })
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
  if (want.includes('wbs')) {
    tasks.push(
      wbsLib.wbsList(db, projectId, {})
        .then((r) => { out.wbs = r.items })
        .catch(() => { out.wbs = null; failures.push('wbs') })
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
