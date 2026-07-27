// bootstrap_project 공통 구현(mcp-tools.md §4.11) — repositories/projects get-or-create 후
// get_project_context와 동일한 조합 로직(server/lib/context.js)으로 state/decisions/issues/recentWork를
// 모아 STATUS.md 마크다운 문자열 하나로 조립해 반환한다. 포맷을 서버가 소유 — 클라이언트는 그대로
// 파일에 쓰기만 하면 된다. 이미 존재하는 프로젝트 재호출은 아무것도 덮어쓰지 않고 조회만(멱등).
import * as repositoriesDao from '../dao/repositories.js'
import * as projectsDao from '../dao/projects.js'
import { getProjectContext } from './context.js'

// 다른 오리진 상수가 아직 없어 여기서 하드코딩(architecture.md에 별도 WEB_URL env 바인딩 없음,
// 배포 오리진 고정: https://malgnai-hub.malgnsoft.workers.dev).
const WEB_ORIGIN = 'https://malgnai-hub.malgnsoft.workers.dev'

function validationError(message) {
  const e = new Error(message)
  e.name = 'ValidationError'
  return e
}

function esc(v) {
  return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

function renderState(state) {
  if (!state) return '- 아직 기록된 상태 없음(update_project_state로 기록 시작)'
  const lines = []
  if (state.phase) lines.push(`- 단계: ${state.phase}`)
  if (state.health) lines.push(`- 건강도: ${state.health}`)
  if (state.progress !== null && state.progress !== undefined) lines.push(`- 진행률: ${state.progress}%`)
  if (state.current_work) lines.push(`- 현재 작업: ${state.current_work}`)
  if (state.next_action) lines.push(`- 다음 조치: ${state.next_action}`)
  if (state.blocker_summary) lines.push(`- 블로커: ${state.blocker_summary}`)
  return lines.length ? lines.join('\n') : '- 아직 기록된 상태 없음(update_project_state로 기록 시작)'
}

// decisions(top5) + recentWork 중 category='completed'(top5)를 합쳐 최신순 1줄 불릿으로.
// context.js는 section 조회 실패 시 해당 필드를 null로(성공+무레코드는 빈 배열로) 채우므로
// null인지 빈 배열인지로 "조회 실패"와 "그냥 없음"을 구분할 수 있다(state는 둘 다 null이라 구분 불가 — 알려진 한계).
function renderRecentCompleted(decisions, recentWork) {
  if (decisions === null && recentWork === null) return '- (조회 실패)'
  const items = []
  if (Array.isArray(decisions)) {
    for (const d of decisions.slice(0, 5)) {
      items.push({ createdAt: d.created_at, text: `- [결정] ${d.title}: ${d.summary}` })
    }
  }
  if (Array.isArray(recentWork)) {
    for (const w of recentWork.filter((x) => x.category === 'completed').slice(0, 5)) {
      items.push({ createdAt: w.created_at, text: `- [완료] ${w.title}` })
    }
  }
  if (!items.length) return '- 아직 없음'
  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  return items.slice(0, 5).map((i) => i.text).join('\n')
}

function renderIssues(issues) {
  if (issues === null) return '- (조회 실패)'
  if (!issues.length) return '- 없음'
  return issues.slice(0, 5).map((i) => `- [${i.severity}] ${i.title}`).join('\n')
}

/**
 * bootstrapProject(db, userId, { repositoryKey, repositoryName?, projectName? })
 * → { projectId, repositoryId, isNew, webUrl, statusMarkdown }
 */
export async function bootstrapProject(db, userId, { repositoryKey, repositoryName, projectName } = {}) {
  if (!repositoryKey || typeof repositoryKey !== 'string') {
    throw validationError('repositoryKey is required')
  }

  const repository = await repositoriesDao.getOrCreate(db, repositoryKey, repositoryName)

  // isNew 판정을 위해 get-or-create 전에 먼저 존재 여부를 확인(projectsDao.getOrCreateForUser는
  // 존재/생성 여부를 알려주지 않고 row만 반환하므로 — 다른 9개 도구의 계약을 바꾸지 않기 위한 최소 변경).
  const existing = await db.prepare('SELECT * FROM projects WHERE user_id = ? AND repository_id = ?')
    .bind(userId, repository.id).first()
  const isNew = !existing
  const project = existing || await projectsDao.getOrCreateForUser(db, userId, repository, projectName)

  const ctx = await getProjectContext(db, project.id, {})

  const webUrl = `${WEB_ORIGIN}/projects/${project.id}`
  const statusMarkdown = `---
malgnai_hub:
  project_id: "${esc(project.id)}"
  repository_id: "${esc(repository.id)}"
  repository_key: "${esc(repository.repository_key)}"
  web_url: "${esc(webUrl)}"
---

# STATUS — ${project.name}
_최종 갱신: ${today()} — malgnai-hub bootstrap_project로 생성/갱신._

## 🟢 현재 상태
${renderState(ctx.state)}

## ✅ 최근 완료
${renderRecentCompleted(ctx.decisions, ctx.recentWork)}

## 🚧 열린 이슈
${renderIssues(ctx.issues)}

## 📌 핵심 메모
- 이 프로젝트의 malgnai-hub project_id는 \`${project.id}\`. malgnai-mcp(사내 별도 시스템) project_id와 다른 값이니 혼동 금지 — 이 파일 상단 YAML frontmatter의 \`malgnai_hub.project_id\`가 정본.
- 상세 이력은 \`${webUrl}\`에서 조회하거나 \`search_project_history\`/\`get_project_context\` MCP 도구로 조회.
`

  return {
    projectId: project.id,
    repositoryId: repository.id,
    isNew,
    webUrl,
    statusMarkdown
  }
}
