// project_bootstrap 공통 구현(mcp-tools.md §4.11, 구 bootstrap_project) — repositories/projects
// get-or-create 후 project_get_context와 동일한 조합 로직(server/lib/context.js)으로
// state/decisions/issues/recentWork를 모아 STATUS.md 마크다운 문자열 하나로 조립해 반환한다.
// 포맷을 서버가 소유 — 클라이언트는 그대로 파일에 쓰기만 하면 된다. 이미 존재하는 프로젝트
// 재호출은 아무것도 덮어쓰지 않고 조회만(멱등). claudeMarkdown/docsReadmeMarkdown/scaffoldFolders는
// D1 조회에 의존하지 않는 고정 템플릿이라 isNew나 컨텍스트 조회 성공 여부와 무관하게 항상 같은
// 값을 반환한다(§4.11 "비정상 케이스"). state는 project_states 폐기(2026-07-28) 이후 즉석 계산 —
// camelCase 키(phase/health/progress/currentWork/nextAction/blockerSummary)로 반환된다(§4.1).
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

// CLAUDE.md 템플릿(mcp-tools.md §4.11) — isNew/D1 조회 결과와 무관하게 항상 같은 고정 내용,
// repositoryKey 자리만 실제 입력값으로 치환한다. 2026-07-28 전면 개명 반영(옛 도구 이름 잔재 없음).
function renderClaudeMarkdown(repositoryKey) {
  return `# CLAUDE.md

이 프로젝트는 malgnai-hub(맑은소프트 공통 프로젝트 메모리 MCP)로 작업 이력을 추적한다.

## 새 세션 부트스트랩
- **L0(항상):** 이 파일 + \`STATUS.md\`. \`STATUS.md\` 상단 YAML frontmatter의 \`malgnai_hub.project_id\`가 이 프로젝트의 malgnai-hub 식별자다.
- **L1(필요 시):** 텍스트 검색이 필요하면 \`project_search_history\` MCP 도구 호출.
- **상황 파악하려고 코드/문서 통독 금지** — STATUS.md + 이 파일이면 대부분 충분.

## malgnai-hub MCP 사용 규칙
- **작업 시작 전**: \`project_get_context\`로 현재 상태·최근 결정·열린 이슈를 먼저 확인한다.
- **의미 있는 작업을 마쳤을 때**: \`work_record\`(started/progress/completed/blocked 상태와 요약, \`nextAction\`을 채워두면 다음 세션의 현재상태에 그대로 이어짐).
- **중요한 결정을 내렸을 때**: \`decision_record\`(결정+이유, \`importance\`는 매번 실제로 판단해서 1~5 지정 — 기본값 3 습관적 사용 금지).
- **막힌 것/장애물을 발견했을 때**: \`issue_record\`, 해결되면 \`issue_resolve\`(issueId 필요 — issue_record 응답의 issueId를 보관해둘 것).
- **여러 단계로 나뉘는 작업**: \`wbs_add\`/\`wbs_bulk_add\`로 계획을 등록하고, 단계가 끝날 때마다 \`wbs_update\`로 갱신.
- **모든 도구는 \`repositoryKey\` 필수** — 이 프로젝트의 repositoryKey는 \`${repositoryKey}\`.

## STATUS.md 작성 규칙
- 진행 상태의 단일 소스. 착수 전 읽고, 상태가 바뀌면 끝내기 전 갱신한다.
- 완료 항목은 1줄 요약만, 완료 섹션은 최근 5~7개만 유지한다.
- 헤더(\`_최종 갱신: ..._\` 줄)는 매번 통째로 교체한다 — "직전:" 체이닝 금지.
- 상세 이력은 STATUS.md에 쓰지 않고 malgnai-hub MCP(\`decision_record\`/\`issue_record\`/\`issue_resolve\`/\`work_record\`)에 남긴다 — STATUS.md는 "지금 돌아가는 것·다음 것·열린 이슈"만 남긴다.
`
}

// docs/README.md 템플릿(mcp-tools.md §4.11) — 완전 고정 스텁, 치환 값 없음.
const DOCS_README_MARKDOWN = `# 문서 지도

이 파일은 \`docs/\` 아래 문서들의 지도다. 새 문서를 추가하면 여기 한 줄로 링크를 남긴다.

- (아직 문서 없음)
`

// 폴더 스캐폴드(mcp-tools.md §4.11) — 고정 배열, D1 조회와 무관.
const SCAFFOLD_FOLDERS = ['docs', 'src', 'output']

// state는 project_states 폐기(2026-07-28) 이후 computeProjectState()가 즉석 계산해 반환하는
// camelCase 필드(phase/health/progress/currentWork/nextAction/blockerSummary)를 그대로 읽는다(§4.1).
function renderState(state) {
  if (!state) return '- 아직 기록된 상태 없음(work_record로 기록 시작)'
  const lines = []
  if (state.phase) lines.push(`- 단계: ${state.phase}`)
  if (state.health) lines.push(`- 건강도: ${state.health}`)
  if (state.progress !== null && state.progress !== undefined) lines.push(`- 진행률: ${state.progress}%`)
  if (state.currentWork) lines.push(`- 현재 작업: ${state.currentWork}`)
  if (state.nextAction) lines.push(`- 다음 조치: ${state.nextAction}`)
  if (state.blockerSummary) lines.push(`- 블로커: ${state.blockerSummary}`)
  return lines.length ? lines.join('\n') : '- 아직 기록된 상태 없음(work_record로 기록 시작)'
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
 * → { projectId, repositoryId, isNew, webUrl, statusMarkdown, claudeMarkdown, docsReadmeMarkdown, scaffoldFolders }
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

  // §4.11: state(즉석계산)/decisions(상위5)/issues(open, 상위5)/recentWork(상위5) — wbs는 STATUS.md
  // 템플릿이 쓰지 않으므로 sections에서 제외해 불필요한 쿼리를 만들지 않는다.
  const ctx = await getProjectContext(db, project.id, { sections: ['state', 'decisions', 'issues', 'recentWork'], limit: 5 })

  const webUrl = `${WEB_ORIGIN}/projects/${project.id}`
  const statusMarkdown = `---
malgnai_hub:
  project_id: "${esc(project.id)}"
  repository_id: "${esc(repository.id)}"
  repository_key: "${esc(repository.repository_key)}"
  web_url: "${esc(webUrl)}"
---

# STATUS — ${project.name}
_최종 갱신: ${today()} — malgnai-hub project_bootstrap으로 생성/갱신._

## 🟢 현재 상태
${renderState(ctx.state)}

## ✅ 최근 완료
${renderRecentCompleted(ctx.decisions, ctx.recentWork)}

## 🚧 열린 이슈
${renderIssues(ctx.issues)}

## 📌 핵심 메모
- 이 프로젝트의 malgnai-hub project_id는 \`${project.id}\`. malgnai-mcp(사내 별도 시스템) project_id와 다른 값이니 혼동 금지 — 이 파일 상단 YAML frontmatter의 \`malgnai_hub.project_id\`가 정본.
- 상세 이력은 \`${webUrl}\`에서 조회하거나 \`project_search_history\`/\`project_get_context\` MCP 도구로 조회.
`

  return {
    projectId: project.id,
    repositoryId: repository.id,
    isNew,
    webUrl,
    statusMarkdown,
    claudeMarkdown: renderClaudeMarkdown(repository.repository_key),
    docsReadmeMarkdown: DOCS_README_MARKDOWN,
    scaffoldFolders: SCAFFOLD_FOLDERS
  }
}
